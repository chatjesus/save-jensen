-- Opt-in only. Device credential hashes are never public identifiers.
CREATE TABLE leaderboard_profiles (
  device_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  public_enabled INTEGER NOT NULL DEFAULT 0 CHECK(public_enabled IN (0,1)),
  admin_hidden INTEGER NOT NULL DEFAULT 0 CHECK(admin_hidden IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Retain an opt-out tombstone/version so an old in-flight join cannot publish it again.
CREATE INDEX cheer_batches_day ON cheer_batches(device_hash, epoch, created_at);
