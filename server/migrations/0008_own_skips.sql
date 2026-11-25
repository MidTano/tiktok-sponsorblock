-- An author's skips of their own segments count towards the base's totals, kept apart so they
-- never add to what the author's segments saved other people.
ALTER TABLE skip_inbox ADD COLUMN own INTEGER NOT NULL DEFAULT 0;
ALTER TABLE segments ADD COLUMN own_skips INTEGER NOT NULL DEFAULT 0;
ALTER TABLE segments ADD COLUMN own_saved_ms INTEGER NOT NULL DEFAULT 0;
