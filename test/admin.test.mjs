// src/admin.js and the list-teacher limits in src/profiles.js: only an ADMIN_PROFILES Spotify sign-in
// sees /api/admin/*, never the teacher key; teachers change only their own name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { handleAdmin } from '../src/admin.js';
import { handleAuth, teacherSession } from '../src/auth.js';
import { handleProfiles, signedIn } from '../src/profiles.js';

const SHARED = 'cb5810b6e2e64ca38407949a4615f160';
const ORIGIN = 'https://roomdj.com';

function fakeKv() {
  const map = new Map();
  const meta = new Map();
  return {
    map,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts) { map.set(k, v); if (opts?.metadata) meta.set(k, opts.metadata); },
    async delete(k) { map.delete(k); },
    async list({ prefix = '' } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: meta.get(name) }));
      return { keys, list_complete: true };
    },
  };
}

let who;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/api/token')) return Response.json({ access_token: `A-${who.id}`, refresh_token: 'R', expires_in: 3600 });
  return Response.json(who);
};

const env = () => ({ CLASS_KV: fakeKv(), SPOTIFY_CLIENT_ID: SHARED, ADMIN_PROFILES: 'teacher-1', TEACHER_KEY: 'k' });
const link = (e, email, id) => e.CLASS_KV.put(`link:v1:${createHash('sha256').update(`email:${email}`).digest('hex')}`, id);
async function signIn(e, id, email) {
  who = { id, display_name: id, email };
  const req = new Request(`${ORIGIN}/api/auth/spotify`, { method: 'POST', body: JSON.stringify({ code: 'C', verifier: 'v'.repeat(64), clientId: SHARED, redirectUri: `${ORIGIN}/host/` }) });
  return (await (await handleAuth(req, e, new URL(req.url))).json()).session;
}
async function admin(e, method, path, { session, key, body } = {}) {
  const headers = { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(key ? { 'x-teacher-key': key, 'x-teacher-profile': 'teacher-1' } : {}) };
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const r = await handleAdmin(req, e, new URL(req.url));
  return { status: r.status, data: await r.json() };
}
async function profiles(e, method, path, session, body) {
  const req = new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${session}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  signedIn.set(req, await teacherSession(req, e));
  const r = await handleProfiles(req, e, new URL(req.url));
  return { status: r.status, data: await r.json() };
}

test('admin: only the ADMIN_PROFILES Spotify sign-in; never the key, never another teacher', async () => {
  const e = env();
  await signIn(e, 'seed', 'seed@example.com'); // seeds the list
  await link(e, 'dalton@example.com', 'teacher-1');
  await link(e, 'peter@example.com', 'teacher-2');
  const dalton = await signIn(e, 'dalton', 'dalton@example.com');
  const peter = await signIn(e, 'peter', 'peter@example.com');
  assert.equal((await admin(e, 'GET', '/api/admin/stats')).status, 404, 'nobody');
  assert.equal((await admin(e, 'GET', '/api/admin/stats', { key: 'k' })).status, 404, 'the teacher key is never admin');
  assert.equal((await admin(e, 'GET', '/api/admin/stats', { session: peter })).status, 404, 'another teacher');
  const s = await admin(e, 'GET', '/api/admin/stats', { session: dalton });
  assert.equal(s.status, 200);
  assert.deepEqual(s.data.teachers.map((t) => [t.id, t.status]).slice(0, 2), [['teacher-1', 'signed in'], ['teacher-2', 'signed in']]);
  assert.equal(s.data.sessions, 3);
  // /api/auth/me says who is an admin (only for the link on the host page).
  const me = async (session) => (await (await handleAuth(new Request(`${ORIGIN}/api/auth/me`, { headers: { authorization: `Bearer ${session}` } }), e, new URL(`${ORIGIN}/api/auth/me`))).json()).admin;
  assert.equal(await me(dalton), true);
  assert.equal(await me(peter), false);
});

test('admin: hide / show / rename others, link an email (hash only); cannot hide yourself', async () => {
  const e = env();
  await signIn(e, 'seed', 'seed@example.com');
  await link(e, 'dalton@example.com', 'teacher-1');
  const dalton = await signIn(e, 'dalton', 'dalton@example.com');
  assert.equal((await admin(e, 'PATCH', '/api/admin/teachers/teacher-1', { session: dalton, body: { archived: true } })).status, 409);
  assert.equal((await admin(e, 'PATCH', '/api/admin/teachers/teacher-2', { session: dalton, body: { archived: true } })).status, 200);
  assert.ok(JSON.parse(e.CLASS_KV.map.get('profiles')).find((p) => p.id === 'teacher-2').archived);
  assert.equal((await admin(e, 'PATCH', '/api/admin/teachers/teacher-2', { session: dalton, body: { name: 'Mr Robinson' } })).data.profile.name, 'Mr Robinson');
  const l = await admin(e, 'POST', '/api/admin/link', { session: dalton, body: { email: 'John.M@Example.com', profile: 'teacher-2' } });
  assert.equal(l.status, 200);
  assert.ok(e.CLASS_KV.map.has(`link:v1:${createHash('sha256').update('email:john.m@example.com').digest('hex')}`));
  for (const [k, v] of e.CLASS_KV.map) assert.ok(!/example\.com/i.test(k + v), `no email stored (${k})`);
  assert.equal((await admin(e, 'POST', '/api/admin/link', { session: dalton, body: { email: 'nope', profile: 'teacher-2' } })).status, 400);
});

test('a teacher on the list sees only themselves and renames only themselves (no hiding anyone)', async () => {
  const e = env();
  await signIn(e, 'seed', 'seed@example.com');
  await link(e, 'peter@example.com', 'teacher-2');
  const peter = await signIn(e, 'peter', 'peter@example.com');
  assert.deepEqual((await profiles(e, 'GET', '/api/teacher/profiles', peter)).data.profiles.map((p) => p.id), ['teacher-2']);
  assert.equal((await profiles(e, 'PATCH', '/api/teacher/profiles/teacher-1', peter, { archived: true })).status, 403, 'cannot hide Dalton');
  assert.equal((await profiles(e, 'PATCH', '/api/teacher/profiles/teacher-1', peter, { name: 'Gotcha' })).status, 403, 'cannot rename Dalton');
  assert.equal((await profiles(e, 'PATCH', '/api/teacher/profiles/teacher-2', peter, { archived: true })).status, 400, 'cannot hide himself either');
  assert.equal((await profiles(e, 'PATCH', '/api/teacher/profiles/teacher-2', peter, { name: 'Mr R' })).data.profile.name, 'Mr R');
});

test('admin: free teachers (own app) are listed and can be renamed, turned off (signed out, kept out) and back on', async () => {
  const e = env();
  await signIn(e, 'seed', 'seed@example.com');
  await link(e, 'dalton@example.com', 'teacher-1');
  const dalton = await signIn(e, 'dalton', 'dalton@example.com');
  // A free teacher signs in with their own Spotify app.
  who = { id: 'stranger', display_name: 'Ms Kay', email: 'kay@example.com' };
  const OWN = '0123456789abcdef0123456789abcdef';
  const signFree = async () => {
    const req = new Request(`${ORIGIN}/api/auth/spotify`, { method: 'POST', body: JSON.stringify({ code: 'C', verifier: 'v'.repeat(64), clientId: OWN, redirectUri: `${ORIGIN}/host/` }) });
    const r = await handleAuth(req, e, new URL(req.url));
    return { status: r.status, data: await r.json() };
  };
  const kay = await signFree();
  const id = kay.data.account.profile.id;
  const s = await admin(e, 'GET', '/api/admin/stats', { session: dalton });
  assert.deepEqual(s.data.free.list.map((f) => [f.id, f.name, f.archived ?? false]), [[id, 'Ms Kay', false]]);
  assert.equal((await admin(e, 'PATCH', `/api/admin/teachers/${id}`, { session: dalton, body: { name: 'Ms Kay Room 4' } })).data.profile.name, 'Ms Kay Room 4');
  assert.equal((await admin(e, 'PATCH', `/api/admin/teachers/${id}`, { session: dalton, body: { archived: true } })).status, 200);
  const me = await handleAuth(new Request(`${ORIGIN}/api/auth/me`, { headers: { authorization: `Bearer ${kay.data.session}` } }), e, new URL(`${ORIGIN}/api/auth/me`));
  assert.equal(me.status, 401, 'signed out at once');
  assert.equal((await signFree()).status, 403, 'their own app cannot get them back in');
  assert.equal((await admin(e, 'GET', '/api/admin/stats', { session: dalton })).data.free.list[0].archived, true);
  await admin(e, 'PATCH', `/api/admin/teachers/${id}`, { session: dalton, body: { archived: false } });
  assert.equal((await signFree()).status, 200, 'turned back on');
});
