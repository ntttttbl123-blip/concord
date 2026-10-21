# Roadmap

Where Concord is going, in now/next/later buckets. The buckets are derived from the limits the
README states today (README, **Limits**) and from the product brief ([`BRIEF.md`](../BRIEF.md));
each item names its source. This is a statement of intent, not a commitment with dates — except
the one external date that shapes everything: **DTCC's tokenization service plans to connect to
Stellar in H1 2027** (first assets: Russell 1000 stocks, major index ETFs, US Treasuries;
DTCC press release, 2026-05-27 — see `BRIEF.md`, "Evidence"). Concord's goal is to be the
reconciliation layer issuers and transfer agents can already trust by then.

## Now — shipped and being hardened

What runs end to end today (README, **Status**): the indexer, reconciler, corporate-actions
engine, controls log and audit export, behind sign-in with a private workspace per
organisation, exercised against mainnet (BENJI) and testnet. Work in this bucket is hardening,
documentation and feedback from first users, not new surface.

## Next — removing stated limits

In rough order of pain, each tracing to a line in the README's **Limits** section:

1. **Balances held by pools, claimable balances and contracts.** Horizon's trustline listing
   omits them, so a classic asset's opening balances understate supply by whatever they hold.
   Next step: read those holders at baseline time so the supply figure is complete, and show
   where the remainder sits.
2. **Load testing.** One process, one SQLite file per workspace, holdings replayed in memory;
   proven comfortable at a thousand holders and seven thousand events, untested beyond. Next
   step: measure against register sizes in the tens of thousands (the shape a Russell-1000
   transfer agent would bring) and publish the numbers, before changing any architecture.
3. **Email.** None is sent today: invitations travel by link, resets go through the operator.
   That is fine for pilot teams and wrong for larger ones. Next step: optional outbound mail
   for invitations and resets, off by default, keeping the no-email path intact (it is also a
   security property — see `SECURITY.md`, "Things operators should know").

## Later

- **DTCC-shaped assets at DTCC scale** (BRIEF.md): corporate-actions and reporting coverage
  evaluated against what the H1 2027 connection actually ships, not guessed at today.
- **Cash in lieu on splits.** Fractions of the smallest unit are dropped today (README,
  **Limits**, "Splits"); modelling cash-in-lieu needs terms input and a second pay-asset flow,
  so it waits for a user who settles fractions that way.
- **History beyond RPC retention.** Today a gap longer than ~7 days means **Rebuild history**
  from fresh opening balances. A paid archive source could close that, if users need it.

## What will not be built

- **Custody, keys, or moving money.** Concord is read-only by design (README: "Concord never
  holds keys or moves money"; BRIEF.md, "Why stand-alone": no custody). Anything that would
  require holding a key is out, permanently — it is the property that keeps Concord's
  regulatory load light and its security model honest.

## How this document changes

A change that removes a limit updates the README's **Limits** section
(`docs/ARCHITECTURE.md`, "Deliberate limits") and should move or delete the matching bullet
here in the same pull request. The kill criteria for the product as a whole stay in
`BRIEF.md`.
