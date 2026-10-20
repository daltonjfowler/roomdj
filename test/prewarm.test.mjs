// src/prewarm.js: chart songs are checked before classes suggest them, within a daily AI cap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PREWARM_AI_PER_DAY, PREWARM_PER_RUN, chartSong, prewarm } from '../src/prewarm.js';
import { PROMPT_VERSION, verdictKey } from '../shared/filter.js';

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
  };
}

const entry = (i, extra = {}) => ({ id: String(1000 + i), name: `Song ${i}`, artistName: `Artist ${i}`, kind: 'songs', releaseDate: '2019-05-01', genres: [{ name: 'Pop' }, { name: 'Music' }], ...extra });
const feed = (n) => async () => Response.json({ feed: { results: Array.from({ length: n }, (_, i) => entry(i)) } });

test('chartSong: the feed entry as a song; Apple\'s "Explict" spelling', () => {
  assert.deepEqual(chartSong(entry(1, { contentAdvisoryRating: 'Explict' })), {
    id: 'it:1001', title: 'Song 1', artist: 'Artist 1', album: '', genre: 'Pop', year: 2019, explicit: 'explicit',
  });
  assert.equal(chartSong(entry(1)).explicit, 'notExplicit');
  assert.equal(chartSong({ id: 'x', name: 'A', kind: 'songs' }), null);
  assert.equal(chartSong({ ...entry(1), kind: 'albums' }), null);
});

test('prewarm: a few songs a run, verdicts cached; known songs cost nothing; daily cap', async () => {
  let asked = 0;
  const env = {
    CLASS_KV: fakeKv(),
    AI: { run: async () => { asked++; return { response: '{"instrumental":false,"verdict":"OK","category":null,"evidence":""}' }; } },
  };
  const now = Date.UTC(2026, 9, 14, 12);
  const one = await prewarm(env, { now, fetchImpl: feed(300) });
  assert.equal(one.checked, PREWARM_PER_RUN);
  assert.equal(one.asked, PREWARM_PER_RUN);
  assert.ok(env.CLASS_KV.map.has(verdictKey('it:1000', PROMPT_VERSION)), 'the verdict is cached for everyone');
  // The same songs again (a new day's list starting with them): no AI.
  const before = asked;
  env.CLASS_KV.map.delete('prewarm:v1:state:2026-10-15');
  const again = await prewarm(env, { now: now + 86_400_000, fetchImpl: async () => Response.json({ feed: { results: Array.from({ length: PREWARM_PER_RUN }, (_, i) => entry(i)) } }) });
  assert.equal(again.asked, 0);
  assert.equal(asked, before, 'known songs: not asked');
  // The cap: runs until the day's AI calls are used.
  let last;
  for (let i = 0; i < 100; i++) last = await prewarm(env, { now, fetchImpl: feed(300) });
  assert.equal(last.used, PREWARM_AI_PER_DAY);
  assert.equal(last.asked, 0, 'past the cap: nothing more');
});
