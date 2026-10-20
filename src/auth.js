// Spotify sign-in and RoomDJ sessions (protocol.js SPOTIFY SIGN-IN; the rules: shared/accounts.js).
// The page sends Spotify's one-time code here and this Worker swaps it for tokens, so the server
// knows which Client ID the login came from (a page could lie about that; Spotify cannot). The
// tokens go straight back to the page for playback: never stored, never logged (CLAUDE.md
// invariant 27). KV keeps only:
//   acct:v1:<sha256 of the Spotify user id>  { profileId }          which teacher that person is
//   prof:v1:<id>                             { id, name, createdAt } a private ('own' app) teacher
//   sess:v1:<sha256 of the session>          { acct, profileId, clientId, app }, TTL SESSION_TTL_S
//   link:v1:<sha256 of "email:<email>">      a list teacher's profile id (RoomDJ's own app;
//                                            written by scripts/link-teacher.mjs, never the email)
// Local tests only: SPOTIFY_AUTH_TEST_BASE=http://127.0.0.1:<port> (a `wrangler dev --var`) sends
// the token swap and /v1/me to a fake Spotify. Only a loopback http address is taken.

import { FREE_SIGNUPS_PER_DAY, FREE_USE_TTL_S, OWN_PROFILE_PREFIX, PROFILE_ID_PATTERN, SESSION_PATTERN, SESSION_TTL_S } from '../shared/protocol.js';
import { SPOTIFY_TOKEN_URL, randomToken, tokenRequestBody, tokensFromReply } from '../shared/spotify.js';
import { accountView, appOf, cleanClientId, newOwnProfileId, startName } from '../shared/accounts.js';
import { addProfile, findProfile } from '../shared/profiles.js';
import { KV_PROFILES, ensureProfiles } from './profiles.js';
import { addressOf } from './lockout.js';

// (Not room.js's: that file needs the Workers runtime, and the Node tests load this one.)
async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_AUTH_BYTES = 4096;
const SPOTIFY_TIMEOUT_MS = 8000;
const SPOTIFY_ME_URL = 'https://api.spotify.com/v1/me';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function spotifyUrls(env) {
  const test = String(env?.SPOTIFY_AUTH_TEST_BASE ?? '');
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(test)) return { token: `${test}/api/token`, me: `${test}/v1/me` };
  return { token: SPOTIFY_TOKEN_URL, me: SPOTIFY_ME_URL };
}

async function readBody(request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_AUTH_BYTES) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_AUTH_BYTES) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

async function spotifyFetch(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(SPOTIFY_TIMEOUT_MS) });
}

const LOGIN_FAILED = { error: 'login', message: 'Spotify login did not work. Try again.' };
const HIDDEN = { error: 'hidden', message: 'Your RoomDJ account is turned off. Ask the person who runs RoomDJ to turn it back on.' };
const SESSION_GONE = { error: 'session', message: 'Sign in with Spotify again.' };

/** Which teacher a profile id is: a private one (prof:v1) or one on the list (active only). */
async function profileById(env, id, list = null) {
  if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) return null;
  if (id.startsWith(OWN_PROFILE_PREFIX)) {
    // A free teacher the admin turned off (src/admin.js) is refused like a turned-off list teacher.
    const p = await env.CLASS_KV.get(`prof:v1:${id}`, 'json');
    return p && !p.archived ? p : null;
  }
  return findProfile(list ?? (await ensureProfiles(env)), id, { active: true });
}

async function newSession(env, { acct, profile, clientId, app }) {
  const session = randomToken(32);
  await env.CLASS_KV.put(`sess:v1:${await sha256Hex(session)}`, JSON.stringify({ acct, profileId: profile.id, clientId, app }), { expirationTtl: SESSION_TTL_S });
  return { session, account: accountView(profile, app, clientId) };
}

/**
 * The signed-in teacher of a request (header authorization: Bearer <session>):
 * null (no session header), a 401 Response (unknown, expired, or the teacher was hidden), or
 * { profile, app, clientId, key } (key: the session's KV key).
 */
export async function teacherSession(request, env) {
  const m = (request.headers.get('authorization') ?? '').match(/^Bearer (\S+)$/);
  if (!m) return null;
  if (!SESSION_PATTERN.test(m[1]) || !env.CLASS_KV) return json(401, SESSION_GONE);
  const key = `sess:v1:${await sha256Hex(m[1])}`;
  const s = await env.CLASS_KV.get(key, 'json');
  const profile = s ? await profileById(env, s.profileId) : null;
  if (!profile) return json(401, s ? HIDDEN : SESSION_GONE);
  return { profile, app: s.app, clientId: s.clientId, key };
}

// POST /api/auth/spotify: swap the code, learn who it is, sign in (or ask which teacher they are).
async function signIn(request, env, url) {
  const body = await readBody(request);
  const clientId = cleanClientId(body?.clientId);
  const { code, verifier, redirectUri } = body ?? {};
  if (!clientId || typeof code !== 'string' || !code || code.length > 2048 || typeof verifier !== 'string'
    || !/^[A-Za-z0-9_.~-]{43,128}$/.test(verifier) || redirectUri !== `${url.origin}/host/`) {
    return json(400, LOGIN_FAILED);
  }
  const urls = spotifyUrls(env);
  let tokens, me;
  try {
    const r = await spotifyFetch(urls.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenRequestBody({ clientId, code, verifier, redirectUri }),
    });
    tokens = r.ok ? tokensFromReply(await r.json()) : null;
    if (!tokens) {
      console.log(JSON.stringify({ message: 'spotify sign-in refused', status: r.status }));
      return json(400, LOGIN_FAILED);
    }
    const r2 = await spotifyFetch(urls.me, { headers: { authorization: `Bearer ${tokens.access}` } });
    me = r2.ok ? await r2.json() : null;
    if (typeof me?.id !== 'string' || !me.id) {
      console.log(JSON.stringify({ message: 'spotify /me failed', status: r2.status }));
      // Dev mode: a Spotify user not on that app's User Management list gets 403 here.
      return json(400, r2.status === 403
        ? { error: 'login', message: 'Spotify says this account is not added to that Spotify app. Add it under User Management in the app\'s dashboard.' }
        : LOGIN_FAILED);
    }
  } catch (e) {
    console.error(JSON.stringify({ message: 'spotify sign-in failed', error: String(e) }));
    return json(503, { error: 'login', message: 'Could not reach Spotify. Try again.' });
  }
  const app = appOf(clientId, env.SPOTIFY_CLIENT_ID);
  const acct = await sha256Hex(`spotify:${me.id}`);
  const known = await env.CLASS_KV.get(`acct:v1:${acct}`, 'json');
  if (known) {
    const profile = await profileById(env, known.profileId);
    if (!profile) return json(403, HIDDEN);
    return json(200, { ...(await newSession(env, { acct, profile, clientId, app })), tokens });
  }
  const name = startName(me.display_name);
  if (app === 'own') {
    // New free teachers a day, for everyone (protocol.js FREE TEACHERS): a flood of sign-ups stops here.
    const day = `signups:v1:${new Date().toISOString().slice(0, 10)}`;
    const count = Number(await env.CLASS_KV.get(day)) || 0;
    if (count >= FREE_SIGNUPS_PER_DAY) {
      console.log(JSON.stringify({ message: 'free sign-ups full today', count }));
      return json(503, { error: 'full', message: 'RoomDJ has had a lot of new teachers today. Please try again tomorrow.' });
    }
    await env.CLASS_KV.put(day, String(count + 1), { expirationTtl: FREE_USE_TTL_S });
    const profile = { id: newOwnProfileId(), name, createdAt: Date.now() };
    // metadata: the admin page lists free teachers without reading each one (src/admin.js).
    await env.CLASS_KV.put(`prof:v1:${profile.id}`, JSON.stringify(profile), { metadata: { name: profile.name, createdAt: profile.createdAt } });
    await env.CLASS_KV.put(`acct:v1:${acct}`, JSON.stringify({ profileId: profile.id }));
    console.log(JSON.stringify({ message: 'teacher signed up', app, profile: profile.id }));
    return json(200, { ...(await newSession(env, { acct, profile, clientId, app })), tokens });
  }
  // RoomDJ's own app (Dalton, 2026-10-14: "don't let me be John or Peter"): nobody picks a teacher.
  // The Spotify account's EMAIL (what the app's User Management list holds) decides: a teacher on
  // the list linked to that email (KV link:v1:<sha256 of the email> = profile id; scripts/link-teacher.mjs)
  // is theirs, once; anyone else gets a new teacher with their Spotify name.
  const email = typeof me.email === 'string' ? me.email.trim().toLowerCase() : '';
  const list = await ensureProfiles(env);
  const linkedId = email ? await env.CLASS_KV.get(`link:v1:${await sha256Hex(`email:${email}`)}`) : null;
  let next, profile;
  if (linkedId) {
    const p = findProfile(list, linkedId);
    if (!p || p.archived) return json(403, HIDDEN);
    if (p.claimed) {
      console.log(JSON.stringify({ message: 'linked teacher already claimed', profile: p.id }));
      return json(409, { error: 'taken', message: `Another Spotify account already signed in as ${p.name}. Ask the person who runs your RoomDJ app.` });
    }
    profile = { ...p, claimed: true };
    next = list.map((x) => (x.id === p.id ? profile : x));
  } else {
    let added = addProfile(list, name);
    for (let n = 2; !added.ok && added.error === 'name_taken' && n < 10; n++) added = addProfile(list, `${name} ${n}`);
    if (!added.ok) return json(added.error === 'name' ? 400 : 409, { error: added.error, message: added.message });
    profile = { ...added.profile, claimed: true };
    next = added.list.map((x) => (x.id === profile.id ? profile : x));
  }
  await env.CLASS_KV.put(KV_PROFILES, JSON.stringify(next));
  await env.CLASS_KV.put(`acct:v1:${acct}`, JSON.stringify({ profileId: profile.id }));
  console.log(JSON.stringify({ message: linkedId ? 'teacher linked by email' : 'teacher added', app, profile: profile.id }));
  return json(200, { ...(await newSession(env, { acct, profile, clientId, app })), tokens });
}

/** /api/auth/* */
export async function handleAuth(request, env, url) {
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  if (url.pathname === '/api/auth/me') {
    if (request.method !== 'GET') return json(405, { error: 'method', message: 'Use GET.' });
    const t = await teacherSession(request, env);
    if (!t) return json(401, SESSION_GONE);
    if (t instanceof Response) return t;
    // admin: this teacher may open /admin/ (src/admin.js checks again on every call).
    const admins = String(env.ADMIN_PROFILES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return json(200, { account: accountView(t.profile, t.app, t.clientId), admin: admins.includes(t.profile.id) });
  }
  if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
  if (url.pathname === '/api/auth/logout') {
    const t = await teacherSession(request, env);
    if (t && !(t instanceof Response)) await env.CLASS_KV.delete(t.key);
    return json(200, { ok: true });
  }
  if (env.AUTH_RATE_IP) {
    if (!(await env.AUTH_RATE_IP.limit({ key: `ip ${addressOf(request)}` })).success) {
      return json(429, { error: 'busy', message: 'A lot of sign-ins are coming from your school right now. Wait a minute and try again.' });
    }
  }
  if (url.pathname === '/api/auth/spotify') return signIn(request, env, url);
  return json(404, { error: 'not_found', message: 'No such API.' });
}
