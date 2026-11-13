-- Widen the energy batch limit without changing past totals or idempotency keys.
-- Apply as one D1 migration (transactional). The copy has no counting trigger;
-- only future inserts count toward energy. Legacy clients can still submit 1–50.
CREATE TABLE cheer_batches_v4 (
  device_hash TEXT NOT NULL,
  idem_key    TEXT NOT NULL,
  delta       INTEGER NOT NULL CHECK (delta BETWEEN 1 AND 10000),
  epoch       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (device_hash, idem_key)
);

INSERT INTO cheer_batches_v4 (device_hash, idem_key, delta, epoch, created_at)
SELECT device_hash, idem_key, delta, epoch, created_at FROM cheer_batches;

DROP TRIGGER cheer_batches_count;
DROP TABLE cheer_batches;
ALTER TABLE cheer_batches_v4 RENAME TO cheer_batches;

CREATE TRIGGER cheer_batches_count AFTER INSERT ON cheer_batches
BEGIN
  INSERT OR IGNORE INTO cheers (device_hash, total, epoch, updated_at) VALUES (NEW.device_hash, 0, 0, NEW.created_at);
  UPDATE cheers SET total = total + NEW.delta, updated_at = NEW.created_at WHERE device_hash = NEW.device_hash;
  UPDATE counters SET n = n + NEW.delta WHERE name = 'cheers';
END;
