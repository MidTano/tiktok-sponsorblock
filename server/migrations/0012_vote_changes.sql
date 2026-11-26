-- A vote row counts every change made to it in the last day (created_at is now the time of the
-- last change), so switching a vote back and forth spends the daily vote limit. A vote taken back
-- stays as a row with vote 0 for the same reason.
ALTER TABLE votes ADD COLUMN changes INTEGER NOT NULL DEFAULT 1;
-- A segment the maintainer restored with admin.mjs unhide stays visible whatever the votes say.
ALTER TABLE segments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
