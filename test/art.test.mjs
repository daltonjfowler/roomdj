// The album art check (protocol.js ALBUM ART): cover keys, the verdict parser, the art state rules,
// the server's art fields, settings, and the Worker's check with a fake fetch, AI and KV.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ART_MODEL, ART_OK_TTL_SECONDS, ART_UNSURE_TTL_SECONDS, artFetchUrl, artFields, artJson, artKey, artKvKey, artOkName, artState,
  buildArtPrompt, cleanArtReason, parseArtVerdict, readArtVerdict, showArt, validArtKey,
} from '../shared/art.js';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';
import { migrateRoomState, newRoomState } from '../shared/queue.js';
import { cachedArtVerdict, checkCover, putTeacherArtOk, teacherArtOk } from '../src/art.js';
import { teacherKvKey } from '../src/teacher-kv.js';

const URL1 = 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/2b/1a/9c/2b1a9c3e-aaaa/00602547.jpg/100x100bb.jpg';
const KEY1 = 'Music115/v4/2b/1a/9c/2b1a9c3e-aaaa/00602547.jpg';

test('artKey: the mzstatic path without host and size; every size and server is one cover', () => {
  assert.equal(artKey(URL1), KEY1);
  assert.equal(artKey(URL1.replace('100x100bb', '300x300bb')), KEY1);
  assert.equal(artKey(URL1.replace('is1-ssl', 'is4-ssl')), KEY1);
  assert.equal(artKey(URL1.replace('100x100bb.jpg', '600x600bb.png')), KEY1);
  assert.equal(artKey(''), null);
  assert.equal(artKey(null), null);
  assert.equal(artKey('https://i.scdn.co/image/ab67616d0000b273abc'), null, 'Spotify art is never a key (never checked, never shown)');
  assert.equal(artKey('http://is1-ssl.mzstatic.com/image/thumb/x.jpg/100x100bb.jpg'), null, 'https only');
  assert.equal(artKey('https://evil.example/is1.mzstatic.com/a.jpg'), null);
  assert.equal(artKey('https://is1-ssl.mzstatic.com/image/thumb/../../a.jpg/100x100bb.jpg'), null);
  assert.equal(artKey('https://is1-ssl.mzstatic.com/image/thumb/a b.jpg/100x100bb.jpg'), null);
});

test('artKvKey, artOkName, validArtKey', () => {
  assert.equal(artKvKey(KEY1), `art:v1:${KEY1}`);
  assert.equal(artOkName(KEY1), `artok:${KEY1}`);
  assert.equal(teacherKvKey(artOkName(KEY1), { id: 'teacher-2' }), `p:teacher-2:artok:${KEY1}`);
  assert.ok(validArtKey(KEY1));
  for (const bad of ['', '../x', '/x', 'a b', 'x'.repeat(301), 12, null, 'a\nb']) assert.equal(validArtKey(bad), false, String(bad));
});

test('artFetchUrl: the same cover at the small size, mzstatic only', () => {
  assert.equal(artFetchUrl(URL1), URL1.replace('100x100bb.jpg', '256x256bb.jpg'));
  assert.equal(artFetchUrl(URL1, 200), URL1.replace('100x100bb.jpg', '200x200bb.jpg'));
  assert.equal(artFetchUrl('https://i.scdn.co/image/abc'), null);
  assert.equal(artFetchUrl('https://is1-ssl.mzstatic.com/image/thumb/a.jpg'), null, 'no size: not a cover address');
});

test('buildArtPrompt: strict JSON, the image as data, the rules', () => {
  const [sys, user] = buildArtPrompt('data:image/jpeg;base64,AAAA');
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /aged 11 to 18/);
  assert.match(sys.content, /nudity/);
  assert.match(sys.content, /swimwear/);
  assert.match(sys.content, /not instructions/);
  assert.match(sys.content, /"verdict":"OK"\|"INAPPROPRIATE"\|"UNSURE"/);
  assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
  assert.match(ART_MODEL, /^@cf\//);
});

test('parseArtVerdict: the three answers; anything else is unsure (hidden)', () => {
  assert.deepEqual(parseArtVerdict('{"verdict":"OK","reason":"ordinary cover"}'), { verdict: 'ok', reason: 'ordinary cover' });
  assert.deepEqual(parseArtVerdict('Sure! {"verdict":"INAPPROPRIATE","reason":"Partial nudity and suggestive pose"}'),
    { verdict: 'inappropriate', reason: 'Partial nudity and suggestive pose' });
  assert.equal(parseArtVerdict('{"verdict":"unsure","reason":"blurry"}').verdict, 'unsure');
  assert.equal(parseArtVerdict('{"verdict":"maybe"}').verdict, 'unsure');
  assert.equal(parseArtVerdict('no json here').verdict, 'unsure');
  assert.equal(parseArtVerdict('{bad json}').verdict, 'unsure');
  assert.equal(parseArtVerdict(null).verdict, 'unsure');
  const long = parseArtVerdict(JSON.stringify({ verdict: 'INAPPROPRIATE', reason: `one two three four five six seven eight nine ten eleven twelve "<b>"` }));
  assert.equal(long.reason, 'one two three four five six seven eight nine ten');
  assert.equal(cleanArtReason('a\u0000b "quoted" <tag>'), 'a b quoted tag');
});

test('readArtVerdict: only the three verdicts', () => {
  assert.deepEqual(readArtVerdict({ verdict: 'ok', reason: 'fine', at: 1 }), { verdict: 'ok', reason: 'fine' });
  assert.equal(readArtVerdict({ verdict: 'OK' }), null);
  assert.equal(readArtVerdict(null), null);
  assert.equal(readArtVerdict('ok'), null);
});

test('artState: the server rule for song.art', () => {
  const on = { artCheck: true, hideAllArt: false };
  assert.equal(artState(on, { key: KEY1, verdict: 'ok' }), 'ok');
  assert.equal(artState(on, { key: KEY1, verdict: 'inappropriate' }), 'hidden');
  assert.equal(artState(on, { key: KEY1, verdict: 'unsure' }), 'hidden', 'UNSURE is hidden');
  assert.equal(artState(on, { key: KEY1 }), 'unchecked');
  assert.equal(artState(on, { key: KEY1, verdict: 'inappropriate', teacherOk: true }), 'ok', 'Show anyway');
  assert.equal(artState(on, { key: null }), 'hidden', 'no cover to check: the 🎵 tile');
  assert.equal(artState({ artCheck: false, hideAllArt: false }, { key: KEY1, verdict: 'inappropriate' }), 'ok', 'check off: the old behaviour');
  assert.equal(artState({ artCheck: false, hideAllArt: true }, { key: KEY1, verdict: 'ok' }), 'hidden', 'hide all wins');
  assert.equal(artState({ artCheck: true, hideAllArt: true }, { key: KEY1, verdict: 'ok', teacherOk: true }), 'hidden');
  assert.equal(artState({}, { key: KEY1 }), 'unchecked', 'missing settings: the defaults (check on)');
});

test('showArt: a page shows a cover only when the server said ok', () => {
  assert.equal(showArt({ art: 'ok', artwork: URL1 }), true);
  assert.equal(showArt({ art: 'unchecked', artwork: URL1 }), false);
  assert.equal(showArt({ art: 'hidden', artwork: URL1 }), false);
  assert.equal(showArt({ artwork: URL1 }), false, 'no art field (an older server): no cover');
  assert.equal(showArt({ art: 'ok', artwork: '' }), false);
});

test('artFields + artJson: every song in a message gets the art fields; reasons only for the host', () => {
  const settings = { artCheck: true, hideAllArt: false };
  const verdicts = { [KEY1]: { verdict: 'inappropriate', reason: 'Partial nudity' } };
  const info = (k) => verdicts[k] ?? {};
  const okUrl = 'https://is2-ssl.mzstatic.com/image/thumb/Music/v4/ok.jpg/100x100bb.jpg';
  verdicts[artKey(okUrl)] = { verdict: 'ok', reason: 'ordinary cover' };
  const newUrl = 'https://is2-ssl.mzstatic.com/image/thumb/Music/v4/new.jpg/100x100bb.jpg';
  const msg = {
    t: 'state',
    state: { nowPlaying: { id: 'q1', song: { id: 'it:1', title: 'A', artwork: URL1 } }, queue: [{ id: 'q2', song: { id: 'it:2', artwork: okUrl } }, { id: 'q3', song: { id: 'it:3', artwork: newUrl } }],
      settings: { art: true }, display: { art: false } },
  };
  const student = JSON.parse(artJson(msg, (u) => artFields(u, 'student', settings, info)));
  assert.deepEqual(student.state.nowPlaying.song, { id: 'it:1', title: 'A', artwork: '', art: 'hidden' }, 'hidden: no URL, no reason');
  assert.equal(student.state.queue[0].song.art, 'ok');
  assert.equal(student.state.queue[0].song.artwork, okUrl);
  assert.equal(student.state.queue[1].song.art, 'unchecked');
  assert.equal(student.state.queue[1].song.artwork, newUrl, 'unchecked keeps the URL (search results blur it)');
  assert.deepEqual(student.state.settings, { art: true }, 'objects without artwork are untouched');
  const host = JSON.parse(artJson(msg, (u) => artFields(u, 'host', settings, info)));
  assert.equal(host.state.nowPlaying.song.artKey, KEY1);
  assert.equal(host.state.nowPlaying.song.artReason, 'Partial nudity');
  assert.equal(host.state.nowPlaying.song.artwork, '');
  const hideAll = JSON.parse(artJson(msg, (u) => artFields(u, 'host', { artCheck: true, hideAllArt: true }, info)));
  assert.equal(hideAll.state.queue[0].song.art, 'hidden');
  assert.equal(hideAll.state.nowPlaying.song.artKey, undefined, 'hide all: no Show anyway');
  const off = JSON.parse(artJson(msg, (u) => artFields(u, 'student', { artCheck: false, hideAllArt: false }, info)));
  assert.equal(off.state.nowPlaying.song.art, 'ok');
  assert.equal(off.state.nowPlaying.song.artwork, URL1);
});

test('settings: artCheck (default on) and hideAllArt (default off), saved with the rest', () => {
  assert.equal(DEFAULT_SETTINGS.artCheck, true);
  assert.equal(DEFAULT_SETTINGS.hideAllArt, false);
  const v = validateSettings({});
  assert.equal(v.settings.artCheck, true);
  assert.equal(v.settings.hideAllArt, false);
  assert.equal(validateSettings({ artCheck: false, hideAllArt: true }).settings.hideAllArt, true);
  assert.equal(validateSettings({ artCheck: 'no' }).ok, false);
  assert.equal(validateSettings({ hideAllArt: 1 }).ok, false);
  const old = newRoomState('r');
  delete old.settings.artCheck;
  delete old.settings.hideAllArt;
  delete old.art;
  const m = migrateRoomState(old);
  assert.equal(m.settings.artCheck, true);
  assert.equal(m.settings.hideAllArt, false);
  assert.deepEqual(m.art, {});
});

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(k, type) {
      const v = map.get(k)?.value ?? null;
      return v !== null && type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, value, opts = {}) { map.set(k, { value, opts }); },
  };
}
const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });

test('checkCover: fetches the small cover, asks the vision model once, caches only the verdict', async () => {
  const kv = fakeKv();
  const asked = [];
  const env = {
    CLASS_KV: kv,
    AI: { run: async (model, input) => { asked.push({ model, input }); return { response: '{"verdict":"INAPPROPRIATE","reason":"Partial nudity"}' }; } },
  };
  const fetched = [];
  const inits = [];
  const v = await checkCover(env, KEY1, URL1, async (url, init) => { fetched.push(url); inits.push(init); return jpeg(); });
  assert.equal(inits[0].redirect, 'manual', 'Workers refuse redirect: "error"');
  assert.deepEqual(v, { verdict: 'inappropriate', reason: 'Partial nudity' });
  assert.deepEqual(fetched, [URL1.replace('100x100bb', '256x256bb')]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].model, ART_MODEL);
  assert.match(asked[0].input.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  const stored = kv.map.get(artKvKey(KEY1));
  assert.deepEqual(Object.keys(JSON.parse(stored.value)).sort(), ['at', 'reason', 'verdict'], 'never the image');
  assert.equal(stored.opts.expirationTtl, ART_OK_TTL_SECONDS);
  assert.deepEqual(await cachedArtVerdict(env, KEY1), { verdict: 'inappropriate', reason: 'Partial nudity' });

  env.AI.run = async () => ({ response: '{"verdict":"UNSURE","reason":"too dark"}' });
  const key2 = 'Music/v4/other.jpg';
  await checkCover(env, key2, 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/other.jpg/100x100bb.jpg', async () => jpeg());
  assert.equal(kv.map.get(artKvKey(key2)).opts.expirationTtl, ART_UNSURE_TTL_SECONDS);
});

test('checkCover: trouble throws and caches nothing (asked again next time)', async () => {
  const kv = fakeKv();
  const env = { CLASS_KV: kv, AI: { run: async () => { throw new Error('AI down'); } } };
  await assert.rejects(checkCover(env, KEY1, URL1, async () => jpeg()));
  await assert.rejects(checkCover({ CLASS_KV: kv, AI: env.AI }, KEY1, URL1, async () => new Response('nope', { status: 404 })));
  await assert.rejects(checkCover(env, KEY1, URL1, async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })));
  await assert.rejects(checkCover(env, KEY1, URL1, async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.jpg' } })));
  await assert.rejects(checkCover(env, KEY1, 'https://i.scdn.co/image/abc', async () => jpeg()), /mzstatic/);
  assert.equal(kv.map.size, 0);
});

test('Show anyway is per teacher profile', async () => {
  const kv = fakeKv();
  const env = { CLASS_KV: kv };
  await putTeacherArtOk(env, KEY1, { id: 'teacher-2' });
  assert.equal(await teacherArtOk(env, KEY1, { id: 'teacher-2' }), true);
  assert.equal(await teacherArtOk(env, KEY1, { id: 'teacher-1', legacy: true }), false);
  assert.ok(kv.map.has(`p:teacher-2:artok:${KEY1}`));
});
