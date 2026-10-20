// Who's teaching on this computer (protocol.js TEACHER PROFILES): the last-picked teacher profile
// (localStorage cq.profile: { id, name }), and this computer's preferences kept per profile.
// Background music (cq.filler), display (cq.display), keys (cq.keys), Music from (cq.music) and the
// screen layouts (cq.layout:normal, cq.layout:big; layout.js) are
// stored as `<key>:<profile id>`. The first profile picked on a computer takes over the values
// saved before profiles (moved once; cq.profilePrefs remembers it was done). Spotify and Apple
// logins stay per computer. Switching to another teacher reloads the page (only between rooms),
// so every part of the page reads that teacher's preferences.

import { PROFILE_ID_PATTERN } from '../../shared/protocol.js';

const CURRENT = 'cq.profile';
const MOVED = 'cq.profilePrefs';
export const PROFILE_PREFS = ['cq.filler', 'cq.display', 'cq.keys', 'cq.music', 'cq.layout:normal', 'cq.layout:big'];

function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key, v) { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); } catch { /* blocked */ } }

/** The teacher picked on this computer: { id, name }, or null. */
export function currentProfile() {
  try {
    const v = JSON.parse(read(CURRENT));
    return v && PROFILE_ID_PATTERN.test(v.id ?? '') && typeof v.name === 'string' ? { id: v.id, name: v.name } : null;
  } catch {
    return null;
  }
}

// The profile whose preferences this page uses: the one it was loaded with, or the first one
// picked on a page loaded before any (its preferences are the ones in memory then).
let active = currentProfile()?.id ?? null;

/** The localStorage key of a per-teacher preference (the plain key before any teacher is picked). */
export function prefKey(base) {
  return active ? `${base}:${active}` : base;
}

/**
 * Remember the teacher on this computer. The first teacher ever picked here takes over the
 * preferences saved before profiles. Returns true when the page must reload to use this teacher's
 * preferences (another teacher than the one the page was loaded with).
 */
export function chooseProfile(profile) {
  write(CURRENT, JSON.stringify({ id: profile.id, name: profile.name }));
  if (!read(MOVED)) {
    for (const base of PROFILE_PREFS) {
      const old = read(base);
      if (old !== null && read(`${base}:${profile.id}`) === null) write(`${base}:${profile.id}`, old);
      write(base, null);
    }
    write(MOVED, profile.id);
  }
  // Loaded before any teacher was picked: the values just moved are the ones in memory already.
  if (active === null) active = profile.id;
  return active !== profile.id;
}

/** Forget the picked teacher (it was hidden, or is not on the list any more). */
export function forgetProfile() {
  write(CURRENT, null);
}
