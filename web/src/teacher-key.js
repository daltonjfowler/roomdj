// The teacher key on this computer, for the host page and the board's sign-in (CLAUDE.md
// invariant 6): sessionStorage cq.teacherKey for this tab, and localStorage too only when
// "Remember on this computer" is ticked (then both pages on this computer find it). Never in a URL.

const KEY = 'cq.teacherKey';

function sessionGet() { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; } }

/** The key this computer remembers (ticked "Remember"), or null. */
export function rememberedKey() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

/** The key for this tab: this tab's own, else the remembered one. */
export function teacherKey() {
  return sessionGet() || rememberedKey();
}

/** Keep the key for this tab; on this computer only when `remember`. */
export function saveTeacherKey(key, remember) {
  try { sessionStorage.setItem(KEY, JSON.stringify(key)); } catch { /* blocked */ }
  try {
    if (remember) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch { /* blocked */ }
}

/** Forget the key in this tab and on this computer. */
export function forgetTeacherKey() {
  try { sessionStorage.removeItem(KEY); } catch { /* blocked */ }
  try { localStorage.removeItem(KEY); } catch { /* blocked */ }
}

/**
 * The teacher list with `key` (GET /api/teacher/profiles; it also checks the key).
 * → { ok, status, data } (status 0: could not reach the server).
 */
export async function fetchProfiles(key) {
  try {
    const r = await fetch('/api/teacher/profiles', { headers: { 'x-teacher-key': key ?? '' } });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}
