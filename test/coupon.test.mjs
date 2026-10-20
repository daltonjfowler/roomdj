// Coupons (shared/coupon.js COUPONS): the format, the signature check, expiry, the link fragment,
// a coupon's credits, and the teacher's switch. The fixed test coupon below is ALSO checked by
// teachChat's signer test (worker test roomdjCoupon): if either side changes the format, one fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToB64url, couponFromHash, parseCoupon, publicKeysFrom, verifyCoupon } from '../shared/coupon.js';
import { couponCredits } from '../shared/queue.js';
import { validateSettings } from '../shared/settings.js';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';

// A throwaway key (seed 1..32), never used anywhere real.
const TEST_PUBLIC_KEY = 'ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ';
const TEST_COUPON = 'RDJ1.eyJpIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsImMiOjEsImUiOjQxMDI0NDQ4MDAsInMiOiJ0YyJ9.67LfuNe4uuvOIEhOQ-6M4c9sSvts6WmETiZ0c8R9_1OgwRc1maVYykGqK5ofWDYcU2wGMh7YVCdsMKMRPDP2Dg';
const keys = publicKeysFrom(TEST_PUBLIC_KEY);

async function makeCoupon(payload, key) {
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(`RDJ1.${body}`)));
  return `RDJ1.${body}.${bytesToB64url(sig)}`;
}

test('the fixed test coupon (shared with teachChat) verifies', async () => {
  const v = await verifyCoupon(TEST_COUPON, keys, { now: Date.UTC(2026, 9, 20) });
  assert.deepEqual(v, { ok: true, id: 'AAAAAAAAAAAAAAAAAAAAAA', credits: 1, exp: 4102444800, issuer: 'tc' });
  assert.equal((await verifyCoupon(`  ${TEST_COUPON}\n`, keys)).ok, true, 'spaces around a pasted coupon are fine');
});

test('a changed coupon, another key, or no key: refused as bad', async () => {
  const [p, body, sig] = TEST_COUPON.split('.');
  const other = JSON.stringify({ i: 'AAAAAAAAAAAAAAAAAAAAAA', c: 10, e: 4102444800, s: 'tc' }); // more credits
  const forged = `${p}.${bytesToB64url(new TextEncoder().encode(other))}.${sig}`;
  assert.deepEqual(await verifyCoupon(forged, keys), { ok: false, reason: 'bad' });
  const flipped = `${p}.${body}.${sig.slice(0, -2)}${sig.endsWith('Dg') ? 'Dh' : 'Dg'}`;
  assert.deepEqual(await verifyCoupon(flipped, keys), { ok: false, reason: 'bad' });
  const { publicKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const otherKey = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  assert.deepEqual(await verifyCoupon(TEST_COUPON, [otherKey]), { ok: false, reason: 'bad' });
  assert.deepEqual(await verifyCoupon(TEST_COUPON, []), { ok: false, reason: 'bad' });
  assert.equal((await verifyCoupon(TEST_COUPON, [otherKey, ...keys])).ok, true, 'any listed key (rotation)');
});

test('expired coupons are refused; fresh ones from a new key work', async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  const now = Date.UTC(2026, 9, 20, 12);
  const fresh = await makeCoupon({ i: 'abcdefghijklmnopqrstuv', c: 2, e: now / 1000 + 60, s: 'tc' }, privateKey);
  assert.deepEqual(await verifyCoupon(fresh, [raw], { now }), { ok: true, id: 'abcdefghijklmnopqrstuv', credits: 2, exp: now / 1000 + 60, issuer: 'tc' });
  assert.deepEqual(await verifyCoupon(fresh, [raw], { now: now + 61_000 }), { ok: false, reason: 'expired' });
});

test('the shape is checked before any signature', async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  for (const bad of [
    { i: 'short', c: 1, e: 4102444800, s: 'tc' },
    { i: 'AAAAAAAAAAAAAAAAAAAAAA', c: 0, e: 4102444800, s: 'tc' },
    { i: 'AAAAAAAAAAAAAAAAAAAAAA', c: 11, e: 4102444800, s: 'tc' },
    { i: 'AAAAAAAAAAAAAAAAAAAAAA', c: 1.5, e: 4102444800, s: 'tc' },
    { i: 'AAAAAAAAAAAAAAAAAAAAAA', c: 1, e: 'soon', s: 'tc' },
    { i: 'AAAAAAAAAAAAAAAAAAAAAA', c: 1, e: 4102444800, s: 'Not An Issuer' },
  ]) assert.equal(parseCoupon(await makeCoupon(bad, privateKey)).ok, false, JSON.stringify(bad));
  for (const junk of [null, 42, '', 'RDJ1', 'RDJ2.a.b', 'RDJ1.a.b.c', `RDJ1.${'a'.repeat(500)}.b`, 'RDJ1.!!!.???']) {
    assert.equal(parseCoupon(junk).ok, false, String(junk));
  }
});

test('publicKeysFrom: comma list, bad entries left out', () => {
  assert.equal(publicKeysFrom(`${TEST_PUBLIC_KEY}, nope ,`).length, 1);
  assert.deepEqual(publicKeysFrom(undefined), []);
});

test('couponFromHash: the #coupon= link fragment', () => {
  assert.equal(couponFromHash(`#coupon=${TEST_COUPON}`), TEST_COUPON);
  assert.equal(couponFromHash(`#x=1&coupon=${TEST_COUPON}&y=2`), TEST_COUPON);
  assert.equal(couponFromHash('#coupon='), null);
  assert.equal(couponFromHash('#other=1'), null);
  assert.equal(couponFromHash(undefined), null);
});

test('couponCredits: only while credits are on, only for a student here, capped', () => {
  const state = { settings: { ...DEFAULT_SETTINGS, startingCredits: 3 }, students: { d1: {} }, credits: {} };
  assert.equal(couponCredits(state, 'd1', 1), 4, 'on top of the starting amount');
  assert.equal(couponCredits(state, 'd1', 2), 6);
  assert.equal(couponCredits(state, 'ghost', 1), null, 'not a student here');
  state.credits.d1 = 998;
  assert.equal(couponCredits(state, 'd1', 5), 999, 'CREDITS_MAX');
  const off = { settings: { ...DEFAULT_SETTINGS, startingCredits: null }, students: { d1: {} } };
  assert.equal(couponCredits(off, 'd1', 1), null, 'credits off');
});

test('settings: coupons on by default, the teacher can turn them off', () => {
  assert.equal(DEFAULT_SETTINGS.coupons, true);
  assert.equal(validateSettings({}).settings.coupons, true, 'saved settings without it read as on');
  assert.equal(validateSettings({ coupons: false }).settings.coupons, false);
  assert.equal(validateSettings({ coupons: 'no' }).ok, false);
});
