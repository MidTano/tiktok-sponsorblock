-- Segments submitted by any user of the shared base.
CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,          -- uuid v4
  tt_uid      TEXT NOT NULL,             -- TikTok user id of the submitter
  name        TEXT NOT NULL,             -- human label, max 80 chars
  duration_ms INTEGER NOT NULL,          -- ad length, 2 000 – 30 000 ms
  source_aid  TEXT,                      -- aid of the original video (optional)
  frames      INTEGER NOT NULL,
  hash_count  INTEGER NOT NULL,
  hashes      BLOB NOT NULL,             -- packed int32 LE
  times       BLOB NOT NULL,             -- packed int32 LE
  score       INTEGER NOT NULL DEFAULT 0,-- up - down
  votes_up    INTEGER NOT NULL DEFAULT 0,
  votes_down  INTEGER NOT NULL DEFAULT 0,
  confirmed   INTEGER NOT NULL DEFAULT 0,-- 1 when confirmed by another device
  hidden      INTEGER NOT NULL DEFAULT 0,-- auto-hidden when score bad
  created_at  INTEGER NOT NULL,          -- epoch seconds
  updated_at  INTEGER NOT NULL           -- epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_seg_updated ON segments(updated_at);
CREATE INDEX IF NOT EXISTS idx_seg_tt_uid  ON segments(tt_uid);

-- One vote per segment per TikTok account.
CREATE TABLE IF NOT EXISTS votes (
  segment_id  TEXT NOT NULL,
  tt_uid      TEXT NOT NULL,
  vote        INTEGER NOT NULL,          -- 1 up, -1 down
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (segment_id, tt_uid)
);

-- Daily delta snapshot cursor (the Worker stores the last export time here).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta(key, value) VALUES ('last_export', '0');
