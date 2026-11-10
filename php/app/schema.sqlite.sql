CREATE TABLE IF NOT EXISTS licenses (
  id             TEXT PRIMARY KEY,
  key_hash       TEXT NOT NULL UNIQUE,
  key_hint       TEXT NOT NULL,
  customer_name  TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  plan           TEXT NOT NULL DEFAULT 'standard',
  max_devices    INTEGER NOT NULL DEFAULT 2,
  status         TEXT NOT NULL DEFAULT 'active',
  expires_at     INTEGER NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  customer_id    TEXT,
  key_enc        TEXT,
  is_trial       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses (expires_at);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses (status);

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  license_id    TEXT NOT NULL REFERENCES licenses (id) ON DELETE CASCADE,
  device_hash   TEXT NOT NULL,
  device_name   TEXT NOT NULL DEFAULT '',
  revit_version TEXT NOT NULL DEFAULT '',
  app_version   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  released_at   INTEGER,
  UNIQUE (license_id, device_hash)
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON devices (license_id, status);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT,
  device_id  TEXT,
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_license ON events (license_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_rate ON events (type, ip, created_at);
CREATE INDEX IF NOT EXISTS idx_events_time ON events (created_at);

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  email_norm    TEXT
);
CREATE INDEX IF NOT EXISTS idx_customers_norm ON customers (email_norm);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  customer_id  TEXT NOT NULL,
  license_id   TEXT,
  plan_id      TEXT NOT NULL,
  plan_name    TEXT NOT NULL,
  seconds      INTEGER NOT NULL,
  devices      INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  provider     TEXT NOT NULL DEFAULT 'manual',
  tier         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at);

CREATE TABLE IF NOT EXISTS trial_devices (
  device_hash TEXT PRIMARY KEY,
  license_id  TEXT NOT NULL,
  first_at    INTEGER NOT NULL
);
