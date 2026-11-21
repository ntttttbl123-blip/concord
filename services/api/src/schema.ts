/**
 * Schema as ordered migrations. A database's `user_version` is the number of entries applied.
 *
 * Writing a migration checklist (see CONTRIBUTING.md & docs/contributing/migrations.md):
 *  1. Append only: add to the end of ORG_MIGRATIONS or CONTROL_MIGRATIONS; never edit or
 *     reorder a shipped entry (guarded by services/api/test/migrations.test.ts).
 *  2. Additive first: prefer nullable/DEFAULT ADD COLUMN, new tables, and new indexes.
 *  3. Table rebuilds: Db.migrate runs with PRAGMA foreign_keys = OFF so DROP TABLE does not
 *     cascade-delete child rows, and runs PRAGMA foreign_key_check before committing; recreate
 *     any dropped indexes or triggers.
 *  4. No explicit COMMIT or ROLLBACK: Db.migrate already wraps each entry in BEGIN / COMMIT
 *     (a COMMIT inside SQL ends the transaction early and masks errors).
 *  5. Fixtures & docs: add an upgrade test from the prior version, run
 *     services/api/test/fixtures/make-db-fixtures.ts so migrations.test.ts passes with the new
 *     fixture in services/api/test/fixtures/db/, and update docs/schema.md & CHANGELOG.md.
 */

/** One workspace: the assets an organisation watches and the books it has uploaded. */
export const ORG_MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  code TEXT NOT NULL,
  issuer TEXT,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  -- How history begins: Horizon trustlines, a ledger the caller named, or the RPC's oldest ledger.
  start_mode TEXT NOT NULL CHECK (start_mode IN ('baseline', 'ledger', 'window')),
  state TEXT NOT NULL DEFAULT 'indexing' CHECK (state IN ('indexing', 'ready')),
  start_ledger INTEGER,
  baseline_ledger INTEGER,
  history_from TEXT,
  cursor TEXT,
  synced_ledger INTEGER,
  synced_at TEXT,
  sync_error TEXT,
  sync_error_at TEXT,
  ignore_addresses TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ledger INTEGER NOT NULL,
  closed_at TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  from_addr TEXT,
  to_addr TEXT,
  amount TEXT NOT NULL,
  authorized INTEGER,
  PRIMARY KEY (asset_id, id)
);
CREATE TABLE openings (
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  amount TEXT NOT NULL,
  authorized INTEGER,
  as_of_ledger INTEGER NOT NULL,
  PRIMARY KEY (asset_id, address)
);
CREATE TABLE registers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  issues TEXT NOT NULL,
  imported_by TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX registers_asset ON registers (asset_id, as_of);
CREATE TABLE register_positions (
  register_id INTEGER NOT NULL REFERENCES registers (id) ON DELETE CASCADE,
  holder_id TEXT NOT NULL,
  holder_name TEXT,
  account TEXT,
  units TEXT NOT NULL,
  status TEXT
);
CREATE INDEX register_positions_register ON register_positions (register_id);
CREATE TABLE journal (
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  from_addr TEXT,
  to_addr TEXT,
  units TEXT NOT NULL,
  tx_hash TEXT,
  PRIMARY KEY (asset_id, ref)
);
CREATE TABLE instructions (
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  type TEXT NOT NULL,
  account TEXT NOT NULL,
  units TEXT,
  issued_at TEXT NOT NULL,
  approved_by TEXT,
  reason TEXT,
  PRIMARY KEY (asset_id, ref)
);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  register_id INTEGER NOT NULL REFERENCES registers (id) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE INDEX runs_asset ON runs (asset_id, id);
CREATE INDEX runs_register ON runs (register_id);
CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  record_time TEXT NOT NULL,
  params TEXT NOT NULL,
  snapshot TEXT,
  result TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  reconciled_at TEXT
);
CREATE INDEX actions_asset ON actions (asset_id, record_time);
CREATE TABLE break_notes (
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  author TEXT,
  author_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, scope, key)
);
`,
  // v2: every sign-off change is kept. break_notes stays the current state; this is the trail.
  `
CREATE TABLE break_note_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  author TEXT,
  author_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX break_note_history_key ON break_note_history (asset_id, scope, key, id);
INSERT INTO break_note_history (asset_id, scope, key, fingerprint, status, note, author, author_id, at)
  SELECT asset_id, scope, key, fingerprint, status, note, author, author_id, updated_at FROM break_notes;
`,
];

/** Identity: who may sign in, and which workspace each session is bound to. */
export const CONTROL_MIGRATIONS: readonly string[] = [
  `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  last_org_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE credentials (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'password' or 'google'
  kind TEXT NOT NULL,
  -- The provider's stable id for the user; NULL for a password.
  subject TEXT,
  -- scrypt$N$r$p$salt$hash for a password; NULL otherwise.
  secret TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);
CREATE UNIQUE INDEX credentials_subject ON credentials (kind, subject) WHERE subject IS NOT NULL;
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);
-- The composite key means a session can only ever point at a workspace its user belongs to,
-- and dies with the membership.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
CREATE INDEX invites_org ON invites (org_id);
CREATE TABLE one_time_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'reset')),
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  note TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`,
];
