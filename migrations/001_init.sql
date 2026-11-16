CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, contact_email TEXT, notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL, description TEXT, environment TEXT NOT NULL DEFAULT 'production',
  -- alert rules / escalation policy
  notify_min_severity TEXT NOT NULL DEFAULT 'low', notify_recovery INTEGER NOT NULL DEFAULT 1,
  esc1_min INTEGER NOT NULL DEFAULT 5, esc2_min INTEGER NOT NULL DEFAULT 15,
  quiet_start INTEGER, quiet_end INTEGER, quiet_tz_offset_min INTEGER NOT NULL DEFAULT 0,
  channels_enabled TEXT NOT NULL DEFAULT '{"email":true,"whatsapp":true}',
  alert_categories_off TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE(client_id, name)
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('super_admin','admin','technician','client')),
  client_id INTEGER REFERENCES clients(id), phone TEXT, timezone TEXT NOT NULL DEFAULT 'UTC',
  totp_secret_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE user_projects (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, PRIMARY KEY(user_id, project_id));
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, user_agent TEXT
);
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL CHECK (type IN ('website','webapp','mobile','api','server','database','domain','ssl','custom')),
  name TEXT NOT NULL, target TEXT NOT NULL, category TEXT, environment TEXT NOT NULL DEFAULT 'production',
  config TEXT NOT NULL DEFAULT '{}', secret_enc TEXT,
  interval_sec INTEGER NOT NULL DEFAULT 60, timeout_ms INTEGER NOT NULL DEFAULT 10000,
  criticality TEXT NOT NULL DEFAULT 'normal' CHECK (criticality IN ('critical','high','normal','low')),
  verify_failures INTEGER NOT NULL DEFAULT 3, recover_successes INTEGER NOT NULL DEFAULT 2, retry_delay_sec INTEGER NOT NULL DEFAULT 10,
  assignee_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'unknown', status_reason TEXT,
  last_check_at INTEGER, last_ok_at INTEGER, last_fail_at INTEGER, last_response_ms REAL, last_status_code INTEGER,
  last_heartbeat_at INTEGER, state TEXT NOT NULL DEFAULT '{}',
  next_run_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
  maintenance INTEGER NOT NULL DEFAULT 0, maint_start INTEGER, maint_end INTEGER,
  agent_token_hash TEXT,
  verified INTEGER NOT NULL DEFAULT 0,       -- 1 once a real check has completed
  is_demo INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX idx_assets_due ON assets(archived, next_run_at);
CREATE INDEX idx_assets_project ON assets(project_id);
CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'check',          -- check | gap (missed checks are recorded, never counted as downtime)
  state TEXT NOT NULL,                         -- ok | slow | fail | gap
  response_ms REAL, status_code INTEGER, size INTEGER, error TEXT, detail TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0         -- 1 = failure belongs to a verified outage (counts as downtime)
);
CREATE INDEX idx_checks_asset_ts ON checks(asset_id, ts);
CREATE INDEX idx_checks_ts ON checks(ts);
CREATE TABLE metrics (asset_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, value REAL NOT NULL);
CREATE INDEX idx_metrics ON metrics(asset_id, name, ts);
CREATE TABLE conditions (asset_id INTEGER NOT NULL, category TEXT NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0, ok_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(asset_id, category));
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL REFERENCES assets(id), project_id INTEGER NOT NULL,
  category TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','acknowledged','investigating','identified','monitoring','resolved','closed')),
  first_detected INTEGER NOT NULL, last_detected INTEGER NOT NULL, recovered_at INTEGER, resolved_at INTEGER, closed_at INTEGER,
  ack_at INTEGER, assignee_id INTEGER REFERENCES users(id), root_cause TEXT, resolution_notes TEXT,
  esc_level INTEGER NOT NULL DEFAULT 0, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_inc_asset ON incidents(asset_id, status);
CREATE INDEX idx_inc_project ON incidents(project_id, first_detected);
CREATE TABLE incident_events (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL REFERENCES incidents(id), ts INTEGER NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, user_id INTEGER);
CREATE INDEX idx_inc_events ON incident_events(incident_id, ts);
CREATE TABLE recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, -- NULL = global
  name TEXT, channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')), address TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1, min_severity TEXT NOT NULL DEFAULT 'low', recovery INTEGER NOT NULL DEFAULT 1,
  daily_summary INTEGER NOT NULL DEFAULT 0, weekly_report INTEGER NOT NULL DEFAULT 0, monthly_report INTEGER NOT NULL DEFAULT 0,
  consent INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER, project_id INTEGER, channel TEXT NOT NULL, recipient TEXT NOT NULL,
  kind TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | delivered | read | failed | unconfigured
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT, provider_id TEXT,
  created_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE INDEX idx_notif_due ON notifications(status, next_attempt_at);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id INTEGER, user_email TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT, ip TEXT);
CREATE TABLE heartbeats (name TEXT PRIMARY KEY, ts INTEGER NOT NULL, info TEXT);
CREATE TABLE mobile_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, platform TEXT, app_version TEXT, message TEXT, requests INTEGER, failures INTEGER);
CREATE INDEX idx_mobile ON mobile_reports(asset_id, ts);
CREATE TABLE report_runs (key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
