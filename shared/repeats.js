// Repeats (Dalton, 2026-10-07; protocol.js REPEATS): one song in any version is one song.
// `songKey` (base title without version labels + main artist) names it for "already played this
// period", "already in the queue / Needs a look", and the repeat cooldown. The cooldown record is
// the teacher's KV `recent` (src/teacher-kv.js teacherKvKey): song key → when it last played in
// any of the teacher's rooms. SONGS ONLY (title + artist for the host's list): never a nickname,
// a device or a room id. Pure functions: the Room, the pages and the Node tests share them.

import { COOLDOWN_DAYS, RECENT_KEEP_DAYS, RECENT_MAX } from './protocol.js';
import { baseTitle, mainArtist, normalizeWords } from './filter.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The song in any version: "Blinding Lights (Remix)", "Heat Waves - Sped Up", "Shake It Off
 * (Taylor's Version)" and "Song (feat. X)" are the song itself. The whole base title must match
 * ("Happy" is not "Happy Now") and so must the main artist (Adele's "Hello" is not Lionel
 * Richie's). Lower case, accents and punctuation dropped. null when the title or artist is missing.
 */
export function songKey(song) {
  const title = baseTitle(song?.title) || normalizeWords(song?.title);
  const artist = mainArtist(song?.artist) || normalizeWords(song?.artist);
  return title && artist ? `${title}|${artist}` : null;
}

/** True when two songs are the same song (by id, or by song key). */
export function sameSong(a, b) {
  if (!a || !b) return false;
  if (a.id && a.id === b.id) return true;
  const k = songKey(a);
  return Boolean(k) && k === songKey(b);
}

/** A valid cooldown setting: null (off) or one of COOLDOWN_DAYS. */
export const cooldownOk = (v) => v === null || COOLDOWN_DAYS.includes(v);

/** When a song that played at `at` may come back, with a cooldown of `days`. */
export const restUntil = (at, days) => at + days * DAY_MS;

/**
 * The KV `recent` value read back: { [songKey]: { at, title, artist } }. Anything malformed is
 * dropped (never throws).
 */
export function readRecent(value) {
  const out = {};
  const songs = value && typeof value === 'object' && value.songs && typeof value.songs === 'object' ? value.songs : {};
  for (const [key, e] of Object.entries(songs)) {
    if (typeof key !== 'string' || key.length > 300 || !e || !Number.isSafeInteger(e.at)) continue;
    out[key] = { at: e.at, title: String(e.title ?? '').slice(0, 200), artist: String(e.artist ?? '').slice(0, 200) };
  }
  return out;
}

/** The value to write to KV. */
export const recentValue = (map) => ({ v: 1, songs: map });

/** A song played at `at`: its key's time moves up (never back). Returns the key, or null. */
export function notePlayed(map, song, at) {
  const key = songKey(song);
  if (!key) return null;
  const before = map[key];
  map[key] = { at: Math.max(at, before?.at ?? 0), title: String(song.title ?? '').slice(0, 200), artist: String(song.artist ?? '').slice(0, 200) };
  return key;
}

/** `into` gets every entry of `from` that is newer. Changes `into`; returns it. */
export function mergeRecent(into, from) {
  for (const [key, e] of Object.entries(from ?? {})) if (!into[key] || into[key].at < e.at) into[key] = e;
  return into;
}

/**
 * Before a write: entries older than RECENT_KEEP_DAYS go (no cooldown is longer), and at most
 * RECENT_MAX stay (the newest). Changes `map`; returns how many were dropped.
 */
export function pruneRecent(map, now = Date.now()) {
  const oldest = now - RECENT_KEEP_DAYS * DAY_MS;
  let dropped = 0;
  for (const [key, e] of Object.entries(map)) {
    if (e.at < oldest) {
      delete map[key];
      dropped++;
    }
  }
  const keys = Object.keys(map);
  if (keys.length > RECENT_MAX) {
    keys.sort((a, b) => map[b].at - map[a].at);
    for (const key of keys.slice(RECENT_MAX)) delete map[key];
    dropped += keys.length - RECENT_MAX;
  }
  return dropped;
}

/**
 * Is this song resting? { key, at, until } while the cooldown (`days`, null = off) has not run
 * out, else null. Exactly at `until` it may come back.
 */
export function restingFor(map, song, days, now = Date.now()) {
  if (!Number.isInteger(days) || days <= 0) return null;
  const key = songKey(song);
  const e = key ? map?.[key] : null;
  if (!e) return null;
  const until = restUntil(e.at, days);
  return now < until ? { key, at: e.at, until } : null;
}

/** Every song resting now, soonest back first: [{ key, title, artist, at, until }]. Off: []. */
export function restingList(map, days, now = Date.now()) {
  if (!Number.isInteger(days) || days <= 0) return [];
  return Object.entries(map ?? {})
    .map(([key, e]) => ({ key, title: e.title, artist: e.artist, at: e.at, until: restUntil(e.at, days) }))
    .filter((e) => now < e.until)
    .sort((a, b) => a.until - b.until || a.key.localeCompare(b.key));
}

// ---- Words for the pages (in the page's own time zone: the server does not know the teacher's) ----

const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Whole calendar days from `now` to `t` (negative: past). Daylight saving changes round away. */
const dayDiff = (t, now) => Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
const weekday = (t, style = 'long') => new Date(t).toLocaleDateString('en-US', { weekday: style });
const shortDate = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const clockTime = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "earlier today" | "yesterday" | "on Monday" (within 7 days) | "on Oct 3". */
export function playedWhen(at, now = Date.now()) {
  const d = dayDiff(at, now);
  if (d >= 0) return 'earlier today';
  if (d === -1) return 'yesterday';
  if (d > -7) return `on ${weekday(at)}`;
  return `on ${shortDate(at)}`;
}

/** "later today at 2:15 PM" | "tomorrow" | "on Thursday" (within 7 days) | "on Oct 21". */
export function backWhen(until, now = Date.now()) {
  const d = dayDiff(until, now);
  if (d <= 0) return `later today at ${clockTime(until)}`;
  if (d === 1) return 'tomorrow';
  if (d < 7) return `on ${weekday(until)}`;
  return `on ${shortDate(until)}`;
}

/** The short label on a result: "until 2:15 PM" | "until tomorrow" | "until Thu" | "until Oct 21". */
export function restingUntilLabel(until, now = Date.now()) {
  const d = dayDiff(until, now);
  if (d <= 0) return `until ${clockTime(until)}`;
  if (d === 1) return 'until tomorrow';
  if (d < 7) return `until ${weekday(until, 'short')}`;
  return `until ${shortDate(until)}`;
}

/** The student's evidence: "This song played on Monday. It can come back on Thursday." */
export function restingEvidence(at, until, now = Date.now()) {
  return `This song played ${playedWhen(at, now)}. It can come back ${backWhen(until, now)}.`;
}
