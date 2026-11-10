// Verificación de correo, recuperación de contraseña, avisos y descarga del instalador (servidor PHP con correo "log").
//   Instalar con: XP_MAIL_DRIVER=log XP_MAIL_LOG=<archivo> XP_ADMIN_EMAIL=admin@example.test php app/bin/setup.php
//   BASE_URL=http://127.0.0.1:8788 ADMIN_PASSWORD=... MAIL_LOG=<archivo> node test/e2e-mail.mjs
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8788';
const adminPassword = process.env.ADMIN_PASSWORD;
const MAIL_LOG = process.env.MAIL_LOG;
if (!adminPassword || !MAIL_LOG) { console.log('Faltan ADMIN_PASSWORD y MAIL_LOG'); process.exit(2); }

let pass = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { failed++; console.log('  ✗ FALLO:', name, extra); } };
const tag = (s) => console.log('\n' + s);
const jar = { admin: '', a: '', b: '' };

async function call(who, method, path, body, { ip, csrf = true, raw } = {}) {
  const headers = { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' };
  if (jar[who]) headers.Cookie = jar[who];
  if (csrf) headers['X-Requested-With'] = 'bimflow';
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(BASE + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const set = res.headers.get('set-cookie');
  if (set) { const m = set.match(/(bf_admin|bf_user)=([^;]*)/); if (m) jar[who] = m[2] ? `${m[1]}=${m[2]}` : ''; }
  return { status: res.status, json: await res.json().catch(() => null) };
}
const por = (who, m, p, b, o) => call(who, m, '/portal/api' + p, b, o);
const adm = (m, p, b, o) => call('admin', m, '/admin/api' + p, b, o);
const mails = () => (existsSync(MAIL_LOG) ? readFileSync(MAIL_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sentTo = (to, subject) => mails().filter((m) => m.to === to && (!subject || m.subject.includes(subject)));
const linkToken = (mail, key) => (mail.text.match(new RegExp(`#${key}=([A-Za-z0-9_-]+)`)) ?? [])[1];
const stamp = Date.now();
const emailA = `ana.${stamp}@example.test`;
const emailB = `beto.${stamp}@example.test`;

tag('Verificación de correo');
check('login admin', (await call('admin', 'POST', '/admin/api/login', { password: adminPassword })).status === 200);
const reg = await por('a', 'POST', '/register', { email: emailA, name: 'Ana', password: 'clave-segura-1' }, { ip: '10.5.0.1' });
check('registro: exige verificar y reporta el envío', reg.status === 201 && reg.json.verificationRequired === true && reg.json.verificationSent === true && reg.json.customer.verified === false, JSON.stringify(reg.json));
const m1 = sentTo(emailA, 'Confirma tu correo');
check('se envía UN correo de verificación con enlace', m1.length === 1 && /\/portal\/#verify=/.test(m1[0].text), JSON.stringify(m1.map((m) => m.subject)));
check('el correo lleva la marca y el botón', m1[0].html.includes('Confirmar mi correo') && m1[0].html.includes('/brand/logo-header.png'));
const tokenA = linkToken(m1[0], 'verify');
check('sin verificar no puede pedir la prueba gratis', (await por('a', 'POST', '/orders', { planId: 'prueba' }, { ip: '9.8.0.1' })).json?.code === 'unverified');
check('sin verificar no puede comprar', (await por('a', 'POST', '/orders', { planId: 'mensual' })).status === 403);
check('me: indica que falta verificar', (await por('a', 'GET', '/me')).json.customer.verified === false);
check('enlace inventado → 400', (await por('none', 'POST', '/verify', { token: 'x'.repeat(43) })).status === 400);
check('sin token → 400', (await por('none', 'POST', '/verify', {})).status === 400);

const r2 = await por('a', 'POST', '/resend-verification', {}, { ip: '10.5.0.1' });
check('reenviar el correo', r2.status === 200 && sentTo(emailA, 'Confirma tu correo').length === 2);
const tokenA2 = linkToken(sentTo(emailA, 'Confirma tu correo')[1], 'verify');
check('el enlace nuevo invalida al anterior', (await por('none', 'POST', '/verify', { token: tokenA })).status === 400);
await por('a', 'POST', '/resend-verification', {}, { ip: '10.5.0.1' });
check('tope de reenvíos: el 4.º en una hora → 429', (await por('a', 'POST', '/resend-verification', {}, { ip: '10.5.0.1' })).status === 429);

const tokenLast = linkToken(sentTo(emailA, 'Confirma tu correo')[2], 'verify');
check('verificar con el enlace', (await por('none', 'POST', '/verify', { token: tokenLast })).status === 200);
check('el mismo enlace otra vez sigue dando OK (ya verificado)', (await por('none', 'POST', '/verify', { token: tokenLast })).json?.alreadyVerified === true);
check('me: ahora está verificado', (await por('a', 'GET', '/me')).json.customer.verified === true);
const trial = await por('a', 'POST', '/orders', { planId: 'prueba' }, { ip: '9.8.0.1' });
check('ya puede activar la prueba gratis', trial.status === 201 && trial.json.paid === true);
check('recibe el aviso "prueba activa"', sentTo(emailA, 'prueba gratis de BIM FLOW está activa').length === 1);

tag('Olvidé mi contraseña');
const before = mails().length;
const unknown = await por('none', 'POST', '/forgot', { email: `nadie.${stamp}@example.test` }, { ip: '10.5.1.1' });
check('correo inexistente: misma respuesta y NO se envía nada', unknown.status === 200 && unknown.json.message.includes('Si existe una cuenta') && mails().length === before);
check('correo mal escrito → 400', (await por('none', 'POST', '/forgot', { email: 'no-es-correo' })).status === 400);
const known = await por('none', 'POST', '/forgot', { email: emailA }, { ip: '10.5.1.2' });
check('cuenta existente: misma respuesta', known.status === 200 && known.json.message === unknown.json.message);
const reset = sentTo(emailA, 'Restablece tu contraseña');
check('llega el correo con el enlace de restablecer', reset.length === 1 && /\/portal\/#reset=/.test(reset[0].text) && reset[0].html.includes('Crear una contraseña nueva'));
const rt = linkToken(reset[0], 'reset');
const oldCookie = jar.a;
check('contraseña corta rechazada', (await por('none', 'POST', '/reset', { token: rt, password: '123' })).status === 400);
check('token inventado rechazado', (await por('none', 'POST', '/reset', { token: 'y'.repeat(43), password: 'otra-clave-nueva' }, { ip: '10.5.1.3' })).status === 400);
const done = await por('none', 'POST', '/reset', { token: rt, password: 'otra-clave-nueva' }, { ip: '10.5.1.2' });
check('restablecer con el enlace', done.status === 200);
check('aviso de seguridad "contraseña cambiada"', sentTo(emailA, 'contraseña de BIM FLOW fue cambiada').length === 1);
check('el enlace es de un solo uso', (await por('none', 'POST', '/reset', { token: rt, password: 'tercera-clave-nueva' })).status === 400);
check('la contraseña vieja ya no sirve', (await por('b', 'POST', '/login', { email: emailA, password: 'clave-segura-1' }, { ip: '10.5.1.4' })).status === 401);
check('la contraseña nueva sí', (await por('b', 'POST', '/login', { email: emailA, password: 'otra-clave-nueva' }, { ip: '10.5.1.4' })).status === 200);
jar.a = oldCookie;
check('las sesiones abiertas antes del cambio se cierran', (await por('a', 'GET', '/me')).status === 401);

tag('Un correo se verifica al restablecer la contraseña');
const regB = await por('b', 'POST', '/register', { email: emailB, name: 'Beto', password: 'clave-segura-2' }, { ip: '10.5.2.1' });
check('registro de Beto sin verificar', regB.status === 201 && regB.json.customer.verified === false);
await por('none', 'POST', '/forgot', { email: emailB }, { ip: '10.5.2.2' });
const rtB = linkToken(sentTo(emailB, 'Restablece tu contraseña')[0], 'reset');
await por('none', 'POST', '/reset', { token: rtB, password: 'clave-nueva-beto' }, { ip: '10.5.2.2' });
const loginB = await por('b', 'POST', '/login', { email: emailB, password: 'clave-nueva-beto' }, { ip: '10.5.2.3' });
check('quien abre el enlace del correo demuestra que es suyo → queda verificado', loginB.status === 200 && loginB.json.customer.verified === true);
let limited = 0;
for (let i = 0; i < 4; i++) limited = (await por('none', 'POST', '/forgot', { email: emailB }, { ip: '10.5.2.9' })).status;
check('tope de solicitudes de recuperación por correo → 429', limited === 429, String(limited));

tag('Avisos de pedidos al cliente y al administrador');
const order = await por('b', 'POST', '/orders', { planId: 'mensual' }, { ip: '9.8.0.2' });
check('pedido creado (pendiente)', order.status === 201 && order.json.paid === false);
check('el cliente recibe "Recibimos tu pedido" con el código y las instrucciones', sentTo(emailB, 'Recibimos tu pedido ' + order.json.order.code).length === 1 && sentTo(emailB, 'Recibimos tu pedido')[0].text.includes('Realice el pago'));
const adminMail = sentTo('admin@example.test', 'Nuevo pedido por aprobar: ' + order.json.order.code);
check('el administrador recibe el aviso del pedido', adminMail.length === 1 && adminMail[0].text.includes('Beto'));
const row = (await adm('GET', '/orders?status=pending')).json.orders.find((o) => o.code === order.json.order.code);
check('aprobar el pago', (await adm('POST', `/orders/${row.id}/approve`)).status === 200);
check('el cliente recibe "Tu licencia está lista"', sentTo(emailB, 'Tu licencia de BIM FLOW está lista').length === 1);

tag('Instalador para clientes');
check('sin instalador publicado', (await por('none', 'GET', '/download')).json.installer === null);
check('subida sin .exe rechazada', (await adm('POST', '/installer?name=nota.txt', undefined, { raw: Buffer.from('MZhola') })).status === 400);
check('un archivo que no es ejecutable se rechaza', (await adm('POST', '/installer?name=XportBIM_Setup_v3.1.0.exe', undefined, { raw: Buffer.from('esto no es un exe') })).status === 400);
const fake = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(5000, 7)]);
const up = await adm('POST', '/installer?name=XportBIM_Setup_v3.1.0_Revit2023-2027.exe', undefined, { raw: fake });
check('el admin publica el instalador', up.status === 200 && up.json.installer.size === fake.length && up.json.installer.version === '3.1.0', JSON.stringify(up.json));
const crypto = await import('node:crypto');
const info = (await por('none', 'GET', '/download')).json.installer;
check('la descarga pública informa tamaño, versión y huella SHA-256 correcta', info && info.sha256 === crypto.createHash('sha256').update(fake).digest('hex') && info.url === '/downloads/XportBIM_Setup.exe');
const file = await fetch(BASE + info.url);
check('el archivo se descarga idéntico', file.status === 200 && Buffer.from(await file.arrayBuffer()).equals(fake));
check('subir sin sesión de admin → 401', (await call('none', 'POST', '/admin/api/installer?name=x.exe', undefined, { raw: fake })).status === 401);

console.log(`\n${pass} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
