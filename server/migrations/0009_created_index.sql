-- The daily cap on new segments and the retention cleanup look segments up by creation time.
CREATE INDEX IF NOT EXISTS idx_seg_created ON segments(created_at);
