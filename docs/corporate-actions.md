# Corporate actions

How Concord reconciles dividends, splits and redemptions: what each action takes as input, when
the record-date snapshot is frozen, how the execution window is bounded, how entitlements round,
and what each break outcome means. Written for fund administrators; the authoritative code is
`packages/core/src/distributions.ts` (the arithmetic) and `services/api/src/concord.ts` (the
`createAction`/`reconcileAction` flow around it).

The examples below use placeholder addresses (`G…A`, `G…B`). No real holder data appears in
this document.

## The three action types and their inputs

Created with `type`, a `recordTime`, an optional `windowTo` and optional `exclude` list, plus
per-type terms (`ActionInput`, `services/api/src/concord.ts`):

| Type | Terms | Meaning |
|---|---|---|
| `dividend` | `ratePerUnit`, optional `payAsset`, `payer`, `rounding` | Pay-asset units per one whole unit held at the record time |
| `split` | whole-number `num`, `den` | Forward split when `num > den` (2:1 doubles), reverse when `num < den` |
| `redemption` | whole-number `num`, `den` with `num ≤ den` | Pro-rata redemption of `num/den` of every holding; `1/1` redeems in full |

Notes on the inputs, as validated in `createAction`:

- `recordTime` and `windowTo` accept anything `Date.parse` understands and are normalised to
  ISO-8601 UTC.
- `ratePerUnit` is a non-negative decimal string of **any** precision (e.g. `0.0123456789`) —
  it is parsed as an exact rational (`parseRatio`, `packages/core/src/amount.ts`), never as a
  float, so a rate with more decimals than either asset carries loses nothing.
- A dividend defaults to being paid **in kind** — `payAsset` defaults to the asset itself — and
  may instead name any other watched asset on the same network (cross-asset, e.g. a share class
  paying in a stablecoin).
- `exclude` lists addresses with no entitlement (e.g. treasury stock). The asset's configured
  `ignore` list (e.g. the issuer's distribution account) is always excluded as well
  (`reconcileAction`).
- A `label` is optional; without one the action is titled from its terms
  (`Dividend 0.25 per unit`, `Split 2:1`, `Redemption 1/4`).

## Snapshot timing and scheduled actions

Entitlements are computed from the holdings **at the record time**, frozen once and stored:

- An action may be created with a future `recordTime`. Until the indexed chain has passed that
  instant (`asset.syncedAt >= recordTime`), the action's state is `scheduled` and nothing is
  computed — Concord will not snapshot from an index that could still be missing events
  (`snapshot`, `services/api/src/concord.ts`).
- After every sync pass, actions whose record time the index has now passed are reconciled
  automatically (`reconcileDue`, called from `syncAll` in `services/api/src/tenants.ts`), so a
  scheduled action advances without anyone pressing a button.
- The first reconciliation writes the snapshot — ledger number, time taken, and every holder's
  units — into the action row. Later re-runs reuse the stored snapshot verbatim: re-reconciling
  never shifts the entitlement basis, even after a re-index.

Holdings at the record time come from the same event replay the position reconciliation uses
(`replay`, `packages/core/src/holdings.ts`), cut off inclusively at the record time.

## The execution window

Flows are counted in a window that starts at the record time and ends at `windowTo`
(`FlowWindow`, `packages/core/src/distributions.ts`; applied in `reconcileAction`):

- the lower bound is **exclusive**: an event stamped exactly at the record time is part of the
  basis, not of the execution (`ev.closedAt <= afterTime` is skipped);
- the upper bound is **inclusive**: an event stamped exactly at `windowTo` still counts
  (`ev.closedAt > untilTime` is skipped);
- without `windowTo` the window is open-ended, and `MISSING`/`SHORT` breaks simply mean
  "not yet" until payments complete — set an end when the terms have a payment deadline.

## Paying agent versus mints

Which events count as the distribution depends on the action (`reconcileAction`,
`services/api/src/concord.ts`):

- **Dividend with a `payer`** (a paying agent distinct from the pay asset's issuer): only
  `transfer` events **sent by that payer** count. Other transfers between holders in the window
  are ignored rather than mistaken for dividend payments. The payer's own line is excluded from
  the reconciliation.
- **Dividend without a `payer`**, or where the payer is the pay asset's issuer: `mint` events
  count instead — on Stellar, a payment made by the asset's own issuer surfaces as a mint, not
  a transfer.
- **Split**: `mint` events add (forward split top-ups), `clawback` events subtract (reverse
  split collections).
- **Redemption**: `burn` and `clawback` events subtract; nothing adds.

## Rounding

- **Dividends** round per holder with the action's `rounding`: `floor` (the default) or
  `half-up` (`mulDiv`, `packages/core/src/amount.ts`). Floor never over-pays a holder;
  half-up matches terms written as "rounded to the nearest unit". The choice applies to the
  smallest unit of the **pay** asset (7 decimals for classic assets), and the entitlement is
  computed from the exact rational rate, so the only rounding is this final step.
- **Splits and redemptions** always floor: fractions of the smallest unit **drop**
  (`splitDeltas`, `redemptionDeltas`). In a 3-for-2 split, a holder of 5 units' worth
  `0.0000005` ends at `0.0000007`, not `0.0000008` — the expected delta is
  `floor(5 × 3 / 2) − 5 = 2` smallest units. Reconciliation expects exactly the floored
  figure; an issuer who tops fractions up will show `EXCESS` breaks of one smallest unit,
  which is the report telling the truth, not a bug.
- Holders whose rounded entitlement is zero are omitted, so they cannot produce `MISSING`
  breaks.

## Break outcomes

Each holder line compares `expected` (from the snapshot and terms) with `observed` (flows in
the window), by address (`reconcileDistribution`, `packages/core/src/distributions.ts`). The
core supports a tolerance, but the API reconciles exactly — any difference of even one smallest
unit breaks:

| Outcome | Meaning | Severity |
|---|---|---|
| `MISSING` | Entitled holder shows no flow in the execution window | high |
| `SHORT` | Holder received less than the entitlement | high |
| `EXCESS` | Holder received more than the entitlement | high |
| `UNEXPECTED` | Flow to a holder with no entitlement at the record date — or a flow in the wrong direction | medium |

A holder whose observed flow matches exactly is `ok`. The action's state is `clean` when no line breaks, `breaks`
otherwise, and `pending` before any result exists; breaks carry into the same
acknowledge/resolve notes flow as position breaks.

## Worked example

Asset with 7 decimals; record time `2026-06-30T00:00:00Z`; dividend of `0.25` per unit paid in
a stablecoin (also 7 decimals) by paying agent `G…PAY`; window to `2026-07-07T00:00:00Z`;
`rounding` left at `floor`.

1. At the first sync whose index passes June 30, the snapshot freezes: `G…A` holds `100`,
   `G…B` holds `0.0000003` (3 smallest units).
2. Entitlements: `G…A` expects `25.0`; `G…B` expects `floor(3 × 0.25) = 0` smallest units —
   omitted.
3. Transfers **from `G…PAY`** after June 30 (exclusive) through July 7 (inclusive) are summed
   per recipient.
4. If `G…A` received `25.0`, the line is `ok`; `24.9` is `SHORT`; nothing is `MISSING`; a
   payment to `G…C`, who held nothing at the record time, is `UNEXPECTED`.
