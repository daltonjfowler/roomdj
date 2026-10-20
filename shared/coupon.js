// COUPONS (Dalton, 2026-10-20; built dark: the COUPONS var must be 'on', see src/coupons.js).
// A student earns points in another class tool (teachChat first), trades them for a coupon there,
// and spends the coupon in any RoomDJ room for song credits. RoomDJ keeps no account for it: the
// coupon carries everything, signed by the tool that made it, and is good once.
//
//   RDJ1.<payload>.<signature>
//     payload    base64url of JSON { i, c, e, s }:
//                  i  coupon id: 16 random bytes, base64url (22 characters)
//                  c  credits it gives: a whole number 1 to COUPON_CREDITS_MAX
//                  e  expiry: Unix seconds
//                  s  who made it: a short issuer name ('tc' = teachChat)
//     signature  base64url of the Ed25519 signature over the ASCII text "RDJ1.<payload>"
//
// Only the issuer holds the private key. RoomDJ checks with the public keys in the
// COUPON_PUBLIC_KEYS var (base64url of the raw 32-byte keys, comma separated so a key can be
// rotated), which is why this open-source repo needs no secret for it. No names, no student ids:
// a coupon says nothing about who earned it.

export const COUPON_PREFIX = 'RDJ1';
export const COUPON_CREDITS_MAX = 10;
export const COUPON_MAX_LENGTH = 400;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ISSUER_PATTERN = /^[a-z0-9]{1,12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export const COUPON_MESSAGES = Object.freeze({
  off: 'This class is not taking coupons right now.',
  credits_off: 'This class is not using song credits right now, so the coupon was not used. Keep it for later.',
  bad: 'That coupon does not look right. Copy it again from where you got it.',
  expired: 'That coupon has expired.',
  used: 'That coupon was already used.',
  rate: 'That is a lot of coupons. Wait a minute and try again.',
  error: 'Could not check that coupon right now. Try again in a minute. It was not used.',
});

export function b64urlToBytes(s) {
  if (typeof s !== 'string' || !B64URL.test(s)) return null;
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(pad);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Take a coupon apart without checking its signature.
 * @returns {{ ok: true, id: string, credits: number, exp: number, issuer: string, signed: string, sig: Uint8Array }
 *   | { ok: false }}
 */
export function parseCoupon(code) {
  if (typeof code !== 'string') return { ok: false };
  const text = code.trim();
  if (!text || text.length > COUPON_MAX_LENGTH) return { ok: false };
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== COUPON_PREFIX) return { ok: false };
  const body = b64urlToBytes(parts[1]);
  const sig = b64urlToBytes(parts[2]);
  if (!body || !sig || sig.length !== 64) return { ok: false };
  // Only the one standard spelling (base64 has spare bits at the end): one coupon, one text.
  if (bytesToB64url(body) !== parts[1] || bytesToB64url(sig) !== parts[2]) return { ok: false };
  let p;
  try {
    p = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false };
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false };
  if (typeof p.i !== 'string' || !ID_PATTERN.test(p.i)) return { ok: false };
  if (!Number.isInteger(p.c) || p.c < 1 || p.c > COUPON_CREDITS_MAX) return { ok: false };
  if (!Number.isInteger(p.e) || p.e <= 0) return { ok: false };
  if (typeof p.s !== 'string' || !ISSUER_PATTERN.test(p.s)) return { ok: false };
  return { ok: true, id: p.i, credits: p.c, exp: p.e, issuer: p.s, signed: `${parts[0]}.${parts[1]}`, sig };
}

/** The COUPON_PUBLIC_KEYS var as raw 32-byte keys (bad entries left out). */
export function publicKeysFrom(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((k) => b64urlToBytes(k.trim())).filter((k) => k?.length === 32);
}

/**
 * Check a coupon: its shape, its signature (any of `keys`), and that it has not expired.
 * @param {string} code
 * @param {Uint8Array[]} keys raw Ed25519 public keys
 * @returns {Promise<{ ok: true, id: string, credits: number, exp: number, issuer: string }
 *   | { ok: false, reason: 'bad'|'expired' }>}
 */
export async function verifyCoupon(code, keys, { now = Date.now() } = {}) {
  const c = parseCoupon(code);
  if (!c.ok) return { ok: false, reason: 'bad' };
  const data = new TextEncoder().encode(c.signed);
  let good = false;
  for (const raw of keys) {
    try {
      const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
      if (await crypto.subtle.verify({ name: 'Ed25519' }, key, c.sig, data)) {
        good = true;
        break;
      }
    } catch {
      /* a bad key: try the next */
    }
  }
  if (!good) return { ok: false, reason: 'bad' };
  if (c.exp * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, id: c.id, credits: c.credits, exp: c.exp, issuer: c.issuer };
}

/** The coupon in a link's fragment (`#coupon=RDJ1...`), or null. */
export function couponFromHash(hash) {
  if (typeof hash !== 'string') return null;
  const m = hash.match(/(?:^#|&)coupon=([A-Za-z0-9._-]{1,400})(?:&|$)/);
  return m ? m[1] : null;
}
