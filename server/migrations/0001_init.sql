-- Save Jensen: support records and moderated messages.
-- No names, emails or raw IPs are stored. device_hash is SHA-256 of a random cookie token.

CREATE TABLE IF NOT EXISTS supports (
  device_hash  TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  withdrawn_at INTEGER
);
CREATE INDEX IF NOT EXISTS supports_active ON supports (withdrawn_at);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  device_hash    TEXT NOT NULL,
  nickname       TEXT NOT NULL,
  content        TEXT NOT NULL,
  lang           TEXT NOT NULL DEFAULT 'zh' CHECK (lang IN ('zh', 'en')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden', 'withdrawn')),
  consent_public INTEGER NOT NULL CHECK (consent_public = 1),
  idem_key       TEXT,
  created_at     INTEGER NOT NULL,
  reviewed_at    INTEGER,
  withdrawn_at   INTEGER
);
CREATE INDEX IF NOT EXISTS messages_wall ON messages (status, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS messages_queue ON messages (status, created_at DESC);
-- A retried submit with the same key returns the first row instead of creating another.
CREATE UNIQUE INDEX IF NOT EXISTS messages_idem ON messages (device_hash, idem_key) WHERE idem_key IS NOT NULL;
-- At most one pending/approved message per device.
CREATE UNIQUE INDEX IF NOT EXISTS messages_one_active ON messages (device_hash) WHERE status IN ('pending', 'approved');

-- Short-lived counters keyed by a salted, daily-rotating IP hash. Rows are purged after expiry.
CREATE TABLE IF NOT EXISTS rate_limits (
  k          TEXT NOT NULL,
  bucket     INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (k, bucket)
);
CREATE INDEX IF NOT EXISTS rate_limits_exp ON rate_limits (expires_at);
