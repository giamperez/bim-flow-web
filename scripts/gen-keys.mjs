// Genera el par de claves ECDSA P-256 que firma las licencias y los secretos locales de desarrollo.
//   node scripts/gen-keys.mjs          -> imprime la clave privada (JWK) y la pública para el complemento
//   node scripts/gen-keys.mjs --dev    -> además escribe .dev.vars (solo si no existe) para `wrangler dev`
import { webcrypto as crypto } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
const privJson = JSON.stringify({ kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d });
const rand = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');

const b64 = (u) => Buffer.from(u, 'base64url').toString('base64');
console.log('=== CLAVE PRIVADA (secreto SIGNING_KEY_JWK; nunca la subas a git) ===');
console.log(privJson);
console.log('\n=== CLAVE PÚBLICA para el complemento de Revit (C#, ECParameters.Q) ===');
console.log('X (base64):', b64(pub.x));
console.log('Y (base64):', b64(pub.y));
console.log('\nJWK público:', JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }));

if (process.argv.includes('--dev')) {
  if (existsSync('.dev.vars')) {
    console.log('\n.dev.vars ya existe; no se sobrescribe.');
  } else {
    const adminPassword = rand(12);
    writeFileSync(
      '.dev.vars',
      `SIGNING_KEY_JWK='${privJson}'\nADMIN_PASSWORD=${adminPassword}\nSESSION_SECRET=${rand(32)}\n`,
    );
    console.log(`\n.dev.vars creado. Contraseña del panel (solo desarrollo): ${adminPassword}`);
  }
}
