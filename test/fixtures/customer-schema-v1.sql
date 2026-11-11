CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  email_norm TEXT,
  email_verified_at INTEGER,
  session_version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO customers (id,email,name,password_hash,created_at,email_norm,email_verified_at)
VALUES ('migration-fixture','legacy@example.test','Cuenta anterior','not-a-login-hash',123,'legacy@example.test',123);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, key_hint TEXT NOT NULL,
  customer_name TEXT NOT NULL, customer_email TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'standard', max_devices INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'active', expires_at INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  customer_id TEXT, key_enc TEXT, is_trial INTEGER NOT NULL DEFAULT 0
);
INSERT INTO licenses (id,key_hash,key_hint,customer_name,plan,max_devices,expires_at,created_at,updated_at,customer_id,is_trial)
VALUES ('legacy-free','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','AAAAA','Cuenta anterior','Gratuito',1,999,123,123,'migration-fixture',1);
INSERT INTO licenses (id,key_hash,key_hint,customer_name,plan,max_devices,expires_at,created_at,updated_at)
VALUES ('legacy-paid','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','BBBBB','Cliente anterior','Anual',2,4102444800,123,123);
