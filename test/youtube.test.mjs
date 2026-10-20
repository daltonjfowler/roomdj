import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MIN_SCORE, decodeEntities, parseDuration, rankCandidates, scoreCandidate, searchIds, searchParams, searchQuery, toCandidate,
} from '../shared/youtube-match.js';
import { YoutubeError, classifyApiError, resolveVideo, secondsToQuotaReset, ytKey } from '../src/youtube.js';

// Hand-written from the shapes in the YouTube Data API v3 docs (search.list, videos.list, errors).
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/youtube/${name}.json`, import.meta.url), 'utf8'));

const happy = {
  id: 'it:863835363', title: 'Happy (From "Despicable Me 2")', artist: 'Pharrell Williams', album: 'G I R L',
  artwork: '', durationMs: 232_720, explicit: 'notExplicit', previewUrl: 'https://x',
};

const cand = (over = {}) => ({
  videoId: 'AAAAAAAAAAA', title: 'Song', channel: 'Artist - Topic', durationMs: 200_000,
  embeddable: true, public: true, ageRestricted: false, live: false, ...over,
});
const song = (over = {}) => ({ ...happy, id: 'it:1', title: 'Song', artist: 'Artist', durationMs: 200_000, ...over });

const candidates = () => {
  const byId = new Map(fixture('videos-happy').items.map((i) => [i.id, toCandidate(i)]));
  return searchIds(fixture('search-happy')).map((id) => byId.get(id));
};

test('search query: artist, title without version labels, "official audio"', () => {
  assert.equal(searchQuery(happy), 'Pharrell Williams - Happy official audio');
  const p = searchParams(happy);
  for (const [k, v] of Object.entries({
    part: 'snippet', type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', safeSearch: 'strict', videoCategoryId: '10', maxResults: '5',
  })) assert.equal(p.get(k), v, k);
  assert.equal(p.get('key'), null);
});

test('ISO 8601 durations', () => {
  assert.equal(parseDuration('PT3M53S'), 233_000);
  assert.equal(parseDuration('PT1H2M3S'), 3_723_000);
  assert.equal(parseDuration('PT45S'), 45_000);
  assert.equal(parseDuration('P0D'), 0);
  assert.equal(parseDuration('nonsense'), 0);
  assert.equal(parseDuration(undefined), 0);
});

test('titles lose their HTML entities', () => {
  assert.equal(decodeEntities('Don&#39;t Stop &amp; &quot;Go&quot;'), 'Don\'t Stop & "Go"');
});

test('fixture: candidates come back in search order with the videos.list details', () => {
  const c = candidates();
  assert.deepEqual(c.map((x) => x.videoId), ['OffVideo001', 'LiveOscar01', 'TopicAudio1', 'KidsCover01', 'SpedUpEdit1']);
  assert.equal(c[2].title, 'Happy (From "Despicable Me 2")');
  assert.equal(c[2].durationMs, 233_000);
  assert.equal(c[4].ageRestricted, true);
});

test('fixture: the Topic upload wins, the official video is next, live / cover / age-restricted never play', () => {
  assert.deepEqual(rankCandidates(happy, candidates()), ['TopicAudio1', 'OffVideo001']);
});

test('ids that failed in the player are not picked again', () => {
  assert.deepEqual(rankCandidates(happy, candidates(), ['TopicAudio1']), ['OffVideo001']);
});

test('never: not embeddable, private, age restricted, a live stream', () => {
  for (const over of [{ embeddable: false }, { public: false }, { ageRestricted: true }, { live: true }]) {
    assert.equal(scoreCandidate(song(), cand(over)), -Infinity, JSON.stringify(over));
  }
});

test('version words count against a video unless the iTunes title has them', () => {
  for (const w of ['Live', 'Cover', 'Remix', 'Nightcore', 'Sped Up', '8D', 'Slowed + Reverb', 'Karaoke']) {
    assert.ok(scoreCandidate(song(), cand({ title: `Song (${w})` })) < MIN_SCORE, w);
  }
  assert.ok(scoreCandidate(song({ title: 'Live Forever' }), cand({ title: 'Live Forever' })) >= MIN_SCORE);
  assert.ok(scoreCandidate(song({ title: 'Song (Remix)' }), cand({ title: 'Song (Remix)' })) >= MIN_SCORE);
  // Whole words only: "Alive" is not "live".
  assert.ok(scoreCandidate(song({ title: 'Alive' }), cand({ title: 'Alive' })) >= MIN_SCORE);
});

test('explicit and uncensored uploads lose badly, even from the artist', () => {
  for (const w of ['Explicit', 'Uncensored', 'Dirty']) {
    assert.ok(scoreCandidate(song(), cand({ title: `Song (${w})` })) < 0, w);
  }
});

test('a cleaned iTunes song prefers a "clean" upload', () => {
  const cleaned = song({ explicit: 'cleaned' });
  const plain = cand({ videoId: 'PlainUpload', title: 'Song' });
  const clean = cand({ videoId: 'CleanUpload', title: 'Song (Clean)' });
  assert.deepEqual(rankCandidates(cleaned, [plain, clean]), ['CleanUpload', 'PlainUpload']);
  // ...but a notExplicit song does not care.
  assert.equal(rankCandidates(song(), [plain, clean])[0], 'PlainUpload');
});

test('length: within 15 s is best, a minute off is out', () => {
  const near = scoreCandidate(song(), cand({ durationMs: 210_000 }));
  const off30 = scoreCandidate(song(), cand({ durationMs: 228_000 }));
  const far = scoreCandidate(song(), cand({ durationMs: 330_000 }));
  assert.ok(near > off30 && off30 > far);
  assert.ok(scoreCandidate(song(), cand({ channel: 'Someone Else', title: 'Artist - Song', durationMs: 330_000 })) < MIN_SCORE);
});

test('channels: Topic > artist / VEVO > channel naming the artist > a stranger', () => {
  const s = (channel) => scoreCandidate(song({ artist: 'Bruno Mars' }), cand({ title: 'Bruno Mars - Song', channel }));
  assert.ok(s('Bruno Mars - Topic') > s('Bruno Mars'));
  assert.equal(s('Bruno Mars'), s('BrunoMarsVEVO'));
  assert.ok(s('BrunoMarsVEVO') > s('Bruno Mars Fans'));
  assert.ok(s('Bruno Mars Fans') > s('Random Uploads'));
  // Several artists on iTunes: the first one's Topic channel counts.
  assert.ok(scoreCandidate(song({ artist: 'Mark Ronson & Bruno Mars' }), cand({ channel: 'Mark Ronson - Topic' })) >= 60);
});

test('a different song by the artist is not a match', () => {
  assert.ok(scoreCandidate(song({ title: 'Uptown Funk' }), cand({ title: 'Grenade', channel: 'Artist - Topic' })) < MIN_SCORE);
});

// ---- src/youtube.js with a fake fetch and KV -----------------------------------------------------

function fakeKv() {
  const map = new Map();
  const ttl = new Map();
  return {
    map, ttl,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts) {
      map.set(k, v);
      ttl.set(k, opts?.expirationTtl);
    },
  };
}

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url) => {
    calls.push(new URL(url));
    const [status, body] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const env = (over = {}) => ({ YOUTUBE_API_KEY: 'test-key', CLASS_KV: fakeKv(), ...over });

test('resolve: search (100 units) + videos (1 unit), then KV for 30 days; no second call', async () => {
  const e = env();
  const f = fakeFetch([[200, fixture('search-happy')], [200, fixture('videos-happy')]]);
  const r = await resolveVideo(happy, e, { fetchImpl: f });
  assert.deepEqual(r, { videoId: 'TopicAudio1', cached: false });
  assert.deepEqual(f.calls.map((u) => u.pathname), ['/youtube/v3/search', '/youtube/v3/videos']);
  assert.equal(f.calls[0].searchParams.get('key'), 'test-key');
  assert.equal(f.calls[1].searchParams.get('id'), 'OffVideo001,LiveOscar01,TopicAudio1,KidsCover01,SpedUpEdit1');
  assert.equal(e.CLASS_KV.ttl.get(ytKey(happy.id)), 30 * 24 * 60 * 60);
  const again = await resolveVideo(happy, e, { fetchImpl: f });
  assert.deepEqual(again, { videoId: 'TopicAudio1', cached: true });
  assert.equal(f.calls.length, 2);
});

test('resolve: skip moves to the next candidate with no new search, and remembers the bad id', async () => {
  const e = env();
  const f = fakeFetch([[200, fixture('search-happy')], [200, fixture('videos-happy')]]);
  const t0 = Date.UTC(2026, 9, 1);
  await resolveVideo(happy, e, { fetchImpl: f, now: t0 });
  const r = await resolveVideo(happy, e, { fetchImpl: f, skip: 'TopicAudio1', now: t0 + 86_400_000 });
  assert.equal(r.videoId, 'OffVideo001');
  assert.equal(f.calls.length, 2);
  // The entry keeps its first 30-day end (one day used).
  assert.equal(e.CLASS_KV.ttl.get(ytKey(happy.id)), 29 * 24 * 60 * 60);
  assert.equal((await resolveVideo(happy, e, { fetchImpl: f })).videoId, 'OffVideo001');
  await assert.rejects(resolveVideo(happy, e, { fetchImpl: f, skip: 'OffVideo001' }), (err) => err.code === 'none');
  assert.equal(f.calls.length, 2);
});

test('resolve: no key → off, and nothing is fetched', async () => {
  const f = fakeFetch([]);
  await assert.rejects(resolveVideo(happy, env({ YOUTUBE_API_KEY: undefined }), { fetchImpl: f }), (err) => err instanceof YoutubeError && err.code === 'off');
  assert.equal(f.calls.length, 0);
});

test('resolve: quota used up → quota, and no more calls until midnight Pacific', async () => {
  const e = env();
  const f = fakeFetch([[403, fixture('quota-exceeded')]]);
  const now = Date.UTC(2026, 9, 5, 15, 0, 0); // 08:00 in California (PDT)
  await assert.rejects(resolveVideo(happy, e, { fetchImpl: f, now }), (err) => err.code === 'quota'
    && err.message === "YouTube's daily search limit is used up; using song previews until tomorrow.");
  assert.equal(e.CLASS_KV.ttl.get('yt:quota'), 16 * 3600);
  await assert.rejects(resolveVideo({ ...happy, id: 'it:2' }, e, { fetchImpl: f, now }), (err) => err.code === 'quota');
  assert.equal(f.calls.length, 1);
  // Songs already found still play.
  e.CLASS_KV.map.set(ytKey(3), JSON.stringify({ ranked: ['TopicAudio1'], bad: [], at: now }));
  assert.equal((await resolveVideo({ ...happy, id: 'it:3' }, e, { fetchImpl: f, now })).videoId, 'TopicAudio1');
});

test('resolve: a bad key is "down" (not quota), and nothing is cached', async () => {
  const e = env();
  await assert.rejects(resolveVideo(happy, e, { fetchImpl: fakeFetch([[400, fixture('key-invalid')]]) }), (err) => err.code === 'down');
  assert.equal(e.CLASS_KV.map.size, 0);
});

test('resolve: no results → none, remembered for a week', async () => {
  const e = env();
  const f = fakeFetch([[200, fixture('search-empty')]]);
  await assert.rejects(resolveVideo(happy, e, { fetchImpl: f }), (err) => err.code === 'none');
  assert.equal(e.CLASS_KV.ttl.get(ytKey(happy.id)), 7 * 24 * 60 * 60);
  await assert.rejects(resolveVideo(happy, e, { fetchImpl: f }), (err) => err.code === 'none');
  assert.equal(f.calls.length, 1);
});

test('API errors: quota reasons vs the rest', () => {
  assert.equal(classifyApiError(403, fixture('quota-exceeded')), 'quota');
  assert.equal(classifyApiError(400, fixture('key-invalid')), 'down');
  assert.equal(classifyApiError(403, { error: { errors: [{ reason: 'forbidden' }] } }), 'down');
  assert.equal(classifyApiError(500, null), 'down');
});

test('quota reset: seconds to the next midnight in California', () => {
  assert.equal(secondsToQuotaReset(Date.UTC(2026, 9, 5, 6, 59, 0)), 60); // 23:59 PDT, never under 60
  assert.equal(secondsToQuotaReset(Date.UTC(2026, 11, 5, 20, 0, 0)), 12 * 3600); // 12:00 PST
});
