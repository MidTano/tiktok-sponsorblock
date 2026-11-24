-- Skip counts wait here between a phone's report and the hourly merge into segments.
CREATE TABLE IF NOT EXISTS skip_inbox (
  segment_id  TEXT NOT NULL,
  n           INTEGER NOT NULL,
  ms          INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_segment ON skip_inbox(segment_id);

-- The snapshot is rebuilt at the next hourly run after a change made by the maintainer.
INSERT OR IGNORE INTO meta(key, value) VALUES ('snapshot_dirty', '1');
