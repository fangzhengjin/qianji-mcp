/** 单实例部署使用的权威 SQLite Schema。 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  utoken TEXT NOT NULL,
  devid TEXT NOT NULL,
  login_identifier TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_json TEXT,
  user_refreshed_at_ms INTEGER,
  write_quota_date TEXT,
  write_quota_used INTEGER NOT NULL DEFAULT 0 CHECK (write_quota_used >= 0)
);

CREATE TABLE IF NOT EXISTS pats (
  id INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  remark TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS pats_single_admin_idx
  ON pats(role) WHERE role = 'admin';

CREATE TABLE IF NOT EXISTS sync_state (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  lasttimes_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_cache (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('books', 'assets', 'categories', 'tags', 'currencies')),
  scope TEXT NOT NULL,
  data_json TEXT NOT NULL,
  refreshed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind, scope)
);

CREATE TABLE IF NOT EXISTS bills (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  bookid INTEGER NOT NULL,
  time INTEGER NOT NULL,
  type INTEGER NOT NULL,
  money REAL NOT NULL,
  cateid INTEGER NOT NULL,
  assetid INTEGER NOT NULL,
  remark TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (account_id, id)
);

CREATE INDEX IF NOT EXISTS bills_query_idx
  ON bills(account_id, time DESC, id DESC);
`;
