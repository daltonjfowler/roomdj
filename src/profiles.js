// Teacher profiles on the Worker (protocol.js TEACHER PROFILES; the list rules are shared/profiles.js).
// KV `profiles` holds the list. The first teacher call after this feature shipped writes the seed
// list ("Teacher 1" = legacy = the data from before; "Teacher 2" = fresh; rename them in Who's teaching?). The seed ids are
// fixed, so a second run, or two at once, writes the same list. Nothing is ever deleted.

import { OWN_PROFILE_PREFIX, PROFILE_ID_PATTERN } from '../shared/protocol.js';
import { addProfile, changeProfile, cleanProfileName, findProfile, migrateProfiles, readProfiles } from '../shared/profiles.js';

export const KV_PROFILES = 'profiles';
const MAX_PROFILE_BYTES = 1024;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** The list, writing the seed list first if there is none yet (teacher calls only). */
export async function ensureProfiles(env) {
  const stored = await env.CLASS_KV?.get(KV_PROFILES, 'json');
  const { list, created } = migrateProfiles(stored);
  if (created && env.CLASS_KV) {
    await env.CLASS_KV.put(KV_PROFILES, JSON.stringify(list));
    console.log(JSON.stringify({ message: 'teacher profiles created', profiles: list.map((p) => p.id) }));
  }
  return list;
}

/** The list without writing anything (public paths: browsing). No list yet → [] (only the plain keys exist). */
export async function readProfileList(env) {
  try {
    return readProfiles(await env.CLASS_KV?.get(KV_PROFILES, 'json'));
  } catch (e) {
    console.error(JSON.stringify({ message: 'profiles read failed', error: String(e) }));
    return [];
  }
}

const NEED_PROFILE = { error: 'profile', message: 'Pick who is teaching first (reload the page).' };

// The Spotify sign-in of a teacher request (src/auth.js teacherSession), set by the Worker before
// any handler runs: { profile, app, clientId, key }. Requests without one used the teacher key.
export const signedIn = new WeakMap();

/**
 * The teacher profile a request names (header x-teacher-profile, or `fromBody`): an active profile
 * on the list, or a 400 Response.
 */
export async function requestProfile(request, env, fromBody = null) {
  const session = signedIn.get(request);
  if (session) return session.profile; // a signed-in teacher is always their own profile
  const id = request.headers.get('x-teacher-profile') || fromBody || '';
  if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) return json(400, NEED_PROFILE);
  const p = findProfile(await ensureProfiles(env), id, { active: true });
  return p ?? json(400, NEED_PROFILE);
}

async function readBody(request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_PROFILE_BYTES) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_PROFILE_BYTES) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** /api/teacher/profiles and /api/teacher/profiles/:id (the teacher key was checked already). */
export async function handleProfiles(request, env, url) {
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  const one = url.pathname.match(/^\/api\/teacher\/profiles\/([^/]+)$/);
  // A private ('own' app) teacher sees and renames only themselves; the list is not theirs to see.
  const me = signedIn.get(request)?.profile;
  if (me?.id.startsWith(OWN_PROFILE_PREFIX)) return ownProfileCall(request, env, one, me);
  // A signed-in list teacher (RoomDJ's app) sees only themselves and changes only their own NAME:
  // hiding, showing and renaming others is the admin page's (src/admin.js), so Peter can never hide
  // or rename Dalton. The old teacher key (local tests) keeps the whole Who's teaching? list.
  if (me) {
    if (url.pathname === '/api/teacher/profiles' && request.method === 'GET') return json(200, { profiles: [me] });
    if (!one || one[1] !== me.id || request.method !== 'PATCH') return json(403, { error: 'own', message: 'You can only change your own name.' });
    const body = await readBody(request);
    if (!body || body.name === undefined || body.archived !== undefined) return json(400, { error: 'json', message: 'Only your name can change here.' });
    const done = changeProfile(await ensureProfiles(env), me.id, { name: body.name });
    if (!done.ok) return json(done.error === 'name' ? 400 : 409, { error: done.error, message: done.message });
    await env.CLASS_KV.put(KV_PROFILES, JSON.stringify(done.list));
    return json(200, { profile: done.profile, profiles: [done.profile] });
  }
  if (url.pathname === '/api/teacher/profiles') {
    if (request.method === 'GET') return json(200, { profiles: await ensureProfiles(env) });
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use GET or POST.' });
    const body = await readBody(request);
    if (!body) return json(400, { error: 'json', message: 'The page sent something the server could not read.' });
    const done = addProfile(await ensureProfiles(env), body.name);
    if (!done.ok) return json(done.error === 'name' ? 400 : 409, { error: done.error, message: done.message });
    await env.CLASS_KV.put(KV_PROFILES, JSON.stringify(done.list));
    console.log(JSON.stringify({ message: 'teacher profile added', profile: done.profile.id }));
    return json(201, { profile: done.profile, profiles: done.list });
  }
  if (one) {
    if (request.method !== 'PATCH') return json(405, { error: 'method', message: 'Use PATCH.' });
    const body = await readBody(request);
    if (!body) return json(400, { error: 'json', message: 'The page sent something the server could not read.' });
    const change = {};
    if (body.name !== undefined) change.name = body.name;
    if (typeof body.archived === 'boolean') change.archived = body.archived;
    const done = changeProfile(await ensureProfiles(env), one[1], change);
    if (!done.ok) {
      const status = done.error === 'no_profile' ? 404 : done.error === 'name' ? 400 : 409;
      return json(status, { error: done.error, message: done.message });
    }
    await env.CLASS_KV.put(KV_PROFILES, JSON.stringify(done.list));
    console.log(JSON.stringify({ message: 'teacher profile changed', profile: done.profile.id, archived: done.profile.archived === true }));
    return json(200, { profile: done.profile, profiles: done.list });
  }
  return json(404, { error: 'not_found', message: 'No such API.' });
}

async function ownProfileCall(request, env, one, me) {
  if (!one && request.method === 'GET') return json(200, { profiles: [me] });
  if (!one || one[1] !== me.id) return json(403, { error: 'own', message: 'You can only change your own name.' });
  if (request.method !== 'PATCH') return json(405, { error: 'method', message: 'Use PATCH.' });
  const body = await readBody(request);
  const v = cleanProfileName(body?.name);
  if (!v.ok) return json(400, { error: 'name', message: v.message });
  const profile = { ...me, name: v.name };
  await env.CLASS_KV.put(`prof:v1:${me.id}`, JSON.stringify(profile), { metadata: { name: profile.name, createdAt: profile.createdAt } });
  return json(200, { profile, profiles: [profile] });
}
