import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { constantTimeEqual, createSession, generateLicenseKey, sha256Hex, verifySession } from './crypto';
import { logEvent } from './license-api';
import type { DeviceRow, Env, LicenseRow } from './types';

export const adminApi = new Hono<{ Bindings: Env }>();

const DAY = 86400;
const COOKIE = 'bf_admin';
const SESSION_TTL = 12 * 3600;
const now = () => Math.floor(Date.now() / 1000);
const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function toPublic(l: LicenseRow & { devices_active?: number; last_seen?: number | null }) {
  const t = now();
  const state = l.status !== 'active' ? l.status : l.expires_at <= t ? 'expired' : l.expires_at - t <= 30 * DAY ? 'expiring' : 'active';
  return {
    id: l.id,
    keyHint: l.key_hint,
    customerName: l.customer_name,
    customerEmail: l.customer_email,
    plan: l.plan,
    maxDevices: l.max_devices,
    status: l.status,
    state,
    expiresAt: l.expires_at,
    notes: l.notes,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    devicesActive: l.devices_active ?? undefined,
    lastSeen: l.last_seen ?? undefined,
  };
}

// ---------- auth ----------
adminApi.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  const recent = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'admin_login_failed' AND ip = ? AND created_at > ?")
    .bind(ip, now() - 900)
    .first<{ n: number }>();
  if (ip && (recent?.n ?? 0) >= 5) return c.json({ ok: false, error: 'Demasiados intentos. Espere 15 minutos.' }, 429);

  let password = '';
  try {
    password = String(((await c.req.json()) as any).password ?? '');
  } catch {
    /* empty */
  }
  if (!c.env.ADMIN_PASSWORD || !(await constantTimeEqual(password, c.env.ADMIN_PASSWORD))) {
    await logEvent(c.env.DB, 'admin_login_failed', { ip });
    return c.json({ ok: false, error: 'Contraseña incorrecta.' }, 401);
  }
  setCookie(c, COOKIE, await createSession(c.env.SESSION_SECRET, SESSION_TTL), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL,
  });
  await logEvent(c.env.DB, 'admin_login', { ip });
  return c.json({ ok: true });
});

adminApi.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

adminApi.use('*', async (c, next) => {
  if (c.req.path.endsWith('/login') || c.req.path.endsWith('/logout')) return next();
  if (!(await verifySession(c.env.SESSION_SECRET, getCookie(c, COOKIE)))) return c.json({ ok: false, error: 'unauthorized' }, 401);
  // CSRF: mutating calls must carry a header that cross-site forms cannot set.
  if (c.req.method !== 'GET' && c.req.header('X-Requested-With') !== 'bimflow') {
    return c.json({ ok: false, error: 'csrf' }, 403);
  }
  return next();
});

adminApi.get('/me', (c) => c.json({ ok: true }));

// ---------- stats ----------
adminApi.get('/stats', async (c) => {
  const t = now();
  const db = c.env.DB;
  const [lic, dev, ev, recent] = await Promise.all([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'active' AND expires_at > ?1 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'active' AND expires_at > ?1 AND expires_at <= ?2 THEN 1 ELSE 0 END) AS expiring,
           SUM(CASE WHEN status = 'active' AND expires_at <= ?1 THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) AS blocked,
           COUNT(*) AS total
         FROM licenses`,
      )
      .bind(t, t + 30 * DAY)
      .first(),
    db.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'active'").first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE created_at > ? AND type IN ('bad_key','device_limit')")
      .bind(t - 7 * DAY)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT id, key_hint, customer_name, expires_at FROM licenses
         WHERE status = 'active' AND expires_at > ? ORDER BY expires_at ASC LIMIT 5`,
      )
      .bind(t)
      .all(),
  ]);
  return c.json({
    ok: true,
    licenses: {
      active: lic?.active ?? 0,
      expiring: lic?.expiring ?? 0,
      expired: lic?.expired ?? 0,
      blocked: lic?.blocked ?? 0,
      total: lic?.total ?? 0,
    },
    devicesActive: dev?.n ?? 0,
    suspiciousLast7d: ev?.n ?? 0,
    nextToExpire: recent.results.map((r: any) => ({
      id: r.id,
      keyHint: r.key_hint,
      customerName: r.customer_name,
      expiresAt: r.expires_at,
    })),
  });
});

// ---------- licenses ----------
adminApi.get('/licenses', async (c) => {
  const q = clip(c.req.query('q'), 80);
  const state = c.req.query('state') ?? '';
  const page = Math.max(0, parseInt(c.req.query('page') ?? '0', 10) || 0);
  const size = 25;
  const t = now();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push("(customer_name LIKE ? ESCAPE '\\' OR customer_email LIKE ? ESCAPE '\\' OR key_hint LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    binds.push(like, like, like);
  }
  if (state === 'active') where.push("status = 'active' AND expires_at > ?"), binds.push(t);
  else if (state === 'expiring') where.push("status = 'active' AND expires_at > ? AND expires_at <= ?"), binds.push(t, t + 30 * DAY);
  else if (state === 'expired') where.push("status = 'active' AND expires_at <= ?"), binds.push(t);
  else if (state === 'suspended' || state === 'revoked') where.push('status = ?'), binds.push(state);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await c.env.DB
    .prepare(
      `SELECT l.*,
         (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id AND d.status = 'active') AS devices_active,
         (SELECT MAX(last_seen) FROM devices d WHERE d.license_id = l.id) AS last_seen
       FROM licenses l ${clause} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds, size + 1, page * size)
    .all<LicenseRow & { devices_active: number; last_seen: number | null }>();
  return c.json({
    ok: true,
    page,
    hasMore: rows.results.length > size,
    licenses: rows.results.slice(0, size).map(toPublic),
  });
});

function parseExpiry(body: any, base: number): number | null {
  if (typeof body.expiresAt === 'number' && body.expiresAt > 0) return Math.floor(body.expiresAt);
  const days = Number(body.days);
  if (Number.isFinite(days) && days > 0 && days <= 3650) return base + Math.floor(days) * DAY;
  return null;
}

adminApi.post('/licenses', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const name = clip(body.customerName, 120);
  if (!name) return c.json({ ok: false, error: 'El nombre del cliente es obligatorio.' }, 400);
  const maxDevices = Math.floor(Number(body.maxDevices ?? 2));
  if (!(maxDevices >= 1 && maxDevices <= 100)) return c.json({ ok: false, error: 'Equipos permitidos: 1 a 100.' }, 400);
  const t = now();
  const expiresAt = parseExpiry(body, t);
  if (!expiresAt || expiresAt <= t) return c.json({ ok: false, error: 'Indique un vencimiento futuro.' }, 400);

  const key = generateLicenseKey();
  const id = crypto.randomUUID();
  await c.env.DB
    .prepare(
      `INSERT INTO licenses (id, key_hash, key_hint, customer_name, customer_email, plan, max_devices, status, expires_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(id, await sha256Hex(key), key.slice(-5), name, clip(body.customerEmail, 160), clip(body.plan, 40) || 'standard', maxDevices, expiresAt, clip(body.notes, 1000), t, t)
    .run();
  await logEvent(c.env.DB, 'admin_created', { licenseId: id, detail: name });
  const lic = await c.env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first<LicenseRow>();
  // The key is shown once; only its hash is stored.
  return c.json({ ok: true, key, license: toPublic(lic!) }, 201);
});

adminApi.get('/licenses/:id', async (c) => {
  const id = c.req.param('id');
  const lic = await c.env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first<LicenseRow>();
  if (!lic) return c.json({ ok: false, error: 'No encontrada.' }, 404);
  const [devices, events] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM devices WHERE license_id = ? ORDER BY status ASC, last_seen DESC').bind(id).all<DeviceRow>(),
    c.env.DB.prepare('SELECT id, device_id, type, detail, ip, created_at FROM events WHERE license_id = ? ORDER BY id DESC LIMIT 50').bind(id).all(),
  ]);
  return c.json({
    ok: true,
    license: toPublic(lic),
    devices: devices.results.map((d) => ({
      id: d.id,
      name: d.device_name,
      revitVersion: d.revit_version,
      appVersion: d.app_version,
      status: d.status,
      firstSeen: d.first_seen,
      lastSeen: d.last_seen,
      releasedAt: d.released_at,
    })),
    events: events.results,
  });
});

adminApi.patch('/licenses/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as any;
  const lic = await c.env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first<LicenseRow>();
  if (!lic) return c.json({ ok: false, error: 'No encontrada.' }, 404);

  const next = {
    customer_name: body.customerName !== undefined ? clip(body.customerName, 120) : lic.customer_name,
    customer_email: body.customerEmail !== undefined ? clip(body.customerEmail, 160) : lic.customer_email,
    plan: body.plan !== undefined ? clip(body.plan, 40) || lic.plan : lic.plan,
    notes: body.notes !== undefined ? clip(body.notes, 1000) : lic.notes,
    max_devices: body.maxDevices !== undefined ? Math.floor(Number(body.maxDevices)) : lic.max_devices,
    status: body.status !== undefined ? String(body.status) : lic.status,
    expires_at: body.expiresAt !== undefined ? Math.floor(Number(body.expiresAt)) : lic.expires_at,
  };
  if (!next.customer_name) return c.json({ ok: false, error: 'El nombre es obligatorio.' }, 400);
  if (!(next.max_devices >= 1 && next.max_devices <= 100)) return c.json({ ok: false, error: 'Equipos permitidos: 1 a 100.' }, 400);
  if (!['active', 'suspended', 'revoked'].includes(next.status)) return c.json({ ok: false, error: 'Estado inválido.' }, 400);
  if (!Number.isFinite(next.expires_at) || next.expires_at <= 0) return c.json({ ok: false, error: 'Vencimiento inválido.' }, 400);

  await c.env.DB
    .prepare('UPDATE licenses SET customer_name=?, customer_email=?, plan=?, notes=?, max_devices=?, status=?, expires_at=?, updated_at=? WHERE id=?')
    .bind(next.customer_name, next.customer_email, next.plan, next.notes, next.max_devices, next.status, next.expires_at, now(), id)
    .run();
  const changes: string[] = [];
  if (next.status !== lic.status) changes.push(`estado ${lic.status}→${next.status}`);
  if (next.expires_at !== lic.expires_at) changes.push(`vence ${new Date(next.expires_at * 1000).toISOString().slice(0, 10)}`);
  if (next.max_devices !== lic.max_devices) changes.push(`equipos ${lic.max_devices}→${next.max_devices}`);
  await logEvent(c.env.DB, 'admin_updated', { licenseId: id, detail: changes.join(', ') || 'datos' });
  const updated = await c.env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first<LicenseRow>();
  return c.json({ ok: true, license: toPublic(updated!) });
});

/** Extend from the later of "now" and the current expiry, so early renewals don't lose time. */
adminApi.post('/licenses/:id/extend', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as any;
  const days = Math.floor(Number(body.days));
  if (!(days >= 1 && days <= 3650)) return c.json({ ok: false, error: 'Días: 1 a 3650.' }, 400);
  const lic = await c.env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first<LicenseRow>();
  if (!lic) return c.json({ ok: false, error: 'No encontrada.' }, 404);
  const expiresAt = Math.max(lic.expires_at, now()) + days * DAY;
  await c.env.DB.prepare('UPDATE licenses SET expires_at = ?, updated_at = ? WHERE id = ?').bind(expiresAt, now(), id).run();
  await logEvent(c.env.DB, 'admin_extended', { licenseId: id, detail: `+${days} días` });
  return c.json({ ok: true, expiresAt });
});

adminApi.post('/licenses/:id/regenerate-key', async (c) => {
  const id = c.req.param('id');
  const lic = await c.env.DB.prepare('SELECT id FROM licenses WHERE id = ?').bind(id).first();
  if (!lic) return c.json({ ok: false, error: 'No encontrada.' }, 404);
  const key = generateLicenseKey();
  await c.env.DB
    .prepare('UPDATE licenses SET key_hash = ?, key_hint = ?, updated_at = ? WHERE id = ?')
    .bind(await sha256Hex(key), key.slice(-5), now(), id)
    .run();
  await logEvent(c.env.DB, 'admin_key_regenerated', { licenseId: id });
  return c.json({ ok: true, key });
});

adminApi.delete('/licenses/:id', async (c) => {
  const id = c.req.param('id');
  const lic = await c.env.DB.prepare('SELECT customer_name FROM licenses WHERE id = ?').bind(id).first<{ customer_name: string }>();
  if (!lic) return c.json({ ok: false, error: 'No encontrada.' }, 404);
  await c.env.DB.prepare('DELETE FROM devices WHERE license_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM licenses WHERE id = ?').bind(id).run();
  await logEvent(c.env.DB, 'admin_deleted', { detail: lic.customer_name });
  return c.json({ ok: true });
});

adminApi.post('/licenses/:id/devices/:deviceId/release', async (c) => {
  const { id, deviceId } = c.req.param();
  const row = await c.env.DB
    .prepare("UPDATE devices SET status = 'released', released_at = ? WHERE id = ? AND license_id = ? AND status = 'active' RETURNING device_name")
    .bind(now(), deviceId, id)
    .first<{ device_name: string }>();
  if (!row) return c.json({ ok: false, error: 'Equipo no encontrado o ya liberado.' }, 404);
  await logEvent(c.env.DB, 'admin_released_device', { licenseId: id, deviceId, detail: row.device_name });
  return c.json({ ok: true });
});

// ---------- events ----------
adminApi.get('/events', async (c) => {
  const type = clip(c.req.query('type'), 40);
  const page = Math.max(0, parseInt(c.req.query('page') ?? '0', 10) || 0);
  const size = 50;
  const rows = await c.env.DB
    .prepare(
      `SELECT e.id, e.type, e.detail, e.ip, e.created_at, e.license_id, l.customer_name, l.key_hint
       FROM events e LEFT JOIN licenses l ON l.id = e.license_id
       ${type ? 'WHERE e.type = ?' : ''}
       ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...(type ? [type] : []), size + 1, page * size)
    .all();
  return c.json({ ok: true, page, hasMore: rows.results.length > size, events: rows.results.slice(0, size) });
});
