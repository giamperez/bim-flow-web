// Prueba de integración contra `wrangler dev` (puerto 8787) con D1 local.
//   Terminal 1: npm run db:migrate:local && npm run dev
//   Terminal 2: node test/e2e.mjs
import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^'|'$/g, '')]),
);
const priv = JSON.parse(vars.SIGNING_KEY_JWK);
const pub = await crypto.subtle.importKey('jwk', { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

let cookie = '';
let pass = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) pass++;
  else { failed++; console.log('  ✗ FALLO:', name, extra); }
};
const tag = (s) => console.log('\n' + s);

async function call(method, path, body, { ip, admin = false, csrf = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (admin && cookie) headers.Cookie = cookie;
  if (admin && csrf) headers['X-Requested-With'] = 'bimflow';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set && set.includes('bf_admin=')) cookie = set.split(';')[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}
const A = (m, p, b, o) => call(m, '/admin/api' + p, b, { admin: true, ...o });
const dev = (n) => n.toString(16).padStart(64, '0');
const lic = (key, n, extra = {}) => ({ key, deviceId: dev(n), deviceName: `PC-${n}`, appVersion: '3.1.0', revitVersion: '2024', ...extra });

async function tokenOk(token, deviceHash) {
  const [body, sig] = token.split('.');
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(sig, 'base64url'), Buffer.from(body));
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return ok && p.dev === deviceHash && p.chk <= p.exp && p.chk > p.iat;
}

tag('Admin: autenticación');
check('sin sesión → 401', (await A('GET', '/stats')).status === 401);
check('login incorrecto → 401', (await call('POST', '/admin/api/login', { password: 'x' }, { ip: '10.0.0.1' })).status === 401);
const login = await call('POST', '/admin/api/login', { password: vars.ADMIN_PASSWORD }, { ip: '10.0.0.1' });
check('login correcto', login.status === 200 && cookie.startsWith('bf_admin='));
check('mutación sin cabecera CSRF → 403', (await A('POST', '/licenses', { customerName: 'x', days: 5 }, { csrf: false })).status === 403);
for (let i = 0; i < 5; i++) await call('POST', '/admin/api/login', { password: 'bad' }, { ip: '10.9.9.9' });
check('bloqueo tras 5 logins fallidos → 429', (await call('POST', '/admin/api/login', { password: vars.ADMIN_PASSWORD }, { ip: '10.9.9.9' })).status === 429);

tag('Licencias: creación y validaciones');
check('nombre obligatorio', (await A('POST', '/licenses', { customerName: '', days: 30 })).status === 400);
check('vencimiento pasado rechazado', (await A('POST', '/licenses', { customerName: 'X', expiresAt: 1000 })).status === 400);
const created = await A('POST', '/licenses', { customerName: 'ACME Ingeniería', customerEmail: 'a@acme.test', maxDevices: 2, days: 30, notes: 'prueba' });
check('crea licencia', created.status === 201 && /^XPBM(-\w{5}){4}$/.test(created.json.key));
const { key } = created.json;
const id = created.json.license.id;
check('la clave no se devuelve en el detalle', !JSON.stringify((await A('GET', '/licenses/' + id)).json).includes(key));

tag('Cliente: activación y límite de equipos');
const a1 = await call('POST', '/api/v1/activate', lic(key, 1), { ip: '1.1.1.1' });
check('activa equipo 1', a1.status === 200 && a1.json.ok && (await tokenOk(a1.json.token, dev(1))), JSON.stringify(a1.json));
check('token con vigencia de gracia ≤ 7 días', (() => { const p = JSON.parse(Buffer.from(a1.json.token.split('.')[0], 'base64url')); return p.chk - p.iat === 7 * 86400; })());
const a2 = await call('POST', '/api/v1/activate', lic(key.toLowerCase().replace(/-/g, ' '), 2), { ip: '1.1.1.1' });
check('activa equipo 2 (clave en minúsculas/espacios)', a2.status === 200 && a2.json.license.devicesUsed === 2, JSON.stringify(a2.json));
const a3 = await call('POST', '/api/v1/activate', lic(key, 3), { ip: '1.1.1.1' });
check('equipo 3 → 409 device_limit con lista', a3.status === 409 && a3.json.error === 'device_limit' && a3.json.devices.length === 2, JSON.stringify(a3.json));
check('reactivar equipo 1 no consume otro cupo', (await call('POST', '/api/v1/activate', lic(key, 1), { ip: '1.1.1.1' })).status === 200);
check('validate de equipo activo', (await call('POST', '/api/v1/validate', lic(key, 1), { ip: '1.1.1.1' })).status === 200);
check('validate de equipo no activado → 409', (await call('POST', '/api/v1/validate', lic(key, 9), { ip: '1.1.1.1' })).json?.error === 'device_not_activated');
check('deviceId inválido → 400', (await call('POST', '/api/v1/activate', { ...lic(key, 1), deviceId: 'abc' }, { ip: '1.1.1.1' })).status === 400);

tag('Liberación de equipos');
const ref2 = a3.json.devices.find((d) => d.name === 'PC-2').ref;
check('libera equipo 2 con la clave', (await call('POST', '/api/v1/release', { key, ref: ref2 }, { ip: '1.1.1.1' })).status === 200);
check('equipo 3 ya puede activarse', (await call('POST', '/api/v1/activate', lic(key, 3), { ip: '1.1.1.1' })).status === 200);
check('equipo 2 liberado no valida', (await call('POST', '/api/v1/validate', lic(key, 2), { ip: '1.1.1.1' })).json?.error === 'device_not_activated');
check('deactivate desde el propio equipo', (await call('POST', '/api/v1/deactivate', lic(key, 3), { ip: '1.1.1.1' })).status === 200);
const detail = (await A('GET', '/licenses/' + id)).json;
const active = detail.devices.filter((d) => d.status === 'active');
check('admin ve 1 equipo activo', active.length === 1, JSON.stringify(detail.devices.map((d) => d.status)));
// agotar liberaciones por autoservicio (límite 3 / 30 días): ya se usó 1
const refs = [];
for (const n of [4, 5]) { await call('POST', '/api/v1/activate', lic(key, n), { ip: '1.1.1.1' }); }
const full = await call('POST', '/api/v1/activate', lic(key, 6), { ip: '1.1.1.1' });
for (const d of full.json.devices) refs.push(d.ref);
const r1 = await call('POST', '/api/v1/release', { key, ref: refs[0] }, { ip: '1.1.1.1' });
const r2 = await call('POST', '/api/v1/release', { key, ref: refs[1] }, { ip: '1.1.1.1' });
const r3 = await call('POST', '/api/v1/release', { key, ref: refs[1] }, { ip: '1.1.1.1' });
check('2 liberaciones más por autoservicio (3 en total) permitidas', r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
check('la 4.ª liberación en 30 días → 429 release_limit', r3.status === 429 && r3.json.error === 'release_limit', JSON.stringify(r3.json));

tag('Estados de la licencia');
check('equipo 1 se activa de nuevo (cupos liberados)', (await call('POST', '/api/v1/activate', lic(key, 1), { ip: '1.1.1.1' })).status === 200);
check('suspender', (await A('PATCH', '/licenses/' + id, { status: 'suspended' })).status === 200);
check('suspendida → 403 suspended', (await call('POST', '/api/v1/validate', lic(key, 1), { ip: '1.1.1.1' })).json?.error === 'suspended');
check('reactivar', (await A('PATCH', '/licenses/' + id, { status: 'active' })).status === 200);
check('reactivada valida', (await call('POST', '/api/v1/validate', lic(key, 1), { ip: '1.1.1.1' })).status === 200);
const nowS = Math.floor(Date.now() / 1000);
await A('PATCH', '/licenses/' + id, { expiresAt: nowS - 10 });
const exp = await call('POST', '/api/v1/validate', lic(key, 1), { ip: '1.1.1.1' });
check('vencida → 403 expired', exp.status === 403 && exp.json.error === 'expired');
check('vencida aparece como "expired" en el listado', (await A('GET', '/licenses?state=expired')).json.licenses.some((l) => l.id === id));
const ext = await A('POST', `/licenses/${id}/extend`, { days: 10 });
check('extender desde hoy si ya venció', ext.json.expiresAt >= nowS + 10 * 86400 - 5 && ext.json.expiresAt <= nowS + 10 * 86400 + 60, JSON.stringify(ext.json));
check('tras extender vuelve a validar', (await call('POST', '/api/v1/validate', lic(key, 1), { ip: '1.1.1.1' })).status === 200);
const tk = (await call('POST', '/api/v1/validate', lic(key, 1), { ip: '1.1.1.1' })).json.token;
const tp = JSON.parse(Buffer.from(tk.split('.')[0], 'base64url'));
check('chk limitado por vencimiento (10 días > 7 de gracia)', tp.chk - tp.iat === 7 * 86400);
await A('PATCH', '/licenses/' + id, { expiresAt: nowS + 2 * 86400 });
const tp2 = JSON.parse(Buffer.from((await call('POST', '/api/v1/validate', lic(key, 1), { ip: '1.1.1.1' })).json.token.split('.')[0], 'base64url'));
check('con 2 días restantes chk = vencimiento', tp2.chk === tp2.exp, `${tp2.chk} vs ${tp2.exp}`);
await A('PATCH', '/licenses/' + id, { expiresAt: nowS + 30 * 86400 });

tag('Regeneración de clave y revocación');
const regen = await A('POST', `/licenses/${id}/regenerate-key`);
check('regenera clave', regen.status === 200 && regen.json.key !== key);
check('clave antigua deja de funcionar', (await call('POST', '/api/v1/validate', lic(key, 1), { ip: '1.1.1.1' })).json?.error === 'invalid_key');
check('clave nueva funciona', (await call('POST', '/api/v1/validate', lic(regen.json.key, 1), { ip: '1.1.1.1' })).status === 200);
await A('PATCH', '/licenses/' + id, { status: 'revoked' });
check('revocada → 403 revoked', (await call('POST', '/api/v1/validate', lic(regen.json.key, 1), { ip: '1.1.1.1' })).json?.error === 'revoked');

tag('Abuso');
let last;
for (let i = 0; i < 21; i++) last = await call('POST', '/api/v1/activate', lic('XPBM-AAAAA-AAAAA-AAAAA-AAAAA', 1), { ip: '7.7.7.7' });
check('20 claves inválidas desde una IP → 429', last.status === 429, String(last.status));
check('otra IP no queda bloqueada', (await call('POST', '/api/v1/activate', lic('XPBM-AAAAA-AAAAA-AAAAA-AAAAA', 1), { ip: '8.8.8.8' })).status === 404);
check('JSON inválido → 400', (await fetch(BASE + '/api/v1/activate', { method: 'POST', body: 'no json' })).status === 400);

tag('Panel: estadísticas, listados y borrado');
const stats = await A('GET', '/stats');
check('stats responde', stats.status === 200 && typeof stats.json.licenses.total === 'number');
const ev = await A('GET', '/events');
check('eventos registran la actividad', ev.json.events.length > 10 && ev.json.events.some((e) => e.type === 'device_limit'));
check('búsqueda con comodines escapados', (await A('GET', '/licenses?q=' + encodeURIComponent('%'))).json.licenses.length === 0);
check('búsqueda por nombre', (await A('GET', '/licenses?q=acme')).json.licenses.length >= 1);
check('elimina licencia', (await A('DELETE', '/licenses/' + id)).status === 200);
check('detalle de eliminada → 404', (await A('GET', '/licenses/' + id)).status === 404);

console.log(`\n${pass} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
