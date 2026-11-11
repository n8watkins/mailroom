-- Every send mailroom attempted. `idem_key` is the app's own key (a job id):
-- a send with a key that already went out is not sent again.
CREATE TABLE sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL,
  kind TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  idem_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  message_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX sends_idem ON sends (app, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX sends_message ON sends (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX sends_app_time ON sends (app, created_at);

-- Email Sending events from the queue, one row per event id.
CREATE TABLE email_events (
  event_id TEXT PRIMARY KEY,
  app TEXT,
  type TEXT NOT NULL,
  message_id TEXT,
  sender TEXT,
  recipient TEXT,
  bounce_type TEXT,
  smtp_status TEXT,
  reason TEXT,
  occurred_at TEXT,
  received_at INTEGER NOT NULL,
  hook_done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX email_events_app_time ON email_events (app, received_at);

-- Addresses mailroom refuses to send to: a hard bounce or a complaint from any
-- app stops every app (Cloudflare's own suppression list is account-wide too).
CREATE TABLE suppressions (
  recipient TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  app TEXT,
  event_id TEXT,
  created_at INTEGER NOT NULL
);

-- Cap counters: one row per window and subject, incremented atomically.
CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX counters_expiry ON counters (expires_at);
