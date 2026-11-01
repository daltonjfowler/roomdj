// Each teacher's running tally, for the admin page (Dalton, 2026-11-01: "show more info on users"):
// counts only, added when a room closes (Room.closeRoom). KV act:v1:<profile id>, the value also its
// metadata, so the admin page reads every teacher's with one list call. Never a song, a student, a
// nickname or a device: only how many. Started 2026-11-01; rooms before that are not in it.
//   { rooms, plays, asks, students, lastAt }

import { PROFILE_ID_PATTERN } from '../shared/protocol.js';

export const ACTIVITY_PREFIX = 'act:v1:';
const int = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** A closing room's counts: songs played to the end, students' requests (one per student and song), students who joined. */
export function roomTally(room, asks = 0) {
  return {
    plays: (room?.history ?? []).filter((h) => h.status === 'finished').length,
    asks: int(asks),
    students: Array.isArray(room?.admitted) ? room.admitted.length : 0,
  };
}

/** Add one closed room to its teacher's tally. → the new tally, or null (no KV, no id). */
export async function addActivity(env, profileId, tally, now = Date.now()) {
  if (!env.CLASS_KV || !PROFILE_ID_PATTERN.test(profileId ?? '')) return null;
  const key = `${ACTIVITY_PREFIX}${profileId}`;
  const was = (await env.CLASS_KV.get(key, 'json').catch(() => null)) ?? {};
  const next = {
    rooms: int(was.rooms) + 1,
    plays: int(was.plays) + int(tally.plays),
    asks: int(was.asks) + int(tally.asks),
    students: int(was.students) + int(tally.students),
    lastAt: now,
  };
  await env.CLASS_KV.put(key, JSON.stringify(next), { metadata: next });
  return next;
}
