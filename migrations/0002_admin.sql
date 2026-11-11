-- Owner overrides set from n8builds-admin (MailroomAdmin): a paused app sends
-- nothing; day_cap replaces the app's daily cap from src/apps.ts while set.
CREATE TABLE app_settings (
  app TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  day_cap INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- Every owner action, who took it and what changed. Addresses are masked.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  app TEXT,
  detail TEXT NOT NULL
);
CREATE INDEX audit_log_at ON audit_log (at);
