import { Hono } from 'hono';
import { normalizeKey, sha256Hex, signToken } from './crypto';
import type { DeviceRow, Env, LicenseRow, TokenPayload } from './types';

export const licenseApi = new Hono<{ Bindings: Env }>();

const DAY = 86400;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BAD_ATTEMPTS_PER_HOUR = 20;
const MAX_SELF_RELEASES_PER_30_DAYS = 3;

const now = () => Math.floor(Date.now() / 1000);
const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function logEvent(
  db: D1Database,
  type: string,
  opts: { licenseId?: string | null; deviceId?: string | null; detail?: string; ip?: string } = {},
) {
  await db
    .prepare('INSERT INTO events (license_id, device_id, type, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(opts.licenseId ?? null, opts.deviceId ?? null, type, (opts.detail ?? '').slice(0, 500), opts.ip ?? '', now())
    .run();
}

function fail(c: any, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ ok: false, error, message, ...extra }, status);
}

async function tooManyBadAttempts(db: D1Database, ip: string): Promise<boolean> {
  if (!ip) return false;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'bad_key' AND ip = ? AND created_at > ?")
    .bind(ip, now() - 3600)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_BAD_ATTEMPTS_PER_HOUR;
}

async function readBody(c: any): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Common key lookup + state checks. Returns either a Response or the license. */
async function resolveLicense(c: any, body: Record<string, unknown>, ip: string): Promise<Response | LicenseRow> {
  if (await tooManyBadAttempts(c.env.DB, ip)) {
    return fail(c, 429, 'rate_limited', 'Demasiados intentos. Inténtelo de nuevo más tarde.');
  }
  const key = normalizeKey(body.key);
  const license = key
    ? await c.env.DB.prepare('SELECT * FROM licenses WHERE key_hash = ?').bind(await sha256Hex(key)).first()
    : null;
  if (!license) {
    await logEvent(c.env.DB, 'bad_key', { ip, detail: key ? 'unknown key' : 'malformed key' });
    return fail(c, 404, 'invalid_key', 'La clave de licencia no es válida.');
  }
  const lic = license as LicenseRow;
  if (lic.status === 'revoked') return fail(c, 403, 'revoked', 'Esta licencia fue revocada. Contacte a su proveedor.');
  if (lic.status === 'suspended') return fail(c, 403, 'suspended', 'Esta licencia está suspendida. Contacte a su proveedor.');
  if (lic.expires_at <= now()) {
    return fail(c, 403, 'expired', 'La licencia ha vencido. Renuévela para seguir usando XportBIM.', { expiresAt: lic.expires_at });
  }
  return lic;
}

async function issue(c: any, lic: LicenseRow, deviceHash: string, devicesUsed: number) {
  const graceDays = Math.min(30, Math.max(1, parseInt(c.env.OFFLINE_GRACE_DAYS ?? '7', 10) || 7));
  const iat = now();
  const payload: TokenPayload = {
    v: 1,
    lid: lic.id,
    dev: deviceHash,
    name: lic.customer_name,
    plan: lic.plan,
    exp: lic.expires_at,
    iat,
    chk: Math.min(lic.expires_at, iat + graceDays * DAY),
  };
  return c.json({
    ok: true,
    token: await signToken(c.env.SIGNING_KEY_JWK, payload),
    license: {
      customer: lic.customer_name,
      plan: lic.plan,
      expiresAt: lic.expires_at,
      maxDevices: lic.max_devices,
      devicesUsed,
    },
    serverTime: iat,
  });
}

function deviceInfo(body: Record<string, unknown>) {
  const deviceHash = typeof body.deviceId === 'string' ? body.deviceId.toLowerCase() : '';
  return {
    deviceHash: HEX64.test(deviceHash) ? deviceHash : '',
    name: clip(body.deviceName, 80),
    revit: clip(body.revitVersion, 16),
    app: clip(body.appVersion, 16),
  };
}

async function handle(c: any, allowNewDevice: boolean) {
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  const body = await readBody(c);
  if (!body) return fail(c, 400, 'bad_request', 'Solicitud inválida.');
  const dev = deviceInfo(body);
  if (!dev.deviceHash) return fail(c, 400, 'bad_request', 'Identificador de equipo inválido.');

  const resolved = await resolveLicense(c, body, ip);
  if (resolved instanceof Response) return resolved;
  const lic = resolved;
  const db: D1Database = c.env.DB;
  const t = now();

  let device = await db
    .prepare('SELECT * FROM devices WHERE license_id = ? AND device_hash = ?')
    .bind(lic.id, dev.deviceHash)
    .first<DeviceRow>();

  if (device && device.status === 'active') {
    await db
      .prepare('UPDATE devices SET last_seen = ?, device_name = ?, revit_version = ?, app_version = ? WHERE id = ?')
      .bind(t, dev.name || device.device_name, dev.revit || device.revit_version, dev.app || device.app_version, device.id)
      .run();
  } else {
    if (!allowNewDevice) {
      return fail(c, 409, 'device_not_activated', 'Este equipo no está activado para la licencia. Actívelo de nuevo.');
    }
    const active = await db
      .prepare("SELECT id, device_name, last_seen FROM devices WHERE license_id = ? AND status = 'active' ORDER BY last_seen DESC")
      .bind(lic.id)
      .all<{ id: string; device_name: string; last_seen: number }>();
    if (active.results.length >= lic.max_devices) {
      await logEvent(db, 'device_limit', { licenseId: lic.id, ip, detail: dev.name });
      return fail(c, 409, 'device_limit', `La licencia ya está activada en ${lic.max_devices} equipo(s). Libere uno para continuar.`, {
        devices: active.results.map((d) => ({ ref: d.id, name: d.device_name, lastSeen: d.last_seen })),
      });
    }
    if (device) {
      await db
        .prepare("UPDATE devices SET status = 'active', released_at = NULL, last_seen = ?, device_name = ?, revit_version = ?, app_version = ? WHERE id = ?")
        .bind(t, dev.name, dev.revit, dev.app, device.id)
        .run();
    } else {
      const id = crypto.randomUUID();
      await db
        .prepare('INSERT INTO devices (id, license_id, device_hash, device_name, revit_version, app_version, status, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, lic.id, dev.deviceHash, dev.name, dev.revit, dev.app, 'active', t, t)
        .run();
      device = { id } as DeviceRow;
    }
    await logEvent(db, 'activated', { licenseId: lic.id, deviceId: device.id, ip, detail: `${dev.name} · Revit ${dev.revit} · v${dev.app}` });
  }

  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE license_id = ? AND status = 'active'")
    .bind(lic.id)
    .first<{ n: number }>();
  return issue(c, lic, dev.deviceHash, count?.n ?? 1);
}

licenseApi.post('/activate', (c) => handle(c, true));
licenseApi.post('/validate', (c) => handle(c, false));

/** The device releases its own slot (e.g. user is moving to another PC). */
licenseApi.post('/deactivate', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  const body = await readBody(c);
  if (!body) return fail(c, 400, 'bad_request', 'Solicitud inválida.');
  const dev = deviceInfo(body);
  if (!dev.deviceHash) return fail(c, 400, 'bad_request', 'Identificador de equipo inválido.');
  const key = normalizeKey(body.key);
  const lic = key
    ? await c.env.DB.prepare('SELECT id FROM licenses WHERE key_hash = ?').bind(await sha256Hex(key)).first<{ id: string }>()
    : null;
  if (!lic) return fail(c, 404, 'invalid_key', 'La clave de licencia no es válida.');
  const row = await c.env.DB
    .prepare("UPDATE devices SET status = 'released', released_at = ? WHERE license_id = ? AND device_hash = ? AND status = 'active' RETURNING id")
    .bind(now(), lic.id, dev.deviceHash)
    .first<{ id: string }>();
  if (row) await logEvent(c.env.DB, 'released_by_device', { licenseId: lic.id, deviceId: row.id, ip });
  return c.json({ ok: true });
});

/** Free another device's slot knowing only the key (limited to a few per 30 days). */
licenseApi.post('/release', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  const body = await readBody(c);
  if (!body) return fail(c, 400, 'bad_request', 'Solicitud inválida.');
  const resolved = await resolveLicense(c, body, ip);
  if (resolved instanceof Response) return resolved;
  const lic = resolved;
  const ref = clip(body.ref, 64);
  const used = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM events WHERE license_id = ? AND type = 'released_self_service' AND created_at > ?")
    .bind(lic.id, now() - 30 * DAY)
    .first<{ n: number }>();
  if ((used?.n ?? 0) >= MAX_SELF_RELEASES_PER_30_DAYS) {
    return fail(c, 429, 'release_limit', 'Se alcanzó el límite de liberaciones. Contacte a su proveedor.');
  }
  const row = await c.env.DB
    .prepare("UPDATE devices SET status = 'released', released_at = ? WHERE id = ? AND license_id = ? AND status = 'active' RETURNING id, device_name")
    .bind(now(), ref, lic.id)
    .first<{ id: string; device_name: string }>();
  if (!row) return fail(c, 404, 'unknown_device', 'No se encontró ese equipo.');
  await logEvent(c.env.DB, 'released_self_service', { licenseId: lic.id, deviceId: row.id, ip, detail: row.device_name });
  return c.json({ ok: true });
});
