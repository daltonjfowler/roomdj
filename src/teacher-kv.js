// Teacher-level KV keys, per teacher profile (protocol.js TEACHER PROFILES). Every teacher-level
// record goes through teacherKvKey: settings (src/worker.js), banned (src/search.js, src/room.js),
// approved:* (shared/filter.js through the room's scope), favorites (src/room.js), asks (🔥 students'
// requests, src/popular.js), openRooms (the board's sign-in, src/open-rooms.js).
// The legacy profile (`legacy: true`, whatever its id: the data from before profiles) and a room saved before
// profiles (profile null) use the plain name, so nothing had to be copied or rewritten.
// Every other profile: `p:<profileId>:<name>`.

import { PROFILE_ID_PATTERN } from '../shared/protocol.js';

export { PROFILE_ID_PATTERN };

/**
 * The KV key for a teacher-level record. `profile`: null/undefined (a room from before profiles)
 * or a legacy profile object → `name`; a profile object or a profile id → `p:<id>:<name>`.
 * A profile id that is not valid is refused (never a key built from bad input).
 */
export function teacherKvKey(name, profile = null) {
  if (profile === null || profile === undefined) return name;
  if (typeof profile === 'object') {
    if (profile.legacy === true) return name;
    profile = profile.id;
  }
  if (typeof profile !== 'string' || !PROFILE_ID_PATTERN.test(profile)) throw new Error('bad profile id');
  return `p:${profile}:${name}`;
}

/** A function that scopes KV names to one profile (shared/filter.js takes one for approvals). */
export function teacherScope(profile = null) {
  return (name) => teacherKvKey(name, profile);
}
