# Concord brief — DTCC readiness (reconciliation and corporate actions)

**Company:** Concord (stand-alone)

## Problem

When a transfer agent or custodian's security lives both on Stellar and in their official
register, someone has to prove the two agree. Dividends, splits, freezes and clawbacks also
have to show up on both sides. Today that is manual.

## Evidence

- DTCC's tokenization service plans to connect to Stellar in **H1 2027**. First assets: Russell
  1000 stocks, major index ETFs, US Treasuries (SEC relief Dec 2025; DTCC press release
  2026-05-27). It is multi-chain, not Stellar-only.
- CAP-67 (Final, Protocol 23) makes classic Stellar operations emit transfer, mint, burn,
  clawback and `set_authorized` events in the same format as Soroban. That makes indexing
  regulated assets practical.
- Existing products were checked (see [`docs/prior-art.md`](./docs/prior-art.md)): StellarExpert,
  Mercury/Zephyr, SDF Hubble, Vertalo and Securitize TA all provide data, indexing or their own
  transfer-agent stacks, not register-against-chain reconciliation.

## Product

- An indexer that reads CAP-67 events for regulated assets.
- A daily reconciliation against the transfer agent's register, with breaks flagged.
- A corporate-actions engine: record-date snapshots, dividend and split reconciliation.
- An audit export for regulators.

Read-only: it never touches money or keys.

## Why stand-alone

Different buyer (transfer agents, custodians), different skills (data, accounting), no custody,
a light regulatory load, SaaS revenue, and a different clock (DTCC 2027). It does not depend on
Ballast's thesis that RWAs will be used as collateral, so it hedges that bet.

## Kill criteria

- DTCC, Securitize or an existing Stellar indexer already ships reconciliation for Stellar.
- DTCC's Stellar launch slips past 2027 with no other issuer needing it.

See [`docs/prior-art.md`](./docs/prior-art.md) for the findings, dated sources, re-check cadence and
result log.
