-- Every segment gets a number, the same on every phone: segment 12 shows as ad12.
ALTER TABLE segments ADD COLUMN num INTEGER;
UPDATE segments SET num = (
  SELECT COUNT(*) FROM segments AS older
  WHERE older.created_at < segments.created_at
     OR (older.created_at = segments.created_at AND older.id <= segments.id)
) WHERE num IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_seg_num ON segments(num);

-- Same sound sent twice is found by its hashes; this narrows the comparison.
CREATE INDEX IF NOT EXISTS idx_seg_hash_count ON segments(hash_count);

-- Daily limits are counted here: Workers rate limit bindings only know 10 and 60 second windows.
-- The address is kept only as a salted hash, never in the clear.
ALTER TABLE segments ADD COLUMN ip_hash TEXT;
ALTER TABLE votes ADD COLUMN ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_seg_uid_time ON segments(tt_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_seg_ip_time  ON segments(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_vote_uid_time ON votes(tt_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_vote_ip_time  ON votes(ip_hash, created_at);
