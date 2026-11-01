// ✓ Checked songs across RoomDJ, for the admin page (Dalton, 2026-11-01: "how many checked and
// approved songs do we have total"). The verdicts kept once per song (verdict:v<PROMPT_VERSION>:song:…)
// are too many to read on every admin visit, so the 15-minute cron walks them a slice at a time and
// keeps the last full count in KV CHECKED_KEY:
//   { version, cursor, skip, run: { ready, waiting, blocked, seen }, last: { ...run, at } | null }
// ready: OK to play by the same rule as search's ✓ Checked (readyToPlay); waiting: the AI said ok
// but the lyrics check has not confirmed it yet; blocked: not appropriate; seen: every song checked.
// KV only, never the AI. A new PROMPT_VERSION starts over.

import { PROMPT_VERSION, readVerdict, readyToPlay } from '../shared/filter.js';

export const CHECKED_KEY = 'stats:v1:checked';
const READS_PER_RUN = 200; // the cron's other work shares the invocation's KV operations
const PAGE = 1000;
const EMPTY = () => ({ ready: 0, waiting: 0, blocked: 0, seen: 0 });
const songKeyOf = (name, prefix) => (name.startsWith(`${prefix}song:`) ? name.slice(prefix.length + 'song:'.length) : null);

/** One slice of the count. Returns the saved state. */
export async function countChecked(env, { now = Date.now(), reads = READS_PER_RUN } = {}) {
  if (!env.CLASS_KV) return null;
  const prefix = `verdict:v${PROMPT_VERSION}:`;
  const kept = await env.CLASS_KV.get(CHECKED_KEY, 'json').catch(() => null);
  const same = kept?.version === PROMPT_VERSION;
  const state = {
    version: PROMPT_VERSION,
    cursor: same ? kept.cursor ?? null : null,
    skip: same ? Number(kept.skip) || 0 : 0,
    run: { ...EMPTY(), ...(same && kept.run ? kept.run : {}) },
    last: same ? kept.last ?? null : null,
  };
  const page = await env.CLASS_KV.list({ prefix: `${prefix}song:`, limit: PAGE, ...(state.cursor ? { cursor: state.cursor } : {}) });
  const names = page.keys.map((k) => k.name);
  const slice = names.slice(state.skip, state.skip + reads);
  const values = await Promise.all(slice.map((name) => env.CLASS_KV.get(name, 'json').catch(() => null)));
  slice.forEach((name, i) => {
    const v = readVerdict(values[i]);
    if (!v) return;
    const [title = '', artist = ''] = (songKeyOf(name, prefix) ?? '').split('|');
    state.run.seen++;
    if (readyToPlay({ title, artist, album: '' }, v)) state.run.ready++;
    else if (v.verdict === 'ok') state.run.waiting++;
    else if (v.verdict === 'inappropriate') state.run.blocked++;
  });
  if (state.skip + slice.length < names.length) state.skip += slice.length;
  else if (page.list_complete) {
    state.last = { ...state.run, at: now };
    state.run = EMPTY();
    state.cursor = null;
    state.skip = 0;
  } else {
    state.cursor = page.cursor;
    state.skip = 0;
  }
  await env.CLASS_KV.put(CHECKED_KEY, JSON.stringify(state));
  return state;
}

/** What the admin page shows: the last full count, or the count so far while the first runs. */
export async function readChecked(env) {
  const s = await env.CLASS_KV?.get(CHECKED_KEY, 'json').catch(() => null);
  if (!s || s.version !== PROMPT_VERSION) return null;
  return s.last ? { ...EMPTY(), ...s.last } : { ...EMPTY(), ...s.run, counting: true };
}
