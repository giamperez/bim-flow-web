import { describe, expect, it } from 'vitest';
import { createSession, generateLicenseKey, normalizeKey, sha256Hex, signToken, verifySession, verifyToken } from '../src/crypto';
import type { TokenPayload } from '../src/types';

describe('license keys', () => {
  it('generates canonical keys that normalise to themselves', () => {
    for (let i = 0; i < 50; i++) {
      const k = generateLicenseKey();
      expect(k).toMatch(/^XPBM(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
      expect(normalizeKey(k)).toBe(k);
    }
  });
  it('is tolerant to case, spaces, missing dashes and look-alike characters', () => {
    expect(normalizeKey(' xpbm 0o1il abcde fghjk mnpqr ')).toBe('XPBM-00111-ABCDE-FGHJK-MNPQR');
  });
  it('rejects malformed input', () => {
    for (const bad of ['', 'XPBM', 'ABCD-AAAAA-AAAAA-AAAAA-AAAAA', 'XPBM-AAAAA-AAAAA-AAAAA', 'XPBM-UUUUU-AAAAA-AAAAA-AAAAA', 42, null, 'x'.repeat(100)]) {
      expect(normalizeKey(bad as any)).toBeNull();
    }
  });
  it('is unique across many generations', () => {
    expect(new Set(Array.from({ length: 2000 }, generateLicenseKey)).size).toBe(2000);
  });
});

describe('signed tokens', () => {
  const payload: TokenPayload = { v: 1, lid: 'l1', dev: 'a'.repeat(64), name: 'ACME', plan: 'standard', exp: 2000000000, iat: 1700000000, chk: 1700600000 };

  async function keypair() {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    return { privJson: JSON.stringify(priv), pub };
  }

  it('round-trips and produces a 64-byte P1363 signature', async () => {
    const { privJson, pub } = await keypair();
    const token = await signToken(privJson, payload);
    expect(await verifyToken(pub, token)).toEqual(payload);
    const sig = token.split('.')[1];
    expect(Buffer.from(sig, 'base64url').length).toBe(64);
  });
  it('rejects tampered payloads and foreign keys', async () => {
    const a = await keypair();
    const b = await keypair();
    const token = await signToken(a.privJson, payload);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, exp: 9999999999 })).toString('base64url');
    expect(await verifyToken(a.pub, `${forged}.${sig}`)).toBeNull();
    expect(await verifyToken(b.pub, token)).toBeNull();
    expect(body.length).toBeGreaterThan(0);
  });
});

describe('admin session', () => {
  it('accepts a fresh session and rejects tampering, wrong secret and expiry', async () => {
    const s = await createSession('secret-one', 60);
    expect(await verifySession('secret-one', s)).toBe(true);
    expect(await verifySession('secret-two', s)).toBe(false);
    expect(await verifySession('secret-one', s.slice(0, -2) + 'xx')).toBe(false);
    expect(await verifySession('secret-one', await createSession('secret-one', -5))).toBe(false);
    expect(await verifySession('secret-one', undefined)).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches the known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
