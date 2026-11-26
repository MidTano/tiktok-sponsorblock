-- Daily vote counters per account ('u:' + account hash) and per network ('n:' + network hash),
-- for the UTC day number in `day`. A vote reads two rows to check its limits however many votes
-- came before, and every change counts, so switching a vote back and forth spends the limit.
CREATE TABLE IF NOT EXISTS vote_quota (
  key   TEXT PRIMARY KEY,
  day   INTEGER NOT NULL,
  n     INTEGER NOT NULL,           -- vote changes that day
  down  INTEGER NOT NULL DEFAULT 0  -- changes to a down-vote that day
) WITHOUT ROWID;
-- Changes to one vote in the day since created_at, which is now the time of its last change. A
-- vote taken back stays as a row with vote 0, so its count survives.
ALTER TABLE votes ADD COLUMN changes INTEGER NOT NULL DEFAULT 1;
-- A segment the maintainer restored with admin.mjs unhide stays visible whatever the votes say.
ALTER TABLE segments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
