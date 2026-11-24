-- Accounts and addresses the maintainer banned with scripts/admin.mjs. Their writes are refused.
CREATE TABLE IF NOT EXISTS bans (
  kind        TEXT NOT NULL,             -- 'uid' or 'ip'
  value       TEXT NOT NULL,             -- TikTok uid, or the salted address hash
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
);
