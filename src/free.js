// Free teachers' daily caps, per Spotify account (protocol.js FREE TEACHERS). One KV record a
// teacher a day: use:v1:<profile>:<UTC day> = { ai, art, rooms }, gone after FREE_USE_TTL_S.
// Teachers on RoomDJ's own app (not free) are never counted.

import { FREE_AI_PER_DAY, FREE_ART_PER_DAY, FREE_ROOMS_PER_DAY, FREE_USE_TTL_S, freeUseKey, isFreeTeacher } from '../shared/protocol.js';

export const FREE_CAPS = { ai: FREE_AI_PER_DAY, art: FREE_ART_PER_DAY, rooms: FREE_ROOMS_PER_DAY };

/**
 * Use one of `kind` ('ai' | 'art' | 'rooms') for `profile` today. → true (go ahead, counted) or
 * false (today's cap is reached; nothing counted). Not a free teacher: always true.
 */
export async function spendFree(env, profile, kind, now = Date.now()) {
  if (!isFreeTeacher(profile?.id) || !env.CLASS_KV) return true;
  const key = freeUseKey(profile.id, now);
  const use = (await env.CLASS_KV.get(key, 'json')) ?? {};
  if ((use[kind] ?? 0) >= FREE_CAPS[kind]) return false;
  use[kind] = (use[kind] ?? 0) + 1;
  await env.CLASS_KV.put(key, JSON.stringify(use), { expirationTtl: FREE_USE_TTL_S, metadata: use }); // metadata: the admin page
  return true;
}

/**
 * What a teacher has left today (GET /api/teacher/usage). Not a free teacher: { free: false }.
 * → { free: true, caps, used, left, resetsAt } (resetsAt: the next UTC midnight, in ms).
 */
export async function freeUsage(env, profile, now = Date.now()) {
  if (!isFreeTeacher(profile?.id)) return { free: false };
  const used = (env.CLASS_KV && (await env.CLASS_KV.get(freeUseKey(profile.id, now), 'json'))) ?? {};
  const out = { free: true, caps: { ...FREE_CAPS }, used: {}, left: {} };
  for (const k of Object.keys(FREE_CAPS)) {
    out.used[k] = Math.min(used[k] ?? 0, FREE_CAPS[k]);
    out.left[k] = FREE_CAPS[k] - out.used[k];
  }
  const d = new Date(now);
  out.resetsAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return out;
}
