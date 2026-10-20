// 👻 Ghost 👍 (protocol.js GHOST VOTE, Dalton 2026-10-08): a waiting song gets one quiet +1 👍 after
// ghostVoteMinutes; students and boards cannot tell it from a real 👍.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';
import { nextAlarmAt } from '../shared/classtime.js';
import {
  addSuggestion, addToReview, allowReview, boardSnapshot, downvotesLeft, ghostFor, migrateRoomState, newRoomState,
  nextGhostAt, nextSong, pruneLowScores, snapshotFor, sortQueue, vote, voteRules,
} from '../shared/queue.js';
import { crowdFavorite, netOf, recapOf, top5View, topFive } from '../shared/highlights.js';

const A = 'deviceAAAAAAAAAAAAAA';
const B = 'deviceBBBBBBBBBBBBBB';
const MIN = 60_000;
const voter = (n) => `voter${String(n).padStart(15, '0')}`;
const song = (n) => ({
  id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, album: 'Album', artwork: '', durationMs: 1000, explicit: 'notExplicit', previewUrl: 'https://x',
});

function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, hideVoteCounts: false, ghostVote: true, ghostVoteMinutes: 3, ...settings }, 0, 10 * 60 * MIN);
  s.students[A] = { nick: 'Ana', joinedAt: 0 };
  s.students[B] = { nick: 'Ben', joinedAt: 0 };
  return s;
}
let next = 0;
function queued(s, n, { up = 0, at = 0, device = A } = {}) {
  const { item } = addSuggestion(s, { device, nick: s.students[device].nick, song: song(n), now: at });
  for (let i = 0; i < up; i++) vote(s, voter(++next), item.id, 1);
  return item;
}
const hostAt = (s, now) => snapshotFor(s, null, { now });
const titles = (snap) => snap.queue.map((q) => q.song.title);
const row = (snap, n) => snap.queue.find((q) => q.song.title === `Song ${n}`);

test('settings: ghostVote off by default, minutes 1..10 default 3; old settings and rooms read the defaults', () => {
  assert.equal(DEFAULT_SETTINGS.ghostVote, false);
  assert.equal(DEFAULT_SETTINGS.ghostVoteMinutes, 3);
  const { ghostVote, ghostVoteMinutes, ...old } = DEFAULT_SETTINGS;
  const v = validateSettings({ ...old, blocklist: [] });
  assert.equal(v.settings.ghostVote, false);
  assert.equal(v.settings.ghostVoteMinutes, 3);
  assert.equal(validateSettings({ ghostVote: true, ghostVoteMinutes: 1 }).settings.ghostVoteMinutes, 1);
  assert.equal(validateSettings({ ghostVoteMinutes: 10 }).ok, true);
  for (const bad of [0, 11, 2.5, '3', null]) assert.equal(validateSettings({ ghostVoteMinutes: bad }).ok, false, String(bad));
  for (const bad of ['yes', 1, null]) assert.equal(validateSettings({ ghostVote: bad }).ok, false);
  const s = room();
  delete s.settings.ghostVote;
  delete s.settings.ghostVoteMinutes;
  migrateRoomState(s);
  assert.equal(s.settings.ghostVote, false);
  assert.equal(s.settings.ghostVoteMinutes, 3);
});

test('one ghost 👍 exactly at N minutes, once (never a second one)', () => {
  const s = room();
  queued(s, 1, { at: 1000 });
  assert.equal(row(hostAt(s, 1000 + 3 * MIN - 1), 1).up, 0);
  assert.equal(row(hostAt(s, 1000 + 3 * MIN - 1), 1).ghost, undefined);
  const at = row(hostAt(s, 1000 + 3 * MIN), 1);
  assert.equal(at.up, 1);
  assert.equal(at.score, 1);
  assert.equal(at.ghost, 1);
  assert.equal(row(hostAt(s, 1000 + 60 * MIN), 1).up, 1); // still one, an hour later
  // Real votes add on top; the stored votes never hold the ghost.
  vote(s, voter(++next), s.queue[0].id, 1);
  assert.equal(row(hostAt(s, 1000 + 4 * MIN), 1).up, 2);
  assert.equal(Object.keys(s.queue[0].votes).length, 1);
});

test('off: no ghost; the minutes setting applies at once', () => {
  const s = room({ ghostVote: false });
  queued(s, 1, { at: 0 });
  assert.equal(row(hostAt(s, 60 * MIN), 1).up, 0);
  s.settings.ghostVote = true;
  s.settings.ghostVoteMinutes = 10;
  assert.equal(row(hostAt(s, 9 * MIN), 1).up, 0);
  s.settings.ghostVoteMinutes = 1;
  assert.equal(row(hostAt(s, 9 * MIN), 1).up, 1);
});

test('turning it on mid-room: songs already waiting N get it at once; off removes it; on again brings it back', () => {
  const s = room({ ghostVote: false });
  queued(s, 1, { at: 0 });
  queued(s, 2, { at: 5 * MIN, up: 1 });
  const now = 6 * MIN;
  assert.deepEqual(titles(hostAt(s, now)), ['Song 2', 'Song 1']);
  s.settings.ghostVote = true; // Song 1 has waited 6 min: ghost now; Song 2 only 1 min
  assert.deepEqual(titles(hostAt(s, now)), ['Song 1', 'Song 2']); // tie at 1 → added first
  s.settings.ghostVote = false;
  assert.deepEqual(titles(hostAt(s, now)), ['Song 2', 'Song 1']);
  assert.equal(row(hostAt(s, now), 1).up, 0);
  s.settings.ghostVote = true;
  assert.equal(row(hostAt(s, now), 1).up, 1);
});

test('ordering: the ghost counts as a 👍; ties go to fewer 👎, more 👍, then added first; pushed and jumped first', () => {
  const s = room({ ghostVoteMinutes: 1 });
  queued(s, 1, { at: 0 }); // 0 real
  queued(s, 2, { at: 30_000, up: 1 }); // 1 real, added later
  assert.deepEqual(titles(hostAt(s, 59_999)), ['Song 2', 'Song 1']);
  assert.deepEqual(titles(hostAt(s, 60_000)), ['Song 1', 'Song 2']); // 1 + 0 ties 0 + 1: Song 1 added first
  assert.deepEqual(titles(hostAt(s, 90_000)), ['Song 2', 'Song 1']); // Song 2 now 2
  // The stored queue follows sortQueue's clock (the room's alarm sorts it).
  sortQueue(s, 60_000);
  assert.deepEqual(s.queue.map((q) => q.song.title), ['Song 1', 'Song 2']);
  // A pushed song still goes first whatever the ghosts.
  const s2 = room({ ghostVoteMinutes: 1 });
  queued(s2, 1, { at: 0 });
  const late = queued(s2, 2, { at: 5 * MIN });
  late.pushed = { at: 5 * MIN };
  assert.deepEqual(titles(hostAt(s2, 5 * MIN)), ['Song 2', 'Song 1']);
  // nextSong plays by the ghost order at its own clock.
  const s3 = room({ ghostVoteMinutes: 1 });
  queued(s3, 1, { at: 0 });
  queued(s3, 2, { at: 30_000, up: 1 });
  assert.equal(nextSong(s3, { now: 70_000 }).song.title, 'Song 1');
});

test('not for Needs a look or the song playing; Allow starts the clock then', () => {
  const s = room({ ghostVoteMinutes: 1 });
  const { item } = addToReview(s, { device: A, nick: 'Ana', song: song(5), now: 0 });
  const snap = hostAt(s, 10 * MIN);
  assert.equal(snap.review[0].up, 0);
  assert.equal(snap.review[0].ghost, undefined);
  allowReview(s, item.id, 10 * MIN);
  assert.equal(row(hostAt(s, 10 * MIN + 59_999), 5).up, 0);
  assert.equal(row(hostAt(s, 11 * MIN), 5).up, 1);
  // Playing: a song that started before its ghost never gets one later.
  const s2 = room({ ghostVoteMinutes: 1 });
  queued(s2, 1, { at: 0 });
  nextSong(s2, { now: 30_000 });
  assert.equal(hostAt(s2, 10 * MIN).nowPlaying.up, 0);
  assert.equal(s2.history.at(-1).ghost, undefined);
});

test('the song playing keeps the ghost it had; the history keeps the real votes + the ghost mark', () => {
  const s = room({ ghostVoteMinutes: 1 });
  queued(s, 1, { at: 0, up: 1 });
  nextSong(s, { now: 2 * MIN });
  assert.equal(s.nowPlaying.ghost, 1);
  const e = s.history.at(-1);
  assert.equal(e.ghost, 1);
  assert.equal(e.up, 1); // real
  assert.equal(e.score, 1);
  assert.equal(hostAt(s, 3 * MIN).nowPlaying.up, 2);
  assert.equal(hostAt(s, 3 * MIN).nowPlaying.ghost, 1);
  s.settings.ghostVote = false; // what the class saw stays
  assert.equal(snapshotFor(s, A, { now: 3 * MIN }).nowPlaying.up, 2);
});

test('students and boards: the ghost is folded into 👍 with no trace; only the host gets `ghost`', () => {
  for (const downvoteMode of ['off', 'hidden', 'shown']) {
    const s = room({ ghostVoteMinutes: 1, downvoteMode });
    queued(s, 1, { at: 0, device: B });
    const stu = snapshotFor(s, A, { now: 2 * MIN });
    const mine = snapshotFor(s, B, { now: 2 * MIN });
    const host = hostAt(s, 2 * MIN);
    const board = (() => {
      const real = Date.now;
      Date.now = () => 2 * MIN; // boardSnapshot uses the clock
      try { return boardSnapshot(s); } finally { Date.now = real; }
    })();
    for (const snap of [stu, mine, board]) {
      assert.equal(snap.queue[0].up, 1, downvoteMode);
      assert.equal(snap.queue[0].score, 1);
      assert.equal('ghost' in snap.queue[0], false);
      assert.equal(JSON.stringify(snap).includes('ghost'), false, `${downvoteMode}: no ghost anywhere`);
    }
    assert.equal(mine.queue[0].myVote, 0); // their own vote is untouched
    assert.equal(stu.queue[0].myVote, 0);
    assert.equal(host.queue[0].ghost, 1);
    assert.equal(host.settings.ghostVote, true);
  }
});

test('score floor and 👎: shown score = max(0, 👍 + ghost − 👎); the remove score counts the ghost', () => {
  const s = room({ ghostVoteMinutes: 1, downvoteMode: 'shown', scoreFloor: true });
  const item = queued(s, 1, { at: 0 });
  for (let i = 0; i < 3; i++) vote(s, voter(++next), item.id, -1);
  assert.equal(row(hostAt(s, 2 * MIN), 1).score, 0);
  assert.equal(row(hostAt(s, 2 * MIN), 1).up, 1);
  // vote() prunes at the real clock (these songs were added at 0: long past their ghost moment).
  const s2 = room({ ghostVote: false, ghostVoteMinutes: 1, downvoteMode: 'shown', scoreFloor: false, removeAtScore: -3 });
  const it2 = queued(s2, 1, { at: 0 });
  for (let i = 0; i < 3; i++) vote(s2, voter(++next), it2.id, -1);
  assert.equal(s2.queue.length, 0, 'no ghost: −3 removes');
  s2.settings.ghostVote = true;
  const it3 = queued(s2, 2, { at: 0 });
  for (let i = 0; i < 3; i++) vote(s2, voter(++next), it3.id, -1);
  assert.equal(s2.queue.length, 1, '−3 + ghost = −2: stays');
  assert.deepEqual(pruneLowScores(s2, 2 * MIN), []);
  assert.equal(pruneLowScores(s2, 30_000).length, 1, 'before its ghost moment it is −3');
});

test('Top 5 and the recap show the ghost 👍; favorites net, Crowd favorite and Top voter use real votes', () => {
  const s = room({ ghostVoteMinutes: 1, downvoteMode: 'shown', scoreFloor: true });
  queued(s, 1, { at: 0, up: 2, device: B }); // real 2, ghost 1
  queued(s, 2, { at: 10_000, up: 2 }); // real 2, no ghost by then? (see below)
  nextSong(s, { now: 65_000 }); // Song 1 (2 + ghost) plays; Song 2 has waited 55 s: no ghost
  nextSong(s, { now: 66_000 }); // Song 2: 2 real (its ghost came at 70 s, it started at 66 s)
  nextSong(s, { now: 67_000 }); // ends Song 2
  const host = top5View(s.history, voteRules(s));
  assert.deepEqual(host.map((t) => [t.song.title, t.up, t.score]), [['Song 1', 3, 3], ['Song 2', 2, 2]]);
  assert.equal('ghost' in host[0], false);
  // Ranking uses the ghost: without it they would tie and Song 1 would still lead (played first),
  // so check a case where the ghost flips it.
  const h = [
    { id: 'a', song: song(1), by: 'x', up: 2, down: 0, score: 2, at: 1, status: 'finished' },
    { id: 'b', song: song(2), by: 'y', up: 2, down: 0, score: 2, at: 2, status: 'finished', ghost: 1 },
  ];
  assert.deepEqual(topFive(h).map((e) => e.id), ['b', 'a']);
  assert.equal(topFive(h)[0].up, 2, 'topFive hands back the stored (real) entry');
  // Favorites: the net is the real one.
  assert.equal(netOf(s.history[0]), 2);
  // Crowd favorite: real 👍 only (Ben 2, Ana 2, one song each: Ben played first; with the ghost Ben would show 3).
  assert.deepEqual(crowdFavorite(s.history), { nick: 'Ben', up: 2 });
  // Top voter: the ghost is never a vote cast.
  assert.equal(Object.values(s.tally.votes).reduce((a, b) => a + b, 0), 4);
  const recap = recapOf(s, 70_000);
  assert.equal(recap.totals.up, 5);
  assert.deepEqual(recap.songs.map((x) => x.up), [3, 2]);
  assert.equal(recap.top5[0].up, 3);
  assert.equal(JSON.stringify(recap).includes('ghost'), false);
  const most = recap.stats.find((x) => x.id === 'mostUp');
  assert.match(most.text, /👍 3/);
});

test('the 👎 limit never counts a ghost', () => {
  const s = room({ ghostVoteMinutes: 1, downvoteMode: 'shown', maxDownvotes: 3 });
  queued(s, 1, { at: 0 });
  assert.equal(downvotesLeft(s, A), 3);
  hostAt(s, 5 * MIN);
  assert.equal(downvotesLeft(s, A), 3);
});

test('alarm: the next ghost moment joins the room alarm (earliest of cleanup, until, idle, ghost)', () => {
  const s = room({ ghostVoteMinutes: 3 });
  s.lastActivity = 0;
  assert.equal(nextGhostAt(s, 0), null); // empty queue
  queued(s, 1, { at: 1000 });
  queued(s, 2, { at: 2000 });
  assert.equal(nextGhostAt(s, 1000), 1000 + 3 * MIN);
  assert.equal(nextGhostAt(s, 1000 + 3 * MIN), 2000 + 3 * MIN); // the first one is past
  assert.equal(nextGhostAt(s, 2000 + 3 * MIN), null); // both have it: nothing left to ring for
  const idle = 12 * 60 * MIN;
  assert.equal(nextAlarmAt(s, idle, nextGhostAt(s, 1000)), 1000 + 3 * MIN);
  s.cleanupAt = 2 * MIN;
  assert.equal(nextAlarmAt(s, idle, nextGhostAt(s, 1000)), 2 * MIN);
  s.settings.ghostVote = false;
  s.cleanupAt = null;
  assert.equal(nextGhostAt(s, 1000), null);
  assert.equal(nextAlarmAt(s, idle, nextGhostAt(s, 1000)), s.until);
  assert.equal(ghostFor(s.queue[0], voteRules(s, true, 10 * MIN)), 0);
});
