// Class time (Dalton, 2026-10-06): Max song length, Instrumentals only, class end + cleanup, the
// bell schedule presets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLEANUP_PAST_SLACK_MS, DEFAULT_SETTINGS, OPEN_MAX_MS, REASONS, SETTINGS_LIMITS, whyText } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';
import {
  AFTER_MIDNIGHT_MS, bellChoices, cleanupDue, defaultTimes, formatDuration, nextAlarmAt, nextBell, timeAhead, timeToday, timeValue, tooLong, validateTimes,
} from '../shared/classtime.js';
import {
  aiThemeCheck, filterSong, instrumentalHint, instrumentalOf, parseThemeVerdict, readInstrumental, readVerdict, verdictKey,
} from '../shared/filter.js';
import { filterWhy, canAllow, SINGING_EVIDENCE } from '../shared/reasons.js';
import { migrateRoomState, newRoomState, snapshotFor, suggestRefusal } from '../shared/queue.js';
import { toSong, trimResult } from '../shared/itunes.js';

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { map.set(k, v); },
  };
}
const song = (extra = {}) => ({ id: 'it:42', title: 'Happy', artist: 'Pharrell Williams', album: 'G I R L', explicit: 'notExplicit', durationMs: 233_000, ...extra });
const aiSays = (obj, counter) => ({ run: async () => { counter.n++; return { response: JSON.stringify(obj) }; } });

// ---- Settings ----

test('settings: Max song length (null = off, whole 1..20, default 5), Instrumentals only, cleanup minutes, bell schedule', () => {
  const d = validateSettings({}).settings;
  assert.deepEqual([d.maxSongMinutes, d.instrumentalsOnly, d.cleanupMinutes, d.bellSchedule], [5, false, 5, []]);
  assert.equal(validateSettings({ maxSongMinutes: null }).settings.maxSongMinutes, null);
  assert.equal(validateSettings({ maxSongMinutes: 20 }).settings.maxSongMinutes, 20);
  for (const bad of [0, 21, 2.5, '5', true, []]) assert.equal(validateSettings({ maxSongMinutes: bad }).ok, false, String(bad));
  for (const bad of ['yes', 1, null]) assert.equal(validateSettings({ instrumentalsOnly: bad }).ok, false, String(bad));
  assert.equal(validateSettings({ cleanupMinutes: 0 }).settings.cleanupMinutes, 0);
  for (const bad of [-1, 31, 1.5, 'x']) assert.equal(validateSettings({ cleanupMinutes: bad }).ok, false, String(bad));
  assert.deepEqual(SETTINGS_LIMITS.maxSongMinutes, [1, 20]);
});

test('settings saved before class time read as the defaults', () => {
  const old = { maxWaitingPerStudent: 3, removeAtScore: -4, blockUnknownSongs: true, aiCheck: true, blocklist: ['beer'], startingCredits: 5, allowJump: true };
  const v = validateSettings(old);
  assert.equal(v.ok, true);
  assert.deepEqual(v.settings, { ...DEFAULT_SETTINGS, ...old, bellSchedule: [] });
});

test('bell schedule: names screened and capped, times as HH:MM 24-hour, sorted by time, at most 12', () => {
  const v = validateSettings({ bellSchedule: [{ name: ' P2 ', ends: '10:10' }, { name: 'P1', ends: '8:55' }, { name: 'Lunch  break', ends: '23:59' }] });
  assert.deepEqual(v.settings.bellSchedule, [{ name: 'P1', ends: '08:55' }, { name: 'P2', ends: '10:10' }, { name: 'Lunch break', ends: '23:59' }]);
  for (const bad of [
    [{ name: '', ends: '10:00' }], [{ name: 'x'.repeat(SETTINGS_LIMITS.bellName + 1), ends: '10:00' }], [{ name: 'P1', ends: '24:00' }],
    [{ name: 'P1', ends: '10:60' }], [{ name: 'P1', ends: '10am' }], [{ name: 'P1' }], ['P1'], 'P1 10:00', [{ name: 'fuck', ends: '10:00' }],
    Array.from({ length: 13 }, (_, i) => ({ name: `P${i}`, ends: `${String(i + 7).padStart(2, '0')}:00` })),
  ]) assert.equal(validateSettings({ bellSchedule: bad }).ok, false, JSON.stringify(bad).slice(0, 60));
  const rude = validateSettings({ bellSchedule: [{ name: 'fuck', ends: '10:00' }] });
  assert.ok(!rude.errors.join(' ').toLowerCase().includes('fu'), 'the word is never repeated');
});

// ---- Max song length ----

test('too long: off, unknown length and exactly the limit pass; longer is refused with the times', () => {
  assert.equal(formatDuration(432_000), '7:12');
  assert.equal(formatDuration(300_000), '5:00');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  const s = { maxSongMinutes: 5 };
  assert.equal(tooLong(song({ durationMs: 300_000 }), s), null);
  assert.equal(tooLong(song({ durationMs: 0 }), s), null);
  assert.equal(tooLong(song({ durationMs: 432_000 }), { maxSongMinutes: null }), null);
  assert.equal(tooLong(song({ durationMs: 432_000 }), s).evidence, 'This song is 7:12; the limit is 5:00.');
  assert.equal(whyText({ id: 'too_long', evidence: 'This song is 7:12; the limit is 5:00.' }), '⏱ Too long: This song is 7:12; the limit is 5:00.');
  assert.equal(REASONS.not_instrumental.student, 'Instrumentals only right now');
});

// ---- Instrumentals only ----

test('instrumental: the answer, title/album words, weak genre hints', () => {
  assert.equal(parseThemeVerdict('{"verdict":"OK","instrumental":true}').instrumental, true);
  assert.equal(parseThemeVerdict('{"verdict":"OK","instrumental":"false"}').instrumental, false);
  assert.equal(parseThemeVerdict('{"verdict":"OK","instrumental":"maybe"}').instrumental, 'unknown');
  assert.equal(parseThemeVerdict('{"verdict":"OK"}').instrumental, 'unknown');
  assert.equal(readVerdict({ verdict: 'ok', category: 'other', evidence: '' }).instrumental, null, 'a v4 verdict: not asked');
  assert.equal(readVerdict({ verdict: 'ok', category: 'other', evidence: '', instrumental: false }).instrumental, false);
  assert.deepEqual(['yes', 'no', 'x', true].map(readInstrumental), [true, false, 'unknown', true]);
  assert.equal(instrumentalHint(song({ title: 'Happy (Instrumental)' })), true);
  assert.equal(instrumentalHint(song({ album: 'Karaoke Hits, Vol. 3' })), true);
  assert.equal(instrumentalHint(song({ title: 'Coffee Shop', album: 'lofi beats to study to' })), true);
  assert.equal(instrumentalHint(song({ title: 'Lo-Fi Beats' })), true);
  assert.equal(instrumentalHint(song({ title: 'Africa (A Cappella)' })), false);
  assert.equal(instrumentalHint(song()), null);
  // Title words beat the AI (it sees "Happy" without the version words).
  assert.equal(instrumentalOf(song({ title: 'Happy (Instrumental)' }), false), true);
  assert.equal(instrumentalOf(song(), false), false);
  assert.equal(instrumentalOf(song(), true), true);
  // Weak hints only when the AI is not sure.
  assert.equal(instrumentalOf(song({ genre: 'Classical' }), 'unknown'), true);
  assert.equal(instrumentalOf(song({ genre: 'Soundtrack' }), false), false);
  assert.equal(instrumentalOf(song({ title: 'Nocturne in E-Flat Major, Op. 9 No. 2' }), null), true);
  assert.equal(instrumentalOf(song({ genre: 'Pop' }), 'unknown'), 'unknown');
});

test('instrumentals: a v4 OK is used as it is while Instrumentals only is off (no AI call)', async () => {
  const kv = fakeKv();
  const n = { n: 0 };
  kv.map.set(verdictKey('it:42', 4), JSON.stringify({ verdict: 'ok', category: 'other', evidence: '' }));
  const env = { CLASS_KV: kv, AI: aiSays({ verdict: 'OK', instrumental: false }, n) };
  const r = await filterSong(song(), { settings: { ...DEFAULT_SETTINGS }, env });
  assert.deepEqual([r.ok, n.n], [true, 0]);
});

test('instrumentals: a v4 OK without the field is asked once, then the v5 answer is cached', async () => {
  const kv = fakeKv();
  const n = { n: 0 };
  kv.map.set(verdictKey('it:42', 4), JSON.stringify({ verdict: 'ok', category: 'other', evidence: '' }));
  const env = { CLASS_KV: kv, AI: aiSays({ verdict: 'OK', category: 'other', evidence: '', instrumental: false }, n) };
  const settings = { ...DEFAULT_SETTINGS, instrumentalsOnly: true };
  const r = await filterSong(song(), { settings, env });
  assert.deepEqual([r.ok, r.reason, n.n], [false, 'not_instrumental', 1]);
  assert.equal(JSON.parse(kv.map.get(verdictKey('it:42'))).instrumental, false);
  const again = await filterSong(song(), { settings, env });
  assert.deepEqual([again.reason, n.n], ['not_instrumental', 1], 'cached: no second call');
  const w = filterWhy(song(), again);
  assert.deepEqual(w.why, { id: 'not_instrumental', evidence: SINGING_EVIDENCE });
  assert.ok(w.detail.includes('Instrumentals only'));
  assert.equal(canAllow({ source: 'filter', status: null, why: w.why }), true, 'the teacher may Allow anyway');
});

test('instrumentals: title words need no AI call; unsure waits for a look; a theme "no" still wins', async () => {
  const n = { n: 0 };
  const settings = { ...DEFAULT_SETTINGS, instrumentalsOnly: true };
  const kv = fakeKv();
  kv.map.set(verdictKey('it:7', 4), JSON.stringify({ verdict: 'ok', category: 'other', evidence: '' }));
  const inst = await filterSong(song({ id: 'it:7', title: 'Some Song (Instrumental)' }), { settings, env: { CLASS_KV: kv, AI: aiSays({}, n) } });
  assert.deepEqual([inst.ok, n.n], [true, 0]);
  const unsure = await filterSong(song({ id: 'it:8', title: 'Obscure' }), { settings, env: { CLASS_KV: fakeKv(), AI: aiSays({ verdict: 'OK', instrumental: 'unknown' }, n) } });
  assert.deepEqual([unsure.reason, unsure.instrumental], ['review', 'unknown']);
  assert.ok(filterWhy(song(), unsure).detail.includes('not sure'));
  const passes = await filterSong(song({ id: 'it:8b', title: 'Obscure' }), { settings: { ...settings, blockUnknownSongs: false }, env: { CLASS_KV: fakeKv(), AI: aiSays({ verdict: 'OK', instrumental: 'unknown' }, n) } });
  assert.equal(passes.ok, true, 'unsure passes while "ask me first" is off');
  const no = await filterSong(song({ id: 'it:9' }), { settings, env: { CLASS_KV: fakeKv(), AI: aiSays({ verdict: 'INAPPROPRIATE', category: 'drugs', evidence: 'x', instrumental: true }, n) } });
  assert.equal(no.reason, 'theme');
});

test('instrumentals: a teacher-approved song is asked only for the instrumental answer; AI off reads the cache only', async () => {
  const n = { n: 0 };
  const kv = fakeKv();
  kv.map.set('approved:42', '{"id":"it:42"}');
  const env = { CLASS_KV: kv, AI: aiSays({ verdict: 'INAPPROPRIATE', category: 'other', evidence: 'x', instrumental: true }, n) };
  const r = await aiThemeCheck(song(), env, { instrumental: true });
  assert.deepEqual([r.verdict, r.source, r.instrumental, n.n], ['ok', 'teacher', true, 1]);
  assert.equal((await aiThemeCheck(song(), env)).instrumental, null, 'not needed: no call, not asked');
  assert.equal(n.n, 1);
  const off = await filterSong(song({ id: 'it:77' }), { settings: { ...DEFAULT_SETTINGS, aiCheck: false, instrumentalsOnly: true }, env: { CLASS_KV: fakeKv(), AI: aiSays({}, n) } });
  assert.deepEqual([off.reason, n.n], ['review', 1], 'AI off: nothing known, so it waits for a look (no call)');
});

test('instrumentals: AI trouble fails closed (unknown → Needs a look)', async () => {
  const settings = { ...DEFAULT_SETTINGS, instrumentalsOnly: true };
  const env = { CLASS_KV: fakeKv(), AI: { run: async () => { throw new Error('down'); } } };
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await filterSong(song(), { settings, env });
    assert.equal(r.reason, 'review');
  } finally {
    console.error = orig;
  }
});

test('songs carry the iTunes genre (a weak hint)', () => {
  const raw = { kind: 'song', trackId: 5, trackName: 'Canon in D', artistName: 'Pachelbel', collectionName: 'Baroque', primaryGenreName: 'Classical',
    previewUrl: 'https://audio-ssl.itunes.apple.com/a.m4a', trackTimeMillis: 300000, extra: 'x' };
  assert.equal(trimResult(raw).primaryGenreName, 'Classical');
  assert.equal(toSong(trimResult(raw)).genre, 'Classical');
});

// ---- Class end + cleanup ----

test('class times: until within a day, cleanup before class ends and not in the past (a minute box: now)', () => {
  const now = 1_000_000_000_000;
  const until = now + 70 * 60_000;
  assert.deepEqual(validateTimes({ until, cleanupAt: null }, now), { ok: true, until, cleanupAt: null });
  assert.deepEqual(validateTimes({ until }, now), { ok: true, until, cleanupAt: null });
  assert.equal(validateTimes({ until, cleanupAt: until - 5 * 60_000 }, now).cleanupAt, until - 5 * 60_000);
  assert.equal(validateTimes({ until, cleanupAt: now - 30_000 }, now).cleanupAt, now, 'just passed: now');
  assert.equal(validateTimes({ until, cleanupAt: now - CLEANUP_PAST_SLACK_MS - 1 }, now).error, 'cleanup');
  assert.equal(validateTimes({ until, cleanupAt: until }, now).error, 'cleanup');
  assert.equal(validateTimes({ until, cleanupAt: '10:00' }, now).error, 'cleanup');
  assert.equal(validateTimes({ until: now - 1 }, now).error, 'until');
  assert.match(validateTimes({ until: now - 1 }, now).message, /passed/);
  assert.equal(validateTimes({ until: now + OPEN_MAX_MS + 1 }, now).error, 'until');
  assert.equal(validateTimes({ until: 'soon' }, now).error, 'until');
});

test('the alarm rings at the earliest of cleanup (not started), class end and idle; cleanup is due once', () => {
  const room = { open: true, until: 5000, lastActivity: 0, cleanupAt: 3000, cleanup: false };
  assert.equal(nextAlarmAt(room, 10_000), 3000);
  assert.equal(nextAlarmAt({ ...room, cleanup: true }, 10_000), 5000);
  assert.equal(nextAlarmAt({ ...room, cleanupAt: null }, 10_000), 5000);
  assert.equal(nextAlarmAt({ ...room, cleanupAt: null }, 1000), 1000);
  assert.equal(cleanupDue(room, 2999), false);
  assert.equal(cleanupDue(room, 3000), true);
  assert.equal(cleanupDue({ ...room, cleanup: true }, 4000), false);
  assert.equal(cleanupDue({ ...room, cleanupAt: null }, 4000), false);
  assert.equal(cleanupDue({ ...room, open: false }, 4000), false);
});

test('cleanup mode closes suggestions; rooms saved before class time get the fields', () => {
  const room = newRoomState('r', { ...DEFAULT_SETTINGS }, 0, 10_000);
  assert.deepEqual([room.cleanupAt, room.cleanup], [null, false]);
  room.cleanup = true;
  assert.equal(suggestRefusal(room, 'd'.repeat(16), 'it:1'), 'cleanup');
  const host = snapshotFor(room, null);
  assert.deepEqual([host.cleanup, host.cleanupAt], [true, null]);
  const student = snapshotFor({ ...room, settings: { ...room.settings, bellSchedule: [{ name: 'P1', ends: '08:00' }] } }, 'd'.repeat(16));
  assert.equal(student.settings.bellSchedule, undefined, 'students never get the bell names');
  const { cleanupAt, cleanup, ...old } = newRoomState('r', { ...DEFAULT_SETTINGS }, 0, 10_000);
  const { maxSongMinutes, instrumentalsOnly, cleanupMinutes, bellSchedule, ...oldSettings } = old.settings;
  const migrated = migrateRoomState({ ...old, settings: oldSettings });
  assert.deepEqual([migrated.cleanupAt, migrated.cleanup, migrated.settings.maxSongMinutes, migrated.settings.instrumentalsOnly, migrated.settings.bellSchedule],
    [null, false, 5, false, []]);
});

// ---- Time boxes and bell presets (the teacher's own time zone) ----

test('time boxes: HH:MM today, never tomorrow; the prefill is one period away, cleanup minutes before', () => {
  const now = new Date(2026, 9, 6, 9, 0, 30);
  assert.equal(timeToday('10:10', now), new Date(2026, 9, 6, 10, 10).getTime());
  assert.equal(timeToday('08:00', now), new Date(2026, 9, 6, 8, 0).getTime(), 'past: still today');
  for (const bad of ['', '25:00', '10:61', 'ten', null]) assert.equal(timeToday(bad, now), null);
  assert.equal(timeValue(new Date(2026, 9, 6, 7, 5).getTime()), '07:05');
  assert.deepEqual(defaultTimes({ periodMinutes: 70, cleanupMinutes: 5 }, now), { classEnd: '10:11', cleanup: '10:06' });
  assert.deepEqual(defaultTimes({ periodMinutes: 50, cleanupMinutes: 0 }, now), { classEnd: '09:51', cleanup: '' });
  assert.deepEqual(defaultTimes({}, new Date(2026, 9, 6, 9, 0)), { classEnd: '10:10', cleanup: '10:05' });
});

test('after midnight (Dalton, 2026-10-07): opened at 22:58, one period ends after midnight (tomorrow), not "passed"', () => {
  const now = new Date(2026, 9, 6, 22, 58, 20);
  const d = defaultTimes({ periodMinutes: 70, cleanupMinutes: 5 }, now);
  assert.deepEqual(d, { classEnd: '00:09', cleanup: '00:04' });
  const until = timeAhead(d.classEnd, now);
  assert.equal(until, new Date(2026, 9, 7, 0, 9).getTime(), 'tomorrow');
  const cleanupAt = timeAhead(d.cleanup, now, { pastSlackMs: CLEANUP_PAST_SLACK_MS });
  assert.equal(cleanupAt, new Date(2026, 9, 7, 0, 4).getTime());
  const v = validateTimes({ until, cleanupAt }, now.getTime());
  assert.equal(v.ok, true, v.message);
  // The old reading (today's 00:09) was refused as passed: that was the bug.
  assert.equal(validateTimes({ until: timeToday(d.classEnd, now) }, now.getTime()).ok, false);
  // A custom time after midnight, and the end of the window.
  assert.equal(timeAhead('01:30', now), new Date(2026, 9, 7, 1, 30).getTime());
  assert.equal(timeAhead('04:58', now) - now.getTime() <= AFTER_MIDNIGHT_MS, true);
  assert.equal(timeAhead('05:30', now), new Date(2026, 9, 6, 5, 30).getTime(), 'too far ahead: today (passed)');
  // A later time today stays today; a passed time in the day is still "passed" (a typo, not a 24-hour room).
  assert.equal(timeAhead('23:30', now), new Date(2026, 9, 6, 23, 30).getTime());
  const morning = new Date(2026, 9, 6, 10, 0);
  assert.equal(timeAhead('09:50', morning), new Date(2026, 9, 6, 9, 50).getTime());
  assert.equal(validateTimes({ until: timeAhead('09:50', morning) }, morning.getTime()).ok, false);
  // Cleanup a minute ago (the minute box): today, moved to now by validateTimes, never tomorrow.
  assert.equal(timeAhead('22:57', now, { pastSlackMs: CLEANUP_PAST_SLACK_MS }), new Date(2026, 9, 6, 22, 57).getTime());
  // OPEN_MAX_MS still caps: a rolled time is never more than a day away.
  assert.ok(until - now.getTime() <= OPEN_MAX_MS);
  for (const bad of ['', '24:00', 'x']) assert.equal(timeAhead(bad, now), null);
});

test('bell presets: the next one to ring; passed ones are greyed out; at midnight nothing is next', () => {
  const bells = [{ name: 'P1', ends: '08:55' }, { name: 'P2', ends: '10:10' }, { name: 'P3', ends: '11:25' }];
  const at = (h, m, s = 0) => new Date(2026, 9, 6, h, m, s);
  assert.equal(nextBell(bells, at(7, 0)), 0);
  assert.equal(nextBell(bells, at(9, 0)), 1);
  assert.equal(nextBell(bells, at(10, 9, 55)), 2, 'a bell seconds away has passed (a room needs 10 s)');
  assert.equal(nextBell(bells, at(12, 0)), -1);
  assert.equal(nextBell([], at(9, 0)), -1);
  const list = bellChoices(bells, at(9, 0));
  assert.deepEqual(list.map((b) => b.passed), [true, false, false]);
  assert.equal(list[1].at, at(10, 10).getTime());
  // Midnight: "00:05" is today's (already passed at 23:50), never tomorrow's.
  const late = [{ name: 'Late', ends: '00:05' }, { name: 'Night', ends: '23:55' }];
  assert.equal(nextBell(late, at(23, 50)), 1);
  assert.equal(nextBell(late, at(23, 56)), -1);
  assert.equal(bellChoices(late, at(0, 1))[0].passed, false);
  // Unsorted input still finds the earliest upcoming bell.
  assert.equal(nextBell([bells[2], bells[1]], at(9, 0)), 1);
});
