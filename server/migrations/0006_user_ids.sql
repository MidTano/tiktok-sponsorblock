-- Accounts are kept as keyed hashes from now on; the TikTok uid itself is no longer stored.
-- Rows written before this migration belong to 'legacy-owner' (segments) or a unique
-- 'legacy-<rowid>' (votes), so their counts survive without the uid.

DROP INDEX IF EXISTS idx_seg_tt_uid;
DROP INDEX IF EXISTS idx_seg_uid_time;
ALTER TABLE segments ADD COLUMN user_id TEXT;
UPDATE segments SET user_id = 'legacy-owner';
ALTER TABLE segments DROP COLUMN tt_uid;
CREATE INDEX IF NOT EXISTS idx_seg_user_time ON segments(user_id, created_at);

DROP INDEX IF EXISTS idx_report_uid_time;
ALTER TABLE skip_reports ADD COLUMN user_id TEXT;
UPDATE skip_reports SET user_id = 'legacy-owner';
ALTER TABLE skip_reports DROP COLUMN tt_uid;
CREATE INDEX IF NOT EXISTS idx_report_user_time ON skip_reports(user_id, created_at);

CREATE TABLE votes_next (
  segment_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  ip_hash     TEXT,
  vote        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (segment_id, user_id)
);
INSERT INTO votes_next (segment_id, user_id, ip_hash, vote, created_at)
  SELECT segment_id, 'legacy-' || rowid, ip_hash, vote, created_at FROM votes;
DROP TABLE votes;
ALTER TABLE votes_next RENAME TO votes;
CREATE INDEX IF NOT EXISTS idx_vote_user_time ON votes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vote_ip_time ON votes(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_vote_segment_ip ON votes(segment_id, ip_hash);

-- Bans were keyed by the raw uid; they cannot be carried over, so the maintainer bans again.
DELETE FROM bans WHERE kind = 'uid';
