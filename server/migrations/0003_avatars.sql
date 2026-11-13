-- Optional avatar for a message. Small, re-encoded in the browser, validated on the server.
-- It is public only while its message is 'approved'; the row is deleted when the author withdraws.
CREATE TABLE IF NOT EXISTS message_avatars (
  message_id TEXT PRIMARY KEY,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  bytes      BLOB NOT NULL CHECK (length(bytes) BETWEEN 100 AND 24576),
  width      INTEGER NOT NULL CHECK (width BETWEEN 16 AND 128),
  height     INTEGER NOT NULL CHECK (height BETWEEN 16 AND 128),
  created_at INTEGER NOT NULL
);
