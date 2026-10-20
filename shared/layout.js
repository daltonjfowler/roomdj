// ✏️ Edit layout (web/src/layout.js): the teacher arranges the room screen. Pure: no DOM, so Node
// tests run it. One layout per view: 'normal' (the host page), 'big' (the host's big screen) and
// 'board' (the projector board). Stored per computer (and per teacher on the host: profile.js prefKey)
// as `cq.layout:<view>`; anything broken or unknown is repaired or dropped, never trusted.
//
// The screen has three COLUMNS (join, now, queue), side by side on a wide screen. A column can move
// (swap places with another) and be made wider or narrower (its share of the width). PANELS are
// what the text size (`scale`) and Hide work on; some live inside a column (Top 5 and the cleanup
// banner inside Now playing, Needs a look above Up next).

export const LAYOUT_VERSION = 1;
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2.5;
export const SCALE_STEP = 0.1;
/** A column's share of the width (the three shares add up to 1). */
export const SHARE_MIN = 0.15;
export const SHARE_MAX = 0.6;
/** No column gets narrower than this on screen, whatever its share. */
export const COLUMN_MIN_PX = 200;

export const COLUMNS = Object.freeze(['join', 'now', 'queue']);

/** Panel ids → the name a teacher reads ("Move Now playing", "Make Up next text bigger"). */
export const PANEL_NAMES = Object.freeze({
  join: 'Join at',
  now: 'Now playing',
  queue: 'Up next',
  review: 'Needs a look',
  top5: 'Top 5',
  cleanup: 'Cleanup',
});

/** The panels whose all being hidden empties a column (Top 5 and cleanup sit inside Now playing). */
const COLUMN_PANELS = Object.freeze({ join: ['join'], now: ['now'], queue: ['review', 'queue'] });

const BIG_TRACKS = Object.freeze({ join: 'minmax(280px, 26vw)', now: 'minmax(0, 1fr)', queue: 'minmax(0, 1.1fr)' });

/**
 * Each view: its panels, the ones that can never be hidden there (the teacher's own screen keeps
 * Start music, Skip, the cleanup buttons and Needs a look), and each column's usual width (host.css).
 */
export const VIEWS = Object.freeze({
  normal: {
    panels: ['join', 'now', 'cleanup', 'top5', 'review', 'queue'],
    locked: ['now', 'cleanup', 'review'],
    tracks: { join: 'minmax(230px, 300px)', now: 'minmax(0, 1.15fr)', queue: 'minmax(0, 1fr)' },
  },
  big: { panels: ['join', 'now', 'cleanup', 'top5', 'queue'], locked: [], tracks: BIG_TRACKS },
  board: { panels: ['join', 'now', 'cleanup', 'top5', 'queue'], locked: [], tracks: BIG_TRACKS },
});

const viewOf = (view) => VIEWS[view] ?? VIEWS.normal;
const round2 = (n) => Math.round(n * 100) / 100;

/** A column's panels in this view. */
export const panelsOfColumn = (view, col) => COLUMN_PANELS[col].filter((p) => viewOf(view).panels.includes(p));

/** The column a panel moves with ('join' | 'now' | 'queue'); Top 5 and cleanup → 'now'. */
export function columnOf(panel) {
  return COLUMNS.find((c) => COLUMN_PANELS[c].includes(panel)) ?? (panel === 'top5' || panel === 'cleanup' ? 'now' : null);
}

/** The panel that carries a column's move handle (join, now, queue). */
export const isColumnPanel = (panel) => COLUMNS.includes(panel);

export const canHide = (view, panel) => viewOf(view).panels.includes(panel) && !viewOf(view).locked.includes(panel);

export function defaultLayout() {
  return { v: LAYOUT_VERSION, order: [...COLUMNS], widths: null, scale: {}, hidden: [] };
}

/** A scale in range, to two decimals (1 for anything that is not a number). */
export function clampScale(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return 1;
  return round2(Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)));
}

/** Shares that add up to 1, each between SHARE_MIN and SHARE_MAX (null: not three good numbers). */
export function cleanWidths(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const raw = COLUMNS.map((c) => Number(w[c]));
  if (raw.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  let shares = raw.map((n) => n / raw.reduce((a, b) => a + b, 0));
  // Clamp, then hand what was cut (or added) to the columns still inside the range; a few rounds settle it.
  for (let i = 0; i < 5; i++) {
    const clamped = shares.map((s) => Math.min(SHARE_MAX, Math.max(SHARE_MIN, s)));
    const diff = 1 - clamped.reduce((a, b) => a + b, 0);
    const free = clamped.map((s) => (diff > 0 ? s < SHARE_MAX : s > SHARE_MIN));
    const room = clamped.reduce((a, s, j) => a + (free[j] ? s : 0), 0);
    shares = clamped.map((s, j) => (free[j] && room ? s + (diff * s) / room : s));
    if (Math.abs(diff) < 1e-6) break;
  }
  return Object.fromEntries(COLUMNS.map((c, i) => [c, Math.round(shares[i] * 1000) / 1000]));
}

/**
 * A stored layout (JSON text or an object) for `view`, checked: another version or anything that is
 * not an object → the default; a bad order → the usual order; bad widths → none; scales clamped and
 * only for this view's panels; hidden only for panels this view may hide, never every column.
 */
export function repairLayout(raw, view) {
  let v = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { v = null; }
  }
  const out = defaultLayout();
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.v !== LAYOUT_VERSION) return out;
  const panels = viewOf(view).panels;
  if (Array.isArray(v.order) && v.order.length === COLUMNS.length && COLUMNS.every((c) => v.order.includes(c))) out.order = [...v.order];
  out.widths = cleanWidths(v.widths);
  if (v.scale && typeof v.scale === 'object' && !Array.isArray(v.scale)) {
    for (const p of panels) {
      if (v.scale[p] === undefined) continue;
      const s = clampScale(v.scale[p]);
      if (s !== 1) out.scale[p] = s;
    }
  }
  if (Array.isArray(v.hidden)) {
    for (const p of v.hidden) {
      if (typeof p === 'string' && canHide(view, p) && !out.hidden.includes(p)) out.hidden.push(p);
    }
    if (!visibleColumns(out, view).length) out.hidden = [];
  }
  return out;
}

/** The layout as storage text ('' = the default: nothing to keep). */
export function saveLayout(layout) {
  const d = defaultLayout();
  const same = layout.order.join() === d.order.join() && !layout.widths && !Object.keys(layout.scale).length && !layout.hidden.length;
  return same ? '' : JSON.stringify(layout);
}

export const scaleOf = (layout, panel) => layout.scale[panel] ?? 1;

export function setScale(layout, panel, s) {
  const scale = { ...layout.scale };
  const n = clampScale(s);
  if (n === 1) delete scale[panel];
  else scale[panel] = n;
  return { ...layout, scale };
}

/** One step bigger (dir 1) or smaller (dir -1). */
export const bumpScale = (layout, panel, dir) => setScale(layout, panel, round2(scaleOf(layout, panel) + dir * SCALE_STEP));

export const isHidden = (layout, panel) => layout.hidden.includes(panel);

/** Is a column on screen (one of its panels in this view is not hidden)? */
export const columnShown = (layout, view, col) => panelsOfColumn(view, col).some((p) => !layout.hidden.includes(p));

/** The columns on screen, left to right. */
export const visibleColumns = (layout, view) => layout.order.filter((c) => columnShown(layout, view, c));

/** Hide a panel. Refused (the same layout back) for a locked panel, or the last column on screen. */
export function hidePanel(layout, view, panel) {
  if (!canHide(view, panel) || layout.hidden.includes(panel)) return layout;
  const next = { ...layout, hidden: [...layout.hidden, panel] };
  return visibleColumns(next, view).length ? next : layout;
}

export const showPanel = (layout, panel) => ({ ...layout, hidden: layout.hidden.filter((p) => p !== panel) });

/** ↺ on one panel: its usual text size, and shown. */
export function resetPanel(layout, panel) {
  return showPanel(setScale(layout, panel, 1), panel);
}

/** Swap two columns' places. */
export function swapColumns(layout, a, b) {
  const i = layout.order.indexOf(a);
  const j = layout.order.indexOf(b);
  if (i < 0 || j < 0 || i === j) return layout;
  const order = [...layout.order];
  [order[i], order[j]] = [order[j], order[i]];
  return { ...layout, order };
}

/** Move a column one place left (-1) or right (1) among the columns on screen. */
export function moveColumn(layout, view, col, dir) {
  const shown = visibleColumns(layout, view);
  const i = shown.indexOf(col);
  const other = shown[i + dir];
  return i < 0 || !other ? layout : swapColumns(layout, col, other);
}

/**
 * Drag the edge between columns `left` and `right` by `dx` pixels. px: each column's width on
 * screen now ({ join, now, queue }; a hidden column 0 or missing). Neither gets narrower than
 * COLUMN_MIN_PX nor wider than SHARE_MAX of the columns on screen. The new widths are shares.
 */
export function resizeColumns(layout, view, px, left, right, dx) {
  const shown = visibleColumns(layout, view);
  if (!shown.includes(left) || !shown.includes(right)) return layout;
  const total = shown.reduce((a, c) => a + (Number(px[c]) || 0), 0);
  const l = Number(px[left]) || 0;
  const r = Number(px[right]) || 0;
  if (total <= 0 || l + r <= 0) return layout;
  const min = Math.max(COLUMN_MIN_PX, total * SHARE_MIN);
  const max = Math.max(min, total * SHARE_MAX);
  const lo = Math.max(min, l + r - max);
  const hi = Math.min(max, l + r - min);
  const newL = lo > hi ? l : Math.min(hi, Math.max(lo, l + dx));
  const now = { ...px, [left]: newL, [right]: l + r - newL };
  // Hidden columns keep their share for when they come back (else an even third).
  const old = layout.widths;
  const sumShown = shown.reduce((a, c) => a + now[c], 0);
  const hiddenShare = COLUMNS.filter((c) => !shown.includes(c)).reduce((a, c) => a + (old?.[c] ?? 1 / 3), 0);
  const widths = {};
  for (const c of COLUMNS) {
    widths[c] = shown.includes(c) ? (now[c] / sumShown) * (1 - hiddenShare) : (old?.[c] ?? 1 / 3);
  }
  return { ...layout, widths: cleanWidths(widths) ?? layout.widths };
}

/** A column's share of the width on screen, in percent (the separator's value for screen readers). */
export function sharePercent(layout, view, px, col) {
  const shown = visibleColumns(layout, view);
  const total = shown.reduce((a, c) => a + (Number(px[c]) || 0), 0);
  return total > 0 ? Math.round(((Number(px[col]) || 0) / total) * 100) : 0;
}

/**
 * The grid for the stage (host.css: --cols and --areas), or null for the usual one (the CSS
 * default, which also keeps the narrow-screen layouts).
 */
export function gridFor(layout, view) {
  const shown = visibleColumns(layout, view);
  const usual = shown.length === COLUMNS.length && layout.order.join() === COLUMNS.join() && !layout.widths;
  if (usual) return null;
  const tracks = shown.map((c) => (layout.widths
    ? `minmax(${COLUMN_MIN_PX}px, ${layout.widths[c]}fr)`
    : viewOf(view).tracks[c]));
  return {
    cols: tracks.join(' '),
    areas: `"${shown.map(() => 'warn').join(' ')}" "${shown.join(' ')}"`,
  };
}
