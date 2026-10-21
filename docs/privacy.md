# Privacy and data handling

For operators and their customers. Concord is a single process that stores everything in
SQLite files under `CONCORD_DATA_DIR` (see [`data-directory.md`](./data-directory.md)). It
sends no email and collects no analytics. This page is the inventory of personal data it does
hold, where it lives, how long it stays, and how to remove it. File references are to the
current code.

## What is collected

Concord stores only what an operator or a user gives it. There is no telemetry, analytics or
tracking code anywhere in the repository (a search of `services/`, `apps/` and `packages/`
finds none). The only outbound network calls are to the configured Stellar RPC and Horizon
endpoints and, if enabled, to Google for sign-in.

### Account and workspace identity (`control.db`)

- `users`: email address (unique, case-insensitive), display name, `email_verified` (default
  `0`), `created_at`, `last_org_id` (`services/api/src/schema.ts`, `Auth.createUser` in
  `services/api/src/auth.ts`).
- `credentials`: for a password account, an scrypt hash (`scrypt$N$r$p$salt$hash`); for Google,
  the provider's stable subject id. Plaintext passwords are never stored
  (`Auth.setCredential`, `security.ts`).
- `orgs`: workspace name and creation time.
- `memberships`: who belongs to which workspace and their role (`owner` or `member`), with
  join time.
- `sessions`: a hash of the session token (`id_hash`), user and workspace, and
  `created_at` / `last_seen_at` / `expires_at`. The cookie token itself is not stored
  (`Auth.startSession`).
- `invites`: the invitee's email address, role, who created it (`created_by`), and
  `created_at` / `expires_at` / `accepted_at`. The link token is stored only as a hash
  (`Auth.createInvite`).
- `one_time_tokens`: hashed sign-up codes and password-reset tokens, with optional `note` text
  the operator supplied, expiry and use time (`Auth.createSignupCode`, `Auth.createResetToken`).

### Sign-off authorship (`orgs/<id>.db`)

- `break_notes.author` and `author_id` record whoever signed off a break, taken from their
  session and never from the request body (`Concord.setNote` in
  `services/api/src/concord.ts`, schema in `docs/schema.md`). The stored label is
  `name <email>`.
- `assets.created_by`, `registers.imported_by`, `runs.created_by` and `actions.created_by`
  store an actor label: `name <email>` for dashboard actions, `cli:<os username>` for the
  command line.

### Holder data (`orgs/<id>.db`)

- `register_positions`: `holder_id`, `holder_name` (optional), `account` (a Stellar address,
  or `NULL` when unmapped), `units` and `status` (`active`/`frozen`) — one row per holder
  line of every imported register (`Concord.importRegister`).
- `events.from_addr` / `to_addr`: Stellar addresses that moved the asset.
- `openings.address`: Stellar addresses with opening balances.
- `actions.snapshot`: a frozen JSON snapshot of every holder's balance at the record time,
  keyed by Stellar address (`docs/schema.md`).
- Reconciliation results stored in `runs.result` and `actions.result` repeat holder ids,
  addresses and unit counts for the compared positions.

### IP addresses

IP addresses are used only as the key for in-memory rate limiting
(`clientIp` in `services/api/src/auth-api.ts`, `RateLimiter` in
`services/api/src/security.ts`). They are never written to a database, a log or a file. The
limiter's windows live in process memory and are lost on restart. Where `trustProxyHops` is
greater than zero, the address is taken from `X-Forwarded-For`; otherwise it is the
connection's remote address.

### Google sign-in (optional)

When `CONCORD_GOOGLE_CLIENT_ID` and `CONCORD_GOOGLE_CLIENT_SECRET` are set, Google returns a
profile (subject id, email, name, verification flag). Concord stores the subject id in
`credentials.subject` and the email and name in `users` (`Auth.googleSignIn`,
`Auth.linkGoogle`). It does not store the Google access token beyond the single callback
request. Google's own handling of that sign-in is governed by Google's policies, not Concord's.

## Where it lives

- `control.db` at the data root: all account, workspace, membership, session, invitation and
  token data.
- `orgs/<16 hex>.db`: one file per workspace, holding that workspace's holder data, books,
  reconciliations, corporate actions and sign-offs. Workspaces are isolated: one file cannot
  reach another's data (`Tenants.forOrg` in `services/api/src/tenants.ts`).
- `-wal` and `-shm` files beside an open database may contain uncheckpointed changes
  (`docs/data-directory.md`).

Nothing else is written under the data directory: Concord does not keep uploaded CSV files,
only what it parsed from them.

## Retention

Nothing is deleted on a timer. Expiry is enforced at use:

- Sessions: 30 days absolute, and idle expiry after 7 days of no use
  (`SESSION_LIFE_MS`, `SESSION_IDLE_MS` in `services/api/src/auth.ts`). An expired session is
  removed when it is next read; idle-expired rows are removed then too.
- Invitations: 7 days (`INVITE_LIFE_MS`); expired or revoked links are refused and, for
  revocation, deleted.
- Password-reset tokens: 1 day (`RESET_LIFE_MS`).
- Sign-up codes: 14 days (`Auth.createSignupCode`).
- Expired or used tokens, accepted invitations and old sessions may remain as rows until the
  workspace is deleted. They contain hashed tokens, not recoverable secrets, and emails where
  an invitation was created.

Data that is not time-limited (accounts, holder rows, reconciliations, actions, sign-offs)
stays until a deletion path below is taken. Events and opening balances are kept indefinitely
while the asset is watched.

## Deletion paths

- Remove a member from a workspace: `Auth.removeMember` deletes the membership, signs them out
  of that workspace, and deletes the account entirely if it now belongs to no workspace
  (`dropStranded`), including its credentials and reset tokens. Their email can then be used to
  sign up again.
- Delete a workspace: `Auth.deleteOrg` removes the workspace row, cascades memberships,
  sessions and invitations, deletes stranded accounts, and `Tenants.drop` removes
  `orgs/<id>.db` with its `-wal` and `-shm` files. This is irreversible; back up first
  (`docs/operator-guide.md`).
- Unwatch an asset: deletes that asset and everything under it (events, openings, registers
  and their positions and runs, journal, instructions, actions, break notes) via cascade
  (`docs/schema.md`).
- Delete a register: deletes its positions and the runs made from it.
- Sign out: deletes the session row (`Auth.endSession`).
- Change password: deletes all other sessions of that account.
- A password reset marks its token used and deletes all sessions of the account.

There is no per-holder or per-email deletion short of removing the register, asset or workspace
that contains it.

## No analytics

Concord includes no analytics, telemetry, crash reporting or third-party tracking. It does not
phone home. The only network traffic is the operator-configured Stellar RPC/Horizon endpoints
and optional Google sign-in.

## Operator responsibilities

Concord gives operators the tools; the data is theirs to protect.

- **Access control.** Run the server as an unprivileged user and restrict the data directory
  (for example mode `0700`). Concord sets no file modes itself (`docs/data-directory.md`,
  Permissions).
- **Backups.** Use `pnpm concord backup DIR`, which uses SQLite's online backup and is safe
  while the server runs. Test a restore. Backups contain the same personal data as the live
  files.
- **Transport.** Put TLS in front and set `CONCORD_PUBLIC_URL` to the `https` address. Cookies
  are `Secure` and `SameSite=Strict` only under https (`sessions` in
  `services/api/src/auth-api.ts`).
- **Reverse proxy.** Set `trustProxyHops` correctly so rate limiting keys on the real client
  address; otherwise every request appears to come from the proxy.
- **Credentials.** Keep `CONCORD_GOOGLE_CLIENT_SECRET` and any RPC API-key headers out of
  version control and logs. Rotate them through the environment.
- **Invitation and reset links.** They are bearer tokens delivered out of band by the operator
  or workspace owners. Send them over a trusted channel; anyone who holds one can use it until
  it expires or is used (`docs/operator-guide.md`).
- **Retention and deletion requests.** Concord has no automatic expiry or anonymisation.
  Honour deletion requests by removing members, unwatching assets, deleting registers or
  deleting the workspace, and by deleting backups that contain the data.
- **Third parties.** Stellar RPC/Horizon providers and Google (if enabled) receive requests
  from the server. Choose providers you trust and review their terms; Concord cannot control
  what they log.
- **Accuracy.** Email addresses are not verified at sign-up and Concord sends no email
  (`docs/operator-guide.md`). Do not treat an account's email as proof of identity without
  your own checks.
- **Legal.** Concord ships no privacy policy, data-processing agreement or compliance
  certification. Operators are responsible for their own legal obligations towards their
  customers and holders.
