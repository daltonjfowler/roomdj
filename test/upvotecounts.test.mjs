// 👍 votes: off / on with counts hidden / on with counts shown (protocol.js UPVOTE COUNTS, Dalton
// 2026-10-22: "toggle the display of likes for songs to be visible or not ... same dropdown as dislikes").
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';
import { addSuggestion, boardSnapshot, migrateRoomState, newRoomState, snapshotFor, vote } from '../shared/queue.js';

const A = 'deviceAAAAAAAAAAAAAA';
const voter = (n) => `voter${String(n).padStart(15, '0')}`;
const song = (n) => ({
  id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, album: 'Album', artwork: '', durationMs: 1000, explicit: 'notExplicit', previewUrl: 'https://x',
});

function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', {
    ...DEFAULT_SETTINGS, downvoteMode: 'shown', hideVoteCounts: false, maxUpvotes: null, maxDownvotes: null, maxWaitingPerStudent: 10, ...settings,
  }, 1000);
  s.students[A] = { nick: 'Ana', joinedAt: 1 };
  return s;
}
let next = 0;
function queued(s, n, { up = 0, down = 0 } = {}) {
  const { item } = addSuggestion(s, { device: `${A}${n}`, nick: 'Ana', song: song(n), now: n });
  for (let i = 0; i < up; i++) assert.equal(vote(s, voter(++next), item.id, 1).ok, true);
  for (let i = 0; i < down; i++) assert.equal(vote(s, voter(++next), item.id, -1).ok, true);
  return item;
}

test('default: 👍 counts shown; settings validation; old rooms read shown', () => {
  assert.equal(DEFAULT_SETTINGS.hideUpvoteCounts, false);
  assert.equal(validateSettings({}).settings.hideUpvoteCounts, false);
  assert.equal(validateSettings({ hideUpvoteCounts: true }).settings.hideUpvoteCounts, true);
  for (const bad of ['yes', 1, null]) assert.equal(validateSettings({ hideUpvoteCounts: bad }).ok, false);
  const s = room();
  delete s.settings.hideUpvoteCounts;
  migrateRoomState(s);
  assert.equal(s.settings.hideUpvoteCounts, false);
});

test('counts hidden: students and boards get no 👍 numbers, the order and 👎 stay; the host sees all', () => {
  const s = room({ hideUpvoteCounts: true });
  queued(s, 1, { up: 1 });
  const big = queued(s, 2, { up: 3, down: 1 });
  vote(s, A, big.id, 1);
  const kid = snapshotFor(s, A);
  assert.equal(kid.upvoteCounts, false);
  assert.deepEqual(kid.queue.map((q) => q.song.title), ['Song 2', 'Song 1']);
  for (const q of kid.queue) {
    assert.equal(q.up, 0);
    assert.equal(q.score, 0);
  }
  assert.equal(kid.queue[0].down, 1); // 👎 shown: still there
  assert.equal(kid.queue[0].myVote, 1);
  const board = boardSnapshot(s);
  assert.equal(board.upvoteCounts, false);
  assert.ok(board.queue.every((q) => q.up === 0 && q.score === 0));
  const host = snapshotFor(s, null);
  assert.equal(host.upvoteCounts, true);
  assert.equal(host.queue[0].up, 4);
});

test('counts shown: students get the 👍 numbers', () => {
  const s = room();
  queued(s, 1, { up: 2 });
  const kid = snapshotFor(s, A);
  assert.equal(kid.upvoteCounts, true);
  assert.equal(kid.queue[0].up, 2);
});
