import assert from 'node:assert/strict';
import test from 'node:test';
import { COOLDOWN_DAYS, DEFAULT_SETTINGS, RECENT_KEEP_DAYS, RECENT_MAX } from '../shared/protocol.js';
import {
  DAY_MS, backWhen, mergeRecent, notePlayed, playedWhen, pruneRecent, readRecent, recentValue, restUntil, restingEvidence,
  restingFor, restingList, restingUntilLabel, sameSong, songKey,
} from '../shared/repeats.js';
import {
  addSuggestion, addToReview, allowBlocked, migrateRoomState, newRoomState, nextSong, refusalMessage, suggestRefusal, unplay,
} from '../shared/queue.js';
import { validateSettings } from '../shared/settings.js';

const s = (title, artist, id = `it:${title}|${artist}`) => ({ id, title, artist, album: '', artwork: '', durationMs: 1, explicit: 'notExplicit', previewUrl: '' });

// ---- song keys: the tricky pairs (Dalton's list) ----

test('song key: versions of one song are the same song', () => {
  const same = [
    [s('Blinding Lights', 'The Weeknd'), s('Blinding Lights (Remix)', 'The Weeknd')],
    [s('Shake It Off', 'Taylor Swift'), s("Shake It Off (Taylor's Version)", 'Taylor Swift')],
    [s('Heat Waves', 'Glass Animals'), s('Heat Waves - Sped Up', 'Glass Animals')],
    [s('Heat Waves', 'Glass Animals'), s('Heat Waves (Slowed + Reverb)', 'Glass Animals')],
    [s('Levitating', 'Dua Lipa'), s('Levitating (feat. DaBaby)', 'Dua Lipa feat. DaBaby')],
    [s('Mr. Brightside', 'The Killers'), s('Mr Brightside - Radio Edit', 'The Killers')],
    [s('Señorita', 'Shawn Mendes & Camila Cabello'), s('Senorita', 'Shawn Mendes')],
    [s('Bohemian Rhapsody', 'Queen'), s('Bohemian Rhapsody (Remastered 2011)', 'Queen')],
    [s('Stay', 'The Kid LAROI & Justin Bieber'), s('STAY [Clean]', 'The Kid LAROI, Justin Bieber')],
    [s('Wonderwall', 'Oasis'), s('Wonderwall (Live)', 'Oasis')],
  ];
  for (const [a, b] of same) {
    assert.equal(songKey(a), songKey(b), `${a.title} = ${b.title}`);
    assert.equal(sameSong(a, b), true);
  }
});

test('song key: different songs stay different', () => {
  const differ = [
    [s('Happy', 'Pharrell Williams'), s('Happy Now', 'Pharrell Williams')],
    [s('Hello', 'Adele'), s('Hello', 'Lionel Richie')],
    [s('Yellow', 'Coldplay'), s('Yellow Submarine', 'Coldplay')],
    [s('Bad', 'Michael Jackson'), s('Bad Guy', 'Michael Jackson')],
    [s('Bad', 'Michael Jackson'), s('Bad Guy', 'Billie Eilish')],
    [s('Hello', 'Adele'), s('Hello from the Other Side', 'Adele')],
    [s('Stay', 'Rihanna'), s('Stay', 'The Kid LAROI & Justin Bieber')],
  ];
  for (const [a, b] of differ) {
    assert.notEqual(songKey(a), songKey(b), `${a.title} (${a.artist}) ≠ ${b.title} (${b.artist})`);
    assert.equal(sameSong(a, b), false);
  }
});

test('song key: case, accents and punctuation do not matter; no title or artist = no key', () => {
  assert.equal(songKey(s('HAPPY!', 'pharrell williams')), songKey(s('Happy', 'Pharrell Williams')));
  assert.equal(songKey(s('', 'Adele')), null);
  assert.equal(songKey(s('Hello', '')), null);
  assert.equal(songKey(null), null);
  assert.equal(sameSong(s('A', 'B', 'it:1'), s('Other', 'Else', 'it:1')), true, 'same id');
});

// ---- the queue rules: played and duplicate by song key ----

function room() {
  const r = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, maxWaitingPerStudent: 10 }, 1000);
  r.students.devAAAAAAAAAAAAAAAA = { nick: 'Ana', joinedAt: 1 };
  r.students.devBBBBBBBBBBBBBBBB = { nick: 'Ben', joinedAt: 1 };
  return r;
}
const A = 'devAAAAAAAAAAAAAAAA';
const B = 'devBBBBBBBBBBBBBBBB';

test('queue: a remix of a played song counts as played; a different song does not', () => {
  const r = room();
  const orig = s('Blinding Lights', 'The Weeknd', 'it:1');
  assert.equal(addSuggestion(r, { device: A, nick: 'Ana', song: orig }).ok, true);
  nextSong(r);
  nextSong(r); // it played and ended
  assert.deepEqual(r.playedKeys, ['blinding lights|the weeknd']);
  const remix = s('Blinding Lights (Remix)', 'The Weeknd', 'it:2');
  assert.equal(suggestRefusal(r, B, remix.id), null, 'by id alone it is a new song');
  assert.equal(suggestRefusal(r, B, remix.id, remix), 'played');
  assert.deepEqual(addSuggestion(r, { device: B, nick: 'Ben', song: remix }), { ok: false, reason: 'played' });
  assert.equal(addSuggestion(r, { device: B, nick: 'Ben', song: s('Save Your Tears', 'The Weeknd', 'it:3') }).ok, true);
  // A ban while playing un-plays every version.
  unplay(r, orig);
  assert.equal(suggestRefusal(r, B, remix.id, remix), null);
});

test('queue: another version of a waiting, playing or Needs a look song is a duplicate', () => {
  const r = room();
  addSuggestion(r, { device: A, nick: 'Ana', song: s('Heat Waves', 'Glass Animals', 'it:1') });
  const sped = s('Heat Waves - Sped Up', 'Glass Animals', 'it:2');
  assert.deepEqual(addSuggestion(r, { device: B, nick: 'Ben', song: sped }), { ok: false, reason: 'duplicate' });
  assert.deepEqual(addToReview(r, { device: B, nick: 'Ben', song: sped }), { ok: false, reason: 'duplicate' });
  nextSong(r); // now playing
  assert.equal(suggestRefusal(r, B, sped.id, sped), 'duplicate');
  const held = s('Shake It Off', 'Taylor Swift', 'it:5');
  assert.equal(addToReview(r, { device: A, nick: 'Ana', song: held }).ok, true);
  const tv = s("Shake It Off (Taylor's Version)", 'Taylor Swift', 'it:6');
  assert.equal(suggestRefusal(r, B, tv.id, tv), 'duplicate');
  assert.match(refusalMessage(r, 'duplicate', tv.id, tv), /checking it/);
  assert.deepEqual(allowBlocked(r, { song: tv, device: B, by: 'Ben' }), { ok: false, reason: 'duplicate' });
});

test('migrate: an old room gets playedKeys from its history and the default cooldown', () => {
  const r = room();
  delete r.playedKeys;
  delete r.restPending;
  delete r.settings.cooldownDays;
  r.history = [{ id: 's1', song: s('Yellow', 'Coldplay'), status: 'finished' }];
  migrateRoomState(r);
  assert.deepEqual(r.playedKeys, ['yellow|coldplay']);
  assert.deepEqual(r.restPending, {});
  assert.equal(r.settings.cooldownDays, 1);
});

// ---- the cooldown setting ----

test('cooldown setting: default 1 day, off is null, only the offered values', () => {
  assert.equal(DEFAULT_SETTINGS.cooldownDays, 1);
  assert.deepEqual(COOLDOWN_DAYS, [1, 3, 7, 14]);
  assert.equal(validateSettings({}).settings.cooldownDays, 1, 'saved settings without it read as 1');
  assert.equal(validateSettings({ cooldownDays: null }).settings.cooldownDays, null);
  for (const d of COOLDOWN_DAYS) assert.equal(validateSettings({ cooldownDays: d }).settings.cooldownDays, d);
  for (const bad of [0, 2, 5, 30, '1', true, 1.5, -1]) assert.equal(validateSettings({ cooldownDays: bad }).ok, false, String(bad));
  assert.equal(newRoomState('r', DEFAULT_SETTINGS).settings.cooldownDays, 1, 'a fresh room rests songs for 1 day');
});

// ---- cooldown math ----

test('cooldown: resting until exactly `days` after it played; the edge is free', () => {
  const at = Date.UTC(2026, 9, 5, 15);
  const map = {};
  notePlayed(map, s('Heat Waves', 'Glass Animals'), at);
  const sped = s('Heat Waves - Sped Up', 'Glass Animals', 'it:other');
  assert.equal(restUntil(at, 3), at + 3 * DAY_MS);
  assert.deepEqual(restingFor(map, sped, 3, at + 1), { key: 'heat waves|glass animals', at, until: at + 3 * DAY_MS });
  assert.ok(restingFor(map, sped, 3, at + 3 * DAY_MS - 1));
  assert.equal(restingFor(map, sped, 3, at + 3 * DAY_MS), null, 'exactly at until: back');
  assert.equal(restingFor(map, sped, 1, at + 2 * DAY_MS), null);
  assert.ok(restingFor(map, sped, 14, at + 13 * DAY_MS));
  assert.equal(restingFor(map, s('Heat Waves', 'Someone Else'), 3, at + 1), null, 'another artist');
});

test('cooldown off: nothing ever rests', () => {
  const map = {};
  notePlayed(map, s('Yellow', 'Coldplay'), 1000);
  for (const off of [null, undefined, 0]) {
    assert.equal(restingFor(map, s('Yellow', 'Coldplay'), off, 1001), null);
    assert.deepEqual(restingList(map, off, 1001), []);
  }
});

test('cooldown: a later play moves the time up, never back; merge keeps the newest', () => {
  const map = {};
  notePlayed(map, s('Yellow', 'Coldplay'), 5000);
  notePlayed(map, s('Yellow (Live)', 'Coldplay'), 3000);
  assert.equal(map['yellow|coldplay'].at, 5000);
  const merged = mergeRecent({ 'yellow|coldplay': { at: 9000, title: 'Yellow', artist: 'Coldplay' } }, map);
  assert.equal(merged['yellow|coldplay'].at, 9000);
  mergeRecent(merged, { 'bad|x': { at: 1, title: 'Bad', artist: 'X' } });
  assert.ok(merged['bad|x']);
});

test('restingList: only songs still resting, soonest back first', () => {
  const now = 100 * DAY_MS;
  const map = {
    'a|x': { at: now - 0.5 * DAY_MS, title: 'A', artist: 'X' },
    'b|x': { at: now - 2 * DAY_MS, title: 'B', artist: 'X' },
    'c|x': { at: now - 0.9 * DAY_MS, title: 'C', artist: 'X' },
  };
  assert.deepEqual(restingList(map, 1, now).map((e) => e.key), ['c|x', 'a|x']);
  assert.deepEqual(restingList(map, 3, now).map((e) => e.key), ['b|x', 'c|x', 'a|x']);
});

// ---- the KV record: read back safely, pruned, capped ----

test('record: pruned to RECENT_KEEP_DAYS and capped at RECENT_MAX (the newest stay)', () => {
  const now = 1000 * DAY_MS;
  const map = { old: { at: now - (RECENT_KEEP_DAYS + 1) * DAY_MS, title: 'Old', artist: 'X' }, edge: { at: now - RECENT_KEEP_DAYS * DAY_MS, title: 'Edge', artist: 'X' } };
  assert.equal(pruneRecent(map, now), 1);
  assert.deepEqual(Object.keys(map), ['edge']);
  const big = {};
  for (let i = 0; i < RECENT_MAX + 50; i++) big[`k${i}`] = { at: now - i * 1000, title: `T${i}`, artist: 'X' };
  assert.equal(pruneRecent(big, now), 50);
  assert.equal(Object.keys(big).length, RECENT_MAX);
  assert.ok(big.k0 && big[`k${RECENT_MAX - 1}`] && !big[`k${RECENT_MAX}`]);
});

test('record: read back keeps good entries only, songs only', () => {
  const map = readRecent({ v: 1, songs: { 'a|x': { at: 5, title: 'A', artist: 'X', device: 'nope' }, bad: { at: 'x' }, nul: null } });
  assert.deepEqual(map, { 'a|x': { at: 5, title: 'A', artist: 'X' } });
  assert.deepEqual(readRecent(null), {});
  assert.deepEqual(readRecent('junk'), {});
  assert.deepEqual(recentValue(map), { v: 1, songs: map });
});

// ---- words for the pages (local time) ----

test('words: weekday names within a week, a short date beyond', () => {
  const mon = new Date(2026, 9, 5, 10, 0).getTime(); // Monday 5 Oct 2026, 10:00 local
  const wed = new Date(2026, 9, 7, 9, 0).getTime();
  const thu = new Date(2026, 9, 8, 10, 0).getTime();
  assert.equal(restingEvidence(mon, thu, wed), 'This song played on Monday. It can come back tomorrow.');
  assert.equal(restingEvidence(mon, new Date(2026, 9, 9, 10).getTime(), wed), 'This song played on Monday. It can come back on Friday.');
  assert.equal(playedWhen(new Date(2026, 9, 6, 22).getTime(), wed), 'yesterday');
  assert.equal(playedWhen(new Date(2026, 9, 7, 8).getTime(), wed), 'earlier today');
  assert.equal(playedWhen(new Date(2026, 8, 25, 8).getTime(), wed), 'on Sep 25');
  assert.equal(backWhen(new Date(2026, 9, 7, 14, 15).getTime(), wed), 'later today at 2:15 PM');
  assert.equal(backWhen(new Date(2026, 9, 21, 9).getTime(), wed), 'on Oct 21');
  assert.equal(restingUntilLabel(thu, wed), 'until tomorrow');
  assert.equal(restingUntilLabel(new Date(2026, 9, 10, 9).getTime(), wed), 'until Sat');
  assert.equal(restingUntilLabel(new Date(2026, 9, 7, 14, 15).getTime(), wed), 'until 2:15 PM');
  assert.equal(restingUntilLabel(new Date(2026, 9, 19, 9).getTime(), wed), 'until Oct 19');
});
