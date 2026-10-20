// Scores never go below 0 (protocol.js SCORE FLOOR, Dalton 2026-10-08).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';
import {
  addSuggestion, applyBlocklist, boardSnapshot, itemScore, jumpSong, migrateRoomState, newRoomState, nextSong,
  pruneLowScores, pushSong, snapshotFor, vote,
} from '../shared/queue.js';
import { recapOf, recapText, shownScore, top5View, topFive } from '../shared/highlights.js';

const A = 'deviceAAAAAAAAAAAAAA';
const voter = (n) => `voter${String(n).padStart(15, '0')}`;
const song = (n) => ({
  id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, album: 'Album', artwork: '', durationMs: 1000, explicit: 'notExplicit', previewUrl: 'https://x',
});

function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, hideVoteCounts: false, scoreFloor: false, downvoteMode: 'shown', ...settings }, 1000);
  s.students[A] = { nick: 'Ana', joinedAt: 1 };
  return s;
}
/** Song n waiting, with `up` 👍 and `down` 👎 from fresh voters (one 👎 each: the 👎 limit never bites). */
let next = 0;
function queued(s, n, { up = 0, down = 0, now = n } = {}) {
  const { item } = addSuggestion(s, { device: `${A}${n}`, nick: 'Ana', song: song(n), now });
  for (let i = 0; i < up; i++) vote(s, voter(++next), item.id, 1);
  for (let i = 0; i < down; i++) vote(s, voter(++next), item.id, -1);
  return item;
}
const order = (s) => snapshotFor(s, null).queue.map((q) => q.song.title);

test('settings: scoreFloor is ON by default (2026-10-08), a boolean; saved settings without it read on, old rooms off', () => {
  assert.equal(DEFAULT_SETTINGS.scoreFloor, true);
  assert.equal(validateSettings({}).settings.scoreFloor, true);
  const { scoreFloor, ...old } = DEFAULT_SETTINGS;
  assert.equal(validateSettings({ ...old, blocklist: [] }).settings.scoreFloor, true);
  assert.equal(validateSettings({ scoreFloor: false }).settings.scoreFloor, false);
  assert.equal(validateSettings({ scoreFloor: true }).settings.scoreFloor, true);
  for (const bad of ['yes', 1, null]) assert.equal(validateSettings({ scoreFloor: bad }).ok, false);
  // A room saved before the setting: off.
  const s = room();
  delete s.settings.scoreFloor;
  assert.equal(migrateRoomState(s).settings.scoreFloor, false);
});

test('itemScore: floored only when asked; up and down stay the real counts', () => {
  const item = { votes: { a: -1, b: -1, c: -1, d: 1 } };
  assert.deepEqual(itemScore(item), { score: -2, up: 1, down: 3 });
  assert.deepEqual(itemScore(item, true), { score: 0, up: 1, down: 3 });
  assert.deepEqual(itemScore({ votes: { a: 1, b: 1 } }, true), { score: 2, up: 2, down: 0 });
});

test('floor on: 3 👎 shows 0 everywhere and nothing is removed (any remove score)', () => {
  const s = room({ scoreFloor: true, removeAtScore: -1 });
  const item = queued(s, 1, { down: 3 });
  assert.equal(s.queue.length, 1);
  const r = vote(s, voter(++next), item.id, -1);
  assert.deepEqual(r, { ok: true, removed: false });
  assert.deepEqual(pruneLowScores(s), []);
  for (const snap of [snapshotFor(s, null), snapshotFor(s, A), boardSnapshot(s)]) {
    assert.equal(snap.queue[0].score, 0);
    assert.equal(snap.queue[0].down, 4);
  }
});

test('floor off: the old behaviour (negative scores, removal at the remove score)', () => {
  const s = room({ removeAtScore: -3 });
  const item = queued(s, 1, { down: 2 });
  assert.equal(snapshotFor(s, null).queue[0].score, -2);
  assert.deepEqual(vote(s, voter(++next), item.id, -1), { ok: true, removed: true });
  assert.equal(s.queue.length, 0);
});

test('floor on: ordering by floored score; ties → fewer 👎, then more 👍, then added first', () => {
  const s = room({ scoreFloor: true });
  queued(s, 1, { down: 3 }); // 0, 3 👎
  queued(s, 2); // 0, no votes
  queued(s, 3, { up: 1, down: 1 }); // 0, 1 👎 1 👍
  queued(s, 4, { up: 2, down: 2 }); // 0, 2 👎
  queued(s, 5, { up: 1 }); // +1
  queued(s, 6); // 0, no votes, added later than 2
  queued(s, 7, { up: 2, down: 1 }); // +1, 1 👎
  assert.deepEqual(order(s), ['Song 5', 'Song 7', 'Song 2', 'Song 6', 'Song 3', 'Song 4', 'Song 1']);
  // The stored queue (what nextSong plays) is the same order.
  assert.deepEqual(s.queue.map((i) => i.song.title), order(s));
  assert.equal(nextSong(s).song.title, 'Song 5');
});

test('floor off: the same songs keep the old order (raw score, then added first)', () => {
  const s = room({ removeAtScore: -50 });
  queued(s, 1, { down: 3 });
  queued(s, 2);
  queued(s, 3, { up: 1, down: 1 });
  assert.deepEqual(order(s), ['Song 2', 'Song 3', 'Song 1']);
});

test('floor on: pushed and jumped songs keep their precedence', () => {
  const s = room({ scoreFloor: true, startingCredits: 10, allowJump: true });
  queued(s, 1, { up: 3 });
  const low = queued(s, 2, { down: 3 });
  const jumped = queued(s, 3, { down: 2 });
  assert.equal(jumpSong(s, { device: A, nick: 'Ana', id: jumped.id, now: 50 }).ok, true);
  assert.equal(pushSong(s, { id: low.id, on: true, now: 60 }).ok, true);
  assert.deepEqual(order(s), ['Song 2', 'Song 3', 'Song 1']);
  const snap = snapshotFor(s, null);
  assert.equal(snap.queue[0].score, 0);
  assert.equal(snap.queue[1].score, 0);
});

test('turning the floor off: nothing removed at once; the next vote removes at the threshold', () => {
  const s = room({ scoreFloor: true, removeAtScore: -3 });
  const bad = queued(s, 1, { down: 4 });
  const other = queued(s, 2);
  // The room's settings change (src/room.js): the new settings, then applyBlocklist without pruning.
  s.settings = { ...s.settings, scoreFloor: false };
  applyBlocklist(s, {}, { prune: false });
  assert.equal(s.queue.length, 2);
  assert.equal(snapshotFor(s, null).queue.find((q) => q.id === bad.id).score, -4); // shows the real score again
  // The next vote (on any song) applies the remove score.
  assert.equal(vote(s, voter(++next), other.id, 1).ok, true);
  assert.deepEqual(s.queue.map((i) => i.id), [other.id]);
});

test('turning the floor on re-sorts at once', () => {
  const s = room({ removeAtScore: -50 });
  queued(s, 1, { up: 2, down: 2 }); // 0, added first
  queued(s, 2); // 0, no votes
  queued(s, 3, { down: 1 }); // -1
  assert.deepEqual(order(s), ['Song 1', 'Song 2', 'Song 3']);
  s.settings = { ...s.settings, scoreFloor: true };
  applyBlocklist(s); // as the room does on a settings change
  // All 0 now: fewer 👎 first (Song 2: none, Song 3: one, Song 1: two).
  assert.deepEqual(s.queue.map((i) => i.song.title), ['Song 2', 'Song 3', 'Song 1']);
  assert.deepEqual(snapshotFor(s, null).queue.map((q) => q.score), [0, 0, 0]);
});

test('Top 5 and recap use the floored score; up and down stay real', () => {
  const s = room({ scoreFloor: true });
  queued(s, 1, { down: 3 }); // 0, 3 👎
  queued(s, 2, { up: 1 }); // +1
  queued(s, 3); // 0, no votes
  for (let i = 0; i < 3; i++) nextSong(s);
  nextSong(s); // the last one finishes
  // History keeps the raw score.
  assert.equal(s.history.find((e) => e.song.title === 'Song 1').score, -3);
  const top = top5View(s.history, { floor: true });
  assert.deepEqual(top.map((t) => [t.song.title, t.score]), [['Song 2', 1], ['Song 3', 0], ['Song 1', 0]]);
  assert.equal(top[2].down, 3);
  assert.deepEqual(snapshotFor(s, A).top5, top);
  const recap = recapOf(s, 5000);
  assert.deepEqual(recap.top5.map((t) => t.score), [1, 0, 0]);
  assert.equal(recap.songs.find((x) => x.song.title === 'Song 1').score, 0);
  assert.equal(recap.totals.down, 3);
  assert.doesNotMatch(recapText(recap), /\(-\d/);
  // Off: the raw scores and the old ties (more 👍, then the earlier play).
  s.settings.scoreFloor = false;
  assert.deepEqual(top5View(s.history).map((t) => t.score), [1, 0, -3]);
  assert.equal(recapOf(s, 5000).songs.find((x) => x.song.title === 'Song 1').score, -3);
  assert.equal(topFive(s.history).length, 3);
  assert.equal(shownScore({ score: -2 }, true), 0);
  assert.equal(shownScore({ score: -2 }), -2);
});
