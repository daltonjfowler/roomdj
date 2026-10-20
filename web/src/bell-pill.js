// The student page's bell countdown (protocol.js BELL OFFSET, SERVER CLOCK): a quiet pill at the top,
// "🔔 Bell in 12:34", in cleanup "🧹 Cleanup! Bell in 0:45". It counts to the room's real `until`
// (bell offset included) on the server's clock, so a Chromebook with a wrong clock shows the right
// time. Not a live region: screen readers hear it only twice, once when cleanup starts and once
// when a minute is left.
import { $, announce } from './dom.js';
import { bellPill } from '../../shared/classtime.js';
import { serverClock } from './server-clock.js';

let room = null; // { until, cleanup, bellOffsetSeconds }
let timer = 0;
let lastUntil = null;
let saidCleanup = false;
let saidMinute = false;

const spoken = (ms) => {
  const min = Math.round(ms / 60_000);
  return min >= 1 ? `${min} ${min === 1 ? 'minute' : 'minutes'}` : 'less than a minute';
};

function draw() {
  timer = 0;
  const el = $('#bellPill');
  if (!el) return;
  const p = room && bellPill(room, serverClock.now());
  el.hidden = !p;
  if (!p) return;
  el.classList.toggle('cleanup', p.cleanup);
  if ($('#bellIcon').textContent !== p.icon) $('#bellIcon').textContent = p.icon;
  if ($('#bellWords').textContent !== p.words) $('#bellWords').textContent = p.words;
  $('#bellClock').textContent = p.clock;
  // Announced once each (a new class end lets the minute one come again).
  let say = '';
  if (p.cleanup && !saidCleanup) {
    saidCleanup = true;
    say = `Cleanup time! The bell rings in ${spoken(p.left)}.`;
  }
  if (p.left > 0 && p.left <= 60_000 && !saidMinute) {
    saidMinute = true;
    say ||= 'One minute until the bell.'; // the cleanup sentence already says how long
  }
  if (say) announce(say);
  if (p.left > 0) timer = setTimeout(draw, 1000 - (serverClock.now() % 1000) + 20); // just after each whole second
}

/** Every State (or null when leaving the room). */
export function showBell(s) {
  clearTimeout(timer);
  timer = 0;
  if (!s) {
    room = null;
    lastUntil = null;
    saidCleanup = saidMinute = false;
    draw();
    return;
  }
  room = { until: s.until, cleanup: s.cleanup === true, bellOffsetSeconds: s.bellOffsetSeconds ?? 0 };
  if (s.until !== lastUntil) {
    lastUntil = s.until;
    if (s.until - serverClock.now() > 60_000) saidMinute = false;
  }
  if (!room.cleanup) saidCleanup = false; // "Keep the music going", then cleanup again: said again
  draw();
}
