export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SIGNING_KEY_JWK: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  OFFLINE_GRACE_DAYS?: string;
}

export interface LicenseRow {
  id: string;
  key_hash: string;
  key_hint: string;
  customer_name: string;
  customer_email: string;
  plan: string;
  max_devices: number;
  status: 'active' | 'suspended' | 'revoked';
  expires_at: number;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface DeviceRow {
  id: string;
  license_id: string;
  device_hash: string;
  device_name: string;
  revit_version: string;
  app_version: string;
  status: 'active' | 'released';
  first_seen: number;
  last_seen: number;
  released_at: number | null;
}

export interface TokenPayload {
  v: 1;
  lid: string; // license id
  dev: string; // device hash
  name: string; // customer name
  plan: string;
  exp: number; // license expiry (epoch s)
  iat: number; // issued at (epoch s)
  chk: number; // must revalidate online before this instant (epoch s)
}
