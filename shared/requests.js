// The song request log (Dalton, 2026-10-30: "begin saving all student requests ever ... so we can
// make a dope chart later ... of interest over time ... without PII"). Every student suggestion of a
// known song, kept for good in one SQLite Durable Object (REQUEST_LOG, name 'all'): the song (title,
// artist, album, genre, year, length, clean edit), the UTC hour, what happened (queued / review /
// blocked / refused, and why) and, from the room's history at close, its fate (played to the end,
// skipped...) with the room's 👍/👎 for it.
// NEVER kept: nicknames, device ids, the teacher, the room, the class code, the school. The room keeps
// its own list while open (room.askLog, with device ids, deleted with the room) only so one student
// asking for the same song again counts once; finishAsks drops the ids before anything leaves.
// Teacher picks are not student requests: never logged. Best effort: a failed write loses that room.
// The log itself: src/request-log.js. Download: the admin page, GET /api/admin/requests.csv (src/admin.js).

import { banKey } from './filter.js';

/** A room's asks at most (a class period is far below it; the oldest go first). */
export const ASK_LOG_MAX = 1000;
export const ADD_MAX = 2 * ASK_LOG_MAX;
export const PAGE_MAX = 5000;
export const CSV_COLUMNS = ['hour_utc', 'title', 'artist', 'album', 'genre', 'year', 'seconds', 'clean_edit', 'outcome', 'reason', 'category', 'fate', 'up', 'down', 'song_id'];

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/**
 * One student ask, as the room keeps it until close. `outcome`: 'queued' | 'review' | 'blocked' |
 * 'refused'; `reason`: the filter's or the queue rule's reason; `why`: the AI category id; `item`:
 * the queue/review item id (for its fate at close); `device`: only to count repeats (never logged).
 */
export function askEntry(song, outcome, { reason = null, why = null, item = null, device = '', now = Date.now() } = {}) {
  return {
    at: now, d: device, item, outcome, reason: reason ? str(reason, 40) : null, why: why ? str(why, 40) : null,
    song: {
      id: str(song.id, 80), title: str(song.title), artist: str(song.artist), album: str(song.album),
      genre: str(song.genre, 40), year: int(song.year), durationMs: int(song.durationMs), explicit: song.explicit === 'cleaned' ? 'cleaned' : '',
    },
  };
}

/** Add one ask to the room's list (capped). */
export function logAsk(state, entry) {
  state.askLog ??= [];
  state.askLog.push(entry);
  if (state.askLog.length > ASK_LOG_MAX) state.askLog.splice(0, state.askLog.length - ASK_LOG_MAX);
}

// A student asking again for the same song keeps the furthest outcome (and the first time).
const RANK = { refused: 0, blocked: 1, review: 2, queued: 3 };
const FATE = { finished: 'played', skipped: 'skipped', failed: 'failed', playing: 'playing' };

/**
 * The room closes: its asks as log rows, one per student and song, the fate from the history
 * ('played', 'skipped', 'failed', 'playing'; 'not played' for a queued or review song that never
 * started; '' for a refused or blocked one). No device id, nickname, teacher or room in a row.
 */
export function finishAsks(log = [], history = []) {
  const best = new Map();
  for (const e of log) {
    if (!e?.song?.title) continue;
    const k = `${e.d}|${banKey(e.song)}`;
    const was = best.get(k);
    if (!was) best.set(k, e);
    else if ((RANK[e.outcome] ?? 0) >= (RANK[was.outcome] ?? 0)) best.set(k, { ...e, at: was.at });
  }
  return [...best.values()].map((e) => {
    const h = e.item ? history.findLast((x) => x.id === e.item) : null;
    const fate = h ? (FATE[h.status] ?? h.status) : e.outcome === 'queued' || e.outcome === 'review' ? 'not played' : '';
    return {
      hour: new Date(e.at).toISOString().slice(0, 13),
      song: e.song.id, title: e.song.title, artist: e.song.artist, album: e.song.album, genre: e.song.genre,
      year: e.song.year, seconds: Math.round(e.song.durationMs / 1000), clean: e.song.explicit === 'cleaned' ? 1 : 0,
      outcome: e.outcome, reason: e.reason ?? '', why: e.why ?? '', fate, up: h ? int(h.up) : 0, down: h ? int(h.down) : 0,
    };
  });
}

/** A spreadsheet cell: quoted, and never a formula (=, +, -, @ at the start). */
function cell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Log rows as CSV lines (no header). */
export function csvLines(rows) {
  return rows.map((r) => [
    `${r.hour}:00Z`, r.title, r.artist, r.album, r.genre, r.year || '', r.seconds || '', r.clean ? 'yes' : '',
    r.outcome, r.reason, r.why, r.fate, r.up, r.down, r.song,
  ].map(cell).join(',')).join('\n');
}

/** The one log ('all'), or null when the binding is missing (tests, an old dev setup). */
export function requestLog(env) {
  return env?.REQUEST_LOG ? env.REQUEST_LOG.get(env.REQUEST_LOG.idFromName('all')) : null;
}
