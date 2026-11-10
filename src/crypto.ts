import type { TokenPayload } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

// ---------- License keys (Crockford base32, 100 bits of entropy) ----------
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const KEY_PREFIX = 'XPBM';

export function generateLicenseKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]);
  const groups: string[] = [];
  for (let i = 0; i < 20; i += 5) groups.push(chars.slice(i, i + 5).join(''));
  return `${KEY_PREFIX}-${groups.join('-')}`;
}

/** Returns canonical `XPBM-XXXXX-XXXXX-XXXXX-XXXXX` or null when malformed. */
export function normalizeKey(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!s.startsWith(KEY_PREFIX) || s.length !== KEY_PREFIX.length + 20) return null;
  const body = s.slice(KEY_PREFIX.length);
  if ([...body].some((c) => !ALPHABET.includes(c))) return null;
  return `${KEY_PREFIX}-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15)}`;
}

// ---------- Signed tokens: ECDSA P-256 / SHA-256, IEEE-P1363 (r||s) ----------
let cachedSigningKey: { jwk: string; key: CryptoKey } | null = null;

async function signingKey(jwkJson: string): Promise<CryptoKey> {
  if (cachedSigningKey?.jwk === jwkJson) return cachedSigningKey.key;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(jwkJson), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cachedSigningKey = { jwk: jwkJson, key };
  return key;
}

export async function signToken(jwkJson: string, payload: TokenPayload): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(jwkJson), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Mirror of what the Revit add-in does; used by tests. */
export async function verifyToken(publicJwk: JsonWebKey, token: string): Promise<TokenPayload | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(sig), enc.encode(body));
  return ok ? (JSON.parse(dec.decode(b64urlDecode(body))) as TokenPayload) : null;
}

// ---------- Admin session cookie (HMAC-SHA256) ----------
async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function createSession(secret: string, ttlSeconds: number): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(secret: string, cookie: string | undefined): Promise<boolean> {
  if (!cookie) return false;
  const [body, sig] = cookie.split('.');
  if (!body || !sig) return false;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), b64urlDecode(sig), enc.encode(body));
    if (!ok) return false;
    const { exp } = JSON.parse(dec.decode(b64urlDecode(body)));
    return typeof exp === 'number' && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}
