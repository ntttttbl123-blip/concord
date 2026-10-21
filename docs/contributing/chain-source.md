# Adding a chain source

Concord reads the ledger through a small interface, `ChainSource`, so the accounting (`packages/core`)
never touches the network and the API can be tested without one. `StellarSource` is the production
implementation. A new data source, a fixture, or a different network implements the same interface.

All of the types below live in [`services/api/src/chain.ts`](../../services/api/src/chain.ts). The
indexer that consumes them is `Concord` in [`services/api/src/concord.ts`](../../services/api/src/concord.ts).

## The interface

```ts
export interface ChainSource {
  latestLedger(): Promise<ChainHead>;
  getEvents(
    contractId: string,
    from: { startLedger: number } | { cursor: string },
    limit: number,
  ): Promise<EventPage>;
  baseline(code: string, issuer: string, decimals: number): Promise<Baseline>;
  describe?(asset: ResolvedAsset): Promise<AssetDescription | undefined>;
  search?(code: string): Promise<AssetCandidate[]>;
}
```

`describe` and `search` are optional. A source without `describe` cannot check an asset exists before
watching it, and a source without `search` cannot offer the code lookup the dashboard uses
(`Concord.lookup` throws `asset search is not available`).

A network is wired up as a `NetworkHandle` in [`concord.ts`](../../services/api/src/concord.ts)
(`{ passphrase, chain? }`). `chain` may be absent, in which case reads on that network are refused
with `no chain source configured for <network>`. [`main.ts`](../../services/api/src/main.ts) builds one
`StellarSource` per configured network.

## What each method must guarantee

### `latestLedger()`

Returns `ChainHead`:

```ts
export interface ChainHead {
  latest: number;
  oldest: number; // the earliest ledger the RPC still holds events for
  oldestClosedAt?: string; // ISO-8601 close time of oldest, when known
}
```

- `latest` is the newest ledger the source has. `getEvents` must never return an event above it, and
  `EventPage.latestLedger` must agree with it. The indexer compares `cursorLedger(cursor)` against
  `latestLedger` to decide it has reached the tip (`concord.ts:558`).
- `oldest` defines retention. The indexer refuses to sync across a gap: if the stored cursor's ledger
  plus one is below `head.oldest`, it stops the asset and tells the user to rebuild
  (`concord.ts:525`). Report `oldest` honestly; do not claim events you no longer keep.
- `oldestClosedAt` is optional and only used to describe where a contract token's history begins
  (`concord.ts:428`).

### `getEvents(contractId, from, limit)`

`from` is either `{ startLedger }` or `{ cursor }`, never both. Returns `EventPage`:

```ts
export interface EventPage {
  events: AssetEvent[];
  cursor?: string;
  latestLedger: number;
  latestLedgerClosedAt?: string;
}
```

- **Ordering.** Events must be returned oldest first and must be ordered the same way as their `id`,
  because the indexer pages with `e.id > cursor` and treats `cursor` as the last id. Event ids follow
  the RPC's TOID layout: the ledger shifted left 32 bits, then an index (`(ledger << 32)`). `cursorLedger`
  decodes a cursor by taking the digits before the first `-` and shifting right 32
  (`chain.ts:515`); a cursor that does not carry a ledger this way breaks tip detection.
- **Cursors.** With `{ cursor }`, return events strictly after that cursor. Set `page.cursor` to a
  value that can be passed back. If a page is short of `limit`, it must not look like there is more to
  read. The indexer stops when the cursor stops moving, when there is no cursor, or when a short page
  ends at the tip (`concord.ts:557`). `StellarSource` sets `cursor` only when the RPC reports one;
  `FakeChain` synthesises a tip cursor for a short page.
- **Idempotency.** Event ids must be stable across calls. The store inserts with `INSERT OR IGNORE`,
  so a repeat page is harmless only if the ids repeat exactly (`concord.ts:589`).
- **Retention.** Never return events below `oldest`; the caller is told about the gap through
  `ChainHead`, not by missing events.
- **Limit.** `limit` is a maximum, not a promise. The indexer passes 1000 (`concord.ts:547`).

`AssetEvent` is defined in `packages/core` and carries `id`, `assetId`, `kind`, `ledger`, `closedAt`,
`txHash`, `amount`, and optionally `from`, `to`, `authorized`. Decoding raw RPC events into it is
`decodeEvent` (`chain.ts:113`), which reads the subject as the last address in the topic list so that
pre-Protocol 23 releases, where the admin leads, still work.

### `baseline(code, issuer, decimals)`

Classic assets only. Returns `Baseline`:

```ts
export interface Baseline {
  ledger: number;
  openings: Map<string, Opening>; // address -> { amount, asOfLedger, authorized? }
}
```

- `ledger` is the ledger the balances reflect. `Concord.prepare` stores it as `baselineLedger` and
  starts event reading at `ledger + 1` (`concord.ts:406`), so the baseline and the first events must
  not overlap or leave a hole.
- The read must be internally consistent. `StellarSource` refuses to go back in time across Horizon
  pages, because a lagging page would put a holder's cut-off before events already counted
  (`chain.ts:385`).
- Call this only for a classic asset. A contract token has no baseline; watching one uses
  `startMode: "window"` and begins at the oldest ledger the source keeps (`concord.ts:422`).

### `describe(asset)`

Optional. Returns what the ledger says about an asset, or `undefined` when the network has no such
asset. `AssetDescription` is `{ code?, issuer?, decimals?, name? }`. It is used when watching an asset:

- `undefined` aborts the watch with a not-found error (`concord.ts:340`).
- A contract id that turns out to wrap a classic asset is watched as that classic asset
  (`concord.ts:345`).
- `decimals` fills in for a contract token that does not state them; a classic asset is always seven.

### `search(code)`

Optional. Returns `AssetCandidate[]` for classic assets carrying a code, most widely held first.
`StellarSource` sorts by trustline count descending (`chain.ts:442`). Every candidate carries the
`CODE:ISSUER` spec, issuer, contract id, trustline count, authorised units, and the issuer control
flags. The dashboard shows these rows so a user can pick the issuer their records hold
(`apps/web/src/Overview.tsx`).

## Errors

Throw `ChainError(message, kind)` for ledger failures, with `kind` one of `unavailable`,
`rate_limited` or `rejected` (`chain.ts:65`). `Concord` shows `ChainError`, `Invalid` and `NotFound`
messages to the user verbatim; any other error is logged and reported as
`Indexing stopped on an unexpected error.` (`concord.ts:193`). `StellarSource` also has an internal
`EndpointFailure` for failover between endpoints; that type stays private to `StellarSource`.

## How `FakeChain` models it

[`services/api/test/helpers.ts`](../../services/api/test/helpers.ts) defines `FakeChain`, the in-memory
source every service test uses. Model a new source on it:

- **State.** `latest` and `oldest` are the chain head, defaulting to 100 and 1. `events` is the event
  list. `baselineResult` is returned by `baseline`, or `baseline` throws `no baseline`. `calls` counts
  `getEvents` calls and `failOnCall` throws once on a chosen call.
- **`push(assetId, kind, ledger, partial)`** appends an event. It builds the id as
  `(ledger << 32)` zero-padded to 19 digits, then the event's index zero-padded to 10, matching the
  RPC layout. Time is fixed: `at(ledger)` is `T0 + ledger` minutes, so tests never depend on the clock.
- **`getEvents`** filters to the contract, drops events above `latest`, keeps `id > cursor` or
  `ledger >= startLedger`, sorts by id, and slices to `limit`. A full page's cursor is the last event
  id; a short page's cursor is a synthetic tip cursor, `((latest << 32) + 9999999999)`.
- **`baseline`** returns `baselineResult` or throws. `describe` and `search` are omitted, so tests
  exercise the paths that need them only when a source adds them.

## Checklist of tests

Add tests in `services/api/test` alongside the existing ones. The suite needs no network.

- [ ] Paging reads every event once and is idempotent. The existing test pushes 2500 events, checks
      the pass count and the added total, runs a second sync that adds nothing, and checks the final
      holdings and `syncedLedger` (`service.test.ts:70`).
- [ ] A pass that dies part-way keeps the already-written pages but does not advance `syncedLedger`,
      and the next pass heals it (`service.test.ts:210`, uses `failOnCall`).
- [ ] A cursor that has fallen below `oldest` stops indexing with the gap message rather than reading
      across the hole (`service.test.ts:228`).
- [ ] A baseline is applied once, and only later events move the figures (`service.test.ts:132`).
- [ ] `rebuild` takes a fresh baseline and keeps uploaded books (`service.test.ts:265`).
- [ ] `decodeEvent` handles the CAP-67 layouts, takes the subject from the last address, reads muxed
      values, and ignores events outside the asset set (`service.test.ts:8`).
- [ ] Any new decoding or cursor logic has a unit test with hand-built raw events, not a live call.

For a source that adds `search` or `describe`, also test that a bare code returns candidates ordered
by trustlines, that an unknown code returns none, and that `describe` returns `undefined` for an
address the network does not hold. If the source talks to a real network, keep those calls out of the
test suite: follow the rule that tests do not touch the network
([`CONTRIBUTING.md`](../../CONTRIBUTING.md)).
