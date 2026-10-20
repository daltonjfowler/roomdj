// Class codes for the day (shared/code.js) and the code → room hash (src/codes.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODE_COUNT, CODE_WORDS, displayCode, generateCode, normalizeCode, untilFor, validateCode, validateUntil,
} from '../shared/code.js';
import {
  CLASS_PERIOD_MIN, CODE_MAX, CODE_MIN_CHARS, CODE_MIN_PARTS, OPEN_MAX_MS, OPEN_MIN_MS, ROOM_ID_PATTERN,
} from '../shared/protocol.js';
import { codeHash } from '../src/codes.js';

test('class codes: forgiving to type (case, spaces, dashes), strict to check', () => {
  assert.equal(normalizeCode('  Orange Walrus__TACO 12 '), 'orange-walrus-taco-12');
  assert.equal(normalizeCode('orange--walrus-taco!'), 'orange-walrus-taco');
  assert.equal(normalizeCode('Golden Walrus Lantern 42'), 'golden-walrus-lantern-42');
  assert.equal(normalizeCode('GOLDEN-walrus  lantern-42'), normalizeCode('golden walrus lantern 42'));
  assert.equal(normalizeCode('Café Ü'), 'cafe-u');
  assert.equal(normalizeCode(null), '');
  assert.equal(displayCode('golden-walrus-lantern-42'), 'golden walrus lantern 42');
});

test('validateCode: any code with a letter or number passes; empty or too long is refused', () => {
  assert.deepEqual(validateCode('Blue Robot Pancake 7'), { ok: true, code: 'blue-robot-pancake-7' });
  assert.deepEqual(validateCode('Ghostghost!'), { ok: true, code: 'ghostghost' });
  for (const good of ['cat', 'x', '7', 'cat dog', 'Period 3']) assert.equal(validateCode(good).ok, true, good);
  assert.equal(CODE_MIN_PARTS, 1);
  assert.equal(CODE_MIN_CHARS, 1);
  for (const bad of ['', '!!', '   ', 'x'.repeat(20) + ' ' + 'y'.repeat(20) + ' z']) {
    const v = validateCode(bad);
    assert.equal(v.ok, false, bad);
    assert.ok(v.message.length > 10, bad);
  }
  assert.match(validateCode('a'.repeat(30) + ' ' + 'b'.repeat(30) + ' c').message, /too long/);
});

test('suggested codes: too many to guess, easy to type, always valid', () => {
  // JOIN_RATE_IP (60 a minute) for a whole day against at least 2^28 codes: about 1 in 5,200.
  assert.ok(CODE_COUNT >= 2 ** 28, `only ${CODE_COUNT} codes`);
  assert.ok((60 * 60 * 24) / CODE_COUNT < 1 / 5000);
  const words = CODE_WORDS.flat();
  assert.deepEqual(words.filter((w, i) => words.indexOf(w) !== i), [], 'no word twice');
  for (const w of words) assert.match(w, /^[a-z]{3,11}$/, w);
  const longest = CODE_WORDS.map((list) => Math.max(...list.map((w) => w.length))).reduce((a, b) => a + b) + 3 + 2;
  assert.ok(longest <= CODE_MAX, `${longest}`);
  assert.match(generateCode(), /^[a-z]+-[a-z]+-[a-z]+-[1-9][0-9]$/);
  assert.equal(generateCode(() => 0), `${CODE_WORDS.map((l) => l[0]).join('-')}-10`);
  assert.equal(generateCode(() => 0.999999), `${CODE_WORDS.map((l) => l.at(-1)).join('-')}-99`);
  // The shortest possible suggestion still passes the teacher's-own-code rule.
  const shortest = CODE_WORDS.map((list) => list.reduce((a, w) => (w.length < a.length ? w : a))).join('-') + '-10';
  assert.equal(validateCode(shortest).ok, true, shortest);
  for (let i = 0; i < 300; i++) assert.equal(validateCode(generateCode()).ok, true);
  // Words that must never be in a list (names, double meanings, tricky spellings).
  for (const w of ['taco', 'banana', 'pickle', 'amber', 'rusty', 'desert', 'arctic', 'grey', 'gray']) assert.equal(words.includes(w), false, w);
});

test('open until: the host page choices, and what the server accepts', () => {
  const now = new Date(2026, 9, 5, 9, 0, 0); // 9:00 local
  assert.equal(untilFor('period', now), now.getTime() + CLASS_PERIOD_MIN * 60_000);
  assert.equal(untilFor('day', now), new Date(2026, 9, 5, 23, 59, 59).getTime());
  // Late at night the end of today is closer than a class period: one period instead.
  const late = new Date(2026, 9, 5, 23, 30, 0);
  assert.equal(untilFor('day', late), late.getTime() + CLASS_PERIOD_MIN * 60_000);
  const t = 1_000_000_000_000;
  assert.equal(validateUntil(t + OPEN_MIN_MS, t), true);
  assert.equal(validateUntil(t + OPEN_MAX_MS, t), true);
  for (const bad of [t, t + OPEN_MIN_MS - 1, t + OPEN_MAX_MS + 1, String(t + 60_000), t + 60_000.5, null]) {
    assert.equal(validateUntil(bad, t), false, String(bad));
  }
  assert.equal(validateUntil(untilFor('day', new Date(t)), t), true);
});

test('code hash: the same for every way of typing a code, different for another code', async () => {
  const a = await codeHash('Golden Walrus Lantern 42');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await codeHash('golden-walrus-lantern-42'), a);
  assert.notEqual(await codeHash('golden-walrus-lantern-43'), a);
  // Not the plain SHA-256 of the code (this app's own prefix).
  const plain = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('golden-walrus-lantern-42'))).toString('hex');
  assert.notEqual(a, plain);
  assert.equal(ROOM_ID_PATTERN.test('0123456789abcdef0123456789abcdef'), true);
  assert.equal(ROOM_ID_PATTERN.test('golden-walrus-lantern-42'), false);
});

test('suggested codes never use the words Dalton struck (giggle combos like "blue pancake")', () => {
  const words = CODE_WORDS.flat();
  for (const w of ['pancake', 'waffle', 'starfish', 'brown']) assert.ok(!words.includes(w), w);
});
