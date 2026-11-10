// Pruebas del portal del cliente, pedidos y licencias de minutos (servidor PHP).
//   BASE_URL=http://127.0.0.1:8788 ADMIN_PASSWORD=... node test/e2e-portal.mjs
// Con payment_mode "manual" (por defecto) se prueba la aprobación por el administrador;
// con XP_PAYMENT_MODE=test en la instalación, la compra se aprueba al instante (E2E_PAYMENT_MODE=test).
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8788';
const adminPassword = process.env.ADMIN_PASSWORD;
const MODE = process.env.E2E_PAYMENT_MODE ?? 'manual';
if (!adminPassword) { console.log('Falta ADMIN_PASSWORD'); process.exit(2); }

let pass = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { failed++; console.log('  ✗ FALLO:', name, extra); } };
const tag = (s) => console.log('\n' + s);
const jar = { admin: '', a: '', b: '', c: '', d: '', e: '' };
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE);

async function call(who, method, path, body, { csrf = true, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar[who]) headers.Cookie = jar[who];
  if (csrf) headers['X-Requested-With'] = 'bimflow';
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) { const m = set.match(/(bf_admin|bf_user)=([^;]*)/); if (m) jar[who] = m[2] ? `${m[1]}=${m[2]}` : ''; }
  return { status: res.status, json: await res.json().catch(() => null) };
}
const adm = (m, p, b, o) => call('admin', m, '/admin/api' + p, b, o);
const por = (who, m, p, b, o) => call(who, m, '/portal/api' + p, b, o);
const dev = (n) => n.toString(16).padStart(64, '0');
const lic = (key, n) => ({ key, deviceId: dev(n), deviceName: `PC-${n}`, appVersion: '3.1.0', revitVersion: '2025' });
const api = (p, b) => call('none', 'POST', '/api/v1' + p, b);
const stamp = Date.now();
const emailA = `a.${stamp}@example.test`, emailB = `b.${stamp}@example.test`;

tag('Admin: licencias de minutos');
check('login admin', (await call('admin', 'POST', '/admin/api/login', { password: adminPassword })).status === 200);
const mins = await adm('POST', '/licenses', { customerName: 'Prueba minutos', maxDevices: 1, minutes: 2 });
check('crea licencia de 2 minutos', mins.status === 201, JSON.stringify(mins.json));
const mkey = mins.json.key;
const left = mins.json.license.expiresAt - Math.floor(Date.now() / 1000);
check('vence en ~2 minutos', left > 100 && left <= 121, String(left));
const tk = await api('/activate', lic(mkey, 1));
check('activa y el token vence con la licencia', tk.status === 200 && (() => { const p = JSON.parse(Buffer.from(tk.json.token.split('.')[0], 'base64url')); return p.chk === p.exp && p.exp === mins.json.license.expiresAt; })());
check('minutos fuera de rango rechazados', (await adm('POST', '/licenses', { customerName: 'x', minutes: 99999999 })).status === 400);
await adm('PATCH', '/licenses/' + mins.json.license.id, { expiresAt: Math.floor(Date.now() / 1000) - 5 });
check('vencida a los pocos minutos → expired', (await api('/validate', lic(mkey, 1))).json?.error === 'expired');
const ext = await adm('POST', `/licenses/${mins.json.license.id}/extend`, { minutes: 3 });
check('extender por minutos', ext.status === 200 && ext.json.expiresAt - Math.floor(Date.now() / 1000) <= 185 && ext.json.expiresAt - Math.floor(Date.now() / 1000) >= 170, JSON.stringify(ext.json));
check('tras extender valida', (await api('/validate', lic(mkey, 1))).status === 200);
await adm('DELETE', '/licenses/' + mins.json.license.id);

tag('Landing: solicitud de demo');
check('demo con correo válido', (await por('none', 'POST', '/lead', { email: `lead.${stamp}@example.test` })).status === 200);
check('demo con correo inválido → 400', (await por('none', 'POST', '/lead', { email: 'no-es-correo' })).status === 400);
check('la solicitud queda en la actividad del admin', (await adm('GET', '/events?type=demo_request')).json.events.some((e) => e.detail === `lead.${stamp}@example.test`));

tag('Portal: cuentas y seguridad');
const pub = (await por('none', 'GET', '/plans')).json;
check('planes públicos con prueba gratis, mensual y anual', pub?.plans?.length === 3 && ['prueba', 'mensual', 'anual'].every((id) => pub.plans.some((p) => p.id === id)), JSON.stringify(pub?.plans?.map((p) => p.id)));
check('no existe el plan de 10 minutos', !pub.plans.some((p) => p.seconds < 86400));
const trialPlan = pub.plans.find((p) => p.id === 'prueba');
check('la prueba dura 7 días y es gratis', trialPlan.trial === true && trialPlan.priceCents === 0 && trialPlan.seconds === 7 * 86400, JSON.stringify(trialPlan));
check('informa el tramo de precio vigente', pub.tier && pub.tier.index === 0 && typeof pub.tier.name === 'string' && pub.tier.trialDays === 7 && pub.tier.nextPrices && pub.tier.nextPrices.mensual > pub.plans.find((p) => p.id === 'mensual').priceCents, JSON.stringify(pub.tier));
check('visitante: trialAvailable desconocido', pub.trialAvailable === null);
check('sin sesión → 401', (await por('a', 'GET', '/license')).status === 401);
check('correo inválido', (await por('a', 'POST', '/register', { email: 'x', name: 'A', password: '12345678' })).status === 400);
check('contraseña corta', (await por('a', 'POST', '/register', { email: emailA, name: 'A', password: '123' })).status === 400);
const regA = await por('a', 'POST', '/register', { email: emailA, name: 'Cliente A', password: 'clave-segura-1' });
check('registro', regA.status === 201 && jar.a.startsWith('bf_user='), JSON.stringify(regA.json));
check('correo repetido → 409', (await por('b', 'POST', '/register', { email: emailA, name: 'X', password: 'clave-segura-1' })).status === 409);
check('login incorrecto → 401', (await por('b', 'POST', '/login', { email: emailA, password: 'mala' })).status === 401);
check('correo inexistente → 401 (mismo mensaje)', (await por('b', 'POST', '/login', { email: 'nadie@example.test', password: 'x' })).json?.error === 'Correo o contraseña incorrectos.');
check('mutación sin CSRF → 403', (await por('a', 'POST', '/orders', { planId: 'mensual' }, { csrf: false })).status === 403);
// Se reutiliza el VALOR de una cookie firmada bajo el nombre de la otra: la firma no debe valer en ambos lados.
const userVal = jar.a.split('=').slice(1).join('='), adminVal = jar.admin.split('=').slice(1).join('=');
check('cookie de cliente NO sirve como sesión de admin', (await fetch(BASE + '/admin/api/stats', { headers: { Cookie: `bf_admin=${userVal}` } })).status === 401);
check('cookie de admin NO sirve en el portal', (await fetch(BASE + '/portal/api/me', { headers: { Cookie: `bf_user=${adminVal}` } })).status === 401);
check('licencia vacía al inicio', (await por('a', 'GET', '/license')).json?.license === null);

tag('Portal: compra, aprobación y licencia propia');
check('plan inexistente', (await por('a', 'POST', '/orders', { planId: 'no-existe' })).status === 400);
const o1 = await por('a', 'POST', '/orders', { planId: 'mensual' });
check('crea pedido', o1.status === 201 && /^BF-/.test(o1.json.order.code), JSON.stringify(o1.json));
if (MODE === 'test') {
  check('modo prueba: pedido pagado al instante', o1.json.paid === true);
} else {
  check('pedido queda pendiente con instrucciones', o1.json.paid === false && o1.json.order.status === 'pending' && o1.json.instructions.length > 10);
  check('aún sin licencia', (await por('a', 'GET', '/license')).json?.license === null);
  const pend = await adm('GET', '/orders?status=pending');
  const row = pend.json.orders.find((o) => o.code === o1.json.order.code);
  check('el admin ve el pedido', !!row && row.customerEmail === emailA);
  check('aprobar pedido', (await adm('POST', `/orders/${row.id}/approve`)).status === 200);
  check('aprobar de nuevo → 409', (await adm('POST', `/orders/${row.id}/approve`)).status === 409);
}
const L1 = (await por('a', 'GET', '/license')).json.license;
check('licencia creada con clave visible para su dueño', L1 && /^XPBM(-\w{5}){4}$/.test(L1.key) && L1.maxDevices === 1 && L1.state === 'active', JSON.stringify(L1));
const days = (L1.expiresAt - Math.floor(Date.now() / 1000)) / 86400;
check('vence en ~30 días', days > 29.9 && days <= 30.1, String(days));
check('la clave del portal activa el plugin', (await api('/activate', lic(L1.key, 1))).status === 200);
check('segundo equipo excede el plan de 1', (await api('/activate', lic(L1.key, 2))).json?.error === 'device_limit');

tag('Portal: renovación');
const o2 = await por('a', 'POST', '/orders', { planId: 'anual' });
check('pedido de renovación', o2.status === 201 && o2.json.order.kind === 'renew', JSON.stringify(o2.json));
if (MODE !== 'test') {
  const row2 = (await adm('GET', '/orders?status=pending')).json.orders.find((o) => o.code === o2.json.order.code);
  await adm('POST', `/orders/${row2.id}/approve`);
}
const L2 = (await por('a', 'GET', '/license')).json.license;
check('renovación suma 365 días y amplía a 2 equipos', L2.id === L1.id && L2.expiresAt - L1.expiresAt === 365 * 86400 && L2.maxDevices === 2, `${L2.expiresAt - L1.expiresAt} / ${L2.maxDevices}`);
check('la misma clave sigue vigente', L2.key === L1.key);
check('ahora admite el segundo equipo', (await api('/activate', lic(L1.key, 2))).status === 200);
const orders = (await por('a', 'GET', '/orders')).json.orders;
check('historial de pedidos', orders.length === 2 && orders.every((o) => o.status === 'paid'));

tag('Portal: gestionar la propia licencia');
const devices = (await por('a', 'GET', '/license')).json.license.devices.filter((d) => d.status === 'active');
check('lista 2 equipos activos', devices.length === 2);
check('libera un equipo', (await por('a', 'POST', `/license/devices/${devices[0].id}/release/`.replace(/\/$/, ''))).status === 200);
check('el equipo liberado deja de validar', (await api('/validate', lic(L1.key, devices[0].name === 'PC-1' ? 1 : 2))).json?.error === 'device_not_activated');
const regen = await por('a', 'POST', '/license/regenerate-key');
check('regenera su clave', regen.status === 200 && regen.json.key !== L1.key);
check('clave vieja inválida', (await api('/validate', lic(L1.key, 2))).json?.error === 'invalid_key');
check('el portal muestra la clave nueva', (await por('a', 'GET', '/license')).json.license.key === regen.json.key);

tag('Aislamiento entre clientes');
const regB = await por('b', 'POST', '/register', { email: emailB, name: 'Cliente B', password: 'clave-segura-2' });
check('cliente B sin licencia', regB.status === 201 && (await por('b', 'GET', '/license')).json.license === null);
check('B no puede liberar equipos de A', (await por('b', 'POST', `/license/devices/${devices[1].id}/release`)).status === 404);
check('B no puede regenerar una clave inexistente', (await por('b', 'POST', '/license/regenerate-key')).status === 404);
check('cancelar pedido pendiente (admin)', await (async () => {
  if (MODE === 'test') return true;
  const o = await por('b', 'POST', '/orders', { planId: 'mensual' });
  const r = (await adm('GET', '/orders?status=pending')).json.orders.find((x) => x.code === o.json.order.code);
  return (await adm('POST', `/orders/${r.id}/cancel`)).status === 200 && (await adm('POST', `/orders/${r.id}/cancel`)).status === 409;
})());
check('logout', (await por('a', 'POST', '/logout')).status === 200 && (await por('a', 'GET', '/license')).status === 401);
const relogin = await por('a', 'POST', '/login', { email: emailA.toUpperCase(), password: 'clave-segura-1' });
check('login (correo sin distinguir mayúsculas)', relogin.status === 200);


tag('Prueba gratis de 7 días y control de abusos');
const aliasBase = `alias${stamp}`;
check('correo temporal rechazado', (await por('c', 'POST', '/register', { email: `x${stamp}@mailinator.com`, name: 'X', password: 'clave-segura-1' }, { ip: '10.1.0.1' })).status === 400);
const regC = await por('c', 'POST', '/register', { email: `${aliasBase}@gmail.com`, name: 'Cliente C', password: 'clave-segura-1' }, { ip: '10.1.0.2' });
check('registro de cliente C', regC.status === 201);
check('alias de Gmail con puntos y +etiqueta rechazado', (await por('d', 'POST', '/register', { email: `${aliasBase.slice(0, 5)}.${aliasBase.slice(5)}+promo@gmail.com`, name: 'Alias', password: 'clave-segura-1' }, { ip: '10.1.0.3' })).status === 409);
check('trialAvailable para un cliente nuevo', (await por('c', 'GET', '/plans')).json.trialAvailable === true);
const tc = await por('c', 'POST', '/orders', { planId: 'prueba' }, { ip: '9.9.9.1' });
check('la prueba se aprueba sola (aunque el pago sea manual)', tc.status === 201 && tc.json.paid === true && tc.json.order.amountCents === 0 && tc.json.order.kind === 'trial', JSON.stringify(tc.json));
const LT = (await por('c', 'GET', '/license')).json.license;
const trialDays = (LT.expiresAt - Math.floor(Date.now() / 1000)) / 86400;
check('licencia de prueba: 7 días, 1 equipo, marcada como prueba', LT.isTrial === true && trialDays > 6.99 && trialDays <= 7.01 && LT.maxDevices === 1, `${trialDays} ${LT.maxDevices} ${LT.isTrial}`);
check('no puede pedir una segunda prueba', (await por('c', 'POST', '/orders', { planId: 'prueba' }, { ip: '9.9.9.1' })).status === 409);
check('trialAvailable pasa a false', (await por('c', 'GET', '/plans')).json.trialAvailable === false);
check('la prueba activa en un equipo', (await api('/activate', lic(LT.key, 50))).status === 200);

const regD = await por('d', 'POST', '/register', { email: `otra.${stamp}@example.test`, name: 'Cliente D', password: 'clave-segura-1' }, { ip: '10.1.0.4' });
check('registro de cliente D', regD.status === 201);
await por('d', 'POST', '/orders', { planId: 'prueba' }, { ip: '9.9.9.2' });
const LD = (await por('d', 'GET', '/license')).json.license;
const reuse = await api('/activate', lic(LD.key, 50));
check('el mismo equipo no puede usar la prueba de otra cuenta → trial_used', reuse.status === 403 && reuse.json.error === 'trial_used', JSON.stringify(reuse.json));
check('otro equipo sí puede usarla', (await api('/activate', lic(LD.key, 51))).status === 200);
check('la prueba de C sigue funcionando en su equipo', (await api('/validate', lic(LT.key, 50))).status === 200);

// al comprar un plan de pago la licencia deja de ser de prueba y ya no está limitada a un equipo "estrenado"
const buyD = await por('d', 'POST', '/orders', { planId: 'anual' });
if (MODE !== 'test') {
  const rowD = (await adm('GET', '/orders?status=pending')).json.orders.find((o) => o.code === buyD.json.order.code);
  await adm('POST', `/orders/${rowD.id}/approve`);
}
const LD2 = (await por('d', 'GET', '/license')).json.license;
check('al pagar deja de ser prueba, suma 365 días y 2 equipos', LD2.isTrial === false && LD2.maxDevices === 2 && LD2.expiresAt - LD.expiresAt === 365 * 86400, JSON.stringify({ t: LD2.isTrial, d: LD2.maxDevices, x: LD2.expiresAt - LD.expiresAt }));
check('ya pagada puede usarse en un equipo que hizo otra prueba', (await api('/activate', lic(LD2.key, 50))).status === 200);

if (LOCAL) {
  // Tope de 3 pruebas por red en 30 días (con IPs simuladas, solo en local)
  const results = [];
  for (let i = 0; i < 4; i++) {
    const who = i % 2 === 0 ? 'e' : 'b';
    await por(who, 'POST', '/register', { email: `tope${i}.${stamp}@example.test`, name: `Tope ${i}`, password: 'clave-segura-1' }, { ip: `10.2.0.${i + 1}` });
    results.push((await por(who, 'POST', '/orders', { planId: 'prueba' }, { ip: '9.9.9.9' })).status);
  }
  check('4.ª prueba desde la misma red → 429', results.slice(0, 3).every((c) => c === 201) && results[3] === 429, results.join(','));
} else console.log('  (omitido: tope de pruebas por IP; solo se prueba en local)');

console.log(`\n${pass} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
