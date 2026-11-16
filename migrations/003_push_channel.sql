-- Allow a third alert channel: phone push notifications (ntfy). The recipient "address" is the private topic name.
CREATE TABLE recipients_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT, channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','push')), address TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1, min_severity TEXT NOT NULL DEFAULT 'low', recovery INTEGER NOT NULL DEFAULT 1,
  daily_summary INTEGER NOT NULL DEFAULT 0, weekly_report INTEGER NOT NULL DEFAULT 0, monthly_report INTEGER NOT NULL DEFAULT 0,
  consent INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
INSERT INTO recipients_new(id,project_id,name,channel,address,level,min_severity,recovery,daily_summary,weekly_report,monthly_report,consent,active,created_at)
  SELECT id,project_id,name,channel,address,level,min_severity,recovery,daily_summary,weekly_report,monthly_report,consent,active,created_at FROM recipients;
DROP TABLE recipients;
ALTER TABLE recipients_new RENAME TO recipients;
