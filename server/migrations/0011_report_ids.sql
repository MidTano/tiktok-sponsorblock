-- Preserve report sequence even when retention deletes every row.
CREATE TABLE skip_reports_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  items TEXT,
  report_id TEXT,
  UNIQUE(user_id, report_id)
);
INSERT INTO skip_reports_next (sequence, user_id, ip_hash, created_at, items)
  SELECT rowid, user_id, ip_hash, created_at, items FROM skip_reports;
-- An empty table may still have an acknowledged high-water mark.
INSERT INTO sqlite_sequence(name, seq)
  SELECT 'skip_reports_next', CAST(value AS INTEGER) FROM meta
  WHERE key = 'skips_merged' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'skip_reports_next');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'skips_merged'), 0))
  WHERE name = 'skip_reports_next';
DROP TABLE skip_reports;
ALTER TABLE skip_reports_next RENAME TO skip_reports;
CREATE INDEX idx_report_user_time ON skip_reports(user_id, created_at);
CREATE INDEX idx_report_ip_time ON skip_reports(ip_hash, created_at);
CREATE INDEX idx_report_created ON skip_reports(created_at);
