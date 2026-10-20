// Each teacher's open rooms, for the board's sign-in (protocol.js BOARD SIGN-IN): KV
// teacherKvKey('openRooms', profile) = [{ room, until, at }], newest first, at most OPEN_ROOMS_MAX,
// kept until the latest `until` (KV forgets it by itself then). The room adds itself when it opens,
// refreshes on "Take back my room" and 'times', and takes itself out when it closes. KV is only the
// signpost (it can be a minute stale, and two rooms writing at once: last write wins): the Worker
// asks each room whether it is live and whose it is before handing out a board token.

import { OPEN_ROOMS_MAX, ROOM_ID_PATTERN } from '../shared/protocol.js';
import { teacherKvKey } from './teacher-kv.js';

export const KV_OPEN_ROOMS = 'openRooms';

const good = (e) => e && typeof e === 'object' && ROOM_ID_PATTERN.test(e.room ?? '') && Number.isFinite(e.until) && Number.isFinite(e.at);

/** The entries still before their `until`, newest opened first (bad ones and repeats dropped). */
export function liveOpenRooms(list, now = Date.now()) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((e) => good(e) && e.until > now)
    .sort((a, b) => b.at - a.at)
    .filter((e) => !seen.has(e.room) && seen.add(e.room))
    .map(({ room, until, at }) => ({ room, until, at }))
    .slice(0, OPEN_ROOMS_MAX);
}

/** The list with `room` (re)added as the newest, or with its until changed when `keepAt`. */
export function addOpenRoom(list, { room, until, at = Date.now() }, now = Date.now(), { keepAt = false } = {}) {
  const old = (Array.isArray(list) ? list : []).find((e) => e?.room === room);
  const entry = { room, until, at: keepAt && Number.isFinite(old?.at) ? old.at : at };
  return liveOpenRooms([entry, ...(Array.isArray(list) ? list : []).filter((e) => e?.room !== room)], now);
}

/** The list without `room` (and without anything past its until). */
export function removeOpenRoom(list, room, now = Date.now()) {
  return liveOpenRooms((Array.isArray(list) ? list : []).filter((e) => e?.room !== room), now);
}

/** KV time to live in seconds: until the latest until, plus a minute (KV's shortest is 60 s). */
export function openRoomsTtl(list, now = Date.now()) {
  const last = Math.max(0, ...list.map((e) => e.until));
  return Math.max(60, Math.ceil((last - now) / 1000) + 60);
}

const key = (profile) => teacherKvKey(KV_OPEN_ROOMS, profile);

/** The teacher's open rooms (live by `until` only; the rooms themselves are the truth). */
export async function readOpenRooms(env, profile) {
  try {
    return liveOpenRooms(await env.CLASS_KV?.get(key(profile), 'json'));
  } catch (e) {
    console.error(JSON.stringify({ message: 'open rooms read failed', error: String(e) }));
    return [];
  }
}

async function write(env, profile, list) {
  if (!env.CLASS_KV) return;
  if (list.length) await env.CLASS_KV.put(key(profile), JSON.stringify(list), { expirationTtl: openRoomsTtl(list) });
  else await env.CLASS_KV.delete(key(profile));
}

/** Change the teacher's list with `fn(list)`; never throws (a board just will not find the room). */
export async function updateOpenRooms(env, profile, fn) {
  try {
    const before = await readOpenRooms(env, profile);
    const after = fn(before);
    if (JSON.stringify(after) !== JSON.stringify(before)) await write(env, profile, after);
  } catch (e) {
    console.error(JSON.stringify({ message: 'open rooms write failed', error: String(e) }));
  }
}
