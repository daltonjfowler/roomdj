// 🔥 Popular on RoomDJ (src/popular.js, CLAUDE.md invariant 40): students' requests (never teacher
// picks) per teacher, merged once a day; a song only when 2+ teachers' students asked for it; songs only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { POPULAR_MIN_TEACHERS } from '../shared/protocol.js';
import { ASKS_MAX, POPULAR_KEY, mergePopular, noteAsks, readAsks, readPopular, refreshPopular } from '../src/popular.js';

const NOW = Date.UTC(2026, 9, 29, 12);
const song = (n, over = {}) => ({ id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, album: '', artwork: '', durationMs: 1, explicit: 'notExplicit', previewUrl: 'https://x', ...over });
const played = (s, up = 0, extra = {}) => ({ id: `q${s.id}`, song: s, device: 'dev-1', by: 'Calm Otter', up, down: 0, score: up, at: NOW, status: 'finished', ...extra });
const asks = (...entries) => ({ v: 1, list: entries.map(([s, n, up = 0]) => ({ song: s, asks: n, up, lastAt: NOW })) });

function fakeKv(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    map,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { map.set(k, v); },
    async list({ prefix }) { return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

test('noteAsks: students\' requests that played to the end count, with their 👍; teacher picks and skips do not', () => {
  const list = noteAsks([], [
    played(song(1), 4),
    played(song(2), 9, { teacher: true }),
    played(song(3), 2, { status: 'skipped' }),
    played(song(1, { id: 'it:11', title: 'Song 1 (Radio Edit)' }), 1), // another version: the same song
    { bad: true },
  ], NOW);
  assert.deepEqual(list.map((e) => [e.song.title, e.asks, e.up]), [['Song 1 (Radio Edit)', 2, 5]]);
  assert.equal(list[0].song.device, undefined, 'songs only');
  assert.equal(JSON.stringify(list).includes('Calm Otter'), false, 'never a nickname');
  const many = noteAsks([], Array.from({ length: ASKS_MAX + 20 }, (_, i) => played(song(100 + i), i)), NOW);
  assert.equal(many.length, ASKS_MAX);
  assert.equal(many.at(-1).song.id, 'it:120', 'the lowest scores drop off');
  assert.deepEqual(readAsks({ list: [{ song: song(1), asks: 2, up: -3 }, { song: song(1) }, { song: {} }] }).map((e) => [e.asks, e.up]), [[2, 0]]);
});

test('mergePopular: only songs 2+ teachers\' students asked for; more teachers first, then the score', () => {
  assert.equal(POPULAR_MIN_TEACHERS, 2);
  const a = asks([song(1), 3], [song(2), 1], [song(3), 20]);
  const b = asks([song(1), 1], [song(2), 1], [song(9, { title: 'Song 3 (Radio Edit)', artist: 'Artist 3' }), 1]);
  const c = asks([song(2), 1]);
  const out = mergePopular([a, b, c, null], NOW);
  assert.deepEqual(out.map((s) => s.id), ['it:2', 'it:3', 'it:1'], 'Song 2: 3 teachers; Song 3 (any version) beats Song 1 on score');
  assert.deepEqual(mergePopular([a], NOW), [], "one teacher's students alone show nothing");
  assert.deepEqual(Object.keys(out[0]).sort(), ['album', 'artist', 'artwork', 'durationMs', 'explicit', 'id', 'previewUrl', 'title'], 'songs only');
});

test('refreshPopular: once a day, every teacher (legacy + profiles)', async () => {
  const kv = fakeKv({
    asks: asks([song(1), 2]),
    'p:dalton-fowler:asks': asks([song(1), 1], [song(2), 5]),
    'p:dalton-fowler:favorites': { v: 1, list: [] },
  });
  const env = { CLASS_KV: kv };
  assert.equal(await refreshPopular(env, { now: NOW }), 1);
  assert.deepEqual((await readPopular(env)).map((s) => s.id), ['it:1'], "Song 2: only one teacher's students");
  kv.map.set('p:u-abc:asks', JSON.stringify(asks([song(2), 1])));
  assert.equal(await refreshPopular(env, { now: NOW + 3600_000 }), null, 'not again the same day');
  assert.equal(await refreshPopular(env, { now: NOW + 25 * 3600_000 }), 2);
  assert.equal(JSON.parse(kv.map.get(POPULAR_KEY)).list.length, 2);
  assert.deepEqual(await readPopular({ CLASS_KV: { get: async () => { throw new Error('down'); } } }), [], 'never throws');
});
