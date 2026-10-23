// The class code lock's rule (src/codes.js lockDecision; src/codelock.js stores and asks).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLAIM_GRACE_MS, claimCode, lockDecision, releaseCode } from '../src/codes.js';

test('lockDecision: free, mine, taken in the start-up grace, ask after it, free once the hold ran out', () => {
  const now = 1_000_000_000;
  assert.equal(lockDecision(undefined, 'a', now), 'free');
  const held = { room: 'a', until: now + 60_000, at: now - 1000 };
  assert.equal(lockDecision(held, 'a', now), 'mine');
  assert.equal(lockDecision(held, 'b', now), 'taken', 'a room still starting up counts as open');
  assert.equal(lockDecision({ ...held, at: now - CLAIM_GRACE_MS }, 'b', now), 'ask');
  assert.equal(lockDecision({ ...held, until: now }, 'b', now), 'free', 'the hold ran out');
  assert.equal(lockDecision({ ...held, until: undefined }, 'b', now), 'free');
});

test('claimCode / releaseCode: no binding = allowed (Node); a lock error refuses; release errors only log', async () => {
  assert.equal(await claimCode({}, 'h', 'a', 1), true);
  const quiet = console.error;
  console.error = () => {};
  try {
    const broken = { CODE_LOCK: { idFromName: () => 'x', get: () => ({ claim: async () => { throw new Error('down'); }, release: async () => { throw new Error('down'); } }) } };
    assert.equal(await claimCode(broken, 'h', 'a', 1), false, 'cannot tell: never hand out a code that may be taken');
    await releaseCode(broken, 'h', 'a');
  } finally {
    console.error = quiet;
  }
  const calls = [];
  const env = { CODE_LOCK: { idFromName: (n) => n, get: (n) => ({ claim: async (...a) => (calls.push(['claim', n, ...a]), false), release: async (...a) => calls.push(['release', n, ...a]) }) } };
  assert.equal(await claimCode(env, 'hash1', 'room1', 99), false);
  await releaseCode(env, 'hash1', 'room1');
  assert.deepEqual(calls, [['claim', 'hash1', 'room1', 99], ['release', 'hash1', 'room1']]);
});
