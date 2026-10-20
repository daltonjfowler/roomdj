// The class times, big (Dalton): "🧹 Cleanup 10:05 · in 12 min" and "🔔 Class ends 10:10 · in 17
// min", on the host page and the board. One element (#untilNote); a timer keeps the "in …" fresh.
// In the last 10 minutes before a time the chip counts down live ("in 9:59"). Clock times are BELL
// times (the real moment minus the bell offset, protocol.js BELL OFFSET); the "in …" counts to the
// real moment on the server's clock (server-clock.js).
import { esc } from './dom.js';
import { bellTime, countdownText } from '../../shared/classtime.js';
import { serverClock } from './server-clock.js';

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const sameDay = (ms, now) => new Date(ms).toDateString() === new Date(now).toDateString();
/** Below this, a chip counts down in mm:ss. */
export const LIVE_MS = 10 * 60_000;

/** "in 12 min", "in 1 h 5 min", "now"; in the last 10 minutes "in 9:59". */
export function inWords(ms, now = serverClock.now()) {
  const left = ms - now;
  if (left <= 0) return 'now';
  if (left <= LIVE_MS) return `in ${countdownText(left)}`;
  const min = Math.ceil(left / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

let last = null;
let timer = 0;

function draw() {
  timer = 0;
  const el = document.querySelector('#untilNote');
  if (!el || !last) return;
  const { until, cleanupAt, cleanup, offset } = last;
  const now = serverClock.now();
  const chips = [];
  const targets = [];
  if (cleanupAt && !cleanup && cleanupAt > now) {
    targets.push(cleanupAt);
    chips.push(`<span class="time-chip cleanup"><span class="time-what">🧹 Cleanup</span> <b>${esc(clock(bellTime(cleanupAt, offset)))}</b> <small>${esc(inWords(cleanupAt, now))}</small></span>`);
  }
  if (until) {
    targets.push(until);
    const bell = bellTime(until, offset);
    chips.push(`<span class="time-chip bell"><span class="time-what">🔔 Class ends</span> <b>${esc(clock(bell))}${sameDay(bell, now) ? '' : ' tomorrow'}</b> <small>${esc(inWords(until, now))}</small></span>`);
  }
  el.innerHTML = chips.join('');
  // Every second while a time is within LIVE_MS (just after the next whole second), else every 15 s.
  const live = targets.some((t) => t - now <= LIVE_MS + 15_000 && t > now - 1000);
  const wait = live ? 1000 - ((now % 1000 + 1000) % 1000) + 20 : 15_000;
  if (el.isConnected) timer = setTimeout(draw, wait);
}

/** Show the times for this room state ({ until, cleanupAt, cleanup, bellOffsetSeconds }). */
export function showTimes(s) {
  last = s ? { until: s.until ?? null, cleanupAt: s.cleanupAt ?? null, cleanup: s.cleanup === true, offset: s.bellOffsetSeconds ?? 0 } : null;
  clearTimeout(timer);
  timer = 0;
  draw();
}
