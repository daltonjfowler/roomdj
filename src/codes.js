// Class code → room, in KV: `room:<codeHash>` → { id, until }, kept until the room's `until`
// (KV forgets it by itself then). The code is never stored as text: only its SHA-256 (with this
// app's own prefix), here and in the room. The room checks the hash again on every join
// (constant time), so KV is only the signpost and the room is the truth: a stale KV copy (KV can
// lag up to a minute between data centres) never lets an old or closed code in.
// Codes in use are refused: two teachers (TEACHER_KEY, TEACHER_KEY_2) can each have a room open
// on the same day, with different codes.
// KV can lag between data centres, so the final say is the code's CodeLock (src/codelock.js,
// claimCode/releaseCode below): one Durable Object per code hash, one holder at a time. codeInUse
// stays as the cheap first check (and covers rooms opened before the lock existed).

import { normalizeCode } from '../shared/code.js';

const encoder = new TextEncoder();

/** Hex SHA-256 of the normalized code. */
export async function codeHash(code) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`classqueue code:${normalizeCode(code)}`)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const kvKey = (hash) => `room:${hash}`;

/** { id, until } for this code hash while it points at a room, else null. */
export async function readCodeRoute(env, hash, now = Date.now()) {
  const rec = await env.CLASS_KV?.get(kvKey(hash), 'json');
  return rec && typeof rec.id === 'string' && Number(rec.until) > now ? rec : null;
}

/** True when another open room (not `exceptId`) has this code. Asks that room, not only KV. */
export async function codeInUse(env, hash, exceptId = null) {
  const rec = await readCodeRoute(env, hash);
  if (!rec || rec.id === exceptId) return false;
  try {
    const res = await env.ROOMS.get(env.ROOMS.idFromName(rec.id)).fetch('https://room/info');
    return res.ok;
  } catch {
    return true; // cannot tell: do not hand out a code that may be taken
  }
}

/** A fresh claim counts as taken this long even before its room says it is open (createRoom claims before /init). */
export const CLAIM_GRACE_MS = 30_000;
/** The lock's alarm rings this long after `until`, then forgets the code. */
export const LOCK_ALARM_SLACK_MS = 60_000;

/**
 * The CodeLock rule: may `room` take a code `held` ({ room, until, at } or nothing) at `now`?
 * 'mine' (it holds it already), 'free' (nobody, or the hold ran out), 'taken' (another room, in time
 * and inside its start-up grace), 'ask' (another room, in time: the lock asks that room if it is open).
 */
export function lockDecision(held, room, now) {
  if (!held) return 'free';
  if (held.room === room) return 'mine';
  if (!(held.until > now)) return 'free';
  if (now - held.at < CLAIM_GRACE_MS) return 'taken';
  return 'ask';
}

const codeLock = (env, hash) => (env.CODE_LOCK ? env.CODE_LOCK.get(env.CODE_LOCK.idFromName(hash)) : null);

/**
 * Take (or keep) the code for room `id` until `until`. true: the room holds it. No CODE_LOCK binding
 * (Node tests): true. The lock cannot be reached: false (never hand out a code that may be taken).
 */
export async function claimCode(env, hash, id, until) {
  const lock = codeLock(env, hash);
  if (!lock) return true;
  try {
    return (await lock.claim(id, until)) === true;
  } catch (e) {
    console.error(JSON.stringify({ message: 'code lock claim failed', error: String(e) }));
    return false;
  }
}

/** Let the code go if room `id` holds it. Failure only logs: the lock forgets the code after `until` anyway. */
export async function releaseCode(env, hash, id) {
  try {
    await codeLock(env, hash)?.release(id);
  } catch (e) {
    console.error(JSON.stringify({ message: 'code lock release failed', error: String(e) }));
  }
}

export async function putCodeRoute(env, hash, id, until) {
  // KV's shortest TTL is 60 s; the room refuses joins after `until` by itself anyway.
  const ttl = Math.max(60, Math.ceil((until - Date.now()) / 1000) + 60);
  await env.CLASS_KV.put(kvKey(hash), JSON.stringify({ id, until }), { expirationTtl: ttl });
}

/** Forget the code, only if it still points at room `id` (another room may have it by now). */
export async function deleteCodeRoute(env, hash, id) {
  try {
    const rec = await env.CLASS_KV?.get(kvKey(hash), 'json');
    if (rec?.id === id) await env.CLASS_KV.delete(kvKey(hash));
  } catch (e) {
    console.error(JSON.stringify({ message: 'code route delete failed', error: String(e) }));
  }
}
