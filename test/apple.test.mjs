import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPLE_MAX_TTL_SECONDS, appleConfigured, appleExplicit, appleSkipMessage, mintDeveloperToken, pemToDer,
  pickAppleMatch, resolveAppleSong,
} from '../shared/apple.js';
import { APPLE_MIN_LEFT_SECONDS, APPLE_TTL_SECONDS, appleDeveloperToken } from '../src/apple.js';

// A throwaway P-256 key made for this test run only (never a real Apple key).
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const b64 = Buffer.from(der).toString('base64');
const PEM = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`; // pragma: allowlist secret (made-up test value)
const TEAM = 'TEAM123456', KID = 'KEY9876543';

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function decode(token) {
  const [h, p, s] = token.split('.');
  return { header: JSON.parse(fromB64url(h)), claims: JSON.parse(fromB64url(p)), input: `${h}.${p}`, sig: fromB64url(s) };
}
const verify = (input, sig) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, new TextEncoder().encode(input));

test('developer token: ES256 header with kid, Apple claims, signature checks out with the public key', async () => {
  const now = Date.UTC(2026, 9, 4, 12);
  const { token, exp } = await mintDeveloperToken({ teamId: TEAM, keyId: KID, privateKey: PEM, ttlSeconds: 3600, origins: ['https://cq.example'], now });
  const d = decode(token);
  assert.deepEqual(d.header, { alg: 'ES256', kid: KID });
  assert.deepEqual(d.claims, { iss: TEAM, iat: now / 1000, exp: now / 1000 + 3600, origin: ['https://cq.example'] });
  assert.equal(exp, d.claims.exp);
  assert.equal(d.sig.length, 64); // JWS r || s
  assert.equal(await verify(d.input, d.sig), true);
  assert.equal(await verify(`${d.input}x`, d.sig), false);
});

test('developer token: life capped at 6 months; no origin claim when none given', async () => {
  const { token } = await mintDeveloperToken({ teamId: TEAM, keyId: KID, privateKey: PEM, ttlSeconds: 10 * APPLE_MAX_TTL_SECONDS, now: 0 });
  const { claims } = decode(token);
  assert.equal(claims.exp - claims.iat, APPLE_MAX_TTL_SECONDS);
  assert.equal('origin' in claims, false);
});

test('developer token: bad ids or a bad key are refused', async () => {
  await assert.rejects(mintDeveloperToken({ teamId: 'short', keyId: KID, privateKey: PEM }));
  await assert.rejects(mintDeveloperToken({ teamId: TEAM, keyId: KID, privateKey: 'not a key' }));
});

test('PEM pasted every which way gives the same key bytes', () => {
  const want = [...der];
  assert.deepEqual([...pemToDer(PEM)], want);
  assert.deepEqual([...pemToDer(PEM.replace(/\n/g, '\r\n'))], want);
  assert.deepEqual([...pemToDer(PEM.replace(/\n/g, '\\n'))], want); // "\n" typed as two characters
  assert.deepEqual([...pemToDer(b64)], want); // body only
  assert.throws(() => pemToDer(''));
});

test('config flag: Apple only when all three secrets are set and the ids look right', () => {
  assert.equal(appleConfigured({}), false);
  assert.equal(appleConfigured({ APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID }), false);
  assert.equal(appleConfigured({ APPLE_TEAM_ID: TEAM, APPLE_PRIVATE_KEY: PEM }), false);
  assert.equal(appleConfigured({ APPLE_TEAM_ID: 'team', APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: PEM }), false);
  assert.equal(appleConfigured({ APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: PEM }), true);
});

test('Worker token: limited to the site origin, reused while it has a day left, then made again', async () => {
  const env = { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: PEM };
  const t0 = Date.UTC(2026, 9, 4);
  const a = await appleDeveloperToken(env, 'https://cq.example', t0);
  assert.deepEqual(decode(a.token).claims.origin, ['https://cq.example']);
  assert.equal(a.exp, t0 / 1000 + APPLE_TTL_SECONDS);
  assert.equal((await appleDeveloperToken(env, 'https://cq.example', t0 + 60_000)).token, a.token);
  const later = t0 + (APPLE_TTL_SECONDS - APPLE_MIN_LEFT_SECONDS + 1) * 1000;
  assert.notEqual((await appleDeveloperToken(env, 'https://cq.example', later)).token, a.token);
  assert.deepEqual(decode((await appleDeveloperToken(env, 'http://127.0.0.1:8796', t0)).token).claims.origin, ['http://127.0.0.1:8796']);
  await assert.rejects(appleDeveloperToken({}, 'https://cq.example'));
});

// ---- Matching ----

const song = (over = {}) => ({
  id: 'it:863835363', title: 'Happy (From "Despicable Me 2")', artist: 'Pharrell Williams', album: 'G I R L', artwork: '',
  durationMs: 233_000, explicit: 'notExplicit', previewUrl: 'https://x', ...over,
});
const item = (id, over = {}) => ({
  id: String(id), type: 'songs',
  attributes: { name: 'Happy (From "Despicable Me 2")', artistName: 'Pharrell Williams', durationInMillis: 232_720, playParams: { id: String(id), kind: 'song' }, ...over },
});

test('the iTunes trackId plays directly when it is a clean catalog song', async () => {
  let searched = false;
  const r = await resolveAppleSong(song(), { byId: async (id) => item(id), search: async () => { searched = true; return []; } });
  assert.deepEqual(r, { status: 'ok', id: '863835363', name: 'Happy (From "Despicable Me 2")' });
  assert.equal(searched, false);
});

test('an explicit catalog song is swapped for its clean version, or skipped when there is none', async () => {
  const explicit = item(1, { contentRating: 'explicit' });
  const clean = item(2, { contentRating: 'clean' });
  assert.equal(appleExplicit(explicit), true);
  assert.deepEqual(await resolveAppleSong(song({ id: 'it:1' }), { byId: async () => explicit, search: async () => [explicit, clean] }),
    { status: 'ok', id: '2', name: clean.attributes.name });
  assert.deepEqual(await resolveAppleSong(song({ id: 'it:1' }), { byId: async () => explicit, search: async () => [explicit] }), { status: 'explicit' });
  assert.deepEqual(await resolveAppleSong(song({ id: 'it:1' }), { byId: async () => explicit, search: async () => [] }), { status: 'explicit' });
});

test('not in this storefront: found by search; another song or recording is not a match', async () => {
  const missing = { byId: async () => null };
  assert.equal((await resolveAppleSong(song(), { ...missing, search: async () => [item(5)] })).id, '5');
  assert.deepEqual(await resolveAppleSong(song(), { ...missing, search: async () => [item(6, { name: 'Sad' })] }), { status: 'none' });
  assert.deepEqual(await resolveAppleSong(song(), { ...missing, search: async () => [item(7, { durationInMillis: 300_000 })] }), { status: 'none' });
  assert.deepEqual(await resolveAppleSong(song(), { ...missing, search: async () => [item(8, { playParams: undefined })] }), { status: 'none' });
  assert.deepEqual(await resolveAppleSong(song(), { byId: async () => { throw new Error('404'); }, search: async () => [] }), { status: 'none' });
});

test('pickAppleMatch takes the best clean match; skip messages name the song', () => {
  const far = item(3, { durationInMillis: 240_000 });
  const near = item(4);
  assert.equal(pickAppleMatch(song(), [far, near]).id, '4');
  assert.match(appleSkipMessage(song(), 'explicit'), /only has the explicit version of "Happy/);
  assert.match(appleSkipMessage(song(), 'none'), /^Apple Music does not have "Happy/);
});
