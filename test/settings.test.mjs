import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';

test('defaults pass; missing fields take defaults', () => {
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS }), { ok: true, settings: { ...DEFAULT_SETTINGS, blocklist: [] } });
  assert.equal(validateSettings({ maxWaitingPerStudent: 4 }).settings.removeAtScore, DEFAULT_SETTINGS.removeAtScore);
});

test('numbers must be whole and in range', () => {
  assert.equal(validateSettings({ maxWaitingPerStudent: 0 }).ok, false);
  assert.equal(validateSettings({ maxWaitingPerStudent: 11 }).ok, false);
  assert.equal(validateSettings({ maxWaitingPerStudent: 2.5 }).ok, false);
  assert.equal(validateSettings({ removeAtScore: 0 }).ok, false);
  assert.equal(validateSettings({ removeAtScore: -51 }).ok, false);
  assert.equal(validateSettings({ removeAtScore: -50 }).ok, true);
});

test('booleans must be booleans', () => {
  assert.equal(validateSettings({ allowJump: 'yes' }).ok, false);
});

test('the AI review is locked on (Dalton, 2026-10-16)', () => {
  for (const v of [false, 'no', 0, undefined]) {
    const s = validateSettings({ aiCheck: v, blockUnknownSongs: v }).settings;
    assert.equal(s.aiCheck, true);
    assert.equal(s.blockUnknownSongs, true);
  }
});

test('TEST_AI_OFF (local browser tests only) reads the AI switches again; without it they stay on', () => {
  const s = validateSettings({ aiCheck: false, blockUnknownSongs: false }, { testAiOff: true }).settings;
  assert.deepEqual([s.aiCheck, s.blockUnknownSongs], [false, false]);
  assert.equal(validateSettings({ aiCheck: 'no' }, { testAiOff: true }).ok, false);
});

test('blocklist: lower-cased, trimmed, deduped, length-limited', () => {
  const v = validateSettings({ blocklist: ['  Beer ', 'beer', 'BEER', '', '  ', 'Two  Words'] });
  assert.deepEqual(v.settings.blocklist, ['beer', 'two words']);
  assert.equal(validateSettings({ blocklist: ['x'.repeat(SETTINGS_LIMITS.blocklistWordLength + 1)] }).ok, false);
  const many = Array.from({ length: SETTINGS_LIMITS.blocklistWords + 1 }, (_, i) => `w${i}`);
  assert.equal(validateSettings({ blocklist: many }).ok, false);
  assert.equal(validateSettings({ blocklist: 'beer' }).ok, false);
  assert.equal(validateSettings({ blocklist: [5] }).ok, false);
});

test('not an object', () => {
  assert.equal(validateSettings(null).ok, false);
  assert.equal(validateSettings([]).ok, false);
  assert.equal(validateSettings('x').ok, false);
});

test('startingCredits: Unlimited (null) by default, or a whole number from 0 to 50', () => {
  assert.equal(validateSettings({}).settings.startingCredits, null);
  assert.equal(validateSettings({ startingCredits: null }).settings.startingCredits, null);
  assert.equal(validateSettings({ startingCredits: 0 }).settings.startingCredits, 0);
  assert.equal(validateSettings({ startingCredits: 50 }).settings.startingCredits, 50);
  for (const bad of [-1, 51, 2.5, '3', true, false, [], {}]) assert.equal(validateSettings({ startingCredits: bad }).ok, false, String(bad));
});

test('allowJump (Priority jump): off by default, booleans only; old saved settings without it read as off', () => {
  assert.equal(DEFAULT_SETTINGS.allowJump, false);
  assert.equal(validateSettings({}).settings.allowJump, false);
  assert.equal(validateSettings({ allowJump: true }).settings.allowJump, true);
  assert.equal(validateSettings({ allowJump: false, startingCredits: 3 }).settings.allowJump, false);
  for (const bad of ['true', 'false', 'on', 1, 0, null, [], {}]) assert.equal(validateSettings({ allowJump: bad }).ok, false, String(bad));
  // Settings saved before the switch (KV): still valid, jump off, credits as they were.
  const old = { maxWaitingPerStudent: 3, removeAtScore: -4, blockUnknownSongs: true, aiCheck: true, blocklist: ['beer'], startingCredits: 5 };
  const v = validateSettings(old);
  assert.equal(v.ok, true);
  assert.deepEqual(v.settings, { ...DEFAULT_SETTINGS, ...old, allowJump: false }); // later fields take their defaults
  // And from before credits too.
  const older = { maxWaitingPerStudent: 2, removeAtScore: -3, blockUnknownSongs: false, aiCheck: false, blocklist: [] };
  assert.deepEqual(validateSettings(older).settings, { ...DEFAULT_SETTINGS, ...older, blockUnknownSongs: true, aiCheck: true, startingCredits: null, allowJump: false });
});
