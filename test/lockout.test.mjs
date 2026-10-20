// The wrong-guess lockout for the class code (src/lockout.js, copied from uploadmymodel): its math,
// who is counted (the device, never the whole school address), and its storage.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIRST_LOCK_S, LOCK_AFTER, MAX_LOCK_S, afterWrong, cacheStore, lockSeconds, lockedFor, lockout, memoryStore,
  addressOf, whoFor,
} from '../src/lockout.js';

const DEVICE_A = 'device-aaaaaaaaaaaaaaaa';
const DEVICE_B = 'device-bbbbbbbbbbbbbbbb';
const req = (ip = '203.0.113.9', device = null) =>
  new Request('https://example.test/', { headers: { 'cf-connecting-ip': ip, ...(device ? { 'x-device': device } : {}) } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the numbers Dalton asked for: 5 tries, 5 s, doubling, capped at 300 s', () => {
  assert.equal(LOCK_AFTER, 5);
  assert.equal(FIRST_LOCK_S, 5);
  assert.equal(MAX_LOCK_S, 300);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map(lockSeconds), [5, 10, 20, 40, 80, 160, 300, 300, 300]);
});

test('4 wrong tries are fine, the 5th locks for 5 s', () => {
  let s = null;
  const now = 1_000_000;
  for (let i = 1; i <= 4; i++) {
    s = afterWrong(s, now);
    assert.equal(lockedFor(s, now), 0, `try ${i}`);
  }
  s = afterWrong(s, now);
  assert.equal(lockedFor(s, now), 5);
  assert.equal(lockedFor(s, now + 4_001), 1);
  assert.equal(lockedFor(s, now + 5_000), 0);
});

test('each wrong try after a lock ends doubles the lock, up to the cap', () => {
  let now = 0;
  let s = null;
  for (let i = 0; i < 5; i++) s = afterWrong(s, now);
  const seen = [lockedFor(s, now)];
  for (let i = 0; i < 8; i++) {
    now = s.until; // the lock has just run out
    s = afterWrong(s, now);
    seen.push(lockedFor(s, now));
  }
  assert.deepEqual(seen, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
});

test('lockout(): counts per address and per kind, locks, and a right answer clears', async () => {
  const store = memoryStore();
  const env = { lockoutStore: store };
  for (let i = 0; i < 5; i++) await (await lockout(env, 'code', req(), 0)).wrong();
  assert.equal((await lockout(env, 'code', req(), 0)).locked, true);
  // Another address, and the other secret, are not locked.
  assert.equal((await lockout(env, 'code', req('198.51.100.1'), 0)).locked, false);
  assert.equal((await lockout(env, 'other', req(), 0)).locked, false);
  // After the lock, a right answer wipes the counter: 4 more wrong tries are fine again.
  await (await lockout(env, 'code', req(), 5_000)).right();
  assert.equal(store.map.size, 0);
  for (let i = 0; i < 4; i++) await (await lockout(env, 'code', req(), 6_000)).wrong();
  assert.equal((await lockout(env, 'code', req(), 6_000)).locked, false);
});

test('the locked answer: 429, error "locked", retryAfter and a Retry-After header', async () => {
  const env = { lockoutStore: memoryStore() };
  for (let i = 0; i < 5; i++) await (await lockout(env, 'code', req(), 0)).wrong();
  const res = (await lockout(env, 'code', req(), 1_500)).response(json);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '4');
  assert.deepEqual(await res.json(), { error: 'locked', retryAfter: 4, message: 'Too many wrong tries. Wait 4 seconds and try again.' });
});

test('storage trouble falls open (no lock, no crash); no storage at all too', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const env = { lockoutStore: memoryStore({ fail: true }) };
    for (let i = 0; i < 10; i++) {
      const lock = await lockout(env, 'code', req(), 0);
      assert.equal(lock.locked, false);
      await lock.wrong();
      await lock.right();
    }
  } finally {
    console.error = quiet;
  }
  // Node has no caches global: nothing is stored, nothing is locked.
  assert.equal(typeof globalThis.caches, 'undefined');
  for (let i = 0; i < 10; i++) await (await lockout({}, 'code', req(), 0)).wrong();
  assert.equal((await lockout({}, 'code', req(), 0)).locked, false);
});

test('cacheStore talks to the Cache API with a synthetic URL and a max-age', async () => {
  const puts = [];
  const saved = new Map();
  const fake = {
    match: async (url) => (saved.has(url) ? new Response(saved.get(url)) : undefined),
    put: async (url, res) => { puts.push([url, res.headers.get('cache-control')]); saved.set(url, await res.text()); },
    delete: async (url) => saved.delete(url),
  };
  const store = cacheStore(fake);
  assert.equal(await store.get('code/1.2.3.4'), null);
  await store.put('code/1.2.3.4', { fails: 2, locks: 0, until: 0 });
  assert.deepEqual(puts, [['https://lockout.internal/code/1.2.3.4', 'max-age=900']]);
  assert.deepEqual(await store.get('code/1.2.3.4'), { fails: 2, locks: 0, until: 0 });
  await store.delete('code/1.2.3.4');
  assert.equal(await store.get('code/1.2.3.4'), null);
});

test('counted per device: one student locked out never locks the class (same school address)', async () => {
  const env = { lockoutStore: memoryStore() };
  const school = '198.51.100.7';
  for (let i = 0; i < 5; i++) await (await lockout(env, 'code', req(school, DEVICE_A), 0)).wrong();
  assert.equal((await lockout(env, 'code', req(school, DEVICE_A), 0)).locked, true);
  // Another Chromebook in the same room (same address) is not locked.
  assert.equal((await lockout(env, 'code', req(school, DEVICE_B), 0)).locked, false);
  // A request without a valid device id is counted by its address instead.
  assert.equal(whoFor(req(school, DEVICE_A)), `device:${DEVICE_A}`);
  assert.equal(whoFor(req(school, 'short')), `ip:${school}`);
  assert.equal(whoFor(req(school)), `ip:${school}`);
});

test('an IPv6 address counts as its /64: one home or phone network cannot dodge the per-address limits by rotating', () => {
  assert.equal(addressOf(req('203.0.113.9')), '203.0.113.9');
  assert.equal(addressOf(req('2001:db8:aaaa:bbbb:1:2:3:4')), '2001:db8:aaaa:bbbb::/64');
  assert.equal(addressOf(req('2001:DB8:AAAA:BBBB:ffff::9')), '2001:db8:aaaa:bbbb::/64');
  assert.equal(addressOf(req('2001:db8::1')), '2001:db8:0:0::/64');
  assert.equal(addressOf(req('::ffff:203.0.113.9')), '203.0.113.9');
  assert.equal(addressOf(new Request('https://example.test/')), 'unknown');
  assert.equal(whoFor(req('2001:db8:aaaa:bbbb:1:2:3:4')), 'ip:2001:db8:aaaa:bbbb::/64');
});
