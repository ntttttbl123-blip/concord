# Monitoring and Logging Guide

This guide describes operational monitoring, log formats, healthcheck semantics, and alerting strategies for Concord.

## Standard Output and Log Formats

Concord logs directly to standard output and standard error using Node's `console` functions (`services/api/src/main.ts`).

### Startup and Configuration

At startup, Concord reports its public URL, listening host and port, and storage path:

```text
concord · https://concord.example.com · listening on 0.0.0.0:4400
data /data
```

Configuration warnings are emitted when running under insecure or non-persistent configurations:
- `CONCORD_PUBLIC_URL is not https: sessions travel in the clear. Put TLS in front before anyone signs in.`
- `CONCORD_EPHEMERAL is set: users are told their data does not survive a restart.`

### Background Indexer Logs

When background syncing is active (`config.syncIntervalSec > 0`, configured via `CONCORD_SYNC_INTERVAL` and defaulting to 30 seconds in `services/api/src/config.ts`), the runner periodically executes `runtime.tenants.syncAll()`.

- **Event Progress:** When new events are ingested from the ledger, Concord logs the workspace and asset prefix followed by the event count:
  ```text
  sync <orgId>/<assetIdPrefix>: +12 events
  ```
  *(Reference: `services/api/src/main.ts#L143`)*
- **Asset Sync Errors:** If an RPC request or indexer pass fails for a specific asset:
  ```text
  sync <orgId>/<assetIdPrefix>: <error message>
  ```
  *(Reference: `services/api/src/main.ts#L142`)*
- **Global Sync Loop Failures:** If an unexpected unhandled exception occurs across the sync worker:
  ```text
  sync pass failed <error stack>
  ```
  *(Reference: `services/api/src/main.ts#L147`)*

### Process Termination

When receiving termination signals (`SIGINT`, `SIGTERM`), Concord captures the signal and performs a graceful shutdown:

```text
SIGTERM: shutting down
```

Concord closes the HTTP server, unrefs timers, closes open SQLite database handles via `runtime.close()`, and enforces an exit timeout so hanging requests do not block process termination (`services/api/src/main.ts#L158-L170`).

## Health Check: `/api/health`

Concord exposes a lightweight HTTP GET endpoint at `/api/health` (`services/api/src/api.ts#L81-L84`):

```sh
curl -f http://127.0.0.1:4400/api/health
```

### What `/api/health` Proves
- The HTTP server process is running, responsive, and accepting incoming connections.
- The control database connection (`data/control.db`) is readable (it executes `auth.orgIds()`).

### What `/api/health` Does NOT Prove
- It does **not** verify connectivity or response health for external Stellar Horizon or Soroban RPC endpoints.
- It does **not** check whether individual tenant SQLite databases under `data/orgs/*.db` are accessible, healthy, or writable.
- It does **not** guarantee that the background event indexer is actively progressing or caught up with the ledger.

Use `/api/health` for process-level container healthchecks, load balancer keepalives, and systemd readiness probes.

## Detecting and Alerting on a Stalled Indexer

To monitor indexing health across watched assets, operators should monitor asset metadata stored in each organization's SQLite workspace database (`data/orgs/<orgId>.db`).

Each asset record in the `assets` table tracks indexing progress (`services/api/src/concord.ts`):

- **`synced_at` / `syncedAt`:** An ISO 8601 timestamp (`latestLedgerClosedAt`) representing the closed time of the most recent ledger ingested.
- **`synced_ledger`:** The ledger sequence number reached by the indexer.
- **`sync_error` / `syncError`:** A human-readable description of the last error encountered during `runSync`. When a subsequent sync succeeds, Concord clears this field to `NULL` (`services/api/src/concord.ts#L535-L537`).
- **`sync_error_at` / `syncErrorAt`:** The timestamp when the current error occurred.

### Recommended Alerting Rules

1. **Persistent Sync Error Alert:**
   - **Condition:** `sync_error IS NOT NULL` continuously for more than 5 minutes (or across 3 consecutive polling intervals).
   - **Severity:** Warning / Page.
   - **Action:** Inspect the error message (e.g., RPC node timeout, rate limits, or network reset).
2. **Indexer Lag Alert:**
   - **Condition:** `strftime('%s', 'now') - strftime('%s', synced_at) > 1800` (synced timestamp is more than 30 minutes behind real time on a live network).
   - **Severity:** High.
   - **Action:** Verify upstream RPC provider responsiveness and check Concord container logs for connection reset errors.
3. **Process Crash Loop:**
   - **Condition:** Container restarts > 2 within 10 minutes.
   - **Action:** Check disk space on `/data` volume and verify file permissions.

## Suggested Log Shipping and Aggregation

Because Concord outputs unstructured and semi-structured text to stdout/stderr:

- **Docker / Compose:** Use standard logging drivers (`json-file`, `fluentd`, `awslogs`, or `loki`).
  ```yaml
  logging:
    driver: "json-file"
    options:
      max-size: "10m"
      max-file: "5"
  ```
- **Log Parsing:** Match log lines against `^sync (?<org>[^/]+)/(?<asset>[^:]+): \+(?<events>\d+) events` to extract ingestion metrics into Grafana, Datadog, or CloudWatch.
- **Alert on Unhandled Exceptions:** Route any log matching `sync pass failed` or `Error: ` directly to operational channels.
