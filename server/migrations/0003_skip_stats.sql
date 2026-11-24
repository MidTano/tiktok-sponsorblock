-- How often phones skipped each segment and the watching time that saved, reported once a
-- day by each phone. Skips of one's own segments are not counted.
ALTER TABLE segments ADD COLUMN skips INTEGER NOT NULL DEFAULT 0;
ALTER TABLE segments ADD COLUMN saved_ms INTEGER NOT NULL DEFAULT 0;

-- One report a day per account and per address.
CREATE TABLE IF NOT EXISTS skip_reports (
  tt_uid      TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_uid_time ON skip_reports(tt_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_report_ip_time  ON skip_reports(ip_hash, created_at);

-- One vote per segment per address as well as per account.
CREATE INDEX IF NOT EXISTS idx_vote_segment_ip ON votes(segment_id, ip_hash);
