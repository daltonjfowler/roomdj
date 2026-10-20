// "The teacher's computer searches": the room's iTunes calls go to the host page (src/host-relay.js)
// and come back as raw results the server maps and checks itself (shared/itunes.js).

import assert from 'node:assert/strict';
import test from 'node:test';
import { HostRelay, NO_HOST, RELAY_BUSY } from '../src/host-relay.js';
import { lookupSong, searchSongs } from '../src/itunes.js';
import { lookupCatalog } from '../src/catalog.js';
import { ITUNES_URL, itunesLookupUrl, itunesSearchUrl, toSong, trimResult } from '../shared/itunes.js';

const RAW = {
  wrapperType: 'track', kind: 'song', trackId: 863835363, artistId: 1, trackName: 'Happy (From "Despicable Me 2")',
  artistName: 'Pharrell Williams', collectionName: 'G I R L', trackViewUrl: 'https://music.apple.com/x',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/a/b/source/100x100bb.jpg', trackTimeMillis: 232720,
  trackExplicitness: 'notExplicit', previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/p.m4a',
};

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(k, type) { const v = map.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { map.set(k, v); },
  };
}

/** A relay with one fake host socket that records what it was sent. */
function relayWith({ host = true, ...o } = {}) {
  const sent = [];
  let n = 0;
  const relay = new HostRelay({
    host: () => (host ? 'HOST' : null),
    send: (h, msg) => sent.push([h, msg]),
    newId: () => `job${++n}`,
    fetchImpl: async () => { throw new Error('no own fetch in this test'); },
    ...o,
  });
  return { relay, sent };
}
const tick = () => new Promise((r) => setImmediate(r));

function quiet(fn) {
  return async () => {
    const orig = console.error;
    console.error = () => {};
    try { await fn(); } finally { console.error = orig; }
  };
}

test('iTunes addresses: only RoomDJ\'s search and lookup URLs count', () => {
  assert.ok(ITUNES_URL.test(itunesSearchUrl("don't stop believin' (live) *")));
  assert.ok(ITUNES_URL.test(itunesLookupUrl(863835363)));
  for (const bad of ['https://itunes.apple.com/search', 'http://itunes.apple.com/search?term=a', 'https://evil.com/search?term=a',
    'https://itunes.apple.com/other?x=1', 'https://itunes.apple.com.evil.com/search?term=a', 'https://itunes.apple.com/search?term=a#x']) {
    assert.equal(ITUNES_URL.test(bad), false, bad);
  }
});

test('the room maps host data itself: shape checks, caps, ids, explicit flag', () => {
  assert.equal(toSong(RAW).id, 'it:863835363');
  assert.equal(toSong(RAW).artwork, 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/a/b/source/300x300bb.jpg');
  assert.equal(toSong({ ...RAW, trackId: '863835363' }), null, 'a string id is refused');
  assert.equal(toSong({ ...RAW, trackId: -1 }), null);
  assert.equal(toSong({ ...RAW, previewUrl: 'http://audio-ssl.itunes.apple.com/p.m4a' }), null);
  assert.equal(toSong({ ...RAW, previewUrl: 'https://evil.example/p.m4a' }), null);
  assert.equal(toSong({ ...RAW, kind: 'music-video' }), null);
  assert.equal(toSong({ ...RAW, trackName: '' }), null);
  assert.equal(toSong({ ...RAW, artworkUrl100: 'https://evil.example/a.jpg' }).artwork, '');
  assert.equal([...toSong({ ...RAW, trackName: 'x'.repeat(5000) }).title].length, 300);
  assert.equal(toSong({ ...RAW, trackExplicitness: 'explicit' }).explicit, 'explicit');
  assert.equal(toSong({ ...RAW, trackExplicitness: 'whatever' }).explicit, 'notExplicit');
  assert.equal(toSong({ ...RAW, trackTimeMillis: 'long' }).durationMs, 0);
  assert.deepEqual(Object.keys(trimResult({ ...RAW, evil: '<script>', nested: { a: 1 } })).sort(),
    ['artistName', 'artworkUrl100', 'collectionName', 'kind', 'previewUrl', 'trackExplicitness', 'trackId', 'trackName', 'trackTimeMillis']);
});

test('relay: the host gets the URL; its raw results are kept to toSong\'s fields and mapped by the server', async () => {
  const { relay, sent } = relayWith();
  const env = { CLASS_KV: fakeKv() };
  const search = searchSongs('Happy', env, { fetchImpl: relay.fetch });
  await tick();
  assert.equal(sent.length, 1);
  const [host, msg] = sent[0];
  assert.equal(host, 'HOST');
  assert.deepEqual(msg, { t: 'lookup', id: 'job1', url: itunesSearchUrl('happy') });
  assert.equal(relay.answer({ t: 'lookupResult', id: 'job1', status: 200, results: [{ ...RAW, extra: 'x'.repeat(1000) }, { kind: 'song', trackId: 'bad' }, 'junk'] }), true);
  const songs = await search;
  assert.deepEqual(songs.map((s) => s.id), ['it:863835363']);
  assert.ok(env.CLASS_KV.map.has('search:happy'), 'cached in KV (a day)');
  assert.ok(!env.CLASS_KV.map.get('search:happy').includes('xxxx'), 'only the fields toSong reads');
});

test('relay: identical calls in flight are asked once; different ones each go', async () => {
  const { relay, sent } = relayWith();
  const url = itunesLookupUrl(863835363);
  const a = relay.fetch(url);
  const b = relay.fetch(url);
  const c = relay.fetch(itunesLookupUrl(1));
  await tick();
  assert.equal(sent.length, 2);
  relay.answer({ id: 'job1', status: 200, results: [RAW] });
  relay.answer({ id: 'job2', status: 200, results: [] });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal((await ra.json()).results[0].trackId, 863835363);
  assert.equal((await rb.json()).results[0].trackId, 863835363);
  assert.deepEqual((await (await c).json()).results, []);
  // Done: the next identical call asks again (KV is the cache, not the relay).
  relay.fetch(url).catch(() => {});
  await tick();
  assert.equal(sent.length, 3);
});

test('relay: no answer in time → "your teacher\'s computer is not answering"; a late answer is ignored', quiet(async () => {
  const { relay } = relayWith({ timeoutMs: 30 });
  await assert.rejects(searchSongs('slow', { CLASS_KV: fakeKv() }, { fetchImpl: relay.fetch }), (e) => e.code === 'nohost' && e.message === NO_HOST);
  assert.equal(relay.answer({ id: 'job1', status: 200, results: [RAW] }), false);
  assert.equal(relay.answer({ id: 'nobody', status: 200, results: [] }), false);
}));

test('relay: no host page open → the server\'s own fetch once; refused → not answering', quiet(async () => {
  let own = 0;
  const ok = relayWith({ host: false, fetchImpl: async () => (own++, new Response(`\n\n${JSON.stringify({ results: [RAW] })}`, { status: 200 })) });
  assert.equal((await lookupSong(863835363, { CLASS_KV: fakeKv() }, { fetchImpl: ok.relay.fetch })).id, 'it:863835363');
  assert.equal(own, 1);
  assert.equal(ok.sent.length, 0);
  const refused = relayWith({ host: false, fetchImpl: async () => new Response('', { status: 429 }) });
  await assert.rejects(lookupCatalog('it:5', { CLASS_KV: fakeKv() }, { fetchImpl: refused.relay.fetch }), (e) => e.code === 'nohost');
  const broken = relayWith({ host: false, fetchImpl: async () => { throw new Error('network'); } });
  await assert.rejects(searchSongs('x', { CLASS_KV: fakeKv() }, { fetchImpl: broken.relay.fetch }), (e) => e.message === NO_HOST);
}));

test('relay: at most 20 calls a minute and 8 at once go to the host; then "busy"', quiet(async () => {
  let t = 0;
  const { relay, sent } = relayWith({ perMinute: 3, inFlightMax: 2, now: () => t, timeoutMs: 1000 });
  const p1 = relay.fetch(itunesLookupUrl(1));
  const p2 = relay.fetch(itunesLookupUrl(2));
  await tick();
  await assert.rejects(relay.fetch(itunesLookupUrl(3)), (e) => e.code === 'busy' && e.message === RELAY_BUSY);
  relay.answer({ id: 'job1', status: 200, results: [] });
  relay.answer({ id: 'job2', status: 200, results: [] });
  await Promise.all([p1, p2]);
  const p4 = relay.fetch(itunesLookupUrl(4));
  await tick();
  relay.answer({ id: 'job3', status: 200, results: [] });
  await p4;
  await assert.rejects(relay.fetch(itunesLookupUrl(5)), (e) => e.code === 'busy', 'the fourth in a minute');
  t += 61_000;
  const p6 = relay.fetch(itunesLookupUrl(6));
  await tick();
  assert.equal(sent.length, 4);
  relay.answer({ id: 'job4', status: 200, results: [] });
  await p6;
  const defaults = new HostRelay({ host: () => null, send: () => {} });
  assert.deepEqual([defaults.perMinute, defaults.inFlightMax, defaults.timeoutMs], [20, 8, 6000]);
}));

test('relay: the host\'s own trouble becomes plain catalog errors; other addresses are a normal fetch', quiet(async () => {
  const { relay } = relayWith();
  const env = { CLASS_KV: fakeKv() };
  const a = searchSongs('busy', env, { fetchImpl: relay.fetch });
  await tick();
  relay.answer({ id: 'job1', status: 429 });
  await assert.rejects(a, (e) => e.code === 'busy');
  const b = searchSongs('down', env, { fetchImpl: relay.fetch });
  await tick();
  relay.answer({ id: 'job2', status: 200, results: 'not a list' });
  await assert.rejects(b, (e) => e.code === 'down');
  const c = searchSongs('cors', env, { fetchImpl: relay.fetch });
  await tick();
  relay.answer({ id: 'job3', status: 0 });
  await assert.rejects(c, (e) => e.code === 'nohost', 'the teacher computer could not reach iTunes');
  assert.equal(env.CLASS_KV.map.size, 0, 'failures are not cached');

  let passed = null;
  const other = relayWith({ fetchImpl: async (url) => { passed = url; return new Response('{}'); } });
  await other.relay.fetch('https://api.spotify.com/v1/search?q=x');
  assert.equal(passed, 'https://api.spotify.com/v1/search?q=x');
  assert.equal(other.sent.length, 0);
}));
