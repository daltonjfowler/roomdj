// src/night.js: songs classes could not settle are checked again at night, within a daily AI cap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NIGHT_AI_PER_DAY, NIGHT_PER_RUN, addToNight, nightHours, nightShift, nightSong, nightWorthy, sweepBans } from '../src/night.js';
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
    async list({ prefix, limit }) {
      return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) };
    },
  };
}

const song = (i, extra = {}) => ({ id: `it:${100 + i}`, title: `Song ${i}`, artist: `Artist ${i}`, album: 'A', durationMs: 200_000, explicit: 'notExplicit', previewUrl: 'https://x', artwork: 'https://y', ...extra });
const LYRICS = 'la la la\nwe sing along';
const lrclib = async (url) => {
  const u = new URL(url);
  const n = u.searchParams.get('track_name').replace('Song ', '');
  return Response.json([{ trackName: `Song ${n}`, artistName: `Artist ${n}`, duration: 200, instrumental: false, plainLyrics: LYRICS }]);
};

test('nightHours: 10 pm to 6 am Eastern, daylight saving included', () => {
  // October: EDT (UTC-4). 10 pm Eastern = 02:00 UTC, 6 am = 10:00 UTC.
  assert.equal(nightHours(Date.UTC(2026, 9, 29, 1, 59)), false, '9:59 pm, clubs still on');
  assert.equal(nightHours(Date.UTC(2026, 9, 29, 2, 0)), true, '10 pm');
  assert.equal(nightHours(Date.UTC(2026, 9, 29, 9, 59)), true, '5:59 am');
  assert.equal(nightHours(Date.UTC(2026, 9, 29, 10, 0)), false, '6 am');
  assert.equal(nightHours(Date.UTC(2026, 9, 29, 15)), false, 'school day');
  // December: EST (UTC-5). 10 pm Eastern = 03:00 UTC.
  assert.equal(nightHours(Date.UTC(2026, 11, 2, 2, 30)), false, '9:30 pm EST');
  assert.equal(nightHours(Date.UTC(2026, 11, 2, 3, 0)), true, '10 pm EST');
  assert.equal(nightHours(Date.UTC(2026, 11, 2, 10, 30)), true, '5:30 am EST');
  assert.equal(nightHours(Date.UTC(2026, 11, 2, 11, 0)), false, '6 am EST');
});

test('nightSong / nightWorthy: song details only; OK or UNKNOWN whose lyrics were never read; never Spotify', () => {
  assert.deepEqual(Object.keys(nightSong(song(1))).sort(), ['album', 'artist', 'durationMs', 'explicit', 'genre', 'id', 'title', 'year']);
  assert.equal(nightSong(song(1, { id: 'sp:4uLU6hMCjMI75M1A2tKUQC' })), null);
  assert.equal(nightWorthy(song(1), { verdict: 'ok', instrumental: false }), true);
  assert.equal(nightWorthy(song(1), { verdict: 'unknown', source: 'limit' }), true, 'a free teacher\'s used-up checks: the night checks it');
  assert.equal(nightWorthy(song(1), { verdict: 'ok', lyrics: 'none' }), false, 'LRCLIB has no lyrics: the night cannot help');
  assert.equal(nightWorthy(song(1), { verdict: 'inappropriate' }), false);
  assert.equal(nightWorthy(song(1), { verdict: 'ok', source: 'teacher' }), false);
  assert.equal(nightWorthy(song(1), null), false);
});

test('nightShift: settles listed songs from their lyrics, a few a run, clears the list, daily cap', async () => {
  let asked = 0;
  const env = {
    CLASS_KV: fakeKv(),
    AI: { run: async () => { asked++; return { response: '{"instrumental":false,"verdict":"OK","category":null,"evidence":""}' }; } },
  };
  const now = Date.UTC(2026, 9, 28, 5);
  await addToNight(env, 'look:a', [song(1)]);
  await addToNight(env, 's:b', Array.from({ length: 12 }, (_, i) => song(10 + i)));
  const one = await nightShift(env, { now, lyricsFetch: lrclib });
  assert.equal(one.checked, NIGHT_PER_RUN);
  assert.equal(env.CLASS_KV.map.has('lyricsq:v1:look:a'), false, 'a finished list is deleted');
  const v = JSON.parse(env.CLASS_KV.map.get(verdictKey('it:101', PROMPT_VERSION)));
  assert.deepEqual([v.verdict, v.lyrics, v.source], ['ok', 'found', 'lyrics'], 'confirmed from its lyrics: ✓ Checked tomorrow');
  assert.ok(!env.CLASS_KV.map.get(verdictKey('it:101', PROMPT_VERSION)).includes('we sing'), 'never the lyrics');
  assert.equal(JSON.parse(env.CLASS_KV.map.get('lyricsq:v1:s:b')).length, 12 - (NIGHT_PER_RUN - 1), 'the rest waits for the next run');
  // A settled song costs nothing the next time it is listed.
  const before = asked;
  await addToNight(env, 'look:c', [song(1)]);
  env.CLASS_KV.map.delete('lyricsq:v1:s:b');
  const again = await nightShift(env, { now, lyricsFetch: lrclib });
  assert.equal(again.asked, 0);
  assert.equal(asked, before);
  // The cap.
  await addToNight(env, 's:d', Array.from({ length: 200 }, (_, i) => song(300 + i)));
  let last;
  for (let i = 0; i < 100; i++) last = await nightShift(env, { now, lyricsFetch: lrclib });
  assert.equal(last.used, NIGHT_AI_PER_DAY);
  assert.equal(last.asked, 0);
});

test('sweepBans: every teacher\'s ban list goes on the night list ONCE; the ban lists stay', async () => {
  const env = { CLASS_KV: fakeKv() };
  const legacy = JSON.stringify([{ id: 'it:501', title: 'Banned One', artist: 'X', at: 1 }, { trackId: 502, title: 'Old Entry', artist: 'Y', at: 2 }]);
  const other = JSON.stringify([{ id: 'it:503', title: 'Banned One', artist: 'X', at: 3 }, { id: 'sp:4uLU6hMCjMI75M1A2tKUQC', title: 'Spotify', artist: 'Z', at: 4 }]);
  env.CLASS_KV.map.set('banned', legacy);
  env.CLASS_KV.map.set('p:matt-carroll:banned', other);
  env.CLASS_KV.map.set('p:matt-carroll:approved:it:9', '{}');
  assert.equal(await sweepBans(env, '2026-10-28'), 2, 'one per song (any version), iTunes only');
  const listed = JSON.parse(env.CLASS_KV.map.get('lyricsq:v1:bans:2026-10-28-0'));
  assert.deepEqual(listed.map((s) => s.id), ['it:501', 'it:502']);
  assert.equal(env.CLASS_KV.map.get('banned'), legacy, 'the teacher\'s ban stays as it was');
  assert.equal(env.CLASS_KV.map.get('p:matt-carroll:banned'), other);
  assert.equal(await sweepBans(env, '2026-11-30'), 0, 'never again (new bans are listed when they are made)');
});

test('nightShift: settled songs cost no AI and do not use up the run', async () => {
  let asked = 0;
  const env = {
    CLASS_KV: fakeKv(),
    AI: { run: async () => { asked++; return { response: '{"instrumental":false,"verdict":"OK","category":null,"evidence":""}' }; } },
  };
  env.CLASS_KV.map.set('night:v1:bans-swept', 'x');
  const settled = { verdict: 'ok', category: 'other', evidence: '', instrumental: false, lyrics: 'found', lv: 1, source: 'lyrics' };
  for (let i = 0; i < 20; i++) env.CLASS_KV.map.set(verdictKey(`song:song ${i}|artist ${i}`, PROMPT_VERSION), JSON.stringify(settled));
  await addToNight(env, 'a', [...Array.from({ length: 20 }, (_, i) => song(i)), song(50)]);
  const r = await nightShift(env, { now: Date.UTC(2026, 9, 28, 5), lyricsFetch: lrclib });
  assert.equal(r.checked, 21, 'the 20 settled ones and the new one, in one run');
  assert.equal(r.asked, 2, 'only the new song: its theme call and its lyrics call');
});
