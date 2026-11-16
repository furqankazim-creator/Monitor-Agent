-- Clients are removed: projects are the top-level grouping. External "client" logins are removed too.
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='client');
DELETE FROM user_projects WHERE user_id IN (SELECT id FROM users WHERE role='client');
UPDATE assets SET assignee_id=NULL WHERE assignee_id IN (SELECT id FROM users WHERE role='client');
UPDATE incidents SET assignee_id=NULL WHERE assignee_id IN (SELECT id FROM users WHERE role='client');
DELETE FROM users WHERE role='client';

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('super_admin','admin','technician')),
  phone TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', totp_secret_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, created_at INTEGER NOT NULL
);
INSERT INTO users_new(id,email,name,password_hash,role,phone,timezone,totp_secret_enc,totp_enabled,active,failed_logins,locked_until,created_at)
  SELECT id,email,name,password_hash,role,phone,timezone,totp_secret_enc,totp_enabled,active,failed_logins,locked_until,created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE TABLE projects_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, environment TEXT NOT NULL DEFAULT 'production',
  notify_min_severity TEXT NOT NULL DEFAULT 'low', notify_recovery INTEGER NOT NULL DEFAULT 1,
  esc1_min INTEGER NOT NULL DEFAULT 5, esc2_min INTEGER NOT NULL DEFAULT 15,
  quiet_start INTEGER, quiet_end INTEGER, quiet_tz_offset_min INTEGER NOT NULL DEFAULT 0,
  channels_enabled TEXT NOT NULL DEFAULT '{"email":true,"whatsapp":true}', alert_categories_off TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
INSERT INTO projects_new(id,name,description,environment,notify_min_severity,notify_recovery,esc1_min,esc2_min,quiet_start,quiet_end,quiet_tz_offset_min,channels_enabled,alert_categories_off,archived,created_at)
  SELECT p.id,
    CASE WHEN (SELECT COUNT(*) FROM projects x WHERE x.name=p.name)>1 THEN p.name||' ('||c.name||')' ELSE p.name END,
    p.description,p.environment,p.notify_min_severity,p.notify_recovery,p.esc1_min,p.esc2_min,p.quiet_start,p.quiet_end,p.quiet_tz_offset_min,p.channels_enabled,p.alert_categories_off,p.archived,p.created_at
  FROM projects p JOIN clients c ON c.id=p.client_id;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
DROP TABLE clients;
