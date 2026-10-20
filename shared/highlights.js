// Top 5 of the period, the end-of-class recap and the teacher's ⭐ Class favorites (protocol.js
// TOP 5 + RECAP and FAVORITES). Pure functions: the Room keeps the history in its state and the
// favorites in KV; the pages and the Node tests use the same rules.
//
// HistoryEntry (RoomState.history, deleted with the room): { id (queue item id), song, device, by,
//   up, down, score (its votes: kept up to date while it plays, so its final votes once it ends),
//   at, status: 'playing'|'finished'|'skipped'|'failed', fav?: true (its net votes already went to
//   the favorites) }
//   `score` is always the RAW 👍 − 👎; with the score floor on (protocol.js SCORE FLOOR) the Top 5 and
//   the recap show and rank max(0, score) (`shownScore`), so turning the floor on or off mid-room
//   changes every view at once. Favorites need a net of FAVORITE_MIN_NET (> 0): raw = floored there.
//   DOWNVOTE MODE (protocol.js): while 👎 is 'off' the views count 👍 only (`down` kept, ignored);
//   unless it is 'shown', the class's views (students, boards, the recap) never show 👎 numbers.
//   GHOST VOTE (protocol.js): `ghost: 1` = the song had a ghost 👍 when it started playing. up/down/
//   score stay the REAL votes (favorites, Crowd favorite use them); the Top 5 and the recap's songs,
//   totals and song stats show and rank it as one more 👍 (`withGhost`), like the queue did.

import {
  DOWNVOTE_MODES, FAVORITES_MAX, FAVORITES_STUDENT, FAVORITE_HALF_LIFE_DAYS, HISTORY_MAX, TOP5_SIZE, TOP5_WEIGHT,
} from './protocol.js';
import { quickCheck } from './filter.js';
import { TEACHER_DEVICE, byLabel } from './protocol.js';
import { songId } from './catalog.js';
import { statPool } from './stats.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** What a kicked student's songs say in the Top 5 and the recap. */
export const CLASSMATE = 'a classmate';

// ---- History (one room = one class period) --------------------------------------------------------

/** A song starts playing: it goes into the history with its votes as they are now. */
export function startPlay(state, item, { up, down, score }, now = Date.now()) {
  state.history ??= [];
  state.history.push({
    id: item.id, song: item.song, device: item.device ?? null, by: item.by, up, down, score, at: now, status: 'playing',
    ...(item.teacher === true ? { teacher: true } : {}), // a teacher pick (protocol.js TEACHER PICKS)
    ...(item.ghost === 1 ? { ghost: 1 } : {}), // its ghost 👍 (protocol.js GHOST VOTE)
  });
  if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
}

/** A vote on the song playing (or a kick): its history entry gets the new numbers while it plays. */
export function updatePlay(state, id, { up, down, score }) {
  const e = (state.history ?? []).findLast((x) => x.id === id);
  if (!e || e.status !== 'playing') return null;
  Object.assign(e, { up, down, score });
  return e;
}

/**
 * The song `id` stopped playing: 'finished' | 'skipped' | 'failed', or 'banned' (it leaves the
 * history). Returns its entry (null when banned or not found).
 */
export function endPlay(state, id, how) {
  const list = state.history ?? [];
  const i = list.findLastIndex((e) => e.id === id);
  if (i < 0) return null;
  if (how === 'banned') {
    list.splice(i, 1);
    return null;
  }
  if (list[i].status === 'playing') list[i].status = how;
  return list[i];
}

/** A renamed or kicked student's played songs: a new nickname (or "a classmate", with no device). */
export function relabelHistory(state, device, nick, { forget = false } = {}) {
  for (const e of state.history ?? []) {
    if (e.device !== device) continue;
    e.by = nick;
    if (forget) e.device = null;
  }
}

const shortSong = (song) => ({ id: song.id, title: song.title, artist: song.artist, artwork: song.artwork ?? '' });
const teacherTag = (e) => (e.teacher === true ? { teacher: true } : {});

/** A room's 👎 mode (protocol.js DOWNVOTE MODE) from its settings; anything unknown reads 'shown' (as before). */
export function downvoteModeOf(settings) {
  return DOWNVOTE_MODES.includes(settings?.downvoteMode) ? settings.downvoteMode : 'shown';
}

/** A history entry's net votes: 👍 − 👎, or 👍 alone while 👎 is off (`downs` false: DOWNVOTE MODE). */
export function netOf(e, downs = true) {
  return downs ? e.score : e.up;
}

/**
 * A history entry's score as the pages rank it: max(0, net) while the score floor is on (SCORE FLOOR);
 * the net counts 👍 only while 👎 is off (`downs` false: DOWNVOTE MODE).
 */
export function shownScore(e, floor = false, downs = true) {
  const net = netOf(e, downs);
  return floor ? Math.max(0, net) : net;
}

/**
 * Highest net score first; ties → more 👍, then the one that played first. Score floor on (or 👎
 * off): the floored score, ties → fewer 👎 (none count while off), then more 👍, then the one that
 * played first (as the queue).
 */
function byRank(floor, downs = true) {
  if (!floor && downs) return (a, b) => b.score - a.score || b.up - a.up || a.at - b.at;
  const d = (e) => (downs ? e.down : 0);
  return (a, b) => shownScore(b, floor, downs) - shownScore(a, floor, downs) || d(a) - d(b) || b.up - a.up || a.at - b.at;
}

/**
 * A history entry as the class saw it (protocol.js GHOST VOTE): its ghost 👍 added to up and score.
 * Never for favorites or Crowd favorite (real votes only).
 */
export function withGhost(e) {
  return e?.ghost === 1 ? { ...e, up: e.up + 1, score: e.score + 1 } : e;
}

/**
 * The period's Top 5 (history entries, best first): songs that played, not ones that would not.
 * Ranked with their ghost 👍 (as the class saw them); the entries come back as stored (real votes).
 */
export function topFive(history = [], { floor = false, downs = true } = {}) {
  const rank = byRank(floor, downs);
  return history.filter((e) => e.status !== 'failed')
    .map((e) => [withGhost(e), e]).sort(([a], [b]) => rank(a, b)).slice(0, TOP5_SIZE).map(([, e]) => e);
}

/**
 * What the state's `top5` holds (protocol.js Top5Item). `hide` (DOWNVOTE MODE: 👎 off, or hidden
 * for students and boards): `down` 0 and `score` the 👍 count, so no number gives a 👎 away.
 */
export function top5View(history = [], { floor = false, downs = true, hide = false } = {}) {
  return topFive(history, { floor, downs }).map((e) => top5Item(withGhost(e), { floor, downs, hide }));
}
const top5Item = (e, { floor = false, downs = true, hide = false } = {}) => ({
  id: e.id, song: shortSong(e.song), by: e.by, up: e.up, down: hide || !downs ? 0 : e.down,
  score: hide ? e.up : shownScore(e, floor, downs), ...teacherTag(e),
});

/**
 * The student whose played songs got the most 👍 (ties → more songs, then whose song played first),
 * or null. Grouped by device (a nickname may change); a kicked student (no device) and the
 * teacher's own picks (protocol.js TEACHER PICKS) never win.
 */
export function crowdFavorite(history = []) {
  const by = new Map();
  for (const e of history) {
    if (e.status === 'failed' || !e.device || e.device === TEACHER_DEVICE || e.teacher) continue;
    const row = by.get(e.device) ?? { nick: e.by, up: 0, songs: 0, first: e.at };
    row.nick = e.by; // the newest nickname
    row.up += e.up;
    row.songs += 1;
    by.set(e.device, row);
  }
  const best = [...by.values()].sort((a, b) => b.up - a.up || b.songs - a.songs || a.first - b.first)[0];
  return best && best.up > 0 ? { nick: best.nick, up: best.up } : null;
}

/**
 * The end-of-class recap (protocol.js TOP 5 + RECAP): THIS room's songs and votes only (nothing
 * from other classes) plus, for a room opened for a bell period, that period's running favorite
 * (`periodFavorite`: { period, song } from src/room.js). `stats`: the pool of fun stats (shared/stats.js).
 */
export function recapOf(state, now = Date.now(), { periodFavorite = null } = {}) {
  // GHOST VOTE: the songs as the class saw them (Crowd favorite below uses the real votes).
  const played = (state.history ?? []).filter((e) => e.status !== 'failed').map(withGhost);
  const floor = state.settings?.scoreFloor === true; // protocol.js SCORE FLOOR
  // DOWNVOTE MODE: the recap is the class's view (boards show it), so unless 👎 is 'shown' it has no
  // 👎 numbers and no 👎 stats; while 'off' the ranking counts 👍 only.
  const downvoteMode = downvoteModeOf(state.settings);
  const rules = { floor, downs: downvoteMode !== 'off', hide: downvoteMode !== 'shown' };
  const up = played.reduce((n, e) => n + e.up, 0);
  const down = rules.hide ? 0 : played.reduce((n, e) => n + e.down, 0);
  return {
    from: state.createdAt ?? null,
    at: now,
    downvoteMode,
    songs: played.map((e) => ({ ...top5Item(e, rules), at: e.at, status: e.status })).map(({ id, ...s }) => s),
    // The host's recap music (protocol.js RECAP MUSIC) plays a Top 5 song's preview: host only.
    top5: topFive(state.history, rules).map(withGhost).map((e) => ({ ...top5Item(e, rules), previewUrl: typeof e.song?.previewUrl === 'string' ? e.song.previewUrl : '' })),
    totals: { songs: played.length, votes: up + down, up, down },
    crowdFavorite: crowdFavorite(state.history),
    stats: statPool({ history: (state.history ?? []).map(withGhost), tally: state.tally, students: state.students, periodFavorite, crowd: crowdFavorite(state.history), downs: !rules.hide }),
  };
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The recap as plain text for "Copy recap" (Google Classroom, an email). */
export function recapText(recap, { date = '', stats = null } = {}) {
  const lines = [`🎵 RoomDJ class recap${date ? ` (${date})` : ''}`, ''];
  // DOWNVOTE MODE: 👎 numbers only while they are 'shown' (a recap from before the setting: shown).
  const downs = (recap.downvoteMode ?? 'shown') === 'shown';
  const net = (x) => (downs ? signed(x.score) : `👍 ${x.up}`);
  lines.push(`${plural(recap.totals.songs, 'song')} played, ${plural(recap.totals.votes, 'vote')} (👍 ${recap.totals.up}${downs ? `, 👎 ${recap.totals.down}` : ''}).`);
  if (recap.crowdFavorite) lines.push(`Crowd favorite: ${recap.crowdFavorite.nick} (👍 ${recap.crowdFavorite.up})`);
  // The stats shown on the page (`stats`: Stat[]), else none beyond the totals.
  for (const st of stats ?? []) if (st?.text && st.id !== 'crowd') lines.push(st.text);
  if (recap.top5.length) {
    lines.push('', '🏆 Top 5');
    recap.top5.forEach((t, i) => lines.push(`${i === 0 ? '👑' : `${i + 1}.`} ${t.song.title} by ${t.song.artist} (${net(t)}), suggested by ${byLabel(t)}`));
  }
  if (recap.songs.length) {
    lines.push('', 'Songs in order');
    recap.songs.forEach((s, i) => lines.push(`${i + 1}. ${s.song.title} by ${s.song.artist} (${net(s)})${s.status === 'skipped' ? ' (skipped)' : ''}`));
  }
  return lines.join('\n');
}

// ---- Favorites (KV `favorites`; songs only) -------------------------------------------------------

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) ? v : 0);

/** Only the catalog's song fields: never who suggested it or where. */
export function favoriteSong(song) {
  const id = songId(song?.id ?? song?.trackId);
  if (!id || !str(song?.title)) return null;
  return {
    id,
    title: str(song.title),
    artist: str(song.artist),
    album: str(song.album),
    artwork: str(song.artwork, 500),
    durationMs: Number.isSafeInteger(song.durationMs) && song.durationMs > 0 ? song.durationMs : 0,
    explicit: ['explicit', 'cleaned', 'notExplicit'].includes(song.explicit) ? song.explicit : 'notExplicit',
    previewUrl: str(song.previewUrl, 500),
    ...(str(song.genre, 80) ? { genre: str(song.genre, 80) } : {}),
    ...(Number.isInteger(song.year) && song.year > 0 ? { year: song.year } : {}),
  };
}

/** The KV value as a clean list (anything broken is dropped; only the fields below survive). */
export function readFavorites(raw) {
  const list = Array.isArray(raw?.list) ? raw.list : Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const e of list) {
    const song = favoriteSong(e?.song);
    if (!song || seen.has(song.id)) continue;
    seen.add(song.id);
    out.push({
      song,
      top5: Math.max(0, num(e.top5)),
      net: num(e.net),
      plays: Math.max(0, num(e.plays)),
      pinned: e.pinned === true,
      firstAt: num(e.firstAt),
      lastAt: num(e.lastAt),
    });
  }
  return out;
}

/** What goes into KV. */
export function favoritesValue(list) {
  return { v: 1, list };
}

/** (TOP5_WEIGHT x times in a Top 5 + total net votes), halved every FAVORITE_HALF_LIFE_DAYS since it last got in. */
export function favoriteScore(e, now = Date.now()) {
  const days = Math.max(0, now - (e.lastAt || now)) / DAY_MS;
  return (TOP5_WEIGHT * e.top5 + e.net) * 0.5 ** (days / FAVORITE_HALF_LIFE_DAYS);
}

/** Pinned first, then the highest score; ties → the one that got in last. */
export function rankFavorites(list, now = Date.now()) {
  return [...list].sort((a, b) => (b.pinned - a.pinned) || favoriteScore(b, now) - favoriteScore(a, now) || b.lastAt - a.lastAt);
}

/**
 * A song finished well (net ≥ FAVORITE_MIN_NET) or made a Top 5: add it, or add to its counts.
 * `net`: votes to add; `top5`: 1 when it made a period's Top 5. Then at most FAVORITES_MAX (the
 * lowest unpinned go). Changes `list` in place and returns it.
 */
export function bumpFavorite(list, song, { net = 0, top5 = 0 } = {}, now = Date.now()) {
  const clean = favoriteSong(song);
  if (!clean) return list;
  let e = list.find((x) => x.song.id === clean.id);
  if (!e) {
    e = { song: clean, top5: 0, net: 0, plays: 0, pinned: false, firstAt: now, lastAt: now };
    list.push(e);
  }
  e.song = clean; // the newest catalog details
  e.net += net;
  e.top5 += top5;
  e.plays += 1;
  e.lastAt = now;
  return capFavorites(list, now);
}

/** At most FAVORITES_MAX: the lowest-scored unpinned songs drop off. Changes `list` in place. */
export function capFavorites(list, now = Date.now()) {
  while (list.length > FAVORITES_MAX) {
    const drop = rankFavorites(list.filter((e) => !e.pinned), now).at(-1) ?? rankFavorites(list, now).at(-1);
    list.splice(list.indexOf(drop), 1);
  }
  return list;
}

/** Take songs off (by song id, or by a predicate). Returns how many went. */
export function removeFavorite(list, idOrTest) {
  const test = typeof idOrTest === 'function' ? idOrTest : (e) => e.song.id === idOrTest;
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (test(list[i])) {
      list.splice(i, 1);
      n++;
    }
  }
  return n;
}

/** Pin (or unpin) one song. Returns false when it is not on the list. */
export function pinFavorite(list, id, on) {
  const e = list.find((x) => x.song.id === id);
  if (!e) return false;
  e.pinned = on === true;
  return true;
}

/**
 * What students see: the best FAVORITES_STUDENT songs that pass the room's filter without the AI
 * (explicit, blocked words, the ban list). Those are left out, never shown, like search results.
 */
export function studentFavorites(list, { blocklist = [], banned = [] } = {}, now = Date.now()) {
  return rankFavorites(list, now)
    .filter((e) => quickCheck(e.song, { blocklist, banned }) === null)
    .slice(0, FAVORITES_STUDENT)
    .map((e) => ({ song: e.song, pinned: e.pinned, top5: e.top5 }));
}

/** What the host sees: every song, ranked, with its numbers (score rounded to a tenth). */
export function hostFavorites(list, now = Date.now()) {
  return rankFavorites(list, now).map((e) => ({
    song: e.song, pinned: e.pinned, top5: e.top5, net: e.net, plays: e.plays, lastAt: e.lastAt,
    score: Math.round(favoriteScore(e, now) * 10) / 10,
  }));
}
