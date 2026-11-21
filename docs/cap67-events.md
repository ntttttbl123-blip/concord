# CAP-67 Event Decoding Reference

Concord decodes Stellar Asset Contract (CAP-67 / SEP-41) events in [`decodeEventDetailed`](../services/api/src/chain.ts#L139-L188) and maps paged RPC responses in [`StellarSource.getEvents`](../services/api/src/chain.ts#L450-L488).

Every decoded event starts with these common fields from the raw RPC event:

- `id`: `raw.id`
- `assetId`: `raw.contractId`
- `kind`: decoded event kind (`topics[0]`)
- `ledger`: `raw.ledger`
- `closedAt`: `new Date(Date.parse(raw.ledgerClosedAt)).toISOString()`
- `txHash`: `raw.txHash`

## Event Reference Table

| Kind | Topics (`raw.topic`) | Value (`raw.value`) | Resulting `AssetEvent` fields | Decoding status & test |
| --- | --- | --- | --- | --- |
| `transfer` | `[symbol("transfer"), from: address, to: address, (optional) sep11: string]` | `i128` amount, or muxed map `{ amount: i128, to_muxed_id?: u64 }` | `from = addresses[0]`, `to = addresses[1]`, `amount` (requires `addresses.length >= 2`, `amount >= 0n`) | Decoded ([`service.test.ts`](../services/api/test/service.test.ts#L46-L51), muxed [`#L65-L66`](../services/api/test/service.test.ts#L65-L66)) |
| `mint` | `[symbol("mint"), (pre-Protocol-23 admin: address)?, to: address, (optional) sep11: string]` | `i128` amount, or muxed map `{ amount: i128 }` | `to = addresses.at(-1)`, `amount` (`amount >= 0n`) | Decoded ([`service.test.ts`](../services/api/test/service.test.ts#L52), admin-first [`#L64`](../services/api/test/service.test.ts#L64)) |
| `burn` | `[symbol("burn"), from: address, (optional) sep11: string]` | `i128` amount, or muxed map `{ amount: i128 }` | `from = addresses.at(-1)`, `amount` (`amount >= 0n`) | Decoded ([`service.test.ts`](../services/api/test/service.test.ts#L98-L102)) |
| `clawback` | `[symbol("clawback"), (pre-Protocol-23 admin: address)?, from: address, (optional) sep11: string]` | `i128` amount, or muxed map `{ amount: i128 }` | `from = addresses.at(-1)`, `amount` (`amount >= 0n`) | Decoded ([`service.test.ts`](../services/api/test/service.test.ts#L53), [`#L105-L109`](../services/api/test/service.test.ts#L105-L109)) |
| `set_authorized` | `[symbol("set_authorized"), (pre-Protocol-23 admin: address)?, subject: address, (optional) sep11: string]` | `bool` (`typeof value === "boolean"`) | `from = addresses.at(-1)`, `authorized = value`, `amount = 0n` | Decoded; non-boolean values are rejected as malformed ([`service.test.ts`](../services/api/test/service.test.ts#L54-L60)) |
| Unknown kind (e.g. `approve`, non-string `topics[0]`) | `[symbol("approve"), ...]` (anything not in `isEventKind`) | Any valid XDR | `undefined` (`malformed: false`) | Deliberately ignored; not counted in `EventPage.skipped` ([`service.test.ts`](../services/api/test/service.test.ts#L69-L71), [`#L128-L167`](../services/api/test/service.test.ts#L128-L167)) |
| Negative amounts on value events | Any tracked value kind (`transfer`, `mint`, `burn`, `clawback`) | `i128 < 0n` (or muxed `{ amount < 0n }`) | `undefined` (`malformed: true`) | Rejected as malformed; increments `EventPage.skipped` ([`service.test.ts`](../services/api/test/service.test.ts#L82-L110)) |
| Malformed XDR / missing address / bad `ledgerClosedAt` | Invalid base64/XDR, zero addresses (or `< 2` for `transfer`), non-i128 value, or unparseable `ledgerClosedAt` | Invalid XDR or mismatched type | `undefined` (`malformed: true`) | Rejected without throwing; increments `EventPage.skipped` ([`service.test.ts`](../services/api/test/service.test.ts#L73-L80), [`#L112-L167`](../services/api/test/service.test.ts#L112-L167)) |

## Decoding Rules

1. **Subject selection (`addresses.at(-1)`):** Releases before Protocol 23 placed the admin address first on `mint`, `clawback`, and `set_authorized` events (`[kind, admin, subject, ...]`). `decodeEventDetailed` filters `topics.slice(1)` for valid Stellar strkey addresses (`/^[GCMLB][A-Z2-7]{55,}$/`) and selects the **last** address (`addresses.at(-1)`) as the subject for single-address events, while `transfer` reads `addresses[0]` as `from` and `addresses[1]` as `to`.
2. **Muxed amounts:** When an event has a muxed destination, `raw.value` is an `ScVal` map carrying `{ amount: bigint, ... }`. Non-`set_authorized` events accept either a plain `i128` (`bigint`) or a non-null object whose `amount` property is a `bigint`.
3. **Unknown kinds are dropped silently:** Events whose `topics[0]` is not one of the five tracked CAP-67 kinds (`transfer`, `mint`, `burn`, `clawback`, `set_authorized`) return `{ malformed: false }` (`decodeEvent` returns `undefined`). `getEvents` ignores them without incrementing `EventPage.skipped`.
4. **Negative amounts and invalid shapes are malformed:** Since negative amounts (`amount < 0n`) violate SEP-41/CAP-67 accounting invariants, `decodeEventDetailed` treats them (along with bad XDR, non-boolean `set_authorized` payloads, missing addresses, and unparseable `ledgerClosedAt` dates) as `{ malformed: true }`. `getEvents` logs the event id once (capped at 1,000 tracked ids) and increments `EventPage.skipped` without throwing.

## Assumption on `inSuccessfulContractCall`

`StellarSource.getEvents` queries Stellar RPC with `filters: [{ type: "contract", contractIds: [contractId] }]` ([`chain.ts`](../services/api/src/chain.ts#L456-L460)), and `RawEvent` does not inspect or require an `inSuccessfulContractCall` property inside `decodeEventDetailed`. Concord assumes the RPC honors the `type: "contract"` filter and only delivers contract events emitted by successful contract invocations (excluding failed-call diagnostic events). Any `ChainSource` implementation feeding `getEvents` must uphold the same invariant so reverted invocations never enter the event log.
