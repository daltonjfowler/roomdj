// src/lyrics-finish.js: the songs still waiting on their lyrics are asked again, a few a run, no new songs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FINISH_KEY, FINISH_PER_RUN, finishLyrics } from '../src/lyrics-finish.js';
import { verdictKey } from '../shared/filter.js';
import { resetLyricsMemory } from '../src/lyrics.js';

function fakeKv(entries) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    async get(k, type) { const v = map.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { map.set(k, v); },
  };
}

const aiOnly = JSON.stringify({ verdict: 'ok', category: 'other', evidence: '', instrumental: false });
const settled = JSON.stringify({ verdict: 'ok', category: 'other', evidence: '', instrumental: false, lyrics: 'found', lv: 1, source: 'lyrics' });
const bad = JSON.stringify({ verdict: 'inappropriate', category: 'drugs', evidence: 'about drugs', instrumental: false });
const song = (i) => ({ id: `it:${i}`, title: `Song ${i}`, artist: `Artist ${i}`, album: 'LP', durationMs: 200_000, explicit: 'notExplicit' });
const lrclib = (calls, fail = () => false) => async (url) => {
  const n = new URL(url).searchParams.get('track_name').replace('Song ', '');
  calls.push(n);
  if (fail(n)) return new Response('busy', { status: 503 });
  return Response.json([{ trackName: `Song ${n}`, artistName: `Artist ${n}`, duration: 200, instrumental: false, plainLyrics: 'la la la\nwe sing along' }]);
};
const ai = () => ({ run: async () => ({ response: '{"instrumental":false,"verdict":"OK","category":null,"evidence":""}' }) });
const source = (v) => JSON.parse(v ?? 'null')?.source;

test('finishLyrics: settles the waiting songs a few a run, one pass, never a song without a verdict', async () => {
  resetLyricsMemory();
  const songs = Array.from({ length: 16 }, (_, i) => song(100 + i));
  const entries = { [verdictKey('it:112')]: settled, [verdictKey('it:113')]: bad };
  for (let i = 0; i < 12; i++) entries[verdictKey(`it:${100 + i}`)] = aiOnly; // 114, 115: never checked
  entries[verdictKey('song:song 115|artist 115')] = aiOnly; // found by its song key too
  const env = { CLASS_KV: fakeKv(entries), AI: ai() };
  const lyrics = [];
  const one = await finishLyrics(env, { songs, lyricsFetch: lrclib(lyrics) });
  assert.equal(lyrics.length, FINISH_PER_RUN);
  assert.equal(one.done, false);
  const v = JSON.parse(env.CLASS_KV.map.get(verdictKey('it:100')));
  assert.deepEqual([v.verdict, v.lyrics, v.source], ['ok', 'found', 'lyrics'], 'confirmed from its lyrics: ✓ Checked now');
  const two = await finishLyrics(env, { songs, lyricsFetch: lrclib(lyrics) });
  assert.equal(two.done, true, 'the pass is over');
  assert.deepEqual(lyrics.sort(), [...Array.from({ length: 12 }, (_, i) => String(100 + i)), '115'].sort(), 'only the waiting ones, each once');
  assert.equal(env.CLASS_KV.map.has(verdictKey('it:114')), false, 'a song never checked stays unchecked');
  // Done for good: nothing is asked again.
  const three = await finishLyrics(env, { songs, lyricsFetch: lrclib(lyrics) });
  assert.equal(three.done, true);
  assert.equal(lyrics.length, 13);
});

test('finishLyrics: LRCLIB busy stops the run on that song, the next run asks it first, then it is passed over', async () => {
  resetLyricsMemory();
  const songs = [song(100), song(101)];
  const env = { CLASS_KV: fakeKv({ [verdictKey('it:100')]: aiOnly, [verdictKey('it:101')]: aiOnly }), AI: ai() };
  const lyrics = [];
  const busy = (n) => n === '100';
  const one = await finishLyrics(env, { songs, lyricsFetch: lrclib(lyrics, busy) });
  assert.equal(one.at, 0, 'stays on the busy song');
  assert.equal(source(env.CLASS_KV.map.get(verdictKey('it:101'))), undefined, 'the songs after it wait');
  resetLyricsMemory(); // the backoff is over
  await finishLyrics(env, { songs, lyricsFetch: lrclib(lyrics, busy) });
  resetLyricsMemory();
  const three = await finishLyrics(env, { songs, lyricsFetch: lrclib(lyrics, busy) });
  assert.equal(three.at, 1, 'after FINISH_TRIES the busy song is passed over');
  resetLyricsMemory(); // its 503 held the backoff, so the next song waited for this run
  const four = await finishLyrics(env, { songs, lyricsFetch: lrclib(lyrics, busy) });
  assert.equal(four.done, true, 'the rest finish');
  assert.equal(source(env.CLASS_KV.map.get(verdictKey('it:101'))), 'lyrics');
  assert.equal(source(env.CLASS_KV.map.get(verdictKey('it:100'))), undefined, 'still waiting, as before');
  assert.ok(env.CLASS_KV.map.has(FINISH_KEY));
});
