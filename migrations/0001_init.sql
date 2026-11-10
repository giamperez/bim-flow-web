CREATE TABLE licenses (
  id            TEXT PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  key_hint      TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  plan          TEXT NOT NULL DEFAULT 'standard',
  max_devices   INTEGER NOT NULL DEFAULT 2 CHECK (max_devices BETWEEN 1 AND 100),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  expires_at    INTEGER NOT NULL,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_licenses_expires ON licenses (expires_at);
CREATE INDEX idx_licenses_status ON licenses (status);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  license_id    TEXT NOT NULL REFERENCES licenses (id) ON DELETE CASCADE,
  device_hash   TEXT NOT NULL,
  device_name   TEXT NOT NULL DEFAULT '',
  revit_version TEXT NOT NULL DEFAULT '',
  app_version   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  released_at   INTEGER,
  UNIQUE (license_id, device_hash)
);
CREATE INDEX idx_devices_license ON devices (license_id, status);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id  TEXT,
  device_id   TEXT,
  type        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_events_license ON events (license_id, created_at);
CREATE INDEX idx_events_rate ON events (type, ip, created_at);
CREATE INDEX idx_events_time ON events (created_at);
