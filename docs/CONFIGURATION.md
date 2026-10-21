# Configuration

Concord takes its settings from environment variables. This page lists every variable it reads,
what each one accepts and when a bad value is refused. All of it is taken from
[`services/api/src/config.ts`](../services/api/src/config.ts) and
[`services/api/src/cli.ts`](../services/api/src/cli.ts). For a file to copy and edit, see
[`.env.example`](../.env.example).

## When settings are read

- **Once, at start-up.** `loadConfig()` (`config.ts`) runs when the server starts (`pnpm start`,
  `pnpm dev`, `pnpm concord serve`, `node services/api/dist/main.js`), when any `pnpm concord`
  command starts, and when `pnpm demo:testnet` starts. A change takes effect only after a restart.
- **A `.env` file is optional.** `loadConfig()` reads `.env` from the repository root (`/app` in
  the container), if one exists. A variable already set in the environment beats the same
  variable in the file. Without the file, the process environment is all there is.
- **Bad values stop the process.** Each check in the table below throws at start-up, naming the
  variable. Concord never quietly falls back to a default for a value it cannot read.
- **`CONCORD_ORG` is the exception.** Only the command line reads it, after `loadConfig()`, so it
  can come from `.env` too.

## Every variable

"Rejected when" lists the conditions that stop start-up. A variable with no check accepts any
value.

| Variable | Default | Accepted values | Rejected when |
|---|---|---|---|
| `CONCORD_HOST` | `127.0.0.1` | An address to listen on, e.g. `0.0.0.0` for all interfaces | Not checked |
| `CONCORD_PORT` | `PORT`, then `4400` | A whole number, 1 or more | Not a whole number, or below 1 |
| `PORT` | `4400` | As `CONCORD_PORT`. Read only when `CONCORD_PORT` is unset or empty | As `CONCORD_PORT` |
| `CONCORD_PUBLIC_URL` | `RENDER_EXTERNAL_URL`, then `http://<host>:<port>` | An absolute URL. Only its origin is kept | Not a URL |
| `RENDER_EXTERNAL_URL` | Set by Render | As `CONCORD_PUBLIC_URL`. Read only when `CONCORD_PUBLIC_URL` is unset or empty | As `CONCORD_PUBLIC_URL` |
| `CONCORD_TRUST_PROXY` | `0` | A whole number of proxy hops, 0 or more | Not a whole number, or below 0 |
| `CONCORD_WEB_DIR` | `<repo>/apps/web/dist` | A directory holding the built dashboard | Not checked |
| `CONCORD_DATA_DIR` | `<repo>/data` | A directory on a local disk | Not checked |
| `CONCORD_EPHEMERAL` | Off | `1` or `true` turns it on. Anything else, `TRUE` and `yes` included, leaves it off | Never |
| `CONCORD_SIGNUP` | `open` | `open` or `code` | Anything else, including an empty value |
| `CONCORD_MAX_ASSETS` | `10` | A whole number, 1 or more | Not a whole number, or below 1 |
| `CONCORD_PASSWORD_COST` | `32768:8:3` | `N:r:p`: N a power of two from 16384 to 1048576, r from 8 to 32, p from 1 to 16 | N, r or p is missing or out of range |
| `CONCORD_GOOGLE_CLIENT_ID` | Unset (Google sign-in off) | An OAuth client id | Only one of the pair is set |
| `CONCORD_GOOGLE_CLIENT_SECRET` | Unset (Google sign-in off) | That client's secret | Only one of the pair is set |
| `CONCORD_DEFAULT_NETWORK` | `mainnet` | `mainnet` or `testnet` | Anything else, including an empty value |
| `CONCORD_MAINNET_RPC_URLS` | Three free public endpoints (below) | Comma-separated `http`/`https` URLs | Any entry is not an `http`/`https` URL |
| `CONCORD_TESTNET_RPC_URLS` | `https://soroban-testnet.stellar.org` | As above | As above |
| `CONCORD_MAINNET_HORIZON_URLS` | `https://horizon.stellar.org` | As above | As above |
| `CONCORD_TESTNET_HORIZON_URLS` | `https://horizon-testnet.stellar.org` | As above | As above |
| `CONCORD_RPC_HEADERS` | None | JSON: `{"<host>": {"<header>": "<value>"}}` | Not valid JSON |
| `CONCORD_SYNC_INTERVAL` | `30` | Seconds between indexer passes. `0` turns the indexer off | Not a whole number, or below 0 |
| `CONCORD_ORG` | None | A workspace id, or a workspace's exact name | When a command needs a workspace and the value matches none, or matches more than one by name |

Whole numbers are parsed with `Number()`, so `" 5 "` is read as `5` and `5.5` is refused
(`integer()` in `config.ts`).

### Empty values

An empty value (`NAME=`) does not always mean unset:

- **Treated as unset:** every whole-number variable, `CONCORD_PORT` (falls through to `PORT`),
  `CONCORD_PUBLIC_URL`, the four URL lists, `CONCORD_RPC_HEADERS`, `CONCORD_PASSWORD_COST`,
  `CONCORD_EPHEMERAL`, `CONCORD_ORG`, and the Google pair when both are empty.
- **Used as given:** `CONCORD_HOST`, `CONCORD_DATA_DIR`, `CONCORD_WEB_DIR`, `CONCORD_SIGNUP` and
  `CONCORD_DEFAULT_NETWORK` replace a missing value with the default, not an empty one. An empty
  `CONCORD_SIGNUP` or `CONCORD_DEFAULT_NETWORK` is refused. An empty `CONCORD_DATA_DIR` or
  `CONCORD_WEB_DIR` resolves to the working directory. Leave these out rather than setting
  them empty.

## Details

### Where it runs

- **`CONCORD_HOST`, `CONCORD_PORT`, `PORT`.** The address the server listens on (`main.ts`). The
  container image sets `CONCORD_HOST=0.0.0.0` (`Dockerfile`). Hosts such as Render pass the port
  as `PORT`. The image's health check and the dashboard's dev server (`apps/web/vite.config.ts`,
  used by `pnpm dev`) read the same two port variables.
- **`CONCORD_PUBLIC_URL`, `RENDER_EXTERNAL_URL`.** The address people open. Concord reduces it to
  its origin, so a path such as `/concord` is dropped and Concord cannot be served under a
  sub-path. When none is set and the host is `0.0.0.0`, the default uses `127.0.0.1` instead. The
  origin decides:
  - **Cookies and HSTS.** With `https://`, session cookies are marked `Secure` and named
    `__Host-…`, and the server sends `Strict-Transport-Security` (`auth-api.ts`, `main.ts`).
  - **The Google redirect URI:** `<origin>/api/auth/google/callback`.
  - **Links Concord hands out:** invitation links (`api.ts`) and `pnpm concord reset-link`
    (`cli.ts`).
  - **The same-origin check.** It protects requests that change something when the browser sends
    no `Sec-Fetch-Site` header (`api.ts`).

  When the origin is not `https://` and the host is anything other than `127.0.0.1` or
  `localhost`, the server prints a warning at start-up.
- **`CONCORD_WEB_DIR`.** The built dashboard, served for every path the API does not handle,
  with `index.html` for client-side routes. If the directory does not exist, those paths return a
  short message asking for `pnpm build` (`main.ts`).

### Data

- **`CONCORD_DATA_DIR`.** Holds `control.db` and one database per workspace under `orgs/`. It
  must be a local disk: SQLite's write-ahead log does not work over NFS. The container image sets
  it to `/data`.
- **`CONCORD_EPHEMERAL`.** Tells users their data does not survive a restart, and prints a
  start-up warning. It changes nothing about storage. `render.yaml` sets it, because Render's
  free plan has no persistent disk.
- **Relative paths.** A relative `CONCORD_DATA_DIR` or `CONCORD_WEB_DIR` is resolved against the
  process's working directory, not the repository root. `pnpm start`, `pnpm dev` and
  `pnpm concord` run in `services/api`, so `CONCORD_DATA_DIR=./data` there means
  `services/api/data`. Use absolute paths. The defaults are already absolute.

### Sign-up and accounts

- **`CONCORD_SIGNUP`.** With `open`, anyone may create a workspace. With `code`, sign-up needs a
  one-use code from `pnpm concord signup-code`.
- **`CONCORD_MAX_ASSETS`.** Caps the assets one workspace may watch. It is enforced when an asset
  is watched from the dashboard or API (`api.ts`). `pnpm concord watch` does not check it.
- **`CONCORD_PASSWORD_COST`.** Sets the scrypt work factors for new password hashes. The default
  is `DEFAULT_COST` in `security.ts`. Each stored hash keeps the factors it was made with, so
  existing passwords keep working after a change.
- **`CONCORD_GOOGLE_CLIENT_ID`, `CONCORD_GOOGLE_CLIENT_SECRET`.** Google sign-in is offered only
  when both are set. Register `<CONCORD_PUBLIC_URL>/api/auth/google/callback` as the OAuth
  client's redirect URI.

### Stellar

- **Both networks are always served.** `CONCORD_DEFAULT_NETWORK` only picks the one a new visitor
  sees first. It is also the network `pnpm concord watch` uses when `--network` is not given.
- **The URL lists.** Each list is split on commas and trimmed, and trailing slashes are removed.
  An empty list keeps the defaults. With no mainnet RPC set, Concord uses
  `https://mainnet.sorobanrpc.com`, `https://soroban-rpc.mainnet.stellar.gateway.fm` and
  `https://rpc.ankr.com/stellar_soroban`. These are free public endpoints that suit light use; SDF
  runs no public mainnet RPC.
- **Failing endpoints.** Endpoints are tried in order. One that fails or is rate limited is
  rested and the next one is used (`chain.ts`). A rest lasts 30 seconds, or what the endpoint's
  `Retry-After` asks for, between 1 and 60 seconds.
- **`CONCORD_RPC_HEADERS`.** Adds headers to every request sent to a host, for providers that
  take an API key by header. The key is the URL's host, including any port that is not the
  default. The headers apply to RPC and Horizon endpoints alike, on both networks. Only the
  outer JSON is checked; see the security notes.
- **`CONCORD_SYNC_INTERVAL`.** The seconds between background indexer passes. Only the server
  runs the indexer: it makes the first pass at start-up, and passes never overlap. `0` turns it
  off; `pnpm concord sync` still works.

### Command line

- **`CONCORD_ORG`.** The workspace `pnpm concord` commands act on when `--org` is not given.
  `--org` wins when both are set. The value is matched by id first, then by exact name. A name
  shared by two workspaces is refused, so use the id. Commands that do not touch a workspace
  (`orgs`, `signup-code`, `reset-link`, `org-delete`, `backup`, `serve`) ignore it.
- **`pnpm concord sync` without an asset** syncs only that workspace when `CONCORD_ORG` is set,
  and every workspace when it is not.

## Retired variables

These were read by earlier versions. Setting any of them to a non-empty value stops start-up
with the message below, so an old environment is never half applied (`RETIRED` in `config.ts`).

| Variable | Replacement |
|---|---|
| `CONCORD_NETWORK` | None. Both networks are always served; use `CONCORD_DEFAULT_NETWORK` to choose which one is shown first |
| `CONCORD_RPC_URL` | `CONCORD_MAINNET_RPC_URLS` or `CONCORD_TESTNET_RPC_URLS` |
| `CONCORD_HORIZON_URL` | `CONCORD_MAINNET_HORIZON_URLS` or `CONCORD_TESTNET_HORIZON_URLS` |
| `CONCORD_DB` | `CONCORD_DATA_DIR`. Each workspace has its own database under it |
| `CONCORD_API_TOKEN` | None. Users sign in; there is no shared token |

## Security notes

### `CONCORD_TRUST_PROXY`

Concord rate-limits sign-up, sign-in, invitation lookups and acceptance, password resets and
Google sign-in per client address (`auth-api.ts`). This variable decides where that address
comes from:

- **`0`, the default.** Concord uses the address of the connection itself and ignores
  `X-Forwarded-For`. This is right when nothing sits in front of Concord.
- **`N`, more than 0.** Each proxy appends the address it saw to `X-Forwarded-For`. Concord takes
  the entry `N` places from the end as the client. If the header has fewer than `N` entries, it
  falls back to the connection address.

Set it to exactly the number of proxies you run, and make sure clients can reach Concord only
through them:

- **Too high, or set with no proxy in front.** The entry Concord trusts is one the client wrote
  itself. A client can then claim a new address on every request to escape the limits, or name
  someone else's address to use up their allowance.
- **Too low.** Every client looks like your proxy and shares one allowance.

`render.yaml` sets `1` for Render's single proxy.

### `CONCORD_RPC_HEADERS`

This usually holds a provider's API key, so treat it as a secret:

- **Store it as a secret.** Set it in your host's secret store, not in a committed file.
  `.env` should stay out of version control.
- **Use `https://` endpoints.** Headers are matched by host alone, so an `http://` URL for the
  same host sends the key unencrypted.
- **Check the host key.** It must equal the endpoint URL's host exactly, port included when the
  port is not the default. A key that matches nothing is silently unused, and the endpoint is
  called without it.
- **Know what is checked.** Only the outer JSON is parsed at start-up; header names and values
  are not checked.
- **What errors show.** When endpoints fail, Concord's error names each one by host and a short
  reason, such as `HTTP 401` (`chain.ts`). Neither the headers nor the URL path appear in it.
