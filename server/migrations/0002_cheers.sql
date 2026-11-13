-- Repeatable cheers and share-button clicks. These count taps, not people.
-- Accepting a batch is ONE insert; triggers update the per-device and site-wide totals in the same
-- implicit transaction, so a batch is either fully counted or not recorded at all.

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  n    INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO counters (name, n) VALUES ('cheers', 0);
INSERT OR IGNORE INTO counters (name, n) VALUES ('shares', 0);

-- One row per device. epoch is bumped on every withdraw (also when there was nothing to withdraw),
-- and a batch is only accepted if it was created under the device's current epoch.
CREATE TABLE IF NOT EXISTS cheers (
  device_hash TEXT PRIMARY KEY,
  total       INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  epoch       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- One row per accepted batch; (device, key) makes retries no-ops. Rows are kept (never pruned), so an
-- old key can never be replayed into a new count.
CREATE TABLE IF NOT EXISTS cheer_batches (
  device_hash TEXT NOT NULL,
  idem_key    TEXT NOT NULL,
  delta       INTEGER NOT NULL CHECK (delta BETWEEN 1 AND 50),
  epoch       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (device_hash, idem_key)
);

CREATE TRIGGER IF NOT EXISTS cheer_batches_count AFTER INSERT ON cheer_batches
BEGIN
  INSERT OR IGNORE INTO cheers (device_hash, total, epoch, updated_at) VALUES (NEW.device_hash, 0, 0, NEW.created_at);
  UPDATE cheers SET total = total + NEW.delta, updated_at = NEW.created_at WHERE device_hash = NEW.device_hash;
  UPDATE counters SET n = n + NEW.delta WHERE name = 'cheers';
END;

CREATE TABLE IF NOT EXISTS share_batches (
  device_hash TEXT NOT NULL,
  idem_key    TEXT NOT NULL,
  delta       INTEGER NOT NULL CHECK (delta BETWEEN 1 AND 50),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (device_hash, idem_key)
);

CREATE TRIGGER IF NOT EXISTS share_batches_count AFTER INSERT ON share_batches
BEGIN
  UPDATE counters SET n = n + NEW.delta WHERE name = 'shares';
END;
