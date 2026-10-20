// Teacher profiles (Dalton, 2026-10-07; protocol.js TEACHER PROFILES): the list in KV `profiles`,
// its checks and changes. Pure JS, no DOM and no KV: the Worker (src/profiles.js), the host page
// and the Node tests use it. Every change returns a NEW list; nothing is ever deleted (Hide keeps
// a profile and all of its data).

import { PROFILES_MAX, PROFILE_ID_PATTERN, PROFILE_NAME_MAX, SEED_PROFILES } from './protocol.js';
import { wordsAllowed } from './nick.js';

/**
 * A teacher's display name: one line, at most PROFILE_NAME_MAX letters, with a letter in it, and
 * passing the same word screen as teacher notes (students may see it: "Ms Rivera's class").
 * @returns {{ ok: true, name: string } | { ok: false, message: string }}
 */
export function cleanProfileName(raw) {
  const name = String(raw ?? '').normalize('NFKC').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, message: 'Type the teacher\'s name.' };
  if ([...name].length > PROFILE_NAME_MAX) return { ok: false, message: `A name can be up to ${PROFILE_NAME_MAX} letters.` };
  if (!/\p{L}/u.test(name)) return { ok: false, message: 'A name needs at least one letter.' };
  if (!wordsAllowed(name)) return { ok: false, message: 'Students may see this name. Try other words.' };
  return { ok: true, name };
}

/** Case and spacing do not make two names different ("ms  rivera" = "Ms Rivera"). */
const sameName = (a, b) => a.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ') === b.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');

/** One stored profile, checked (null when it is not one). */
function readProfile(p) {
  if (!p || typeof p !== 'object' || !PROFILE_ID_PATTERN.test(p.id ?? '')) return null;
  const name = typeof p.name === 'string' ? p.name.slice(0, PROFILE_NAME_MAX * 2) : '';
  if (!name) return null;
  const out = { id: p.id, name, createdAt: Number.isSafeInteger(p.createdAt) ? p.createdAt : 0 };
  if (p.legacy === true) out.legacy = true;
  if (p.archived === true) out.archived = true;
  if (p.claimed === true) out.claimed = true; // a Spotify sign-in owns it (protocol.js SPOTIFY SIGN-IN)
  return out;
}

/** The stored list (KV value), checked: bad entries and repeated ids dropped, at most one legacy. */
export function readProfiles(value) {
  const out = [];
  const seen = new Set();
  let legacy = false;
  for (const raw of Array.isArray(value) ? value : []) {
    const p = readProfile(raw);
    if (!p || seen.has(p.id)) continue;
    if (p.legacy) {
      if (legacy) delete p.legacy;
      legacy = true;
    }
    seen.add(p.id);
    out.push(p);
  }
  return out.slice(0, PROFILES_MAX);
}

/** The first list (migration): "Teacher 1" (legacy) owns the data from before profiles; "Teacher 2" starts fresh. Never used when a list exists. */
export function seedProfiles(now = Date.now()) {
  return SEED_PROFILES.map((p) => ({ ...p, createdAt: now }));
}

/**
 * The migration step: the stored value if it is a list already (running it again changes
 * nothing), else the seed list. `created` says whether it has to be written.
 */
export function migrateProfiles(stored, now = Date.now()) {
  if (Array.isArray(stored)) return { list: readProfiles(stored), created: false };
  return { list: readProfiles(seedProfiles(now)), created: true };
}

/** A profile in the list by id, or null. `active`: hidden ones do not count. */
export function findProfile(list, id, { active = false } = {}) {
  if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) return null;
  const p = (list ?? []).find((x) => x.id === id) ?? null;
  return p && active && p.archived ? null : p;
}

/** A new random id (8 letters and digits; 36^8 makes a clash practically impossible, and it is checked). */
export function newProfileId(list = [], random = () => crypto.getRandomValues(new Uint8Array(8))) {
  for (;;) {
    const id = [...random()].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    if (!list.some((p) => p.id === id)) return id;
  }
}

/**
 * Add a teacher. @returns {{ ok: true, list, profile } | { ok: false, error: 'name'|'name_taken'|'full', message }}
 */
export function addProfile(list, rawName, { now = Date.now(), id = newProfileId(list) } = {}) {
  const v = cleanProfileName(rawName);
  if (!v.ok) return { ok: false, error: 'name', message: v.message };
  if (list.length >= PROFILES_MAX) return { ok: false, error: 'full', message: `RoomDJ keeps up to ${PROFILES_MAX} teachers (hidden ones count). Show and rename a hidden one instead.` };
  if (list.some((p) => sameName(p.name, v.name))) return { ok: false, error: 'name_taken', message: 'There is a teacher with that name already (look under Hidden teachers too).' };
  const profile = { id, name: v.name, createdAt: now };
  return { ok: true, list: [...list, profile], profile };
}

/**
 * Rename and/or hide / show one teacher. Hiding the last teacher who is not hidden is refused.
 * @returns {{ ok: true, list, profile } | { ok: false, error: 'no_profile'|'name'|'name_taken'|'last', message }}
 */
export function changeProfile(list, id, { name, archived } = {}) {
  const old = findProfile(list, id);
  if (!old) return { ok: false, error: 'no_profile', message: 'That teacher is not on the list any more. Reload the page.' };
  const next = { ...old };
  if (name !== undefined) {
    const v = cleanProfileName(name);
    if (!v.ok) return { ok: false, error: 'name', message: v.message };
    if (list.some((p) => p.id !== id && sameName(p.name, v.name))) return { ok: false, error: 'name_taken', message: 'There is a teacher with that name already (look under Hidden teachers too).' };
    next.name = v.name;
  }
  if (archived === true) {
    if (!list.some((p) => p.id !== id && !p.archived)) return { ok: false, error: 'last', message: 'Keep at least one teacher on the list.' };
    next.archived = true;
  } else if (archived === false) {
    delete next.archived;
  }
  return { ok: true, list: list.map((p) => (p.id === id ? next : p)), profile: next };
}

/** What a room keeps of its profile: { id, name, legacy }. */
export function roomProfile(p) {
  return { id: p.id, name: p.name, legacy: p.legacy === true };
}
