// Cobro con Culqi contra un Culqi SIMULADO (no toca dinero ni la API real).
//   Instalar con: XP_PAYMENT_MODE=culqi XP_CULQI_PUBLIC=pk_test_FAKE123 XP_CULQI_SECRET=sk_test_FAKEKEY123 XP_CULQI_API=http://127.0.0.1:8799/v2 php app/bin/setup.php
//   BASE_URL=http://127.0.0.1:8788 ADMIN_PASSWORD=... node test/e2e-culqi.mjs
import http from 'node:http';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8788';
const adminPassword = process.env.ADMIN_PASSWORD;
const SECRET = 'sk_test_FAKEKEY123';
if (!adminPassword) { console.log('Falta ADMIN_PASSWORD'); process.exit(2); }

let pass = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { failed++; console.log('  ✗ FALLO:', name, extra); } };
const tag = (s) => console.log('\n' + s);

// ---------------- Culqi simulado
const charges = [];
let seq = 0;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url !== '/v2/charges' || req.method !== 'POST') return send(404, { object: 'error', merchant_message: 'ruta' });
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { object: 'error', type: 'authentication_error', user_message: 'llave inválida' });
    const body = JSON.parse(raw);
    charges.push({ ...body, auth: req.headers.authorization });
    if (body.source_id === 'tkn_test_ok1234') {
      return send(201, { object: 'charge', id: `chr_test_${++seq}`, amount: body.amount, currency_code: body.currency_code,
        outcome: { type: 'venta_exitosa', code: 'AUT0000', user_message: 'Su compra ha sido exitosa.' } });
    }
    if (body.source_id === 'tkn_test_declined') {
      return send(400, { object: 'error', type: 'card_error', code: 'card_declined', merchant_message: 'declined', user_message: 'La tarjeta fue rechazada por el banco. Prueba con otra.' });
    }
    if (body.source_id === 'tkn_test_boom00') return send(500, { object: 'error' });
    return send(400, { object: 'error', type: 'parameter_error', user_message: 'Token inválido.' });
  });
});
await new Promise((r) => fake.listen(8799, '127.0.0.1', r));

// ---------------- cliente HTTP
const jar = { admin: '', a: '', b: '' };
const bodies = [];
async function call(who, method, path, body, { ip } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'bimflow' };
  if (jar[who]) headers.Cookie = jar[who];
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) { const m = set.match(/(bf_admin|bf_user)=([^;]*)/); if (m) jar[who] = m[2] ? `${m[1]}=${m[2]}` : ''; }
  const text = await res.text();
  bodies.push(text);
  let json = null; try { json = JSON.parse(text); } catch { /* sin JSON */ }
  return { status: res.status, json };
}
const por = (who, m, p, b, o) => call(who, m, '/portal/api' + p, b, o);
const adm = (m, p, b) => call('admin', m, '/admin/api' + p, b);
const stamp = Date.now();

try {
  tag('Datos del formulario de pago');
  check('login admin', (await call('admin', 'POST', '/admin/api/login', { password: adminPassword })).status === 200);
  const plans = (await por('none', 'GET', '/plans')).json;
  check('el modo de pago es Culqi y solo se expone la llave PÚBLICA', plans.paymentMode === 'culqi' && plans.payment.provider === 'culqi' && plans.payment.publicKey === 'pk_test_FAKE123' && plans.payment.environment === 'test', JSON.stringify(plans.payment));

  const reg = await por('a', 'POST', '/register', { email: `cli.${stamp}@example.test`, name: 'Cliente Culqi', password: 'clave-segura-1' }, { ip: '10.7.0.1' });
  check('registro', reg.status === 201);

  tag('Compra con tarjeta aceptada');
  const o1 = await por('a', 'POST', '/orders', { planId: 'mensual' });
  check('crear el pedido devuelve los datos del pago, sin instrucciones manuales', o1.status === 201 && o1.json.paid === false && o1.json.payment.amount === 2500 && o1.json.payment.currency === 'PEN' && o1.json.payment.orderCode === o1.json.order.code && o1.json.instructions === '', JSON.stringify(o1.json));
  const code1 = o1.json.order.code;
  check('sin licencia hasta pagar', (await por('a', 'GET', '/license')).json.license === null);
  check('token con formato inválido → 400', (await por('a', 'POST', `/orders/${code1}/pay`, { token: 'x' })).status === 400);
  check('sin sesión → 401', (await por('b', 'POST', `/orders/${code1}/pay`, { token: 'tkn_test_ok1234' })).status === 401);
  // el navegador intenta falsificar el monto: se ignora
  const [p1, p2] = await Promise.all([
    por('a', 'POST', `/orders/${code1}/pay`, { token: 'tkn_test_ok1234', amount: 1, currency: 'USD' }),
    por('a', 'POST', `/orders/${code1}/pay`, { token: 'tkn_test_ok1234' }),
  ]);
  const statuses = [p1.status, p2.status].sort();
  check('dos pagos simultáneos del mismo pedido: uno cobra y el otro se rechaza', statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses));
  check('Culqi recibió UN solo cargo', charges.length === 1, String(charges.length));
  const c = charges[0];
  check('el cargo usa el monto y la moneda de la BASE DE DATOS (no los del navegador)', c.amount === 2500 && c.currency_code === 'PEN', JSON.stringify(c));
  check('el cargo lleva el correo, el token, la descripción y el código del pedido', c.email === `cli.${stamp}@example.test` && c.source_id === 'tkn_test_ok1234' && c.description.includes(code1) && c.metadata.order_code === code1, JSON.stringify(c));
  check('se autentica con la llave privada', c.auth === `Bearer ${SECRET}`);
  const L = (await por('a', 'GET', '/license')).json.license;
  check('tras el cobro se crea la licencia de 30 días con su clave', L && /^XPBM(-\w{5}){4}$/.test(L.key) && L.maxDevices === 1 && L.secondsLeft > 29 * 86400, JSON.stringify(L && { k: !!L.key, d: L.maxDevices, s: L.secondsLeft }));
  const orders = (await por('a', 'GET', '/orders')).json.orders;
  check('el pedido queda pagado', orders.find((o) => o.code === code1).status === 'paid');
  check('pagar otra vez el mismo pedido → 409', (await por('a', 'POST', `/orders/${code1}/pay`, { token: 'tkn_test_ok1234' })).status === 409);

  tag('Tarjeta rechazada: se puede reintentar sin duplicar');
  const o2 = await por('a', 'POST', '/orders', { planId: 'anual' });
  const code2 = o2.json.order.code;
  check('pedido de renovación anual a S/ 250 (tramo Fundadores, 10 mensualidades)', o2.json.payment.amount === 25000 && o2.json.order.kind === 'renew', JSON.stringify(o2.json.payment));
  const before = charges.length;
  const declined = await por('a', 'POST', `/orders/${code2}/pay`, { token: 'tkn_test_declined' });
  check('rechazo → 402 con el mensaje del banco', declined.status === 402 && declined.json.error.includes('rechazada'), JSON.stringify(declined.json));
  check('el pedido sigue pendiente para reintentar', (await por('a', 'GET', '/orders')).json.orders.find((o) => o.code === code2).status === 'pending');
  const retry = await por('a', 'POST', `/orders/${code2}/pay`, { token: 'tkn_test_ok1234' });
  check('reintento con otra tarjeta → pagado', retry.status === 200 && retry.json.paid === true);
  check('Culqi vio exactamente 2 cargos nuevos (1 rechazado + 1 aceptado)', charges.length === before + 2, String(charges.length - before));
  const L2 = (await por('a', 'GET', '/license')).json.license;
  check('la renovación suma 365 días y amplía a 2 equipos', L2.maxDevices === 2 && L2.expiresAt - L.expiresAt === 365 * 86400);

  tag('Corte de conexión: no se vuelve a cobrar');
  const o3 = await por('a', 'POST', '/orders', { planId: 'mensual' });
  const code3 = o3.json.order.code;
  const boom = await por('a', 'POST', `/orders/${code3}/pay`, { token: 'tkn_test_boom00' });
  check('error 5xx de Culqi → 502 con aviso de "no lo repitas"', boom.status === 502 && boom.json.pending === true && boom.json.error.includes('no lo repitas'), JSON.stringify(boom.json));
  check('el pedido queda "en verificación" (processing), NO vuelve a pendiente', (await por('a', 'GET', '/orders')).json.orders.find((o) => o.code === code3).status === 'processing');
  const n = charges.length;
  check('reintentar un pedido en verificación → 409 y NO se llama a Culqi', (await por('a', 'POST', `/orders/${code3}/pay`, { token: 'tkn_test_ok1234' })).status === 409 && charges.length === n);
  const row = (await adm('GET', '/orders?status=processing')).json.orders.find((o) => o.code === code3);
  check('el administrador ve el pedido en verificación', !!row);
  check('el administrador lo aprueba tras comprobarlo en Culqi', (await adm('POST', `/orders/${row.id}/approve`)).status === 200);
  check('queda pagado', (await por('a', 'GET', '/orders')).json.orders.find((o) => o.code === code3).status === 'paid');

  tag('Seguridad');
  const regB = await por('b', 'POST', '/register', { email: `otro.${stamp}@example.test`, name: 'Otro', password: 'clave-segura-2' }, { ip: '10.7.0.2' });
  const o4 = await por('a', 'POST', '/orders', { planId: 'mensual' });
  check('otro cliente no puede pagar un pedido ajeno', regB.status === 201 && (await por('b', 'POST', `/orders/${o4.json.order.code}/pay`, { token: 'tkn_test_ok1234' })).status === 404);
  check('el cliente puede cancelar un pedido pendiente', (await por('a', 'POST', `/orders/${o4.json.order.code}/cancel`)).status === 200);
  check('no puede cancelar uno ya pagado', (await por('a', 'POST', `/orders/${code1}/cancel`)).status === 409);
  const o5 = await por('a', 'POST', '/orders', { planId: 'mensual' });
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await por('a', 'POST', `/orders/${o5.json.order.code}/pay`, { token: 'tkn_test_declined' })).status;
  check('tope de intentos de pago por pedido (5 por hora) → 429', last === 429, String(last));
  check('la llave PRIVADA no aparece en ninguna respuesta del servidor', !bodies.some((b) => b.includes(SECRET) || b.includes('sk_test_')));
  check('la prueba gratis sigue siendo gratuita y no pasa por Culqi', await (async () => {
    const t = await por('b', 'POST', '/orders', { planId: 'prueba' }, { ip: '9.7.0.1' });
    return t.status === 201 && t.json.paid === true && t.json.payment === null;
  })());
} finally {
  fake.close();
}
console.log(`\n${pass} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
