// The admin page (/admin/; Dalton, 2026-10-14: "a way for me to log in to see admin details, like
// teachChat"). ONLY a Spotify sign-in whose profile id is on ADMIN_PROFILES (wrangler.jsonc vars;
// comma-separated) — never the old teacher key. Anyone else gets 404, as if there were no admin.
//   GET  /api/admin/stats                    → the summary (like `npm run stats`)
//   PATCH /api/admin/teachers/:id {name?, archived?} → rename / hide / show a teacher on the list
//   POST /api/admin/link {email, profile}    → link a Spotify email to a list teacher (only its hash
//                                              is kept; the email is never stored or logged)
// KV cost: list operations (paged, capped) and a few gets; free teachers and their daily use are
// read from LIST METADATA (written with the records), so no per-teacher get.

import { changeProfile, cleanProfileName, findProfile } from '../shared/profiles.js';
import { OWN_PROFILE_PREFIX, PROFILE_ID_PATTERN } from '../shared/protocol.js';
import { FREE_CAPS } from './free.js';
import { KV_PROFILES, ensureProfiles } from './profiles.js';
import { teacherSession } from './auth.js';

const MAX_BODY = 2048;
const NOT_FOUND = { error: 'not_found', message: 'No such API.' };

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The signed-in admin, or null. */
async function adminOf(request, env) {
  const s = await teacherSession(request, env);
  if (!s || s instanceof Response) return null;
  const admins = String(env.ADMIN_PROFILES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return admins.includes(s.profile.id) ? s : null;
}

/** Keys under a prefix with their metadata, at most `pages` pages of 1000. → { keys, more } */
async function listAll(env, prefix, pages = 5) {
  const keys = [];
  let cursor;
  for (let i = 0; i < pages; i++) {
    const r = await env.CLASS_KV.list({ prefix, cursor, limit: 1000 });
    keys.push(...r.keys);
    if (r.list_complete) return { keys, more: false };
    cursor = r.cursor;
  }
  return { keys, more: true };
}

async function readBody(request) {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) return null;
  try {
    const b = JSON.parse(new TextDecoder().decode(bytes));
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

/** Rename / turn off / turn back on a free (own-app) teacher: their prof:v1 record and its list metadata. */
async function changeFreeTeacher(env, id, body) {
  if (!PROFILE_ID_PATTERN.test(id)) return json(404, { error: 'no_profile', message: 'No such teacher.' });
  const key = `prof:v1:${id}`;
  const rec = await env.CLASS_KV.get(key, 'json');
  if (!rec) return json(404, { error: 'no_profile', message: 'No such teacher.' });
  const next = { ...rec };
  if (body.name !== undefined) {
    const v = cleanProfileName(body.name);
    if (!v.ok) return json(400, { error: 'name', message: v.message });
    next.name = v.name;
  }
  if (body.archived === true) next.archived = true;
  else if (body.archived === false) delete next.archived;
  await env.CLASS_KV.put(key, JSON.stringify(next), {
    metadata: { name: next.name, createdAt: next.createdAt, ...(next.archived ? { archived: true } : {}) },
  });
  console.log(JSON.stringify({ message: 'admin changed free teacher', profile: id, archived: next.archived === true }));
  return json(200, { profile: next });
}

async function stats(env) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const [list, links, own, sessions, use, verdicts, olderVerdicts, prewarm] = await Promise.all([
    ensureProfiles(env),
    listAll(env, 'link:v1:', 1),
    listAll(env, 'prof:v1:'),
    listAll(env, 'sess:v1:'),
    listAll(env, 'use:v1:'),
    listAll(env, 'verdict:v6:', 20),
    listAll(env, 'verdict:v5:', 20), // shared/filter.js OLDER_VERDICT_VERSIONS: still used
    env.CLASS_KV.get(`prewarm:v1:state:${today}`, 'json'),
  ]);
  const linked = new Set(await Promise.all(links.keys.map((k) => env.CLASS_KV.get(k.name))));
  const teachers = list.map((p) => ({
    id: p.id, name: p.name, status: p.archived ? 'hidden' : p.claimed ? 'signed in' : linked.has(p.id) ? 'linked' : 'not linked',
  }));
  // Today's use per free teacher (use:v1:<id>:<day> metadata), shown next to each one.
  const useToday = new Map(use.keys.filter((k) => k.name.endsWith(`:${today}`)).map((k) => [k.name.split(':')[2], k.metadata ?? {}]));
  const free = own.keys.map((k) => {
    const id = k.name.slice('prof:v1:'.length);
    return { id, name: k.metadata?.name ?? '', createdAt: k.metadata?.createdAt ?? 0, ...(k.metadata?.archived ? { archived: true } : {}), today: useToday.get(id) ?? {} };
  });
  const perDay = {};
  for (const f of free) {
    const d = new Date(f.createdAt).toISOString().slice(0, 10);
    perDay[d] = (perDay[d] ?? 0) + 1;
  }
  const todayUse = use.keys.filter((k) => k.name.endsWith(`:${today}`)).map((k) => k.metadata ?? {});
  const sum = (k) => todayUse.reduce((n, u) => n + (u[k] ?? 0), 0);
  // A verdict is kept per catalog id (a number, or sp:…) AND once per song (title + artist); a song
  // checked under v5 and again under v6 counts once.
  const songs = new Set([...verdicts.keys, ...olderVerdicts.keys].map((k) => k.name.replace(/^verdict:v\d+:/, ''))
    .filter((k) => !/^(\d+|sp:.*)$/.test(k))).size;
  return {
    at: now,
    teachers,
    free: {
      total: own.more ? `${free.length}+` : free.length,
      // Every free teacher (newest first; at most 500 here), to rename or turn off.
      list: free.sort((a, b) => b.createdAt - a.createdAt).slice(0, 500),
      perDay,
    },
    sessions: sessions.more ? `${sessions.keys.length}+` : sessions.keys.length,
    today: { teachers: todayUse.length, rooms: sum('rooms'), ai: sum('ai'), art: sum('art'), caps: FREE_CAPS },
    prewarm: prewarm ?? null,
    songs: verdicts.more ? `${songs}+` : songs,
  };
}

/** /api/admin/* */
export async function handleAdmin(request, env, url) {
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  const admin = await adminOf(request, env);
  if (!admin) return json(404, NOT_FOUND);
  if (url.pathname === '/api/admin/stats' && request.method === 'GET') return json(200, await stats(env));
  const one = url.pathname.match(/^\/api\/admin\/teachers\/([^/]+)$/);
  if (one && request.method === 'PATCH') {
    const body = await readBody(request);
    if (!body) return json(400, { error: 'json', message: 'The page sent something the server could not read.' });
    if (one[1] === admin.profile.id && body.archived === true) return json(409, { error: 'self', message: 'You cannot turn yourself off.' });
    if (one[1].startsWith(OWN_PROFILE_PREFIX)) return changeFreeTeacher(env, one[1], body);
    const change = {};
    if (body.name !== undefined) change.name = body.name;
    if (typeof body.archived === 'boolean') change.archived = body.archived;
    const done = changeProfile(await ensureProfiles(env), one[1], change);
    if (!done.ok) return json(done.error === 'no_profile' ? 404 : done.error === 'name' ? 400 : 409, { error: done.error, message: done.message });
    await env.CLASS_KV.put(KV_PROFILES, JSON.stringify(done.list));
    console.log(JSON.stringify({ message: 'admin changed teacher', profile: one[1], archived: done.profile.archived === true }));
    return json(200, { profile: done.profile });
  }
  if (url.pathname === '/api/admin/link' && request.method === 'POST') {
    const body = await readBody(request);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return json(400, { error: 'email', message: 'Type the email of that teacher\'s Spotify account.' });
    const id = typeof body?.profile === 'string' && PROFILE_ID_PATTERN.test(body.profile) ? body.profile : '';
    const p = findProfile(await ensureProfiles(env), id);
    if (!p) return json(404, { error: 'no_profile', message: 'That teacher is not on the list.' });
    await env.CLASS_KV.put(`link:v1:${await sha256Hex(`email:${email}`)}`, p.id);
    console.log(JSON.stringify({ message: 'admin linked teacher', profile: p.id }));
    return json(200, { ok: true, profile: { id: p.id, name: p.name } });
  }
  return json(404, NOT_FOUND);
}
