// Class time (Dalton, 2026-10-06): Max song length, the class end + cleanup time model (protocol.js
// CLEANUP) and the time boxes on the host page. Pure JS, no DOM: the Room, the Worker, the pages
// and the Node tests use it.

import {
  CLASS_PERIOD_MIN, CLEANUP_PAST_SLACK_MS, OPEN_MAX_MS, OPEN_MIN_MS,
} from './protocol.js';

/** 432000 → "7:12"; 3_725_000 → "1:02:05". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Max song length: null when the song may play, else the student's evidence ("This song is 7:12;
 * the limit is 5:00."). Off (maxSongMinutes null) or an unknown length (durationMs 0) passes.
 * A song exactly at the limit passes (iTunes lengths are whole milliseconds).
 */
export function tooLong(song, settings) {
  const limit = settings?.maxSongMinutes;
  const ms = Number(song?.durationMs) || 0;
  if (!Number.isInteger(limit) || ms <= 0) return null;
  const limitMs = limit * 60_000;
  if (ms <= limitMs) return null;
  return { evidence: `This song is ${formatDuration(ms)}; the limit is ${formatDuration(limitMs)}.`, durationMs: ms, limitMs };
}

/**
 * Class end + cleanup start from a page (a new room or "Change times"), as absolute ms.
 * until: OPEN_MIN_MS to OPEN_MAX_MS from now (validateUntil). cleanupAt: null (no cleanup) or before
 * until and not more than CLEANUP_PAST_SLACK_MS ago (a time box has whole minutes, so "10:03" typed
 * at 10:03:40 means now: it is moved to now).
 * @returns {{ ok: true, until: number, cleanupAt: number|null } | { ok: false, error: 'until'|'cleanup', message: string }}
 */
export function validateTimes({ until, cleanupAt = null } = {}, now = Date.now()) {
  if (!Number.isSafeInteger(until) || until < now + OPEN_MIN_MS || until > now + OPEN_MAX_MS) {
    return { ok: false, error: 'until', message: until < now ? 'That class end time has passed. Pick a later time.' : 'Pick when class ends (later today, up to a day).' };
  }
  if (cleanupAt === null || cleanupAt === undefined) return { ok: true, until, cleanupAt: null };
  if (!Number.isSafeInteger(cleanupAt)) return { ok: false, error: 'cleanup', message: 'Pick when cleanup starts, or leave it empty for no cleanup.' };
  if (cleanupAt >= until) return { ok: false, error: 'cleanup', message: 'Cleanup has to start before class ends.' };
  if (cleanupAt < now - CLEANUP_PAST_SLACK_MS) return { ok: false, error: 'cleanup', message: 'That cleanup time has passed. Pick a later time, or leave it empty.' };
  return { ok: true, until, cleanupAt: Math.max(cleanupAt, now) };
}

/** True when the room should go into cleanup mode now (its alarm, or any request that wakes it). */
export function cleanupDue(room, now = Date.now()) {
  return Boolean(room?.open && !room.cleanup && Number.isSafeInteger(room.cleanupAt) && now >= room.cleanupAt);
}

/**
 * When the room's one alarm should next ring: the earliest of cleanup start (not yet started), class
 * end, idle and `ghostAt` (the next ghost 👍 moment, protocol.js GHOST VOTE: queue.js nextGhostAt; null = none).
 */
export function nextAlarmAt(room, idleMs, ghostAt = null) {
  const times = [room.until ?? Infinity, room.lastActivity + idleMs];
  if (!room.cleanup && Number.isSafeInteger(room.cleanupAt)) times.push(room.cleanupAt);
  if (Number.isSafeInteger(ghostAt)) times.push(ghostAt);
  return Math.min(...times);
}

/** Absolute ms → "HH:MM" in this computer's time zone (a time box's value). */
export function timeValue(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A time box's "HH:MM" → absolute ms today in this computer's time zone, or null. A time earlier
 * than now is today's here; the host's boxes read through timeAhead (after midnight = tomorrow).
 */
export function timeToday(value, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2])).getTime();
}

/** How far ahead a time box may reach past midnight (Dalton's bug, 2026-10-07: at 22:58 the
 * one-period prefill "00:08" was refused as passed). */
export const AFTER_MIDNIGHT_MS = 6 * 60 * 60 * 1000;

/**
 * A time box's "HH:MM" → absolute ms, or null: today's, unless today's has passed (more than
 * `pastSlackMs` ago) and the same time tomorrow is at most AFTER_MIDNIGHT_MS away. Then it is
 * tomorrow's: opening at 22:58, "00:08" means 70 minutes from now. Any other passed time stays
 * today's, so the checks still say "passed" (at 10:00, "09:50" is a typo, not a 24-hour room).
 * OPEN_MAX_MS still caps the result (validateTimes).
 */
export function timeAhead(value, now = new Date(), { pastSlackMs = 0 } = {}) {
  const today = timeToday(value, now);
  if (today === null || today >= now.getTime() - pastSlackMs) return today;
  const d = new Date(today);
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, d.getHours(), d.getMinutes()).getTime();
  return tomorrow - now.getTime() <= AFTER_MIDNIGHT_MS ? tomorrow : today;
}

/**
 * The open-room form's prefill: class ends one period from now (settings.periodMinutes, else
 * CLASS_PERIOD_MIN), rounded up to a whole minute; cleanup starts settings.cleanupMinutes before
 * (0 = none: ''). As "HH:MM" values.
 */
export function defaultTimes(settings = {}, now = new Date()) {
  const period = Number.isInteger(settings.periodMinutes) ? settings.periodMinutes : CLASS_PERIOD_MIN;
  const end = Math.ceil((now.getTime() + period * 60_000) / 60_000) * 60_000;
  const cleanup = Number.isInteger(settings.cleanupMinutes) ? settings.cleanupMinutes : 5;
  return { classEnd: timeValue(end), cleanup: cleanup > 0 ? timeValue(end - cleanup * 60_000) : '' };
}

/**
 * The bell schedule presets for today: each with its absolute time `at` (this computer's time
 * zone) and `passed` (at or before now + OPEN_MIN_MS: too late to open a room until then).
 * A preset is today's only: at 23:50 a "00:05" bell has passed (never tomorrow's).
 */
export function bellChoices(bells, now = new Date()) {
  return (Array.isArray(bells) ? bells : []).map((b) => {
    const at = timeToday(b?.ends, now);
    return { name: String(b?.name ?? ''), ends: String(b?.ends ?? ''), at, passed: at === null || at <= now.getTime() + OPEN_MIN_MS };
  });
}

/** The index of the next bell to ring (the earliest not passed), or -1 when every bell has passed. */
export function nextBell(bells, now = new Date()) {
  let best = -1;
  bellChoices(bells, now).forEach((b, i) => {
    if (!b.passed && (best < 0 || b.at < bellChoices(bells, now)[best].at)) best = i;
  });
  return best;
}

// ---- Bell offset (protocol.js BELL OFFSET) ----

/** settings.bellOffsetSeconds (or a number of seconds) as ms; anything that is not a whole number is 0. */
export function bellOffsetMs(settingsOrSeconds) {
  const s = typeof settingsOrSeconds === 'object' && settingsOrSeconds !== null ? settingsOrSeconds.bellOffsetSeconds : settingsOrSeconds;
  return Number.isInteger(s) ? s * 1000 : 0;
}

/**
 * Typed BELL times → the REAL moments the room keeps: both moved by the offset (null stays null).
 * Not-a-number values pass through unchanged, so the checks (validateTimes) still refuse them.
 */
export function shiftTimes({ until, cleanupAt = null } = {}, offsetSeconds = 0) {
  const off = bellOffsetMs(offsetSeconds);
  const move = (ms) => (Number.isSafeInteger(ms) ? ms + off : ms);
  return { until: move(until), cleanupAt: cleanupAt === null || cleanupAt === undefined ? null : move(cleanupAt) };
}

/** A real moment → the bell time a page shows (the time on the school's printed schedule). */
export function bellTime(ms, offsetSeconds = 0) {
  return Number.isFinite(ms) ? ms - bellOffsetMs(offsetSeconds) : ms;
}

/** A countdown's text: whole seconds rounded UP ("0:01" until it is over), "12:34" or "1:02:05". */
export function countdownText(ms) {
  return formatDuration(Math.ceil(Math.max(0, Number(ms) || 0) / 1000) * 1000);
}

/**
 * The student page's bell pill for a room state, at server time `now`: null when there is no bell
 * to count down to (no until, or the room runs to the end of the day), else { text, cleanup, left }.
 *   "🔔 Bell in 12:34", in cleanup "🧹 Cleanup! Bell in 0:45".
 */
export function bellPill(s, now) {
  if (!s || !Number.isFinite(s.until) || endOfDay(bellTime(s.until, s.bellOffsetSeconds))) return null;
  const left = Math.max(0, s.until - now);
  const clock = countdownText(left);
  const cleanup = s.cleanup === true;
  const icon = cleanup ? '🧹' : '🔔';
  const words = cleanup ? 'Cleanup! Bell in' : 'Bell in';
  return { text: `${icon} ${words} ${clock}`, icon, words, clock, cleanup, left };
}

/** True for the "end of today" class end (shared/code.js untilFor('day'): 23:59:59 here): no bell. */
export function endOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() === 23 && d.getMinutes() === 59 && d.getSeconds() === 59;
}
