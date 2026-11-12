CREATE TABLE IF NOT EXISTS licenses (
  id             CHAR(36) NOT NULL PRIMARY KEY,
  key_hash       CHAR(64) NOT NULL,
  key_hint       VARCHAR(8) NOT NULL,
  customer_name  VARCHAR(120) NOT NULL,
  customer_email VARCHAR(160) NOT NULL DEFAULT '',
  plan           VARCHAR(40) NOT NULL DEFAULT 'standard',
  max_devices    INT NOT NULL DEFAULT 2,
  status         VARCHAR(12) NOT NULL DEFAULT 'active',
  expires_at     BIGINT NOT NULL,
  notes          VARCHAR(1000) NOT NULL DEFAULT '',
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  customer_id    CHAR(36) NULL,
  key_enc        TEXT NULL,
  is_trial       TINYINT NOT NULL DEFAULT 0,
  access_mode VARCHAR(10) NOT NULL DEFAULT 'paid',
  UNIQUE KEY uq_licenses_key_hash (key_hash),
  KEY idx_licenses_expires (expires_at),
  KEY idx_licenses_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS devices (
  id            CHAR(36) NOT NULL PRIMARY KEY,
  license_id    CHAR(36) NOT NULL,
  device_hash   CHAR(64) NOT NULL,
  device_name   VARCHAR(80) NOT NULL DEFAULT '',
  revit_version VARCHAR(16) NOT NULL DEFAULT '',
  app_version   VARCHAR(16) NOT NULL DEFAULT '',
  status        VARCHAR(10) NOT NULL DEFAULT 'active',
  first_seen    BIGINT NOT NULL,
  last_seen     BIGINT NOT NULL,
  released_at   BIGINT NULL,
  UNIQUE KEY uq_devices_license_hash (license_id, device_hash),
  KEY idx_devices_license (license_id, status),
  CONSTRAINT fk_devices_license FOREIGN KEY (license_id) REFERENCES licenses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS events (
  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  license_id CHAR(36) NULL,
  device_id  CHAR(36) NULL,
  type       VARCHAR(40) NOT NULL,
  detail     VARCHAR(500) NOT NULL DEFAULT '',
  ip         VARCHAR(45) NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  KEY idx_events_license (license_id, created_at),
  KEY idx_events_rate (type, ip, created_at),
  KEY idx_events_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customers (
  id            CHAR(36) NOT NULL PRIMARY KEY,
  email         VARCHAR(160) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    BIGINT NOT NULL,
  email_norm    VARCHAR(160) NULL,
  email_verified_at BIGINT NULL,
  session_version INT NOT NULL DEFAULT 0,
  phone VARCHAR(24) NOT NULL DEFAULT '',
  company VARCHAR(120) NOT NULL DEFAULT '',
  billing_json TEXT NULL,
  free_started_at BIGINT NULL,
  trial_started_at BIGINT NULL,
  UNIQUE KEY uq_customers_email (email),
  KEY idx_customers_norm (email_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  code         VARCHAR(12) NOT NULL,
  customer_id  CHAR(36) NOT NULL,
  license_id   CHAR(36) NULL,
  plan_id      VARCHAR(40) NOT NULL,
  plan_name    VARCHAR(80) NOT NULL,
  seconds      BIGINT NOT NULL,
  devices      INT NOT NULL,
  kind         VARCHAR(10) NOT NULL,
  amount_cents INT NOT NULL,
  currency     VARCHAR(8) NOT NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'pending',
  provider     VARCHAR(20) NOT NULL DEFAULT 'manual',
  tier         INT NOT NULL DEFAULT 0,
  provider_ref VARCHAR(100) NULL,
  claimed_at   BIGINT NULL,
  created_at   BIGINT NOT NULL,
  paid_at      BIGINT NULL,
  UNIQUE KEY uq_orders_code (code),
  KEY idx_orders_customer (customer_id, created_at),
  KEY idx_orders_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trial_devices (
  device_hash CHAR(64) NOT NULL PRIMARY KEY,
  license_id  CHAR(36) NOT NULL,
  first_at    BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_tokens (
  id          CHAR(36) NOT NULL PRIMARY KEY,
  customer_id CHAR(36) NOT NULL,
  type        VARCHAR(10) NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_at     BIGINT NULL,
  created_at  BIGINT NOT NULL,
  UNIQUE KEY uq_email_tokens_hash (token_hash),
  KEY idx_email_tokens_customer (customer_id, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS export_usage (
  license_id CHAR(36) NOT NULL,
  usage_day CHAR(10) NOT NULL,
  device_hash CHAR(64) NOT NULL,
  request_id CHAR(36) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (license_id, usage_day),
  UNIQUE KEY uq_export_device_day (device_hash, usage_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS export_buckets (
  subject VARCHAR(80) NOT NULL,
  period CHAR(7) NOT NULL,
  used_units INT NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS export_reservations (
  license_id CHAR(36) NOT NULL,
  request_id CHAR(36) NOT NULL,
  device_hash CHAR(64) NOT NULL,
  period CHAR(7) NOT NULL,
  planned_units INT NOT NULL,
  quota_units INT NOT NULL,
  actual_units INT NULL,
  created_at BIGINT NOT NULL,
  settled_at BIGINT NULL,
  PRIMARY KEY (license_id, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_customers (
  customer_id CHAR(36) NOT NULL,
  environment VARCHAR(4) NOT NULL,
  provider_id VARCHAR(100) NOT NULL,
  PRIMARY KEY (customer_id, environment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_methods (
  id CHAR(36) NOT NULL PRIMARY KEY,
  customer_id CHAR(36) NOT NULL,
  environment VARCHAR(4) NOT NULL,
  provider_id VARCHAR(100) NOT NULL,
  brand VARCHAR(24) NOT NULL,
  last_four CHAR(4) NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE KEY uq_payment_provider (provider_id, environment),
  KEY idx_payment_customer (customer_id, environment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider VARCHAR(16) NOT NULL,
  subject_hash CHAR(64) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (provider, subject_hash),
  KEY idx_oauth_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS oauth_flows (
  state_hash CHAR(64) NOT NULL PRIMARY KEY,
  provider VARCHAR(16) NOT NULL,
  verifier VARCHAR(100) NOT NULL,
  nonce VARCHAR(100) NOT NULL,
  next_view VARCHAR(24) NOT NULL DEFAULT '',
  expires_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
