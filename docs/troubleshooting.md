# Troubleshooting Guide: Sync and Indexing Messages

This guide explains every user- and operator-facing error message emitted during asset indexing, ledger synchronization, and RPC interactions in Concord. Each section details the root cause, exact trigger in the codebase, what to look for in server logs, and actionable resolution steps.

---

## 1. RPC Pool Exhaustion and Backoff

### Error Message
```text
<label> is not answering; trying again in <N>s
```
*(Example: `Stellar RPC is not answering; trying again in 24s`)*

- **Code Location:** `services/api/src/chain.ts#L210-L215` (`EndpointPool.run`)
- **Cause:** Concord maintains a pool of RPC endpoints for each network. When an endpoint encounters consecutive request failures or timeouts, it is temporarily rested for 30 seconds (`REST_MS`). If all configured endpoints in the pool are currently in a resting backoff state, Concord rejects immediate calls and states how many seconds remain before the earliest endpoint wakes up.
- **What to look for in logs:**
  - Previous error lines showing why individual endpoints failed, such as `sync <org>/<asset>: Stellar RPC is unavailable (mainnet.sorobanrpc.com: fetch failed)`.
- **Resolution:**
  1. Verify external internet connectivity from the Concord host container or server.
  2. Confirm whether the upstream RPC provider is experiencing an outage.
  3. Add multiple independent fallback endpoints in `CONCORD_MAINNET_RPC_URLS` or `CONCORD_TESTNET_RPC_URLS` (comma-separated list).

---

## 2. All Endpoints Unavailable or Rate-Limited

### Error Message
```text
<label> is unavailable (<host>: <reason>; ...)
```
*(Example: `Stellar RPC is unavailable (rpc1.example.com: 429 Too Many Requests; rpc2.example.com: connection timeout)`)*

- **Code Location:** `services/api/src/chain.ts#L237-L241` (`EndpointPool.run`)
- **Cause:** Every awake endpoint in the pool was attempted within the 90-second execution budget (`BUDGET_MS`), but each endpoint threw an `EndpointFailure` (such as HTTP 429, HTTP 5xx, or network socket timeout).
- **What to look for in logs:**
  - `sync <org>/<asset>: Stellar RPC is unavailable (...)`
- **Resolution:**
  1. If the message specifies `429 Too Many Requests`, your RPC provider's rate limits have been exceeded. Increase your rate limit tier with your provider or configure dedicated private RPC nodes.
  2. If the message specifies connection timeouts or socket resets, check proxy firewalls, DNS resolution, and TLS interceptors.

---

## 3. Indexer Paused Beyond Retention Window

### Error Message
```text
Indexing was paused for longer than the network keeps events, so movements in between are missing. Rebuild this asset to start again from fresh opening balances.
```

- **Code Location:** `services/api/src/concord.ts#L525-L529` (`Concord.runSync`)
- **Cause:** Standard Stellar RPC nodes retain approximately 7 days of historical contract and CAP-67 ledger events. When Concord resumes indexing an asset, it compares the asset's last indexed cursor ledger (`at`) against the oldest ledger currently retained by the RPC node (`head.oldest`). If `at + 1 < head.oldest`, an unrecoverable gap exists in the event stream. Concord halts indexing on this asset to prevent incorrect ledger accounting.
- **What to look for in logs:**
  - `sync <org>/<asset>: Indexing was paused for longer than the network keeps events...`
  - In the database: `SELECT cursor, synced_ledger, sync_error FROM assets WHERE id = ?`.
- **Resolution:**
  - Trigger a rebuild of the asset history. In the web dashboard, open the asset settings and select **Rebuild history**, or run the CLI command:
    ```sh
    pnpm concord rebuild <ASSET_CODE>
    ```
  - Rebuilding pulls fresh opening balances from Horizon while preserving your uploaded registers, journals, and sign-offs.

---

## 4. Network Reset Detected

### Error Message
```text
The <network> ledger is now behind this asset's history: the network was reset. Stop watching it.
```
*(Example: `The testnet ledger is now behind this asset's history: the network was reset. Stop watching it.`)*

- **Code Location:** `services/api/src/concord.ts#L530-L533` (`Concord.runSync`)
- **Cause:** The ledger sequence number returned by the network tip is more than 1,000 ledgers behind the asset's recorded cursor (`at > head.latest + 1000`). This occurs on Stellar Testnet or local standalone development networks when the network is periodically reset back to ledger 1.
- **What to look for in logs:**
  - `sync <org>/<asset>: The testnet ledger is now behind this asset's history...`
- **Resolution:**
  - Unwatch and delete the asset from the workspace, as its prior ledger history belongs to a discarded network incarnation:
    ```sh
    pnpm concord unwatch <ASSET_CODE>
    ```
  - Once removed, watch the new asset instance on the fresh network.

---

## 5. Undeclared Contract Decimals

### Error Message
```text
this token does not state its decimals; give them when watching it
```

- **Code Location:** `services/api/src/concord.ts#L351-L354` (`Concord.watchAsset`)
- **Cause:** Classic Stellar assets carry 7 decimals by protocol specification. However, Soroban SEP-41 contract tokens can have any precision between 0 and 18 decimals. If a contract token does not export a `decimals()` view method or metadata entry on-chain, Concord cannot guess the precision.
- **What to look for in logs:**
  - HTTP 400 Bad Request returned from `POST /api/assets`.
- **Resolution:**
  - Specify the decimals explicitly when adding the token. Via CLI:
    ```sh
    pnpm concord watch <CONTRACT_ID> --decimals <D>
    ```
  - Via the web dashboard: Enter the decimal precision (0 to 18) in the Decimals input field that appears when watching a contract token.

---

## 6. Requested Starting Ledger Older Than RPC Retention

### Error Message
```text
ledger <N> is older than the RPC retains (oldest <oldest>); use a baseline
```
*(Example: `ledger 50000000 is older than the RPC retains (oldest 54800000); use a baseline`)*

- **Code Location:** `services/api/src/concord.ts#L416-L420` (`Concord.prepare`)
- **Cause:** When watching an asset with a manual starting ledger (`--from <LEDGER>`), the requested ledger sequence is older than the retention boundary (`oldest`) of the connected RPC node.
- **What to look for in logs:**
  - CLI command failure or API error response: `Invalid: ledger ... is older than the RPC retains...`.
- **Resolution:**
  1. For classic assets, omit `--from` to allow Concord to take an automated Horizon balance snapshot (`baseline` mode).
  2. For contract tokens, specify a starting ledger within the RPC node's retention window (`latest - 100000`), or configure an archive RPC endpoint that maintains full ledger history.

---

## 7. Unexpected Indexing Errors

### Error Message
```text
Indexing stopped on an unexpected error.
```

- **Code Location:** `services/api/src/concord.ts#L193-L197` (`describeFailure`)
- **Cause:** A runtime exception occurred during `runSync` that was not an expected network or domain error (such as `ChainError`, `Invalid`, or `NotFound`). Common root causes include SQLite database locking, disk write errors, or invalid JSON payloads.
- **What to look for in logs:**
  - Concord redacts internal system details in the user-facing asset status, but prints the complete error stack trace to server `stderr`:
    ```text
    [Error: SQLITE_BUSY: database is locked]
    ```
    or
    ```text
    sync pass failed TypeError: ...
    ```
- **Resolution:**
  1. Inspect the server stdout/stderr stream at the time of failure.
  2. Ensure the `/data` volume has sufficient disk space and correct read/write filesystem permissions.
  3. Ensure no competing external process has opened the workspace SQLite database in exclusive write mode.
