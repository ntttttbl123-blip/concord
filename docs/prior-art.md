# Prior-art check

The brief's first kill criterion is that someone already ships reconciliation for Stellar. This
document holds the check that tests it: the findings, a dated source for each, who re-checks and when,
and a log of each result. It replaces the summary that used to sit in the README and is the record
maintainers and evaluators should read.

## Kill criteria

From [`BRIEF.md`](../BRIEF.md):

- DTCC, Securitize or an existing Stellar indexer already ships reconciliation for Stellar.
- DTCC's Stellar launch slips past 2027 with no other issuer needing it.

The first criterion turns on whether a vendor sells register-against-chain comparison or
corporate-action reconciliation for Stellar, as opposed to data, indexing or a transfer-agent stack of
their own. The second turns on the DTCC timeline and on whether other issuers need the same work.

## Findings

Every claim below carries the source it comes from and the date that source was read or published. A
source marked "(read)" is a live product page with no publication date, so the date it was read is
given instead.

| Subject | What was found | Source | Date |
|---|---|---|---|
| StellarExpert | Block explorer and analytics for Stellar assets, accounts, transactions and contracts. No reconciliation product. | [stellar.expert](https://stellar.expert/) | read 2026-10-06 |
| Mercury / Zephyr | Indexing and cloud execution for Stellar and Soroban data. Builds custom indexers and APIs, not reconciliation. | [mercurydata.app](https://www.mercurydata.app/), [Zephyr VM](https://www.mercurydata.app/products/zephyr-vm) | read 2026-10-06 |
| SDF Hubble | Read-only BigQuery data warehouse for Stellar history. Analytics, not real-time, no reconciliation. | [Hubble docs](https://developers.stellar.org/docs/data/analytics/hubble) | read 2026-10-06 |
| Securitize | SEC-registered transfer agent with a tokenization platform; reconciles inside its own transfer-agent stack. No Stellar register-against-chain product found. | [Securitize](https://securitize.io/), [NYSE MOU release](https://investors.securitize.io/news/news-details/2026/New-York-Stock-Exchange-and-Securitize-Agree-to-Memorandum-of-Understanding-to-Support-Tokenized-Securities/default.aspx) | release 2026-03-24 |
| Vertalo | SEC-registered digital transfer agent and cap-table platform that keeps its own register. No Stellar reconciliation product. | [Vertalo transfer agent services](https://beta.vertalo.com/solutions/transfer-agent-services) | read 2026-10-06 |
| Allium | Closest match: a `stellar.rwa.transfers` table and broader RWA transfer data aimed at the market. Transfers only, with no balances, control events, register comparison or corporate actions. | [Allium Stellar RWA transfers](https://docs.allium.so/historical-data/supported-blockchains/other-ecosystems/stellar/rwa/transfers) | read 2026-10-06 |
| Franklin Templeton (in-house) | Its registered transfer agent (FTIS) maintains the official record and reconciles BENJI daily with in-house tooling. Confirms the workflow exists, and that it is not sold as a product. | [FTIS no-action letter](https://www.sec.gov/rules-regulations/no-action-interpretive-exemptive-letters/division-investment-management-staff-no-action-interpretive-letters/franklin-templeton-081226), [BENJI](https://digitalassets.franklintempleton.com/benji/) | letter 2026-08-12 |
| DTCC tokenization service | Plans to connect to Stellar in the first half of 2027 and says the integration will support the asset lifecycle, including corporate actions and reporting. DTC-tokenized assets are expected on Stellar in 1H27. | [DTCC press release](https://www.dtcc.com/press-releases/2026/tokenization-service-to-connect-with-stellar-public-blockchain-as-dtc-advances-multi-chain-strategy), [DTCC progress release](https://www.dtcc.com/press-releases/2026/dtcc-advances-development-of-new-tokenization-service) | 2026-05-27, 2026-05-04 |

Supporting context used by the brief:

| Subject | Claim | Source | Date |
|---|---|---|---|
| CAP-67 | Unified asset events for Classic in the same format as Soroban, from Protocol 23. | [CAP-67](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0067.md) | created 2025-01-13 |
| Stellar RWA size | About $4B of tokenized real-world assets on Stellar in 2026, up about 360 percent over 2025. | [SDF Dune dashboard](https://dune.com/stellar/rwas), [CoinTelegraph](https://cointelegraph.com/markets/stellar-tokenized-rwa-market-nears-4b-after-fourfold-2026-growth) | 2026-08-29 |

### Result

As of the last re-check (2026-10-17), neither kill criterion is triggered. No vendor was found selling
register-against-chain or corporate-action reconciliation for Stellar. DTCC's Stellar connection is
planned for 1H27 and its milestone for participant-facing reconciliation is not yet met.

## Who re-checks and when

- **Owner:** the Concord maintainer on duty. The check is repeated **quarterly**, with the next one due
  **2027-01-17**, and is run again sooner if DTCC moves its Stellar date, if any of Securitize,
  StellarExpert, Mercury or Allium launches a reconciliation product, or if a new Stellar RWA
  reconciliation vendor appears.
- **Method:** search for reconciliation products aimed at Stellar transfer agents, custodians and fund
  administrators, and read each candidate vendor's own product pages and any dated press or filings.
  Record every new claim with its source and date, and update the findings table rather than deleting
  the old rows.

## Result log

| Date | By | Result | Notes |
|---|---|---|---|
| 2026-10-06 | Concord maintainer | Not triggered | First pass, moved here from the README. Web search, several sources read only as summaries. |
| 2026-10-17 | Concord maintainer | Not triggered | Sources checked and dated for this move. Allium remains the closest, and covers transfers only. DTCC still 1H27. |
