// 👎 votes: off / on with counts hidden / on with counts shown (protocol.js DOWNVOTE MODE, Dalton
// 2026-10-08: "Set default to not show dislikes and 0 is floor. So all student songs will get to play").
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, DOWNVOTE_MODES } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';
import {
  VOTE_MESSAGES, addSuggestion, boardSnapshot, downvotesLeft, migrateRoomState, newRoomState, nextSong, pruneLowScores,
  snapshotFor, vote, voteRules,
} from '../shared/queue.js';
import { recapOf, top5View } from '../shared/highlights.js';
import { statPool } from '../shared/stats.js';

const A = 'deviceAAAAAAAAAAAAAA';
const voter = (n) => `voter${String(n).padStart(15, '0')}`;
const song = (n) => ({
  id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, album: 'Album', artwork: '', durationMs: 1000, explicit: 'notExplicit', previewUrl: 'https://x',
});

/** A room with the NEW defaults unless `settings` says otherwise. */
function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, downvoteMode: 'off', hideVoteCounts: false, maxWaitingPerStudent: 10, ...settings }, 1000);
  s.students[A] = { nick: 'Ana', joinedAt: 1 };
  return s;
}
let next = 0;
function queued(s, n, { up = 0, down = 0, now = n } = {}) {
  const { item } = addSuggestion(s, { device: `${A}${n}`, nick: 'Ana', song: song(n), now });
  for (let i = 0; i < up; i++) vote(s, voter(++next), item.id, 1);
  for (let i = 0; i < down; i++) assert.equal(vote(s, voter(++next), item.id, -1).ok, true);
  return item;
}
const titles = (snap) => snap.queue.map((q) => q.song.title);

test('defaults: 👎 on with counts hidden (2026-10-21) and the score floor on; settings validation', () => {
  assert.deepEqual(DOWNVOTE_MODES, ['off', 'hidden', 'shown']);
  assert.equal(DEFAULT_SETTINGS.downvoteMode, 'hidden');
  assert.equal(DEFAULT_SETTINGS.scoreFloor, true);
  assert.equal(validateSettings({}).settings.downvoteMode, 'hidden');
  // Saved settings from before the setting: the new default.
  const { downvoteMode, ...old } = DEFAULT_SETTINGS;
  assert.equal(validateSettings({ ...old, blocklist: [] }).settings.downvoteMode, 'hidden');
  for (const m of DOWNVOTE_MODES) assert.equal(validateSettings({ downvoteMode: m }).settings.downvoteMode, m);
  for (const bad of ['on', '', null, true, 1, 'Shown']) assert.equal(validateSettings({ downvoteMode: bad }).ok, false);
});

test('old rooms (saved before the setting) keep 👎 shown and the floor off', () => {
  const s = room();
  delete s.settings.downvoteMode;
  delete s.settings.scoreFloor;
  migrateRoomState(s);
  assert.equal(s.settings.downvoteMode, 'shown');
  assert.equal(s.settings.scoreFloor, false);
  // A room saved with the settings keeps them.
  const t = room({ downvoteMode: 'hidden', scoreFloor: true });
  migrateRoomState(t);
  assert.equal(t.settings.downvoteMode, 'hidden');
  assert.equal(t.settings.scoreFloor, true);
  // A new room is 👎 on with counts hidden, the floor on.
  const n = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS }, 1000);
  assert.equal(snapshotFor(n, A).downvoteMode, 'hidden');
  assert.equal(n.settings.scoreFloor, true);
});

test('off: a new 👎 is refused (downvotes_off) for students and the teacher; 👍 works; no 👎 left shown', () => {
  const s = room();
  const item = queued(s, 1, { up: 2 });
  assert.deepEqual(vote(s, A, item.id, -1), { ok: false, error: 'downvotes_off' });
  assert.equal(VOTE_MESSAGES.downvotes_off, '👎 is turned off in this class.');
  assert.deepEqual(vote(s, 'teacher:host', item.id, -1), { ok: false, error: 'downvotes_off' });
  assert.equal(item.votes[A], undefined);
  assert.equal(s.downvotes[A], undefined);
  assert.equal(vote(s, A, item.id, 1).ok, true);
  assert.equal(downvotesLeft(s, A), null);
  assert.equal(snapshotFor(s, A).you.downvotesLeft, null);
  // Score = 👍 everywhere.
  for (const snap of [snapshotFor(s, A), snapshotFor(s, null), boardSnapshot(s)]) {
    assert.equal(snap.downvoteMode, 'off');
    assert.equal(snap.queue[0].score, 3);
    assert.equal(snap.queue[0].down, 0);
  }
});

test('off: stored 👎 are kept but ignored; switching back on restores them (and removes nothing at once)', () => {
  const r = room({ downvoteMode: 'shown', scoreFloor: false, removeAtScore: -5 });
  const x = queued(r, 1, { up: 1, down: 3, now: 1 }); // -2
  const y = queued(r, 2, { up: 0, now: 2 }); // 0
  assert.deepEqual(titles(snapshotFor(r, null)), ['Song 2', 'Song 1']);
  const mine = voter(next); // the last 👎 on x
  assert.equal(x.votes[mine], -1);
  r.settings.downvoteMode = 'off';
  // Ignored: x is 1 (👍 only) and goes first; the 👎 is still stored.
  assert.deepEqual(titles(snapshotFor(r, null)), ['Song 1', 'Song 2']);
  assert.equal(x.votes[mine], -1);
  const view = snapshotFor(r, mine).queue.find((q) => q.id === x.id);
  assert.equal(view.myVote, 0); // a stored 👎 reads as no vote while off
  assert.equal(view.down, 0);
  assert.equal(view.score, 1);
  // A take-back of the stored 👎 still works while off; nothing is removed by any vote.
  r.settings.removeAtScore = -1;
  assert.equal(vote(r, voter(++next), y.id, 1).ok, true);
  assert.deepEqual(pruneLowScores(r), []);
  // Back on: the 👎 count again (restored), the queue re-sorts; nothing removed by the switch itself.
  r.settings.downvoteMode = 'shown';
  r.settings.removeAtScore = -5;
  const back = snapshotFor(r, null).queue.find((q) => q.id === x.id);
  assert.equal(back.down, 3);
  assert.equal(back.score, -2);
  assert.equal(snapshotFor(r, mine).queue.find((q) => q.id === x.id).myVote, -1);
  assert.deepEqual(titles(snapshotFor(r, null)), ['Song 2', 'Song 1']);
});

test('off: ordering and the Top 5 use 👍 only; recap has no 👎 numbers or 👎 stats', () => {
  const s = room({ downvoteMode: 'shown', scoreFloor: false, removeAtScore: -50 });
  queued(s, 1, { up: 2, down: 3, now: 1 });
  queued(s, 2, { up: 1, now: 2 });
  s.settings.downvoteMode = 'off';
  assert.deepEqual(titles(snapshotFor(s, A)), ['Song 1', 'Song 2']);
  nextSong(s, { now: 10 });
  nextSong(s, { now: 20 });
  nextSong(s, { now: 30 });
  const top = snapshotFor(s, A).top5;
  assert.deepEqual(top.map((t) => [t.song.title, t.score, t.down]), [['Song 1', 2, 0], ['Song 2', 1, 0]]);
  const recap = recapOf(s, 40);
  assert.equal(recap.downvoteMode, 'off');
  assert.equal(recap.totals.down, 0);
  assert.equal(recap.totals.votes, 3);
  assert.ok(recap.songs.every((x) => x.down === 0));
  assert.ok(!recap.stats.some((st) => st.id === 'mostDown' || st.id === 'closest'));
  assert.equal(s.history[0].down, 3); // the stored numbers stay
});

test('hidden: students and boards get no 👎 counts (score = 👍); the host gets the real ones; ordering is real', () => {
  const s = room({ downvoteMode: 'hidden', scoreFloor: true });
  const a = queued(s, 1, { up: 2, down: 3, now: 1 }); // real 0 (floored), 👍 2
  queued(s, 2, { up: 1, now: 2 }); // 1
  assert.equal(vote(s, A, a.id, -1).ok, true); // students may 👎; the limit applies
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 2);
  for (const snap of [snapshotFor(s, A), boardSnapshot(s)]) {
    assert.equal(snap.downvoteMode, 'hidden');
    assert.deepEqual(titles(snap), ['Song 2', 'Song 1']); // ordering by the real floored score
    const v = snap.queue.find((q) => q.id === a.id);
    assert.equal(v.down, 0);
    assert.equal(v.score, 2);
    assert.equal(v.up, 2);
  }
  assert.equal(snapshotFor(s, A).queue.find((q) => q.id === a.id).myVote, -1); // my own 👎 shows
  const host = snapshotFor(s, null).queue.find((q) => q.id === a.id);
  assert.equal(host.down, 4);
  assert.equal(host.score, 0);
  // Top 5 too.
  nextSong(s, { now: 10 });
  nextSong(s, { now: 20 });
  nextSong(s, { now: 30 });
  assert.ok(snapshotFor(s, A).top5.every((t) => t.down === 0));
  assert.ok(boardSnapshot(s).top5.every((t) => t.down === 0));
  assert.ok(snapshotFor(s, null).top5.some((t) => t.down === 4));
  const recap = recapOf(s, 40);
  assert.equal(recap.totals.down, 0);
  assert.ok(!recap.stats.some((st) => st.id === 'mostDown' || st.id === 'closest'));
});

test('shown: everyone sees 👎 and the net score (the old behaviour); the recap keeps 👎 stats', () => {
  const s = room({ downvoteMode: 'shown', scoreFloor: false, removeAtScore: -50 });
  const a = queued(s, 1, { up: 1, down: 3 });
  for (const snap of [snapshotFor(s, A), boardSnapshot(s), snapshotFor(s, null)]) {
    const v = snap.queue.find((q) => q.id === a.id);
    assert.equal(v.down, 3);
    assert.equal(v.score, -2);
  }
  nextSong(s, { now: 10 });
  nextSong(s, { now: 20 });
  const recap = recapOf(s, 30);
  assert.equal(recap.totals.down, 3);
  assert.ok(recap.stats.some((st) => st.id === 'mostDown'));
});

test('voteRules and the helpers', () => {
  const vr = (...a) => { const { floor, downs, hide } = voteRules(...a); return { floor, downs, hide }; };
  assert.deepEqual(vr(room()), { floor: true, downs: false, hide: true });
  assert.deepEqual(vr(room({ downvoteMode: 'hidden' }), false), { floor: true, downs: true, hide: true });
  assert.deepEqual(vr(room({ downvoteMode: 'hidden' }), true), { floor: true, downs: true, hide: false });
  assert.deepEqual(vr(room({ downvoteMode: 'shown', scoreFloor: false }), false), { floor: false, downs: true, hide: false });
  const h = [{ id: 'a', song: song(1), by: 'x', up: 1, down: 4, score: -3, at: 1, status: 'finished' }];
  assert.deepEqual(top5View(h, { downs: false, hide: true }).map((t) => [t.score, t.down]), [[1, 0]]);
  const played = [{ ...h[0] }, { id: 'b', song: song(2), by: 'y', up: 2, down: 1, score: 1, at: 2, status: 'finished' }];
  assert.ok(statPool({ history: played }).some((x) => x.id === 'closest'));
  assert.ok(!statPool({ history: played, downs: false }).some((x) => x.id === 'closest' || x.id === 'mostDown'));
});
