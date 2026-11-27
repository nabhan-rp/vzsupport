CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  reporter_email TEXT,
  category TEXT,
  target_url TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_created_at
  ON tickets (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_status_created_at
  ON tickets (status, created_at DESC);
