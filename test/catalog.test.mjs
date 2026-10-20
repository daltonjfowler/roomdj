// Song catalogs: catalog-qualified song ids (and reading the old numeric trackIds), Spotify's
// catalog with the Client Credentials flow (mapping, token cache, 429 handling), the fallback
// order to iTunes, clean-version swaps, and the policy rules (a Spotify song never goes to the AI
// or to YouTube). Spotify answers are hand-written in the Web API's documented shapes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogOf, itunesTrackId, kvId, legacySong, songId, spotifyLink, spotifyTrackId } from '../shared/catalog.js';
import { migrateRoomState, newRoomState, suggestRefusal } from '../shared/queue.js';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import { aiThemeCheck, approveSong, filterSong, verdictKey } from '../shared/filter.js';
import { pickArtwork, resetSpotifyMemory, searchSpotify, lookupSpotify, spotifyCatalogConfigured, trackToSong } from '../src/spotify-catalog.js';
import { findCleanVersion, isCleanVersionOf, lookupCatalog, roomCatalog, searchCatalog } from '../src/catalog.js';
import { readBanned, searchAllowed } from '../src/search.js';
import { resolveVideo } from '../src/youtube.js';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const SECRET = 'test-secret-not-real'; // pragma: allowlist secret (made-up test value)
const ID_A = '4uLU6hMCjMI75M1A2tKUQC'; // 22 base-62 characters
const ID_B = '7ouMYWpwJ422jRcDASZB7P';

function fakeKv() {
  const map = new Map();
  const ttl = new Map();
  return {
    map,
    ttl,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts) {
      map.set(k, v);
      if (opts?.expirationTtl) ttl.set(k, opts.expirationTtl);
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

const spotifyEnv = (over = {}) => ({ CLASS_KV: fakeKv(), SPOTIFY_CLIENT_ID: CLIENT_ID, SPOTIFY_CLIENT_SECRET: SECRET, ...over });

/** A track object as GET /v1/tracks/{id} and /v1/search document it (February 2026 fields). */
function track(over = {}) {
  return {
    type: 'track',
    id: ID_A,
    uri: `spotify:track:${over.id ?? ID_A}`,
    name: 'Happy - From "Despicable Me 2"',
    artists: [{ type: 'artist', id: '2RdwBSPQiwcmiDo9kixcl8', name: 'Pharrell Williams' }],
    album: {
      album_type: 'single',
      name: 'Happy (From "Despicable Me 2")',
      images: [
        { url: 'https://i.scdn.co/image/ab67616d0000b273aaaa', height: 640, width: 640 },
        { url: 'https://i.scdn.co/image/ab67616d00001e02bbbb', height: 300, width: 300 },
        { url: 'https://i.scdn.co/image/ab67616d00004851cccc', height: 64, width: 64 },
      ],
    },
    duration_ms: 232720,
    explicit: false,
    is_local: false,
    is_playable: true,
    external_urls: { spotify: `https://open.spotify.com/track/${over.id ?? ID_A}` },
    ...over,
  };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * A fake fetch: routes by URL. `routes` maps a test (string prefix or function) to a handler
 * (url, init) → Response. Records every call.
 */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (typeof match === 'function' ? match(String(url)) : String(url).startsWith(match)) return handler(String(url), init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  f.calls = calls;
  f.count = (prefix) => calls.filter((c) => c.url.startsWith(prefix)).length;
  return f;
}

const TOKEN = ['https://accounts.spotify.com/api/token', () => json(200, { access_token: 'app-token-1', token_type: 'Bearer', expires_in: 3600 })];
const searchPage = (items, next = null) => ({ tracks: { href: '', items, limit: 10, next, offset: 0, previous: null, total: items.length } });

function quiet(fn) {
  return async () => {
    const orig = console.error;
    const logged = [];
    console.error = (...a) => logged.push(a.join(' '));
    try {
      await fn(logged);
    } finally {
      console.error = orig;
    }
  };
}

test.beforeEach(() => resetSpotifyMemory());

// ---- ids --------------------------------------------------------------------------------------

test('song ids: catalog-qualified, and old numeric iTunes trackIds read as it:<n>', () => {
  assert.equal(catalogOf('it:863835363'), 'it');
  assert.equal(catalogOf(`sp:${ID_A}`), 'sp');
  for (const bad of ['it:0', 'it:01', 'it:-1', 'it:99999999999999999', 'sp:short', `sp:${ID_A}x`, 'xx:1', '', null, 42]) {
    assert.equal(catalogOf(bad), null, String(bad));
  }
  assert.equal(songId(42), 'it:42');
  assert.equal(songId('it:42'), 'it:42');
  assert.equal(songId('42'), null, 'a string number is not an id');
  assert.equal(songId(0), null);
  assert.equal(songId(1.5), null);
  assert.equal(itunesTrackId('it:42'), 42);
  assert.equal(spotifyTrackId(`sp:${ID_A}`), ID_A);
  assert.equal(spotifyTrackId('it:42'), null);
  assert.equal(kvId('it:42'), '42', 'iTunes KV keys keep their old bare-number form');
  assert.equal(kvId(`sp:${ID_A}`), `sp:${ID_A}`);
  assert.equal(spotifyLink(`sp:${ID_A}`), `https://open.spotify.com/track/${ID_A}`);
  assert.equal(spotifyLink('it:42'), null);
  assert.deepEqual(legacySong({ trackId: 7, title: 'T' }), { id: 'it:7', title: 'T' });
  const fresh = { id: 'it:8', title: 'U' };
  assert.equal(legacySong(fresh), fresh);
});

test('a room saved before catalog ids: its songs and played list move to it:<n>', () => {
  const old = newRoomState('r', DEFAULT_SETTINGS);
  delete old.service;
  const s = (n) => ({ trackId: n, title: `Song ${n}`, artist: 'A', album: '', artwork: '', durationMs: 1, explicit: 'notExplicit', previewUrl: 'https://x' });
  old.queue = [{ id: 's1', song: s(1), device: 'd', by: 'Ana', addedAt: 1, votes: {} }];
  old.nowPlaying = { id: 's2', song: s(2), device: 'd', by: 'Ana', addedAt: 1, votes: {} };
  delete old.review;
  old.played = [2, 3];
  const room = migrateRoomState(old);
  assert.equal(room.queue[0].song.id, 'it:1');
  assert.equal(room.queue[0].song.trackId, undefined);
  assert.equal(room.nowPlaying.song.id, 'it:2');
  assert.deepEqual(room.played, ['it:2', 'it:3']);
  assert.deepEqual(room.review, []);
  assert.equal(room.service, null);
  assert.equal(suggestRefusal(room, 'other', 'it:3'), 'played');
  assert.equal(suggestRefusal(room, 'other', 'it:1'), 'duplicate');
  assert.equal(migrateRoomState(null), null);
});

// ---- Spotify mapping --------------------------------------------------------------------------

test('Spotify track → Song: id, joined artists, ~300 px artwork, explicit flag, no preview', () => {
  const song = trackToSong(track({ artists: [{ name: 'Daft Punk' }, { name: 'Pharrell Williams' }, { name: 'Nile Rodgers' }] }));
  assert.deepEqual(song, {
    id: `sp:${ID_A}`,
    title: 'Happy - From "Despicable Me 2"',
    artist: 'Daft Punk, Pharrell Williams, Nile Rodgers',
    album: 'Happy (From "Despicable Me 2")',
    artwork: 'https://i.scdn.co/image/ab67616d00001e02bbbb',
    durationMs: 232720,
    explicit: 'notExplicit',
    previewUrl: '',
  });
  assert.equal(trackToSong(track({ explicit: true })).explicit, 'explicit');
  assert.equal(trackToSong(track({ explicit: undefined })).explicit, 'explicit', 'a missing flag counts as explicit');
  assert.equal(trackToSong(track({ is_playable: false })), null);
  assert.equal(trackToSong(track({ is_local: true })), null);
  assert.equal(trackToSong(track({ id: 'nope' })), null);
  assert.equal(trackToSong(track({ type: 'episode' })), null);
  assert.equal(trackToSong(track({ artists: [] })), null);
  assert.equal(trackToSong(track({ name: '  ' })), null);
  assert.equal(trackToSong(null), null);
  // Only Spotify's image host (the page's CSP allows i.scdn.co).
  assert.equal(pickArtwork([{ url: 'https://evil.example/x.jpg', width: 300 }]), '');
  assert.equal(pickArtwork([{ url: 'https://i.scdn.co/image/abc', width: 64 }, { url: 'https://i.scdn.co/image/def', width: 160 }]), 'https://i.scdn.co/image/def');
  assert.equal(pickArtwork(undefined), '');
});

test('configured only with both the client id and the secret', () => {
  assert.equal(spotifyCatalogConfigured(spotifyEnv()), true);
  assert.equal(spotifyCatalogConfigured(spotifyEnv({ SPOTIFY_CLIENT_SECRET: '' })), false);
  assert.equal(spotifyCatalogConfigured(spotifyEnv({ SPOTIFY_CLIENT_ID: 'x' })), false);
  assert.equal(roomCatalog('spotify', spotifyEnv()), 'sp');
  assert.equal(roomCatalog('youtube', spotifyEnv()), 'it', 'only a room that plays through Spotify');
  assert.equal(roomCatalog('preview', spotifyEnv()), 'it');
  assert.equal(roomCatalog(null, spotifyEnv()), 'it');
  assert.equal(roomCatalog('spotify', spotifyEnv({ SPOTIFY_CLIENT_SECRET: undefined })), 'it');
});

// ---- token --------------------------------------------------------------------------------------

test('app token: Client Credentials with Basic auth, cached in memory and KV until near expiry', async () => {
  const env = spotifyEnv();
  const f = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', () => json(200, searchPage([track()]))]]);
  await searchSpotify('happy', env, { fetchImpl: f });
  await searchSpotify('other song', env, { fetchImpl: f });
  assert.equal(f.count('https://accounts.spotify.com/'), 1, 'one token for both searches');
  const tokenCall = f.calls[0];
  assert.equal(tokenCall.init.method, 'POST');
  assert.equal(tokenCall.init.body, 'grant_type=client_credentials');
  assert.equal(tokenCall.init.headers.authorization, `Basic ${btoa(`${CLIENT_ID}:${SECRET}`)}`);
  assert.equal(tokenCall.init.headers['content-type'], 'application/x-www-form-urlencoded');
  const search = f.calls.find((c) => c.url.includes('/v1/search'));
  assert.equal(search.init.headers.authorization, 'Bearer app-token-1');
  const saved = JSON.parse(env.CLASS_KV.map.get('spotify:token'));
  assert.equal(saved.token, 'app-token-1');
  assert.equal(env.CLASS_KV.ttl.get('spotify:token'), 3600 - 300);

  // Another isolate (memory empty) reads the KV copy.
  resetSpotifyMemory();
  await searchSpotify('third', env, { fetchImpl: f });
  assert.equal(f.count('https://accounts.spotify.com/'), 1);

  // Near expiry: a new token.
  resetSpotifyMemory();
  await searchSpotify('fourth', env, { fetchImpl: f, now: Date.now() + 3600_000 - 60_000 });
  assert.equal(f.count('https://accounts.spotify.com/'), 2);
});

test('app token: a 401 from the API gets one fresh token; a refused secret is "down" and never logged', quiet(async (logged) => {
  const env = spotifyEnv();
  let n = 0;
  const f = fakeFetch([
    ['https://accounts.spotify.com/api/token', () => json(200, { access_token: `tok${++n}`, expires_in: 3600 })],
    ['https://api.spotify.com/v1/tracks/', (url, init) => (init.headers.authorization === 'Bearer tok1'
      ? json(401, { error: { status: 401, message: 'The access token expired' } })
      : json(200, track()))],
  ]);
  assert.equal((await lookupSpotify(ID_A, env, { fetchImpl: f })).id, `sp:${ID_A}`);
  assert.equal(n, 2);

  resetSpotifyMemory();
  const env2 = spotifyEnv();
  const refused = fakeFetch([['https://accounts.spotify.com/api/token', () => json(400, { error: 'invalid_client', error_description: 'Invalid client secret' })]]);
  await assert.rejects(searchSpotify('x', env2, { fetchImpl: refused }), (e) => e.code === 'down');
  assert.ok(logged.length > 0);
  assert.ok(!logged.join('\n').includes(SECRET), 'the secret is never logged');
  assert.ok(!logged.join('\n').includes(btoa(`${CLIENT_ID}:${SECRET}`)));
}));

// ---- search and lookup ------------------------------------------------------------------------

test('search: two pages of 10 (the development-mode limit), market US, de-duplicated, cached a day', async () => {
  const env = spotifyEnv();
  const ids = Array.from({ length: 12 }, (_, i) => `${'A'.repeat(20)}${String(i).padStart(2, '0')}`);
  const f = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', (url) => {
    const p = new URL(url).searchParams;
    assert.equal(p.get('type'), 'track');
    assert.equal(p.get('limit'), '10');
    assert.equal(p.get('market'), 'US');
    assert.equal(p.get('q'), 'happy');
    const offset = Number(p.get('offset'));
    const page = offset === 0 ? ids.slice(0, 10) : [ids[9], ...ids.slice(10)];
    return json(200, searchPage(page.map((id) => track({ id })), offset === 0 ? 'https://api.spotify.com/v1/search?offset=10' : null));
  }]]);
  const songs = await searchSpotify('  Happy ', env, { fetchImpl: f });
  assert.equal(songs.length, 12);
  assert.deepEqual(songs.map((s) => s.id), ids.map((id) => `sp:${id}`));
  assert.equal(f.count('https://api.spotify.com/v1/search'), 2);
  assert.equal(env.CLASS_KV.ttl.get('search:sp:2:happy'), 24 * 60 * 60);
  await searchSpotify('happy', env, { fetchImpl: f });
  assert.equal(f.count('https://api.spotify.com/v1/search'), 2, 'the second search came from KV');
});

test('search: a short first page needs no second; a failed second page keeps the first', quiet(async () => {
  const env = spotifyEnv();
  const f = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', () => json(200, searchPage([track()]))]]);
  assert.equal((await searchSpotify('a', env, { fetchImpl: f })).length, 1);
  assert.equal(f.count('https://api.spotify.com/v1/search'), 1);

  const ten = Array.from({ length: 10 }, (_, i) => track({ id: `${'B'.repeat(20)}${String(i).padStart(2, '0')}` }));
  const g = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', (url) => (new URL(url).searchParams.get('offset') === '0'
    ? json(200, searchPage(ten, 'next'))
    : json(502, { error: { status: 502 } }))]]);
  assert.equal((await searchSpotify('b', env, { fetchImpl: g })).length, 10);
}));

test('lookup: GET /v1/tracks/{id}?market=US, cached a week; 404 is "no such song"', async () => {
  const env = spotifyEnv();
  const f = fakeFetch([TOKEN, ['https://api.spotify.com/v1/tracks/', (url) => (url.includes(ID_A) ? json(200, track()) : json(404, { error: { status: 404 } }))]]);
  const song = await lookupSpotify(ID_A, env, { fetchImpl: f });
  assert.equal(song.id, `sp:${ID_A}`);
  assert.ok(f.calls.some((c) => c.url === `https://api.spotify.com/v1/tracks/${ID_A}?market=US`));
  assert.equal(env.CLASS_KV.ttl.get(`song:sp:${ID_A}`), 7 * 24 * 60 * 60);
  await lookupSpotify(ID_A, env, { fetchImpl: f });
  assert.equal(f.count('https://api.spotify.com/v1/tracks/'), 1);
  assert.equal(await lookupSpotify(ID_B, env, { fetchImpl: f }), null);
  assert.equal(await lookupSpotify('../../me', env, { fetchImpl: f }), null, 'not an id: no call');
  // Relinked for the market: the same song under the id that was asked for.
  const g = fakeFetch([TOKEN, ['https://api.spotify.com/v1/tracks/', () => json(200, track({ id: ID_B }))]]);
  assert.equal((await lookupSpotify(ID_A, spotifyEnv(), { fetchImpl: g })).id, `sp:${ID_A}`);
});

test('429: a short Retry-After is waited once; a long one or QUOTA_EXCEEDED backs off and says busy', quiet(async () => {
  const env = spotifyEnv();
  let tries = 0;
  const f = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', () => (++tries === 1
    ? json(429, {}, { 'retry-after': '0' })
    : json(200, searchPage([track()])))]]);
  assert.equal((await searchSpotify('retry', env, { fetchImpl: f })).length, 1);
  assert.equal(tries, 2);

  const env2 = spotifyEnv();
  const g = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', () => json(429, {}, { 'retry-after': '30' })]]);
  await assert.rejects(searchSpotify('slow', env2, { fetchImpl: g }), (e) => e.code === 'busy');
  assert.equal(g.count('https://api.spotify.com/v1/search'), 1, 'no wait longer than 3 s');
  await assert.rejects(searchSpotify('slow again', env2, { fetchImpl: g }), (e) => e.code === 'busy');
  assert.equal(g.count('https://api.spotify.com/v1/search'), 1, 'backing off: no call at all');
  assert.ok(env2.CLASS_KV.map.has('spotify:backoff'));

  resetSpotifyMemory();
  const env3 = spotifyEnv();
  const h = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', () => json(429, { error: { status: 429, message: 'quota' }, reason: 'QUOTA_EXCEEDED' }, { 'retry-after': '1' })]]);
  await assert.rejects(searchSpotify('quota', env3, { fetchImpl: h }), (e) => e.code === 'busy');
  assert.equal(h.count('https://api.spotify.com/v1/search'), 1, 'quota: no retry');
  assert.ok(env3.CLASS_KV.ttl.get('spotify:backoff') >= 600);
}));

// ---- fallback order -----------------------------------------------------------------------------

const ITUNES_SONG = {
  kind: 'song', trackId: 863835363, trackName: 'Happy', artistName: 'Pharrell Williams', collectionName: 'G I R L',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/a/b.jpg/100x100bb.jpg', trackTimeMillis: 232720,
  trackExplicitness: 'notExplicit', previewUrl: 'https://audio-ssl.itunes.apple.com/p.m4a',
};
const ITUNES = ['https://itunes.apple.com/', () => new Response(`\n\n${JSON.stringify({ resultCount: 1, results: [ITUNES_SONG] })}`, { status: 200 })];

test('fallback: a Spotify room searches Spotify; busy or down Spotify, or no secret, means iTunes', quiet(async () => {
  const ok = fakeFetch([TOKEN, ['https://api.spotify.com/', () => json(200, searchPage([track()]))], ITUNES]);
  const a = await searchCatalog('happy', spotifyEnv(), { catalog: 'sp', fetchImpl: ok });
  assert.deepEqual([a.catalog, a.songs[0].id], ['sp', `sp:${ID_A}`]);
  assert.equal(ok.count('https://itunes.apple.com/'), 0);

  resetSpotifyMemory();
  const down = fakeFetch([TOKEN, ['https://api.spotify.com/', () => json(503, {})], ITUNES]);
  const b = await searchCatalog('happy', spotifyEnv(), { catalog: 'sp', fetchImpl: down });
  assert.deepEqual([b.catalog, b.songs[0].id], ['it', 'it:863835363']);

  resetSpotifyMemory();
  const busy = fakeFetch([TOKEN, ['https://api.spotify.com/', () => json(429, {}, { 'retry-after': '60' })], ITUNES]);
  assert.equal((await searchCatalog('happy', spotifyEnv(), { catalog: 'sp', fetchImpl: busy })).catalog, 'it');

  const none = fakeFetch([ITUNES]);
  assert.equal((await searchCatalog('happy', spotifyEnv({ SPOTIFY_CLIENT_SECRET: '' }), { catalog: 'sp', fetchImpl: none })).catalog, 'it');
  assert.equal((await searchCatalog('happy', { CLASS_KV: fakeKv() }, { fetchImpl: none })).catalog, 'it', 'iTunes is the default');

  // Both down: the iTunes error (a plain "busy" sentence).
  resetSpotifyMemory();
  const both = fakeFetch([TOKEN, ['https://api.spotify.com/', () => json(503, {})], ['https://itunes.apple.com/', () => new Response('', { status: 429 })]]);
  await assert.rejects(searchCatalog('happy', spotifyEnv(), { catalog: 'sp', fetchImpl: both }), (e) => e.code === 'busy' && /busy/.test(e.message));
}));

test('lookup by id goes to the id\'s own catalog; an sp: id never falls back to iTunes', quiet(async () => {
  const f = fakeFetch([TOKEN, ['https://api.spotify.com/v1/tracks/', () => json(200, track())], ITUNES]);
  assert.equal((await lookupCatalog(`sp:${ID_A}`, spotifyEnv(), { fetchImpl: f })).id, `sp:${ID_A}`);
  assert.equal((await lookupCatalog('it:863835363', spotifyEnv(), { fetchImpl: f })).id, 'it:863835363');
  assert.ok(f.calls.some((c) => c.url.startsWith('https://itunes.apple.com/lookup?id=863835363')));
  assert.equal(await lookupCatalog(`sp:${ID_A}`, { CLASS_KV: fakeKv() }, { fetchImpl: f }), null, 'no secret: no Spotify songs');
  assert.equal(await lookupCatalog('nonsense', spotifyEnv(), { fetchImpl: f }), null);
  resetSpotifyMemory();
  const down = fakeFetch([TOKEN, ['https://api.spotify.com/', () => json(500, {})], ITUNES]);
  await assert.rejects(lookupCatalog(`sp:${ID_A}`, spotifyEnv(), { fetchImpl: down }), (e) => e.code === 'down');
  assert.equal(down.count('https://itunes.apple.com/'), 0);
}));

test('old KV entries without ids (search and song caches) still work', async () => {
  const env = { CLASS_KV: fakeKv() };
  const old = { trackId: 5, title: 'Old', artist: 'A', album: '', artwork: '', durationMs: 1, explicit: 'notExplicit', previewUrl: 'https://x' };
  env.CLASS_KV.map.set('search:old', JSON.stringify([old]));
  env.CLASS_KV.map.set('song:5', JSON.stringify(old));
  const f = fakeFetch([]);
  assert.equal((await searchCatalog('old', env, { fetchImpl: f })).songs[0].id, 'it:5');
  assert.equal((await lookupCatalog('it:5', env, { fetchImpl: f })).id, 'it:5');
  assert.equal(f.calls.length, 0);
});

// ---- clean versions -----------------------------------------------------------------------------

test('clean swap on Spotify: a non-explicit track with the same base title, artist and length', async () => {
  const explicit = trackToSong(track({ id: ID_A, name: 'Bad Words', explicit: true, duration_ms: 200_000 }));
  const clean = trackToSong(track({ id: ID_B, name: 'Bad Words - Radio Edit', explicit: false, duration_ms: 198_000 }));
  assert.equal(isCleanVersionOf(clean, explicit), true);
  assert.equal(isCleanVersionOf({ ...clean, durationMs: 260_000 }, explicit), false, 'a remix or live version runs longer');
  assert.equal(isCleanVersionOf({ ...clean, explicit: 'explicit' }, explicit), false);
  assert.equal(isCleanVersionOf({ ...clean, artist: 'Someone Else' }, explicit), false);
  assert.equal(isCleanVersionOf({ ...clean, id: 'it:5', explicit: 'cleaned' }, explicit), false, 'never across catalogs');

  // In the same results: swapped with no extra call.
  const env = spotifyEnv();
  const f = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', (url) => {
    const q = new URL(url).searchParams.get('q');
    if (q === 'bad words') return json(200, searchPage([track({ id: ID_A, name: 'Bad Words', explicit: true, duration_ms: 200_000 })]));
    // The one extra search for the clean version: field filters on base title and main artist.
    assert.equal(q, 'track:"bad words" artist:"pharrell williams"');
    assert.equal(new URL(url).searchParams.get('limit'), '10');
    return json(200, searchPage([track({ id: ID_B, name: 'Bad Words', explicit: false, duration_ms: 201_000 })]));
  }]]);
  const { results, catalog } = await searchAllowed('bad words', env, { catalog: 'sp', fetchImpl: f });
  assert.equal(catalog, 'spotify');
  assert.deepEqual(results.map((s) => [s.id, s.explicit]), [[`sp:${ID_B}`, 'notExplicit']]);
  assert.equal(f.count('https://api.spotify.com/v1/search'), 2);
  assert.ok(env.CLASS_KV.map.has(`clean:sp:${ID_A}`));
  // Remembered: the next search makes no clean search.
  assert.equal((await findCleanVersion(explicit, env, { fetchImpl: f })).id, `sp:${ID_B}`);
  assert.equal(f.count('https://api.spotify.com/v1/search'), 2);
});

test('clean swap on Spotify: no clean version means the explicit song is left out', async () => {
  const env = spotifyEnv();
  const f = fakeFetch([TOKEN, ['https://api.spotify.com/v1/search', () => json(200, searchPage([track({ name: 'Only Explicit', explicit: true })]))]]);
  const { results } = await searchAllowed('only explicit', env, { catalog: 'sp', fetchImpl: f });
  assert.deepEqual(results, []);
});

// ---- policy: no Spotify content to the AI or to YouTube; bans across catalogs -------------------

const spSong = (over = {}) => ({ ...trackToSong(track()), title: 'Happy', ...over });

test('a Spotify song never goes to the AI: approvals and iTunes verdicts for the same song count, else review', async () => {
  const kv = fakeKv();
  let calls = 0;
  const env = { CLASS_KV: kv, AI: { run: async () => (calls++, { response: '{"verdict":"OK","reason":"fine"}' }) } };
  const r = await filterSong(spSong(), { settings: DEFAULT_SETTINGS, env });
  assert.deepEqual([r.ok, r.reason, r.ai.source, r.ai.failed, r.ai.cached], [false, 'review', 'policy', false, true]);
  assert.equal(calls, 0);
  assert.equal((await filterSong(spSong(), { settings: { ...DEFAULT_SETTINGS, blockUnknownSongs: false }, env })).ok, true);

  // The iTunes version was checked by the AI (iTunes details): the Spotify version uses that verdict.
  const itunes = { id: 'it:863835363', title: 'Happy', artist: 'Pharrell Williams', album: 'G I R L', artwork: '', durationMs: 1, explicit: 'notExplicit', previewUrl: 'https://x' };
  assert.equal((await aiThemeCheck(itunes, env)).verdict, 'ok');
  assert.equal(calls, 1);
  const again = await aiThemeCheck(spSong(), env);
  assert.deepEqual([again.verdict, again.cached], ['ok', true]);
  assert.equal(calls, 1, 'still one AI call: the Spotify song was not sent');
  assert.ok(kv.map.has(verdictKey('song:happy|pharrell williams')));
});

test('a teacher\'s Allow covers the song from either catalog; inappropriate iTunes verdicts block the Spotify copy', async () => {
  const kv = fakeKv();
  const env = { CLASS_KV: kv, AI: { run: async () => ({ response: '{"verdict":"INAPPROPRIATE","reason":"drugs"}' }) } };
  await approveSong(spSong(), env);
  assert.ok(kv.map.has(`approved:sp:${ID_A}`));
  assert.ok(kv.map.has('approved:song:happy|pharrell williams'));
  const itunes = { id: 'it:9', title: 'Happy (Radio Edit)', artist: 'Pharrell Williams', album: '', artwork: '', durationMs: 1, explicit: 'notExplicit', previewUrl: 'https://x' };
  assert.equal((await aiThemeCheck(itunes, env)).source, 'teacher');

  const kv2 = fakeKv();
  const env2 = { CLASS_KV: kv2, AI: env.AI };
  assert.equal((await aiThemeCheck({ ...itunes, title: 'Other' }, env2)).verdict, 'inappropriate');
  assert.equal((await filterSong(spSong({ title: 'Other' }), { settings: DEFAULT_SETTINGS, env: env2 })).reason, 'theme');
});

test('bans: new entries by song id, old ones by trackId, and every version from either catalog by banKey', async () => {
  const kv = fakeKv();
  kv.map.set('banned', JSON.stringify([
    { trackId: 42, title: 'Old Song', artist: 'Band', at: 1 },
    { id: `sp:${ID_B}`, title: 'Happy', artist: 'Pharrell Williams', at: 2 },
  ]));
  const banned = await readBanned({ CLASS_KV: kv });
  assert.ok(banned.has('it:42'));
  assert.ok(banned.has(`sp:${ID_B}`));
  const { quickCheck } = await import('../shared/filter.js');
  assert.equal(quickCheck({ ...spSong(), id: `sp:${ID_B}` }, { banned }), 'banned');
  assert.equal(quickCheck({ id: 'it:77', title: 'Happy (From "Despicable Me 2")', artist: 'Pharrell Williams', album: '', explicit: 'notExplicit' }, { banned }), 'banned', 'the iTunes version of a song banned on Spotify');
  assert.equal(quickCheck({ id: 'it:42', title: 'x', artist: 'y', album: '', explicit: 'notExplicit' }, { banned }), 'banned');
});

test('YouTube is never searched for a Spotify song', async () => {
  let calls = 0;
  await assert.rejects(
    resolveVideo(spSong(), { CLASS_KV: fakeKv(), YOUTUBE_API_KEY: 'k' }, { fetchImpl: async () => { calls++; return json(200, {}); } }),
    (e) => e.code === 'none',
  );
  assert.equal(calls, 0);
});
