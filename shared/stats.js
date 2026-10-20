// The recap's fun stats (Dalton, 2026-10-06; protocol.js TOP 5 + RECAP): a pool of award slides,
// worked out from the room's own numbers only. A stat is in the pool only when its data is real
// (no song lengths known → no "longest song"); nothing is ever made up. The host page shows the
// Top 5, the versus finale (always) and 3 or 4 others picked at random ("🎲 More stats").
//
// Input: the room's history (shared/highlights.js; songs that played, with their final votes, 👍
// given while a song played included), RoomState.tally ({ songs, votes } per device, and a genre log of every suggestion),
// and the students (device → nickname; a kicked device is gone, so never named). Only THIS room's
// data: nothing from other classes or days.
//
// Stat: { id, emoji, title, lead ("And the Top voter is…"), name (the reveal), detail, text (for
//   Copy recap), chart?: { kind: 'bars', label, rows: [{ label, n }] } }
// The versus card: { id: 'versus', contributor: { nick, n } | null, voter: { nick, n } | null, text }

import { TEACHER_DEVICE } from './protocol.js';

/** Songs that played (not ones that would not). */
const playedOf = (history = []) => history.filter((e) => e.status !== 'failed');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const songLine = (s) => `"${s.title}" by ${s.artist}`;
const shortSong = (song) => ({ id: song.id, title: song.title, artist: song.artist, artwork: song.artwork ?? '' });

/** m:ss for a length in ms. */
export function minutesSeconds(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The device with the most (ties → the one that got there first in `order`), as { nick, n }, or null. */
function topDevice(counts = {}, students = {}) {
  let best = null;
  for (const [device, n] of Object.entries(counts)) {
    const nick = students[device]?.nick;
    // Left the room or kicked: never named. The teacher (TEACHER_DEVICE) is never a student.
    if (!nick || !(n > 0) || device === TEACHER_DEVICE) continue;
    if (!best || n > best.n) best = { nick, n };
  }
  return best;
}

/** 🎤 Top contributor (songs suggested) vs 🗳 Top voter (votes cast). Null when neither has any. */
export function versusStat(tally, students) {
  const contributor = topDevice(tally?.songs, students);
  const voter = topDevice(tally?.votes, students);
  if (!contributor && !voter) return null;
  const text = `🎤 Top contributor: ${contributor ? `${contributor.nick} (${plural(contributor.n, 'song')} suggested)` : 'nobody yet'}`
    + ` vs 🗳 Top voter: ${voter ? `${voter.nick} (${plural(voter.n, 'vote')} cast)` : 'nobody yet'}`;
  return { id: 'versus', contributor, voter, text };
}

/** Genres of the songs that played: [{ label, n }], biggest first (at most `max` rows, the rest "Other"). */
export function genreCounts(history, max = 6) {
  const counts = new Map();
  for (const e of playedOf(history)) {
    const g = String(e.song.genre ?? '').trim();
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const rows = [...counts].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  if (rows.length <= max) return rows;
  const other = rows.slice(max - 1).reduce((n, r) => n + r.n, 0);
  return [...rows.slice(0, max - 1), { label: 'Other', n: other }];
}

/** Decades of the songs that played ("2010s"), oldest first. */
export function decadeCounts(history) {
  const counts = new Map();
  for (const e of playedOf(history)) {
    const y = e.song.year;
    if (Number.isInteger(y) && y > 0) counts.set(Math.floor(y / 10) * 10, (counts.get(Math.floor(y / 10) * 10) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => a[0] - b[0]).map(([d, n]) => ({ label: `${d}s`, n }));
}

/**
 * 🌀 Vibe changer: a played song whose genre differed from the two songs before it, after which the
 * next 3 suggestions had more of its genre (at least 2) than the 3 suggestions before it started.
 * The biggest swing wins (ties → the earlier). Null when no song did that.
 */
export function vibeChanger(history, log = []) {
  const played = playedOf(history);
  let best = null;
  for (let i = 2; i < played.length; i++) {
    const e = played[i];
    const g = String(e.song.genre ?? '').trim();
    const prev = [played[i - 1], played[i - 2]].map((p) => String(p.song.genre ?? '').trim());
    if (!g || prev.some((p) => !p || p === g)) continue;
    const before = log.filter((x) => x.at < e.at).slice(-3);
    const after = log.filter((x) => x.at >= e.at).slice(0, 3);
    if (before.length < 3 || after.length < 3) continue;
    const was = before.filter((x) => x.genre === g).length;
    const now = after.filter((x) => x.genre === g).length;
    if (now >= 2 && now > was && (!best || now - was > best.swing)) best = { entry: e, genre: g, swing: now - was };
  }
  return best;
}

/**
 * Every stat the data supports (the pool), not counting the Top 5: from this room's own history,
 * tally and students only. `crowd`: highlights.js crowdFavorite.
 */
export function statPool({ history = [], tally = null, students = {}, crowd = null, downs = true, periodFavorite = null } = {}) {
  const played = playedOf(history);
  const out = [];
  const add = (s) => out.push({ chart: null, detail: '', ...s });

  const versus = versusStat(tally, students);
  if (versus) out.push(versus);

  const genres = genreCounts(history);
  if (genres.length >= 2) {
    add({
      id: 'genres', emoji: '🎸', title: 'Genre mix', lead: 'The sound of the period was…', name: genres[0].label,
      detail: genres.map((r) => `${r.label} ${r.n}`).join(' · '),
      text: `🎸 Genre mix: ${genres.map((r) => `${r.label} ${r.n}`).join(', ')}`,
      chart: { kind: 'bars', label: 'Songs played per genre', rows: genres },
    });
  }

  const timed = played.filter((e) => e.song.durationMs > 0);
  if (timed.length >= 2) {
    const long = timed.reduce((a, b) => (b.song.durationMs > a.song.durationMs ? b : a));
    const short = timed.reduce((a, b) => (b.song.durationMs < a.song.durationMs ? b : a));
    if (long !== short) {
      add({ id: 'longest', emoji: '🐢', title: 'Longest song', lead: 'The longest song of the period…', name: long.song.title, song: shortSong(long.song),
        detail: `${long.song.artist} · ${minutesSeconds(long.song.durationMs)}`, text: `🐢 Longest song: ${songLine(long.song)} (${minutesSeconds(long.song.durationMs)})` });
      add({ id: 'shortest', emoji: '⚡', title: 'Shortest song', lead: 'Short and sweet…', name: short.song.title, song: shortSong(short.song),
        detail: `${short.song.artist} · ${minutesSeconds(short.song.durationMs)}`, text: `⚡ Shortest song: ${songLine(short.song)} (${minutesSeconds(short.song.durationMs)})` });
    }
    const minutes = Math.round(timed.reduce((n, e) => n + e.song.durationMs, 0) / 60_000);
    if (minutes > 0) {
      add({ id: 'minutes', emoji: '⏱', title: 'Music time', lead: 'Total music time…', name: `${minutes} min`,
        detail: `${plural(played.length, 'song')} (full song lengths)`, text: `⏱ Music: about ${minutes} minutes in ${plural(played.length, 'song')}` });
    }
  }

  const dated = played.filter((e) => Number.isInteger(e.song.year) && e.song.year > 0);
  if (dated.length >= 2) {
    const old = dated.reduce((a, b) => (b.song.year < a.song.year ? b : a));
    const young = dated.reduce((a, b) => (b.song.year > a.song.year ? b : a));
    if (old.song.year !== young.song.year) {
      add({ id: 'oldest', emoji: '📼', title: 'Oldest song', lead: 'Going way back to…', name: String(old.song.year), song: shortSong(old.song),
        detail: songLine(old.song), text: `📼 Oldest song: ${songLine(old.song)} (${old.song.year})` });
      add({ id: 'newest', emoji: '🆕', title: 'Newest song', lead: 'Fresh out of the studio…', name: String(young.song.year), song: shortSong(young.song),
        detail: songLine(young.song), text: `🆕 Newest song: ${songLine(young.song)} (${young.song.year})` });
    }
    const decades = decadeCounts(history);
    if (decades.length >= 2) {
      add({ id: 'decades', emoji: '📅', title: 'Decades', lead: 'Time travel! The decades were…', name: decades.reduce((a, b) => (b.n > a.n ? b : a)).label,
        detail: decades.map((r) => `${r.label} ${r.n}`).join(' · '), text: `📅 Decades: ${decades.map((r) => `${r.label} ${r.n}`).join(', ')}`,
        chart: { kind: 'bars', label: 'Songs played per decade', rows: decades } });
    }
  }

  const vibe = vibeChanger(history, tally?.log);
  if (vibe) {
    add({ id: 'vibe', emoji: '🌀', title: 'Vibe changer', lead: 'One song changed the vibe…', name: vibe.entry.song.title, song: shortSong(vibe.entry.song),
      detail: `switched the room to ${vibe.genre}`, text: `🌀 Vibe changer: ${songLine(vibe.entry.song)} switched the room to ${vibe.genre}` });
  }

  const liked = played.filter((e) => e.up > 0);
  if (liked.length) {
    const top = liked.reduce((a, b) => (b.up > a.up ? b : a));
    add({ id: 'mostUp', emoji: '👍', title: 'Most 👍', lead: 'The class loved…', name: top.song.title, song: shortSong(top.song),
      detail: `${top.song.artist} · 👍 ${top.up}`, text: `👍 Most thumbs up: ${songLine(top.song)} (👍 ${top.up})` });
  }
  // The 👎 stats only while 👎 counts are shown (protocol.js DOWNVOTE MODE: `downs` false otherwise).
  const booed = downs ? played.filter((e) => e.down > 0) : [];
  if (booed.length) {
    const top = booed.reduce((a, b) => (b.down > a.down ? b : a));
    add({ id: 'mostDown', emoji: '😬', title: 'Survived the 👎', lead: 'It still made it to the speakers…', name: top.song.title, song: shortSong(top.song),
      detail: `${top.song.artist} · 👎 ${top.down}, and it played anyway`, text: `😬 Survived the most thumbs down: ${songLine(top.song)} (👎 ${top.down})` });
  }
  const split = downs ? played.filter((e) => e.up > 0 && e.down > 0) : [];
  if (split.length) {
    const close = split.reduce((a, b) => {
      const da = Math.abs(a.up - a.down);
      const db = Math.abs(b.up - b.down);
      return db < da || (db === da && b.up + b.down > a.up + a.down) ? b : a;
    });
    add({ id: 'closest', emoji: '⚖️', title: 'Closest vote', lead: 'The class could not decide on…', name: close.song.title, song: shortSong(close.song),
      detail: `👍 ${close.up} vs 👎 ${close.down}`, text: `⚖️ Closest vote: ${songLine(close.song)} (👍 ${close.up} vs 👎 ${close.down})` });
  }

  // Crowd favorite: the student whose played songs got the most 👍 (shared/highlights.js crowdFavorite).
  if (crowd) {
    add({ id: 'crowd', emoji: '⭐', title: 'Crowd favorite', lead: 'The DJ the class loved most…', name: crowd.nick,
      detail: `👍 ${crowd.up} on the songs they picked`, text: `⭐ Crowd favorite: ${crowd.nick} (👍 ${crowd.up})` });
  }

  // No "Class favorite of all time" (Dalton, 2026-10-14): it came from every class's favorites, so a
  // quiet period with no songs still had one. Instead, for a room opened for a bell period, THAT
  // period's running favorite (its own favorites list; src/room.js periodFavorite).
  const pf = periodFavorite?.song;
  if (pf?.title && periodFavorite.period) {
    const p = periodFavorite.period;
    add({ id: 'period', emoji: '🏅', title: `${p} favorite`, lead: `${p}'s favorite so far is…`, name: pf.title,
      song: shortSong(pf), detail: pf.artist, text: `🏅 ${p} favorite so far: ${songLine(pf)}` });
  }
  return out;
}

/**
 * Pick the slides to show: always the versus card (when there is one), plus `n` others at random
 * (`random`: a function like Math.random, for tests). Returns { versus, picks }.
 */
export function pickStats(pool, n = 4, random = Math.random) {
  const versus = pool.find((s) => s.id === 'versus') ?? null;
  // The period's running favorite is one of the pool like any other stat (Dalton: "doesn't have to
  // show every time").
  const rest = pool.filter((s) => s.id !== 'versus');
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return { versus, picks: rest.slice(0, n) };
}
