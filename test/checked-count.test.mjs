import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKED_KEY, countChecked, readChecked } from '../src/checked-count.js';
import { PROMPT_VERSION } from '../shared/filter.js';

/** A KV with list pages and cursors, like Workers KV. */
function fakeKv(entries) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    async get(k, type) { const v = map.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { map.set(k, v); },
    async list({ prefix, cursor, limit }) {
      const names = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const keys = names.slice(from, from + limit).map((name) => ({ name }));
      const done = from + limit >= names.length;
      return { keys, list_complete: done, ...(done ? {} : { cursor: String(from + limit) }) };
    },
  };
}

const p = `verdict:v${PROMPT_VERSION}:`;
const ok = JSON.stringify({ verdict: 'ok', category: 'other', evidence: '', instrumental: false, lyrics: 'found', lv: 1, source: 'lyrics' });
const aiOnly = JSON.stringify({ verdict: 'ok', category: 'other', evidence: '', instrumental: false });
const bad = JSON.stringify({ verdict: 'inappropriate', category: 'drugs', evidence: 'about drugs', instrumental: false });

test('the cron counts ✓ Checked songs a slice at a time, then keeps the full count', async () => {
  const kv = fakeKv({
    [`${p}song:a|x`]: ok, [`${p}song:b|x`]: ok, [`${p}song:c|x`]: aiOnly, [`${p}song:d|x`]: bad,
    [`${p}123`]: ok, // per catalog id: not counted again
  });
  const env = { CLASS_KV: kv };
  assert.equal(await readChecked(env), null);
  await countChecked(env, { reads: 3 });
  assert.deepEqual(await readChecked(env), { ready: 2, waiting: 1, blocked: 0, seen: 3, counting: true });
  await countChecked(env, { reads: 3, now: 5 });
  assert.deepEqual(await readChecked(env), { ready: 2, waiting: 1, blocked: 1, seen: 4, at: 5 });
  // The next pass starts over and keeps showing the last full count meanwhile.
  kv.map.set(`${p}song:e|x`, ok);
  await countChecked(env, { reads: 3, now: 6 });
  assert.deepEqual(await readChecked(env), { ready: 2, waiting: 1, blocked: 1, seen: 4, at: 5 });
  await countChecked(env, { reads: 3, now: 7 });
  assert.deepEqual(await readChecked(env), { ready: 3, waiting: 1, blocked: 1, seen: 5, at: 7 });
});

test('a count from an older prompt version is not shown, and starts over', async () => {
  const kv = fakeKv({ [CHECKED_KEY]: JSON.stringify({ version: PROMPT_VERSION - 1, last: { ready: 99, seen: 99, at: 1 } }), [`${p}song:a|x`]: ok });
  const env = { CLASS_KV: kv };
  assert.equal(await readChecked(env), null);
  await countChecked(env, { now: 2 });
  assert.deepEqual(await readChecked(env), { ready: 1, waiting: 0, blocked: 0, seen: 1, at: 2 });
});

test("a closed room adds to its teacher's tally: counts only", async () => {
  const { addActivity, roomTally } = await import('../src/teacher-activity.js');
  const map = new Map();
  const env = { CLASS_KV: { async get(k) { return map.has(k) ? JSON.parse(map.get(k).v) : null; }, async put(k, v, o) { map.set(k, { v, meta: o?.metadata }); } } };
  const room = { history: [{ status: 'finished' }, { status: 'skipped' }, { status: 'finished' }], admitted: ['d1', 'd2', 'd3'] };
  assert.deepEqual(roomTally(room, 4), { plays: 2, asks: 4, students: 3 });
  await addActivity(env, 'own-abc', roomTally(room, 4), 10);
  const t = await addActivity(env, 'own-abc', roomTally({ history: [{ status: 'finished' }], admitted: ['d1'] }, 1), 20);
  assert.deepEqual(t, { rooms: 2, plays: 3, asks: 5, students: 4, lastAt: 20 });
  assert.deepEqual(map.get('act:v1:own-abc').meta, t);
  assert.equal(await addActivity(env, 'Not An Id!', roomTally(room)), null);
});
