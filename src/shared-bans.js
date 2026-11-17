// ⛔ Other teachers' bans (protocol.js SHARED BANS; Dalton 2026-11-16: "How can we learn bans from other teachers",
// then: a hint only, an "Other teachers' bans" list to copy from, every teacher counts, 2 other teachers).
// KV bancount:v1:<banKey> = { id, title, artist, teachers: [teacher hash], at }; its METADATA { n, title, artist }
// lets the list come from one KV list call. A teacher is a short SHA-256 of their profile id (never the id or a
// name). Only counts ever leave the server. Nothing here blocks a song: a teacher's own ban list does that.

import { SHARED_BAN_MIN } from '../shared/protocol.js';
import { banKey } from '../shared/filter.js';
import { songId } from '../shared/catalog.js';
import { readBanned } from './search.js';
import { teacherKvKey } from './teacher-kv.js';

export const BANCOUNT_PREFIX = 'bancount:v1:';
const TEACHERS_MAX = 200;
const BANNED_MAX = 2000;

/** The legacy profile (plain KV keys) is one teacher however it arrives: null (a room from before profiles) or legacy. */
export async function teacherHash(profile) {
  const id = !profile || profile.legacy === true ? 'legacy' : String(profile.id);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bancount:${id}`)));
  return Array.from(bytes.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One more teacher banned this song (any version). Last write wins between two at once (accepted: a count). */
export async function recordBan(env, song, profile) {
  const key = banKey(song);
  if (!key || !env.CLASS_KV) return;
  try {
    const kvKey = BANCOUNT_PREFIX + key;
    const old = (await env.CLASS_KV.get(kvKey, 'json')) ?? {};
    const teachers = Array.isArray(old.teachers) ? old.teachers : [];
    const me = await teacherHash(profile);
    if (teachers.includes(me)) return;
    const next = { id: old.id ?? song.id, title: String(old.title ?? song.title ?? '').slice(0, 200), artist: String(old.artist ?? song.artist ?? '').slice(0, 200), teachers: [...teachers, me].slice(-TEACHERS_MAX), at: Date.now() };
    await env.CLASS_KV.put(kvKey, JSON.stringify(next), { metadata: { n: next.teachers.length, title: next.title.slice(0, 120), artist: next.artist.slice(0, 80) } });
  } catch (e) {
    console.error(JSON.stringify({ message: 'ban count not saved', error: String(e) }));
  }
}

/**
 * Songs banned by SHARED_BAN_MIN or more OTHER teachers, most banned first:
 * [{ key, title, artist, others, mine }] (mine: on this teacher's own ban list).
 */
export async function sharedBans(env, profile) {
  const mine = await readBanned(env, profile);
  const out = [];
  let cursor;
  do {
    const r = await env.CLASS_KV.list({ prefix: BANCOUNT_PREFIX, cursor });
    for (const k of r.keys) {
      const key = k.name.slice(BANCOUNT_PREFIX.length);
      const n = Number(k.metadata?.n) || 0;
      const own = mine.has(key);
      const others = n - (own ? 1 : 0);
      if (others >= SHARED_BAN_MIN) out.push({ key, title: String(k.metadata?.title ?? ''), artist: String(k.metadata?.artist ?? ''), others, mine: own });
    }
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out.sort((a, b) => b.others - a.others || a.title.localeCompare(b.title));
}

/** ⛔ Ban for me: copy a shared ban into this teacher's own ban list (and count them). → true when it is on it now. */
export async function banForMe(env, profile, key) {
  if (typeof key !== 'string' || !key.startsWith('song:') || key.length > 450) return false;
  const v = await env.CLASS_KV.get(BANCOUNT_PREFIX + key, 'json');
  const id = songId(v?.id);
  if (!v || !id) return false;
  const kvKey = teacherKvKey('banned', profile);
  const list = (await env.CLASS_KV.get(kvKey, 'json')) ?? [];
  const banned = Array.isArray(list) ? list.filter((b) => songId(b?.id ?? b?.trackId) !== id) : [];
  banned.push({ id, title: v.title, artist: v.artist, at: Date.now(), reason: 'shared' });
  await env.CLASS_KV.put(kvKey, JSON.stringify(banned.slice(-BANNED_MAX)));
  await recordBan(env, { id, title: v.title, artist: v.artist }, profile);
  return true;
}
