// ⛔ Other teachers' bans on the host page (protocol.js SHARED BANS): a hint only. The list comes from
// GET /api/teacher/bans/shared (songs banned by 2+ OTHER teachers, counts only) and is kept for a few minutes;
// rows that show a song call sharedBanTag(song) for "⛔ Banned by N other teachers".

import { banKey } from '../../shared/filter.js';
import { esc } from './dom.js';

const REFRESH_MS = 5 * 60_000;
let byKey = new Map(); // banKey → { others, mine }
let list = [];
let loadedAt = 0;
let loading = null;
let onChange = () => {};

/** The rows to redraw when the list arrives. */
export function onSharedBans(fn) {
  onChange = fn;
}

/** Load (or refresh) the list. `headers`: the teacher's session or key headers. Never throws. */
export async function loadSharedBans(headers, { force = false } = {}) {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return list;
  loading ??= (async () => {
    try {
      const r = await fetch('/api/teacher/bans/shared', { headers });
      if (r.ok) {
        list = (await r.json()).songs ?? [];
        byKey = new Map(list.map((s) => [s.key, s]));
        loadedAt = Date.now();
        onChange();
      }
    } catch { /* offline: no hints */ }
    loading = null;
    return list;
  })();
  return loading;
}

/** This song was banned by other teachers: the small tag for a row, else ''. Not shown once it is on my own list. */
export function sharedBanTag(song) {
  const hit = byKey.get(banKey(song) ?? '');
  if (!hit || hit.mine) return '';
  return `<span class="shared-ban" title="Other teachers banned this song (counts only, never who). Nothing is blocked unless you ban it.">⛔ Banned by ${esc(String(hit.others))} other teachers</span>`;
}

/** After ⛔ Ban for me: it is mine now (no tag). */
export function markMine(key) {
  const hit = byKey.get(key);
  if (hit) hit.mine = true;
  onChange();
}
