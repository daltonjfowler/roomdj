// src/lyrics-finish.js: the songs still waiting on their lyrics are asked again, a few a run, no new songs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FINISH_KEY, FINISH_PER_RUN, finishLyrics } from '../src/lyrics-finish.js';
import { PROMPT_VERSION, verdictKey } from '../shared/filter.js';
import { resetLyricsMemory } from '../src/lyrics.js';

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
const aiOnly = JSON.stringify({ verdict: 'ok', category: 'other', evidence: '', instrumental: false });
const settled = JSON.stringify({ verdict: 'ok', category: 'other', evidence: '', instrumental: false, lyrics: 'found', lv: 1, source: 'lyrics' });
const bad = JSON.stringify({ verdict: 'inappropriate', category: 'drugs', evidence: 'about drugs', instrumental: false });

const itunes = (asked) => async (url) => {
  const ids = new URL(url).searchParams.get('id').split(',');
  asked.push(...ids);
  return Response.json({ results: ids.map((id) => ({
    kind: 'song', trackId: Number(id), trackName: `Song ${id}`, artistName: `Artist ${id}`, collectionName: 'LP',
    trackTimeMillis: 200000, trackExplicitness: 'notExplicit', previewUrl: 'https://audio-ssl.itunes.apple.com/a.m4a',
  })) });
};
const lrclib = (calls, fail = () => false) => async (url) => {
  const n = new URL(url).searchParams.get('track_name').replace('Song ', '');
  calls.push(n);
  if (fail(n)) return new Response('busy', { status: 503 });
  return Response.json([{ trackName: `Song ${n}`, artistName: `Artist ${n}`, duration: 200, instrumental: false, plainLyrics: 'la la la\nwe sing along' }]);
};
const ai = () => ({ run: async () => ({ response: '{"instrumental":false,"verdict":"OK","category":null,"evidence":""}' }) });

test('finishLyrics: settles the waiting songs a few a run, one pass, never a song without a verdict', async () => {
  resetLyricsMemory();
  const entries = { [`${p}song:a|x`]: aiOnly, [`${p}900`]: settled, [`${p}901`]: bad, 'other:5': '1' };
  for (let i = 0; i < 12; i++) entries[`${p}${100 + i}`] = aiOnly;
  const env = { CLASS_KV: fakeKv(entries), AI: ai() };
  const looked = [], lyrics = [];
  const one = await finishLyrics(env, { fetchImpl: itunes(looked), lyricsFetch: lrclib(lyrics) });
  assert.equal(looked.length, FINISH_PER_RUN, 'one iTunes lookup for the run\'s share');
  assert.equal(one.done, false);
  const v = JSON.parse(env.CLASS_KV.map.get(verdictKey('it:100')));
  assert.deepEqual([v.verdict, v.lyrics, v.source], ['ok', 'found', 'lyrics'], 'confirmed from its lyrics: ✓ Checked now');
  const two = await finishLyrics(env, { fetchImpl: itunes(looked), lyricsFetch: lrclib(lyrics) });
  assert.equal(two.done, true, 'the pass is over');
  assert.deepEqual(looked.sort(), Array.from({ length: 12 }, (_, i) => String(100 + i)), 'only the waiting ones, each once');
  for (let i = 0; i < 12; i++) assert.equal(JSON.parse(env.CLASS_KV.map.get(verdictKey(`it:${100 + i}`))).source, 'lyrics');
  // Done for good: nothing is listed or asked again.
  const before = lyrics.length;
  const three = await finishLyrics(env, { fetchImpl: itunes(looked), lyricsFetch: lrclib(lyrics) });
  assert.equal(three.done, true);
  assert.equal(lyrics.length, before);
});

test('finishLyrics: LRCLIB busy stops the run on that song, the next run asks it first, then it is passed over', async () => {
  resetLyricsMemory();
  const env = { CLASS_KV: fakeKv({ [`${p}100`]: aiOnly, [`${p}101`]: aiOnly }), AI: ai() };
  const looked = [], lyrics = [];
  const busy = (n) => n === '100';
  const one = await finishLyrics(env, { fetchImpl: itunes(looked), lyricsFetch: lrclib(lyrics, busy) });
  assert.equal(one.skip, 0, 'stays on the busy song');
  assert.equal(one.tries, 1);
  assert.equal(JSON.parse(env.CLASS_KV.map.get(verdictKey('it:101'))).source, undefined, 'the songs after it wait');
  resetLyricsMemory(); // the backoff is over
  await finishLyrics(env, { fetchImpl: itunes(looked), lyricsFetch: lrclib(lyrics, busy) });
  resetLyricsMemory();
  const three = await finishLyrics(env, { fetchImpl: itunes(looked), lyricsFetch: lrclib(lyrics, busy) });
  assert.equal(three.skip, 1, 'after FINISH_TRIES the busy song is passed over');
  // Its 503 holds LRCLIB's backoff, so the next song waits for the next run too.
  resetLyricsMemory();
  const four = await finishLyrics(env, { fetchImpl: itunes(looked), lyricsFetch: lrclib(lyrics, busy) });
  assert.equal(four.done, true, 'the rest finish');
  assert.equal(JSON.parse(env.CLASS_KV.map.get(verdictKey('it:101'))).source, 'lyrics');
  assert.equal(JSON.parse(env.CLASS_KV.map.get(verdictKey('it:100'))).source, undefined, 'still waiting, as before');
  assert.ok(env.CLASS_KV.map.has(FINISH_KEY));
});
