-- A skip report becomes one row that carries its counts as JSON, so a report costs the same few
-- rows written however many ads it covers. The hourly run merges the reports after skips_merged.
ALTER TABLE skip_reports ADD COLUMN items TEXT;

-- Counts still waiting in the old inbox are merged before it goes.
UPDATE segments SET
  skips = skips + (SELECT COALESCE(SUM(n), 0) FROM skip_inbox WHERE segment_id = segments.id AND own = 0),
  saved_ms = saved_ms + (SELECT COALESCE(SUM(ms), 0) FROM skip_inbox WHERE segment_id = segments.id AND own = 0),
  own_skips = own_skips + (SELECT COALESCE(SUM(n), 0) FROM skip_inbox WHERE segment_id = segments.id AND own = 1),
  own_saved_ms = own_saved_ms + (SELECT COALESCE(SUM(ms), 0) FROM skip_inbox WHERE segment_id = segments.id AND own = 1)
WHERE id IN (SELECT segment_id FROM skip_inbox);
DROP TABLE skip_inbox;

INSERT OR REPLACE INTO meta (key, value)
  VALUES ('skips_merged', (SELECT COALESCE(MAX(rowid), 0) FROM skip_reports));
