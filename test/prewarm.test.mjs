// src/prewarm.js: chart songs are checked before classes suggest them, within a daily AI cap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PREWARM_AI_PER_DAY, PREWARM_NIGHT_PER_RUN, PREWARM_PER_RUN, PREWARM_SCAN_PER_RUN, chartSong, genreChartSong, growShelves, prewarm } from '../src/prewarm.js';
import { GROWN_KEY, readGrown } from '../src/songbook.js';
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
  // LRCLIB has nothing for these test songs (never the real LRCLIB in a test).
  const lyricsFetch = async () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  const one = await prewarm(env, { now, fetchImpl: feed(300), lyricsFetch, songbook: [] });
  // 8 am in New York: a daytime run.
  assert.equal(one.checked, PREWARM_PER_RUN);
  assert.equal(one.asked, PREWARM_PER_RUN * 2, 'each OK is also looked up on LRCLIB to confirm it (one budget step each)');
  assert.ok(env.CLASS_KV.map.has(verdictKey('it:1000', PROMPT_VERSION)), 'the verdict is cached for everyone');
  // The same songs again (a new day's list starting with them): no AI.
  const before = asked;
  env.CLASS_KV.map.delete('prewarm:v1:state:2026-10-15');
  const again = await prewarm(env, { now: now + 86_400_000, lyricsFetch, songbook: [], fetchImpl: async () => Response.json({ feed: { results: Array.from({ length: PREWARM_PER_RUN }, (_, i) => entry(i)) } }) });
  assert.equal(again.asked, 0);
  assert.equal(again.scanned, PREWARM_PER_RUN, 'looked at, at no AI cost');
  assert.equal(asked, before, 'known songs: not asked');
  // The cap: runs until the day's AI calls are used.
  let last;
  for (let i = 0; i < 400 && !(last?.used >= PREWARM_AI_PER_DAY && last.asked === 0); i++) last = await prewarm(env, { now: now + 2 * 86_400_000, fetchImpl: feed(1000), lyricsFetch, songbook: [] });
  assert.equal(last.used, PREWARM_AI_PER_DAY);
  assert.equal(last.asked, 0, 'past the cap: nothing more');
});

test('prewarm: the songbook after the day\'s charts, one pass per list, a new list starts again', async () => {
  const env = {
    CLASS_KV: fakeKv(),
    AI: { run: async () => ({ response: '{"instrumental":false,"verdict":"OK","category":null,"evidence":""}' }) },
  };
  const now = Date.UTC(2026, 9, 29, 12);
  const lyricsFetch = async () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  const songbook = Array.from({ length: PREWARM_PER_RUN + 2 }, (_, i) => ({ id: `it:${5000 + i}`, title: `Book ${i}`, artist: 'Shelf', album: '', durationMs: 1 }));
  // Charts first: 2 chart songs, then the rest of the run goes to the songbook.
  const one = await prewarm(env, { now, fetchImpl: feed(2), lyricsFetch, songbook, songbookMade: '2026-10-29' });
  assert.equal(one.checked, PREWARM_PER_RUN);
  assert.equal(one.songbook, PREWARM_PER_RUN - 2);
  assert.ok(env.CLASS_KV.map.has(verdictKey('it:5000', PROMPT_VERSION)));
  const two = await prewarm(env, { now, fetchImpl: feed(2), lyricsFetch, songbook, songbookMade: '2026-10-29' });
  assert.equal(two.songbook, songbook.length, 'picks up where it stopped');
  // Done: nothing more for this list, even on a new day.
  env.CLASS_KV.map.delete('prewarm:v1:state:2026-10-29');
  const three = await prewarm(env, { now, fetchImpl: feed(2), lyricsFetch, songbook, songbookMade: '2026-10-29' });
  assert.deepEqual([three.songbook, three.checked, three.scanned], [songbook.length, 0, 2], 'known chart songs: looked at, no AI');
  // A new list (npm run songbook again): from the top; known songs cost no AI call.
  env.CLASS_KV.map.delete('prewarm:v1:state:2026-10-29');
  const four = await prewarm(env, { now, fetchImpl: feed(2), lyricsFetch, songbook, songbookMade: '2026-11-05' });
  assert.deepEqual([four.songbook, four.asked], [songbook.length, 0], 'all known: the whole list in one run, no AI');
});

const gEntry = (i, genre = 'Pop') => ({
  id: { attributes: { 'im:id': String(7000 + i) } }, 'im:name': { label: `Genre Song ${i}` }, 'im:artist': { label: `Band ${i}` },
  category: { attributes: { label: genre } }, 'im:releaseDate': { label: '2025-03-01T00:00:00-07:00' },
});
const itunes = (i, extra = {}) => ({
  kind: 'song', trackId: 7000 + i, trackName: `Genre Song ${i}`, artistName: `Band ${i}`, collectionName: 'LP', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg',
  trackTimeMillis: 200000, trackExplicitness: 'notExplicit', previewUrl: 'https://audio-ssl.itunes.apple.com/a.m4a', primaryGenreName: 'Pop', releaseDate: '2025-03-01T00:00:00Z', ...extra,
});

test('genreChartSong: the older iTunes RSS entry as a song', () => {
  assert.deepEqual(genreChartSong(gEntry(1, 'K-Pop')), { id: 'it:7001', title: 'Genre Song 1', artist: 'Band 1', album: '', genre: 'K-Pop', year: 2025, explicit: 'notExplicit' });
  assert.equal(genreChartSong({ 'im:name': { label: 'x' } }), null);
});

test('prewarm: genre charts after the songbook; ✓ Checked finds join the shelves with their iTunes details', async () => {
  const env = {
    CLASS_KV: fakeKv(),
    AI: { run: async () => ({ response: '{"instrumental":false,"verdict":"OK","category":null,"evidence":""}' }) },
  };
  const now = Date.UTC(2026, 9, 30, 12);
  // LRCLIB confirms: clean lyrics found for every song, so an OK is ✓ Checked.
  const lyricsFetch = async (url) => {
    const q = new URL(String(url)).searchParams;
    return Response.json([{ id: 1, trackName: q.get('track_name'), artistName: q.get('artist_name'), albumName: '', duration: 200, plainLyrics: 'Sunshine on the window, happy days ahead\n'.repeat(12), syncedLyrics: null, instrumental: false }]);
  };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/rss/topsongs/') && String(url).includes('genre=14/')) return Response.json({ feed: { entry: [gEntry(1), gEntry(2)] } });
    if (String(url).includes('/rss/topsongs/')) return Response.json({ feed: { entry: [] } });
    if (String(url).includes('/lookup?')) return Response.json({ results: [itunes(1), itunes(2, { trackExplicitness: 'explicit' })] });
    return Response.json({ feed: { results: [] } });
  };
  let r;
  for (let i = 0; i < 3; i++) r = await prewarm(env, { now, fetchImpl, lyricsFetch, songbook: [], baked: new Set() });
  assert.ok(urls.some((u) => u.includes('genre=51/')), 'the K-Pop chart is read');
  const grown = readGrown(JSON.parse(env.CLASS_KV.map.get(GROWN_KEY) ?? 'null'));
  assert.deepEqual(grown.map((s) => [s.id, s.shelves.join()]), [['it:7001', 'pop']], 'the explicit one stays off the shelves');
  assert.match(grown[0].previewUrl, /^https:/);
  assert.ok(r.scanned <= PREWARM_SCAN_PER_RUN);
});

test('growShelves: a failed lookup adds nothing; known songs are not looked up again', async () => {
  const env = { CLASS_KV: fakeKv() };
  const found = [{ id: 'it:7001', title: 'Genre Song 1', artist: 'Band 1' }];
  assert.equal(await growShelves(env, found, async () => new Response('', { status: 403 }), new Set()), 0);
  assert.equal(env.CLASS_KV.map.has(GROWN_KEY), false);
  let calls = 0;
  const ok = async () => { calls++; return Response.json({ results: [itunes(1)] }); };
  assert.equal(await growShelves(env, found, ok, new Set()), 1);
  assert.equal(await growShelves(env, found, ok, new Set()), 0);
  assert.equal(calls, 1, 'already on a shelf: no second lookup');
});

test('prewarm: more songs a run at night (New York), the same daily cap', async () => {
  const env = { CLASS_KV: fakeKv(), AI: { run: async () => ({ response: '{"instrumental":false,"verdict":"OK","category":null,"evidence":""}' }) } };
  const lyricsFetch = async () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  const night = await prewarm(env, { now: Date.UTC(2026, 9, 31, 6), fetchImpl: feed(300), lyricsFetch, songbook: [] }); // 2 am ET
  assert.equal(night.checked, PREWARM_NIGHT_PER_RUN);
});
