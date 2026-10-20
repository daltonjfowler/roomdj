// Class code → room, in KV: `room:<codeHash>` → { id, until }, kept until the room's `until`
// (KV forgets it by itself then). The code is never stored as text: only its SHA-256 (with this
// app's own prefix), here and in the room. The room checks the hash again on every join
// (constant time), so KV is only the signpost and the room is the truth: a stale KV copy (KV can
// lag up to a minute between data centres) never lets an old or closed code in.
// Codes in use are refused: two teachers (TEACHER_KEY, TEACHER_KEY_2) can each have a room open
// on the same day, with different codes.

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
