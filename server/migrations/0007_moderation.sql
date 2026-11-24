-- Moderation state. 'pending' segments wait for the maintainer and reach no phone; 'removed'
-- segments were taken down by the maintainer and cannot be voted on again.
ALTER TABLE segments ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
