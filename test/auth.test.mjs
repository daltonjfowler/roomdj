// Spotify sign-in (protocol.js SPOTIFY SIGN-IN): src/auth.js with a fake Spotify and a fake KV.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { handleAuth, teacherSession } from '../src/auth.js';
import { handleProfiles, requestProfile, signedIn } from '../src/profiles.js';
import { appOf, cleanClientId, startName } from '../shared/accounts.js';
import { OWN_PROFILE_PREFIX, SESSION_PATTERN } from '../shared/protocol.js';

const SHARED = 'cb5810b6e2e64ca38407949a4615f160';
const OWN = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'https://roomdj.com';

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

// The fake Spotify: every code is good; `who` decides which Spotify user it is.
let who = { id: 'dalton', display_name: 'Mr Fowler' };
let tokenCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://accounts.spotify.com/api/token') {
    tokenCalls++;
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.ok(body.get('code_verifier'));
    return Response.json({ access_token: `ACCESS-${who.id}`, refresh_token: `REFRESH-${who.id}`, expires_in: 3600 });
  }
  if (u === 'https://api.spotify.com/v1/me') {
    if (who.forbidden) return new Response('{}', { status: 403 });
    return Response.json(who);
  }
  throw new Error(`unexpected fetch ${u}`);
};

const env = () => ({ CLASS_KV: fakeKv(), SPOTIFY_CLIENT_ID: SHARED });
const verifier = 'v'.repeat(64);

async function call(e, path, { body, session, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) };
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const r = await handleAuth(req, e, new URL(req.url));
  return { status: r.status, data: await r.json() };
}
const signIn = (e, clientId, extra = {}) => call(e, '/api/auth/spotify', { body: { code: 'CODE', verifier, clientId, redirectUri: `${ORIGIN}/host/`, ...extra } });

test('accounts: client ids, which app, start names', () => {
  assert.equal(cleanClientId(` ${SHARED.toUpperCase()} `), SHARED);
  assert.equal(cleanClientId('not-an-id'), null);
  assert.equal(appOf(SHARED, SHARED), 'shared');
  assert.equal(appOf(OWN, SHARED), 'own');
  assert.equal(appOf(OWN, ''), 'own', 'no shared app on the server: everyone is own');
  assert.equal(startName('Ms Rivera'), 'Ms Rivera');
  assert.equal(startName(null), 'Teacher');
  assert.equal(startName('a'.repeat(60)), 'Teacher', 'too long for students to see');
});

test('own app: a private teacher, the same one next time; tokens back to the page, never stored', async () => {
  const e = env();
  who = { id: 'stranger', display_name: 'Ms Rivera' };
  const a = await signIn(e, OWN);
  assert.equal(a.status, 200);
  assert.ok(SESSION_PATTERN.test(a.data.session));
  assert.equal(a.data.account.app, 'own');
  assert.equal(a.data.account.clientId, OWN);
  assert.ok(a.data.account.profile.id.startsWith(OWN_PROFILE_PREFIX));
  assert.equal(a.data.account.profile.name, 'Ms Rivera');
  assert.equal(a.data.tokens.access, 'ACCESS-stranger');
  const b = await signIn(e, OWN);
  assert.equal(b.data.account.profile.id, a.data.account.profile.id, 'same Spotify user, same teacher');
  for (const [k, v] of e.CLASS_KV.map) {
    assert.ok(!v.includes('ACCESS-') && !v.includes('REFRESH-'), `no Spotify token in KV ${k}`);
    assert.ok(!k.includes('stranger') && !v.includes('stranger'), 'the Spotify user id is kept only as a hash');
    assert.ok(!k.includes(a.data.session), 'the session is kept only as a hash');
  }
  assert.equal(e.CLASS_KV.map.has('profiles'), false, 'an own-app teacher is never put on the list');
});

test('own app: sees and renames only themselves; the list stays hidden', async () => {
  const e = env();
  who = { id: 'stranger2', display_name: 'Mx Lee' };
  const { data } = await signIn(e, OWN);
  const me = data.account.profile;
  const req = (method, path, body) => new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${data.session}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const run = async (r) => {
    const s = await teacherSession(r, e);
    signedIn.set(r, s);
    const res = await handleProfiles(r, e, new URL(r.url));
    return { status: res.status, data: await res.json() };
  };
  const list = await run(req('GET', '/api/teacher/profiles'));
  assert.deepEqual(list.data.profiles.map((p) => p.id), [me.id]);
  assert.equal((await run(req('PATCH', '/api/teacher/profiles/teacher-1', { archived: true }))).status, 403);
  const renamed = await run(req('PATCH', `/api/teacher/profiles/${me.id}`, { name: 'Mx Lee Room 12' }));
  assert.equal(renamed.data.profile.name, 'Mx Lee Room 12');
  const r = req('GET', '/api/teacher/settings');
  signedIn.set(r, await teacherSession(r, e));
  assert.equal((await requestProfile(r, e, 'teacher-1')).name, 'Mx Lee Room 12', 'a body profile is ignored: the session decides');
});

const link = async (e, email, id) => e.CLASS_KV.put(`link:v1:${createHash('sha256').update(`email:${email}`).digest('hex')}`, id);

test('shared app: the Spotify email decides the teacher; nobody can sign in as someone else', async () => {
  const e = env();
  await call(e, '/api/auth/me', { method: 'GET' }); // nothing
  who = { id: 'x0', display_name: 'Seed', email: 'seed@example.com' };
  await signIn(e, SHARED); // writes the seed list (Teacher 1, Teacher 2) + a new "Seed"
  await link(e, 'dalton@example.com', 'teacher-1');
  await link(e, 'peter@example.com', 'teacher-2');

  who = { id: 'dalton', display_name: 'Peter', email: 'Dalton@Example.com ' };
  const d = await signIn(e, SHARED);
  assert.equal(d.status, 200);
  assert.equal(d.data.account.profile.id, 'teacher-1', 'linked by email (case and spaces do not matter), not by display name');
  assert.equal(d.data.account.app, 'shared');
  assert.equal((await signIn(e, SHARED)).data.account.profile.id, 'teacher-1', 'next time: the same');

  who = { id: 'impostor', display_name: 'Teacher 2', email: 'someone@example.com' };
  const i = await signIn(e, SHARED);
  assert.notEqual(i.data.account.profile.id, 'teacher-2', 'a name match is not enough');
  assert.equal(i.data.account.profile.name, 'Teacher 2 2', 'a new teacher with the Spotify name, numbered when taken');

  who = { id: 'peter', display_name: 'Peter', email: 'peter@example.com' };
  assert.equal((await signIn(e, SHARED)).data.account.profile.id, 'teacher-2');
  who = { id: 'peter-second-account', display_name: 'Peter', email: 'peter@example.com' };
  assert.equal((await signIn(e, SHARED)).status, 409, 'a linked teacher is taken once');
  for (const [k, v] of e.CLASS_KV.map) assert.ok(!k.includes('example.com') && !v.includes('example.com'), `no email stored (${k})`);
  assert.equal((await call(e, '/api/auth/claim', { body: { claim: 'x'.repeat(43), profile: 'teacher-1' } })).status, 404, 'no picking route');
});

test('hidden teachers are signed out and cannot sign in; logout ends a session', async () => {
  const e = env();
  who = { id: 'seed', display_name: 'Seed', email: 'seed@example.com' };
  await signIn(e, SHARED);
  await link(e, 'evan@example.com', 'teacher-2');
  who = { id: 'evan', display_name: 'Evan', email: 'evan@example.com' };
  const s = await signIn(e, SHARED);
  assert.equal((await call(e, '/api/auth/me', { method: 'GET', session: s.data.session })).status, 200);
  const list = JSON.parse(e.CLASS_KV.map.get('profiles')).map((p) => (p.id === 'teacher-2' ? { ...p, archived: true } : p));
  await e.CLASS_KV.put('profiles', JSON.stringify(list));
  const me = await call(e, '/api/auth/me', { method: 'GET', session: s.data.session });
  assert.equal(me.status, 401);
  assert.equal(me.data.error, 'hidden');
  assert.equal((await signIn(e, SHARED)).status, 403);

  who = { id: 'stranger3', display_name: 'Ms Kay' };
  const o = await signIn(e, OWN);
  await call(e, '/api/auth/logout', { session: o.data.session });
  assert.equal((await call(e, '/api/auth/me', { method: 'GET', session: o.data.session })).status, 401);
});

test('refused: wrong redirect, bad client id, bad verifier, a Spotify user not on the app', async () => {
  const e = env();
  who = { id: 'x', display_name: 'X' };
  const calls = tokenCalls;
  assert.equal((await signIn(e, OWN, { redirectUri: 'https://evil.example/host/' })).status, 400);
  assert.equal((await signIn(e, 'nope')).status, 400);
  assert.equal((await signIn(e, OWN, { verifier: 'short' })).status, 400);
  assert.equal(tokenCalls, calls, 'Spotify is not even asked');
  who = { id: 'y', forbidden: true };
  const r = await signIn(e, OWN);
  assert.equal(r.status, 400);
  assert.match(r.data.message, /User Management/);
  assert.equal((await call(e, '/api/auth/me', { method: 'GET', session: 'garbage' })).status, 401);
});

// ---- Free teachers' caps, per Spotify account (protocol.js FREE TEACHERS) ----
import { FREE_CAPS, spendFree } from '../src/free.js';
import { aiThemeCheck } from '../shared/filter.js';
import { FREE_SIGNUPS_PER_DAY, freeUseKey } from '../shared/protocol.js';

test('free caps: counted per teacher per day; RoomDJ\'s own app is never counted', async () => {
  const e = env();
  const free = { id: 'u-abc' }, other = { id: 'u-def' }, listed = { id: 'teacher-1', legacy: true };
  const day = Date.UTC(2026, 9, 14, 12);
  for (let i = 0; i < FREE_CAPS.rooms; i++) assert.equal(await spendFree(e, free, 'rooms', day), true);
  assert.equal(await spendFree(e, free, 'rooms', day), false, 'the cap');
  assert.equal(await spendFree(e, other, 'rooms', day), true, 'another Spotify account has its own');
  assert.equal(await spendFree(e, free, 'rooms', day + 24 * 3600_000), true, 'a new day');
  assert.equal(await spendFree(e, free, 'ai', day), true, 'ai counts apart from rooms');
  assert.equal(JSON.parse(e.CLASS_KV.map.get(freeUseKey('u-abc', day))).rooms, FREE_CAPS.rooms);
  for (let i = 0; i < 500; i++) assert.equal(await spendFree(e, listed, 'ai', day), true);
  assert.equal([...e.CLASS_KV.map.keys()].some((k) => k.includes('teacher-1')), false, 'nothing stored for a list teacher');
});

test('free caps: AI used up → the song waits for the teacher, the AI is not asked', async () => {
  let asked = 0;
  const e = { ...env(), AI: { run: async () => { asked++; return { response: '{"verdict":"OK"}' }; } } };
  const song = { id: 'it:123', title: 'New Song', artist: 'Someone', album: 'A', explicit: 'notExplicit' };
  const r = await aiThemeCheck(song, e, { budget: async () => false });
  assert.equal(asked, 0);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.source, 'limit');
  assert.equal(r.failed, false, 'not an AI failure (no warning on the host)');
});

test('free sign-ups: at most FREE_SIGNUPS_PER_DAY new own-app teachers a day', async () => {
  const e = env();
  await e.CLASS_KV.put(`signups:v1:${new Date().toISOString().slice(0, 10)}`, String(FREE_SIGNUPS_PER_DAY));
  who = { id: 'late', display_name: 'Late' };
  const r = await signIn(e, OWN);
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'full');
  who = { id: 'dalton', display_name: 'Mr Fowler' };
  assert.equal((await signIn(e, SHARED)).status, 200, 'RoomDJ\'s own app is not capped');
});

test('signed in: no Add teacher (teachers are added on the Spotify app)', async () => {
  const e = env();
  who = { id: 'one', display_name: 'One', email: 'one@example.com' };
  const r = await signIn(e, SHARED);
  const req = new Request(`${ORIGIN}/api/teacher/profiles`, { method: 'POST', headers: { authorization: `Bearer ${r.data.session}` }, body: JSON.stringify({ name: 'Someone' }) });
  signedIn.set(req, await teacherSession(req, e));
  assert.equal((await handleProfiles(req, e, new URL(req.url))).status, 403);
});
