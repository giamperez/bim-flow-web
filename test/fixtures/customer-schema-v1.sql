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
