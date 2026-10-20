// Bell countdown, bell offset and the server clock (protocol.js BELL OFFSET, SERVER CLOCK).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '../shared/protocol.js';
import { bellOffsetMs, bellPill, bellTime, countdownText, endOfDay, shiftTimes, validateTimes } from '../shared/classtime.js';
import { CLOCK_OUTLIER_MS, CLOCK_SAMPLES, createServerClock, estimateOffset } from '../shared/servertime.js';
import { validateSettings } from '../shared/settings.js';
import { boardSnapshot, newRoomState, snapshotFor } from '../shared/queue.js';

test('bell offset setting: default 0, -120..120 whole seconds, saved settings without it read as 0', () => {
  assert.equal(DEFAULT_SETTINGS.bellOffsetSeconds, 3);
  assert.deepEqual(SETTINGS_LIMITS.bellOffsetSeconds, [-120, 120]);
  assert.equal(validateSettings({}).settings.bellOffsetSeconds, 3);
  for (const ok of [-120, -5, 0, 3, 120]) assert.equal(validateSettings({ bellOffsetSeconds: ok }).settings.bellOffsetSeconds, ok);
  for (const bad of [-121, 121, 1.5, 'x', null, true]) assert.equal(validateSettings({ bellOffsetSeconds: bad }).ok, false, String(bad));
});

test('offset math: typed bell times + offset = the real moments; shown as real - offset', () => {
  assert.equal(bellOffsetMs(3), 3000);
  assert.equal(bellOffsetMs({ bellOffsetSeconds: -5 }), -5000);
  assert.equal(bellOffsetMs({}), 0);
  assert.equal(bellOffsetMs(null), 0);
  assert.equal(bellOffsetMs(2.5), 0);
  assert.deepEqual(shiftTimes({ until: 1_000_000, cleanupAt: 700_000 }, 3), { until: 1_003_000, cleanupAt: 703_000 });
  assert.deepEqual(shiftTimes({ until: 1_000_000, cleanupAt: null }, -120), { until: 880_000, cleanupAt: null });
  assert.deepEqual(shiftTimes({ until: 1_000_000 }, 0), { until: 1_000_000, cleanupAt: null });
  assert.equal(shiftTimes({ until: 'x' }, 3).until, 'x', 'garbage stays garbage for validateTimes to refuse');
  assert.equal(bellTime(1_003_000, 3), 1_000_000);
  assert.equal(bellTime(shiftTimes({ until: 42_000 }, -7).until, -7), 42_000, 'round trip');
  // Checked as real moments: +120 s past a class end 30 s ahead is fine; -120 s makes it passed.
  const now = 10_000_000;
  assert.equal(validateTimes(shiftTimes({ until: now + 30_000 }, 120), now).ok, true);
  assert.equal(validateTimes(shiftTimes({ until: now + 30_000 }, -120), now).ok, false);
  // A cleanup typed "now" with +3: starts 3 s from now.
  assert.equal(validateTimes(shiftTimes({ until: now + 600_000, cleanupAt: now }, 3), now).cleanupAt, now + 3000);
});

test('countdown text: mm:ss, h:mm:ss from an hour, rounded up, never negative', () => {
  assert.equal(countdownText(754_000), '12:34');
  assert.equal(countdownText(753_001), '12:34', 'rounded up: 0:01 until it is over');
  assert.equal(countdownText(45_000), '0:45');
  assert.equal(countdownText(1), '0:01');
  assert.equal(countdownText(0), '0:00');
  assert.equal(countdownText(-5000), '0:00');
  assert.equal(countdownText(3_600_000), '1:00:00');
  assert.equal(countdownText(3_725_000), '1:02:05');
  assert.equal(countdownText(59 * 60_000 + 59_500), '1:00:00');
});

test('the student bell pill: "🔔 Bell in 12:34", in cleanup "🧹 Cleanup! Bell in 0:45"; none for the end of the day', () => {
  const now = new Date(2026, 9, 7, 10, 0, 0).getTime();
  const p = bellPill({ until: now + 754_000, cleanup: false, bellOffsetSeconds: 0 }, now);
  assert.equal(p.text, '🔔 Bell in 12:34');
  assert.equal(p.cleanup, false);
  assert.equal(p.left, 754_000);
  const c = bellPill({ until: now + 45_000, cleanup: true, bellOffsetSeconds: 3 }, now);
  assert.equal(c.text, '🧹 Cleanup! Bell in 0:45');
  assert.equal(c.clock, '0:45');
  assert.equal(bellPill({ until: now + 2 * 3_600_000, cleanup: false }, now).text, '🔔 Bell in 2:00:00');
  assert.equal(bellPill({ until: now - 1000, cleanup: true }, now).text, '🧹 Cleanup! Bell in 0:00');
  const endOfToday = new Date(2026, 9, 7, 23, 59, 59).getTime();
  assert.equal(endOfDay(endOfToday), true);
  assert.equal(bellPill({ until: endOfToday + 3000, bellOffsetSeconds: 3 }, now), null, 'the end of today has no bell (offset included)');
  assert.equal(bellPill(null, now), null);
  assert.equal(bellPill({ until: null }, now), null);
});

test('clock offset: median of the samples, outliers ignored', () => {
  assert.equal(estimateOffset([]), 0);
  assert.equal(estimateOffset([500]), 500);
  assert.equal(estimateOffset([100, 120, 110]), 110);
  assert.equal(estimateOffset([100, 120, 110, 30_000]), 110, 'a stale message (30 s late) is ignored');
  assert.equal(estimateOffset([100, 120, 110, -30_000, 30_000]), 110);
  assert.equal(estimateOffset([NaN, 200, Infinity]), 200);
  assert.equal(CLOCK_OUTLIER_MS, 1000);
});

test('server clock: a Chromebook 7 minutes slow still counts down on server time', () => {
  let local = 1_000_000; // the page's own (wrong) clock
  const skew = 7 * 60_000; // the server is 7 minutes ahead
  const clock = createServerClock(() => local);
  assert.equal(clock.now(), local, 'no sample yet: the page clock');
  for (let i = 0; i < 5; i++) {
    clock.sample(local + skew - 40 - i * 5); // 40-60 ms in transit
    local += 1000;
  }
  assert.ok(Math.abs(clock.now() - (local + skew)) < 100, `offset ${clock.offset}`);
  clock.sample(local + skew - 45_000); // one message held up 45 s in a sleeping tab
  assert.ok(Math.abs(clock.offset - skew) < 100, 'the late one does not move it');
  for (let i = 0; i < 20; i++) clock.sample(local + skew - 50);
  assert.equal(clock.samples, CLOCK_SAMPLES, 'only the last samples are kept');
  clock.sample(NaN);
  assert.equal(clock.samples, CLOCK_SAMPLES);
  clock.reset();
  assert.equal(clock.offset, 0);
});

test('every State carries serverNow and bellOffsetSeconds (student, host, board)', () => {
  const s = newRoomState('r1', { ...DEFAULT_SETTINGS, bellOffsetSeconds: 3 }, 1000, 999_000);
  const now = 123_456;
  assert.equal(snapshotFor(s, null, { now }).serverNow, now);
  assert.equal(snapshotFor(s, 'device-aaaaaaaaaaaaaaaa', { now }).bellOffsetSeconds, 3);
  assert.equal(snapshotFor(s, null, { now }).bellOffsetSeconds, 3);
  const b = boardSnapshot(s);
  assert.equal(b.bellOffsetSeconds, 3);
  assert.ok(Number.isFinite(b.serverNow));
  const old = newRoomState('r2', { ...DEFAULT_SETTINGS, bellOffsetSeconds: undefined }, 1000, 999_000);
  assert.equal(snapshotFor(old, null).bellOffsetSeconds, 0, 'a room from before the setting: 0');
});
