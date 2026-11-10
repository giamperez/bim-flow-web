// Prueba del cliente SMTP del servidor contra un servidor SMTP simulado (sin cifrado, con AUTH LOGIN).
//   PHP=ruta/a/php node test/smtp-test.mjs      (requiere php/app/config.php de desarrollo; lo restaura al terminar)
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PHP = process.env.PHP ?? 'php';
const root = resolve(import.meta.dirname, '..');
const configFile = join(root, 'php/app/config.php');
let pass = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { failed++; console.log('  ✗ FALLO:', name, extra); } };

// ---- servidor SMTP simulado
const received = [];
const server = net.createServer((sock) => {
  sock.on('error', () => {}); // el cliente cierra la conexión sin esperar: es normal
  let state = 'cmd', buf = '', msg = '', session = { auth: [], from: null, to: [] };
  const send = (s) => sock.write(s + '\r\n');
  send('220 fake.local ESMTP listo');
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    for (;;) {
      if (state === 'data') {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) { msg += buf; buf = ''; return; }
        msg += buf.slice(0, end); buf = buf.slice(end + 5);
        received.push({ ...session, raw: msg }); msg = ''; state = 'cmd'; send('250 OK mensaje en cola');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      if (state === 'user') { session.auth.push(Buffer.from(line, 'base64').toString()); state = 'pass'; send('334 UGFzc3dvcmQ6'); continue; }
      if (state === 'pass') { session.auth.push(Buffer.from(line, 'base64').toString()); state = 'cmd'; send(session.auth[1] === 'secreto' ? '235 autenticado' : '535 credenciales inválidas'); continue; }
      const up = line.toUpperCase();
      if (up.startsWith('EHLO')) { send('250-fake.local'); send('250-AUTH LOGIN'); send('250 8BITMIME'); }
      else if (up === 'AUTH LOGIN') { state = 'user'; send('334 VXNlcm5hbWU6'); }
      else if (up.startsWith('MAIL FROM:')) { session.from = line.slice(10); send('250 OK'); }
      else if (up.startsWith('RCPT TO:')) { session.to.push(line.slice(8)); send('250 OK'); }
      else if (up === 'DATA') { state = 'data'; send('354 adelante'); }
      else if (up === 'QUIT') { send('221 adiós'); sock.end(); }
      else send('500 no entendido');
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---- el servidor PHP envía un correo a ese SMTP
const original = readFileSync(configFile, 'utf8');
const script = join(mkdtempSync(join(tmpdir(), 'smtp-')), 'send.php');
writeFileSync(script, `<?php
$f = ${JSON.stringify(configFile)};
$c = require $f;
$c['public_url'] = 'https://bimflow.example.test';
$c['mail'] = ['driver' => 'smtp', 'host' => '127.0.0.1', 'port' => ${port}, 'encryption' => 'none', 'username' => $argv[1], 'password' => $argv[2], 'from_email' => 'no-reply@bimflow.example.test', 'from_name' => 'BIM FLOW · Verificación'];
file_put_contents($f, "<?php\\nreturn " . var_export($c, true) . ";\\n");
require ${JSON.stringify(join(root, 'php/app/bootstrap.php'))};
$ok = xp_send_mail('cliente@example.test', 'Confirma tu correo — ñandú ✓', xp_mail_template('Confirma tu correo', '<p>Hola José, tu código ñ.</p>', 'https://bimflow.example.test/portal/#verify=abc', 'Confirmar'), '');
echo $ok ? 'OK' : 'FALLO';
`);
// Asíncrono: el servidor SMTP simulado vive en este mismo proceso y debe poder responder mientras PHP espera.
const run = (user, pass) => new Promise((resolveRun) => {
  const child = spawn(PHP, [script, user, pass], { env: { ...process.env, OPENSSL_CONF: process.env.OPENSSL_CONF ?? '' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.on('close', () => resolveRun({ stdout, stderr }));
});

try {
  const ok = await run('usuario@smtp.test', 'secreto');
  check('el servidor envía por SMTP con AUTH LOGIN', ok.stdout.trim() === 'OK', ok.stdout + ok.stderr);
  const m = received[0];
  check('se autentica con el usuario y la contraseña configurados', m && m.auth[0] === 'usuario@smtp.test' && m.auth[1] === 'secreto', JSON.stringify(m?.auth));
  check('sobre SMTP correcto', m && m.from === '<no-reply@bimflow.example.test>' && m.to[0] === '<cliente@example.test>', JSON.stringify([m?.from, m?.to]));
  const raw = m?.raw ?? '';
  const header = (name) => (raw.match(new RegExp(`^${name}: (.*)$`, 'mi')) ?? [])[1];
  const dec = (v) => v.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  check('asunto con acentos y símbolos codificado en UTF-8', dec(header('Subject') ?? '') === 'Confirma tu correo — ñandú ✓', header('Subject'));
  check('remitente con nombre acentuado', dec(header('From') ?? '') === 'BIM FLOW · Verificación <no-reply@bimflow.example.test>', header('From'));
  check('cabeceras estándar', /<[0-9a-f]{24}@bimflow\.example\.test>/.test(header('Message-ID') ?? '') && /MIME-Version: 1\.0/i.test(raw) && header('Date'), header('Message-ID'));
  const parts = raw.split(/--bf_[0-9a-f]+/).filter((p) => p.includes('Content-Type: text/'));
  const body = (p) => Buffer.from(p.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  const text = parts.find((p) => p.includes('text/plain')), html = parts.find((p) => p.includes('text/html'));
  check('incluye versión de texto y versión HTML', !!text && !!html);
  check('el HTML conserva acentos y el enlace con la URL pública', html && body(html).includes('Hola José, tu código ñ.') && body(html).includes('https://bimflow.example.test/portal/#verify=abc'));
  check('la versión de texto se genera sola', text && body(text).includes('Hola José'));

  const bad = await run('usuario@smtp.test', 'mala');
  check('credenciales rechazadas → el envío falla sin romper la aplicación', bad.stdout.trim() === 'FALLO', bad.stdout);
} finally {
  writeFileSync(configFile, original);
  server.close();
}
console.log(`\n${pass} correctas, ${failed} fallidas`);
process.exit(failed ? 1 : 0);
