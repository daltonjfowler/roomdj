import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CREDITS_MAX, DEFAULT_SETTINGS, DOWNVOTE_CHOICES, JUMP_COST, QUEUE_MAX, REVIEW_MAX, SUGGEST_COST, TEACHER_DEVICE, UPVOTE_CHOICES } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';
import {
  QUEUE_MESSAGES, addSuggestion, addToReview, allowReview, applyBlocklist, kickDevice, newRoomState, nextSong,
  nextIsFor, nickTaken, refusalMessage, snapshotFor, suggestRefusal, takeReview, veto, vote,
  VOTE_MESSAGES, boardSnapshot, pruneLowScores,
  JUMP_MESSAGES, creditsOf, creditsOn, jumpOn, jumpSong, migrateRoomState, refundCredits, refundItem, settleCredits,
  spendCredits, teacherCredits, lockNext, ghostMs,
} from '../shared/queue.js';

/** Not resting (📚 back to work, protocol.js BACK TO WORK). */
const NO_REST = { restUntil: null, restGraceUntil: null, restLeft: 0, restGraceLeft: 0 };
const A = 'deviceAAAAAAAAAAAAAA';
const B = 'deviceBBBBBBBBBBBBBB';
const C = 'deviceCCCCCCCCCCCCCC';
const song = (n, title = `Song ${n}`) => ({
  id: `it:${n}`, title, artist: 'Artist', album: 'Album', artwork: '', durationMs: 1000, explicit: 'notExplicit', previewUrl: 'https://x',
});

function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, hideVoteCounts: false, scoreFloor: false, downvoteMode: 'shown', ...settings }, 1000);
  s.students[A] = { nick: 'Ana', joinedAt: 1 };
  s.students[B] = { nick: 'Ben', joinedAt: 1 };
  s.students[C] = { nick: 'Cy', joinedAt: 1 };
  return s;
}

test('suggest: per-device limit, duplicates, locked room', () => {
  const s = room({ maxWaitingPerStudent: 2 });
  assert.equal(addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 }).ok, true);
  assert.equal(addSuggestion(s, { device: A, nick: 'Ana', song: song(2), now: 2 }).ok, true);
  assert.deepEqual(addSuggestion(s, { device: A, nick: 'Ana', song: song(3), now: 3 }), { ok: false, reason: 'limit' });
  assert.deepEqual(addSuggestion(s, { device: B, nick: 'Ben', song: song(1), now: 4 }), { ok: false, reason: 'duplicate' });
  s.locked = true;
  assert.deepEqual(addSuggestion(s, { device: B, nick: 'Ben', song: song(9), now: 5 }), { ok: false, reason: 'locked' });
});

test('suggest: now playing counts as a duplicate, played songs cannot come back', () => {
  const s = room();
  addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  nextSong(s);
  assert.equal(suggestRefusal(s, B, 'it:1'), 'duplicate');
  nextSong(s); // queue empty → nothing playing
  assert.equal(s.nowPlaying, null);
  assert.equal(suggestRefusal(s, B, 'it:1'), 'played');
  // A's song left the queue, so A may suggest again.
  assert.equal(suggestRefusal(s, A, 'it:5'), null);
});

test('vote: one per device, final (no change, no take-back), bad values refused', () => {
  const s = room();
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  vote(s, B, item.id, 1);
  vote(s, B, item.id, 1);
  let snap = snapshotFor(s, B);
  assert.equal(snap.queue[0].score, 1);
  assert.equal(snap.queue[0].myVote, 1);
  assert.deepEqual(vote(s, B, item.id, -1), { ok: false, error: 'vote_final' }, 'votes are final');
  assert.deepEqual(vote(s, B, item.id, 0), { ok: false, error: 'vote_final' }, 'no take-back');
  assert.equal(snapshotFor(s, B).queue[0].score, 1);
  assert.equal(VOTE_MESSAGES.vote_final, 'Votes are final. You already voted on this song.');
  assert.equal(vote(s, TEACHER_DEVICE, item.id, -1).ok, true, 'the teacher may change');
  assert.equal(vote(s, TEACHER_DEVICE, item.id, 0).ok, true);
  assert.equal(vote(s, B, item.id, 2).ok, false);
  assert.equal(vote(s, B, 'nope', 1).ok, false);
});

test('vote: the now-playing song takes a new 👍, never a new 👎; its queue votes carry over and stay final', () => {
  const s = room();
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  vote(s, B, item.id, -1); // a 👎 from the queue
  nextSong(s);
  assert.equal(s.nowPlaying.id, item.id);
  let now = snapshotFor(s, B).nowPlaying;
  assert.deepEqual([now.up, now.down, now.score, now.myVote], [0, 1, -1, -1], 'its queue votes carry over, 👎 too');
  assert.deepEqual(vote(s, C, item.id, -1), { ok: false, error: 'playing_down' });
  assert.equal(VOTE_MESSAGES.playing_down, 'You can only give a 👍 to the song playing now.');
  assert.deepEqual(vote(s, C, item.id, 1), { ok: true, removed: false });
  assert.deepEqual(vote(s, A, item.id, 1), { ok: true, removed: false }, 'its own student may 👍 it, as in the queue');
  now = snapshotFor(s, C).nowPlaying;
  assert.deepEqual([now.up, now.down, now.score, now.myVote], [2, 1, 1, 1]);
  assert.equal(snapshotFor(s, null).nowPlaying.up, 2, 'the host sees it');
  assert.equal(boardSnapshot(s).nowPlaying.up, 2, 'the board sees it');
  assert.deepEqual(vote(s, C, item.id, 0), { ok: false, error: 'vote_final' }, 'no take-back');
  assert.deepEqual(vote(s, B, item.id, 1), { ok: false, error: 'vote_final' }, 'a 👎 from the queue stays');
  now = snapshotFor(s, B).nowPlaying;
  assert.deepEqual([now.up, now.down, now.score, now.myVote], [2, 1, 1, -1]);
  assert.equal(s.history.at(-1).score, 1, 'the history follows');
});

test('vote: the remove score never removes or skips the song playing', () => {
  const s = room({ removeAtScore: -1 });
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  addSuggestion(s, { device: B, nick: 'Ben', song: song(2), now: 2 });
  nextSong(s);
  s.nowPlaying.votes[B] = -1; // as if carried over from the queue, at the remove score
  s.nowPlaying.votes[C] = -1;
  assert.deepEqual(vote(s, A, item.id, 1), { ok: true, removed: false });
  assert.equal(s.nowPlaying.id, item.id);
  assert.equal(s.queue.length, 1);
  assert.equal(pruneLowScores(s).length, 0, 'only queued songs go');
  assert.equal(s.nowPlaying.id, item.id);
});

test('vote: a kick leaves the votes on the song playing (like the songs that played)', () => {
  const s = room();
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  nextSong(s);
  vote(s, B, item.id, 1);
  vote(s, C, item.id, 1);
  kickDevice(s, B);
  assert.equal(snapshotFor(s, null).nowPlaying.up, 2);
  assert.equal(s.history.at(-1).up, 2);
});

test('sort: score first, ties to the earliest; next takes the top', () => {
  const s = room({ maxWaitingPerStudent: 5 });
  const first = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 10 }).item;
  const second = addSuggestion(s, { device: A, nick: 'Ana', song: song(2), now: 20 }).item;
  const third = addSuggestion(s, { device: A, nick: 'Ana', song: song(3), now: 30 }).item;
  vote(s, B, third.id, 1);
  assert.deepEqual(snapshotFor(s, null).queue.map((q) => q.id), [third.id, first.id, second.id]);
  assert.equal(nextSong(s).id, third.id);
  assert.equal(s.nowPlaying.id, third.id);
  assert.deepEqual(s.played, ['it:3']);
});

test('auto-remove at removeAtScore', () => {
  const s = room({ removeAtScore: -2 });
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  assert.equal(vote(s, B, item.id, -1).removed, false);
  assert.equal(vote(s, C, item.id, -1).removed, true);
  assert.equal(s.queue.length, 0);
});

test('veto and kick', () => {
  const s = room({ maxWaitingPerStudent: 5 });
  const a1 = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 }).item;
  const b1 = addSuggestion(s, { device: B, nick: 'Ben', song: song(2), now: 2 }).item;
  vote(s, B, a1.id, 1);
  assert.equal(veto(s, 'missing'), null);
  assert.equal(veto(s, b1.id).id, b1.id);
  addSuggestion(s, { device: B, nick: 'Ben', song: song(3), now: 3 });
  kickDevice(s, B);
  assert.deepEqual(s.queue.map((q) => q.song.id), ['it:1']);
  assert.deepEqual(s.queue[0].votes, {});
  assert.ok(s.kicked.includes(B));
  assert.equal(s.students[B], undefined);
});

test('snapshot: mine/myVote/you for students, students + aiStatus + blocklist for the host only', () => {
  const s = room({ blocklist: ['badword'] });
  s.hostHash = 'secret-hash';
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  vote(s, A, item.id, 1);
  const forA = snapshotFor(s, A, { online: new Set([A]) });
  assert.equal(forA.queue[0].mine, true);
  assert.equal(forA.queue[0].myVote, 1);
  assert.deepEqual(forA.you, { nick: 'Ana', waiting: 1, review: 0, checks: [], credits: null, downvotesLeft: 3, upvotesLeft: 2, ...NO_REST });
  assert.equal(forA.students, undefined);
  assert.equal(forA.aiStatus, undefined);
  assert.equal(forA.settings.blocklist, undefined);
  assert.equal(forA.queue[0].votes, undefined, 'raw votes never leave the server');
  const forB = snapshotFor(s, B);
  assert.equal(forB.queue[0].mine, false);
  assert.equal(forB.queue[0].myVote, 0);
  const host = snapshotFor(s, null, { online: new Set([A]) });
  assert.equal(host.you, null);
  assert.equal(host.queue[0].mine, false);
  assert.deepEqual(host.settings.blocklist, ['badword']);
  assert.equal(host.aiStatus, 'ok');
  assert.deepEqual(host.students.find((x) => x.device === A), { device: A, nick: 'Ana', online: true, credits: null, downvotes: 0, upvotes: 1, restUntil: null, restLeft: 0 });
  assert.equal(host.students.find((x) => x.device === B).online, false);
  for (const snap of [forA, forB, host]) assert.equal(JSON.stringify(snap).includes('secret-hash'), false);
});

// ---- "Needs a look" (review list) ----

test('review: add, duplicate everywhere, counts toward the limit, students never see the list', () => {
  const s = room({ maxWaitingPerStudent: 2 });
  const r1 = addToReview(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  assert.equal(r1.ok, true);
  assert.equal(r1.item.by, 'Ana');
  // The same song is a duplicate wherever it is: review, queue, now playing.
  assert.equal(suggestRefusal(s, B, 'it:1'), 'duplicate');
  assert.deepEqual(addSuggestion(s, { device: B, nick: 'Ben', song: song(1), now: 2 }), { ok: false, reason: 'duplicate' });
  assert.deepEqual(addToReview(s, { device: B, nick: 'Ben', song: song(1), now: 2 }), { ok: false, reason: 'duplicate' });
  assert.match(refusalMessage(s, 'duplicate', 'it:1'), /teacher is checking/);
  assert.equal(refusalMessage(s, 'duplicate', 'it:99'), QUEUE_MESSAGES.duplicate);
  addSuggestion(s, { device: B, nick: 'Ben', song: song(2), now: 3 });
  assert.deepEqual(addToReview(s, { device: A, nick: 'Ana', song: song(2), now: 4 }), { ok: false, reason: 'duplicate' });
  // Review + queue together count toward maxWaitingPerStudent.
  assert.equal(addSuggestion(s, { device: A, nick: 'Ana', song: song(3), now: 5 }).ok, true);
  assert.deepEqual(addToReview(s, { device: A, nick: 'Ana', song: song(4), now: 6 }), { ok: false, reason: 'limit' });
  assert.deepEqual(addSuggestion(s, { device: A, nick: 'Ana', song: song(4), now: 6 }), { ok: false, reason: 'limit' });
  const forA = snapshotFor(s, A);
  assert.deepEqual(forA.you, { nick: 'Ana', waiting: 2, review: 1, checks: [{ id: 's1', song: 'it:1', title: 'Song 1', since: 1, place: 1, of: 1 }], credits: null, downvotesLeft: 3, upvotesLeft: 3, ...NO_REST });
  assert.equal(forA.review, undefined, 'students never get the review list');
  assert.equal(JSON.stringify(snapshotFor(s, B)).includes('Song 1'), false, 'other students never see a song waiting for a look (only its owner does: MY CHECKS)');
  const host = snapshotFor(s, null);
  assert.deepEqual(host.review.map((x) => [x.id, x.by, x.song.id]), [[r1.item.id, 'Ana', 'it:1']]);
  assert.equal(host.queue.some((q) => q.song.id === 'it:1'), false);
});

test('review: now playing is a duplicate; locked room and played songs refused; oldest first; capped', () => {
  const s = room({ maxWaitingPerStudent: 10 });
  s.locked = true;
  assert.deepEqual(addToReview(s, { device: A, nick: 'Ana', song: song(1) }), { ok: false, reason: 'locked' });
  s.locked = false;
  addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  nextSong(s);
  assert.deepEqual(addToReview(s, { device: B, nick: 'Ben', song: song(1) }), { ok: false, reason: 'duplicate' });
  nextSong(s);
  assert.deepEqual(addToReview(s, { device: A, nick: 'Ana', song: song(1) }), { ok: false, reason: 'played' });
  // Fill the list to REVIEW_MAX with many students.
  for (let i = 0; i < REVIEW_MAX; i++) {
    const dev = `device${String(i).padStart(14, '0')}`;
    s.students[dev] = { nick: `N${i}`, joinedAt: 1 };
    assert.equal(addToReview(s, { device: dev, nick: `N${i}`, song: song(100 + i), now: 100 + i }).ok, true);
  }
  assert.deepEqual(addToReview(s, { device: B, nick: 'Ben', song: song(500) }), { ok: false, reason: 'reviewFull' });
  assert.ok(QUEUE_MESSAGES.reviewFull);
  assert.deepEqual(snapshotFor(s, null).review.map((x) => x.song.id).slice(0, 3), ['it:100', 'it:101', 'it:102']);
  // A known song still joins the queue while the review list is full.
  assert.equal(addSuggestion(s, { device: B, nick: 'Ben', song: song(501) }).ok, true);
});

test('review: allow joins the queue credited to the student, even over the limit', () => {
  const s = room({ maxWaitingPerStudent: 2 });
  const held = addToReview(s, { device: A, nick: 'Ana', song: song(1), now: 1 }).item;
  addSuggestion(s, { device: A, nick: 'Ana', song: song(2), now: 2 });
  // The teacher lowers the limit and locks the room while it waits: allowed anyway.
  s.settings.maxWaitingPerStudent = 1;
  s.locked = true;
  const allowed = allowReview(s, held.id, 50);
  assert.equal(allowed.id, held.id);
  assert.equal(s.review.length, 0);
  const view = snapshotFor(s, A).queue.find((q) => q.id === held.id);
  assert.equal(view.by, 'Ana');
  assert.equal(view.mine, true);
  assert.equal(view.addedAt, 50, 'its tie place counts from when it was allowed');
  assert.deepEqual(snapshotFor(s, A).you, { nick: 'Ana', waiting: 2, review: 0, checks: [], credits: null, downvotesLeft: 3, upvotesLeft: 3, ...NO_REST });
  assert.equal(vote(s, B, held.id, 1).ok, true, 'votes work once it is queued');
  assert.equal(allowReview(s, held.id), null, 'allowing twice does nothing');
  assert.equal(allowReview(s, 'nope'), null);
});

test('review: remove takes it off the list; queue veto does not touch review', () => {
  const s = room({ maxWaitingPerStudent: 5 });
  const r1 = addToReview(s, { device: A, nick: 'Ana', song: song(1), now: 1 }).item;
  const r2 = addToReview(s, { device: B, nick: 'Ben', song: song(2), now: 2 }).item;
  assert.equal(veto(s, r1.id), null, 'queue veto only looks at the queue');
  assert.equal(takeReview(s, r1.id).id, r1.id);
  assert.equal(takeReview(s, r1.id), null);
  assert.deepEqual(s.review.map((x) => x.id), [r2.id]);
  assert.equal(suggestRefusal(s, C, 'it:1'), null, 'a removed song may be suggested again (and is checked again)');
});

test('review: kick removes the kicked device\'s items; a blocklist change removes matches', () => {
  const s = room({ maxWaitingPerStudent: 5 });
  addToReview(s, { device: A, nick: 'Ana', song: song(1, 'Pineapple Song'), now: 1 });
  addToReview(s, { device: B, nick: 'Ben', song: song(2), now: 2 });
  addToReview(s, { device: C, nick: 'Cy', song: song(3), now: 3 });
  addSuggestion(s, { device: C, nick: 'Cy', song: song(4, 'More Pineapple'), now: 4 });
  kickDevice(s, B);
  assert.deepEqual(s.review.map((x) => x.song.id), ['it:1', 'it:3']);
  s.settings.blocklist = ['pineapple'];
  const removed = applyBlocklist(s);
  assert.deepEqual(removed.map((x) => x.song.id), ['it:1']);
  assert.deepEqual(s.review.map((x) => x.song.id), ['it:3']);
  assert.deepEqual(s.queue.map((x) => x.song.id), [], 'queued matches go too');
});

test('review: rooms saved before the review list still work', () => {
  const s = room();
  delete s.review;
  assert.equal(suggestRefusal(s, A, 'it:1'), null);
  assert.deepEqual(snapshotFor(s, A).you, { nick: 'Ana', waiting: 0, review: 0, checks: [], credits: null, downvotesLeft: 3, upvotesLeft: 3, ...NO_REST });
  assert.deepEqual(snapshotFor(s, null).review, []);
  assert.equal(addToReview(s, { device: A, nick: 'Ana', song: song(1) }).ok, true);
});

test('next: only from the song now playing, so a double Skip or a second host tab never skips two', () => {
  const s = room();
  addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  addSuggestion(s, { device: B, nick: 'Ben', song: song(2), now: 2 });
  assert.equal(nextIsFor(s, null), true); // nothing playing yet
  nextSong(s);
  const first = s.nowPlaying.id;
  assert.equal(nextIsFor(s, null), false);
  assert.equal(nextIsFor(s, first), true);
  nextSong(s);
  assert.equal(nextIsFor(s, first), false); // the second click of a double Skip
  assert.equal(nextIsFor(s, s.nowPlaying.id), true);
  assert.equal(nextIsFor(s, undefined), true); // an old page that sends no `from`
  assert.equal(nextIsFor(s, 42), false);
});

test('nicknames: one per room, so nobody can pose as a classmate (case, spaces and accents do not count)', () => {
  const s = room(); // Ana (A), Ben (B), Cy (C)
  assert.equal(nickTaken(s, C, 'ana'), true);
  assert.equal(nickTaken(s, C, '  ÁNA '), true);
  assert.equal(nickTaken(s, C, 'A n a'), true);
  assert.equal(nickTaken(s, A, 'Ana'), false); // the same device coming back
  assert.equal(nickTaken(s, C, 'Anabel'), false);
  assert.equal(nickTaken(s, C, 'Ana', new Set([B])), false); // Ana went home: a later class may have its own
  assert.equal(nickTaken(s, C, 'Ana', new Set([A, B])), true);
});

test('suggest: the queue stops at QUEUE_MAX songs, whoever asks', () => {
  const s = room({ maxWaitingPerStudent: 10 });
  for (let i = 0; i < QUEUE_MAX; i++) {
    const device = `devicefill${String(i).padStart(10, '0')}`;
    assert.equal(addSuggestion(s, { device, nick: `kid${i}`, song: song(1000 + i), now: 10 + i }).ok, true);
  }
  const r = addSuggestion(s, { device: A, nick: 'Ana', song: song(9), now: 999 });
  assert.deepEqual(r, { ok: false, reason: 'queueFull' });
  assert.match(QUEUE_MESSAGES.queueFull, /full/);
});

// ---- Credits (protocol.js CREDITS) ----

const credited = (n, settings = {}) => room({ startingCredits: n, ...settings });

test('credits: off by default (Unlimited); every credit function is a no-op', () => {
  assert.equal(DEFAULT_SETTINGS.startingCredits, null);
  const s = room({ maxWaitingPerStudent: 5 });
  assert.equal(creditsOn(s), false);
  assert.equal(creditsOf(s, A), null);
  assert.equal(spendCredits(s, A, SUGGEST_COST), 0); // free
  assert.deepEqual(s.credits, {});
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  assert.deepEqual(jumpSong(s, { device: B, nick: 'Ben', id: item.id }), { ok: false, reason: 'off' });
  assert.equal(teacherCredits(s, { device: A, amount: 5 }).ok, false);
  assert.equal(snapshotFor(s, A).you.credits, null);
  assert.equal(snapshotFor(s, null).students.every((x) => x.credits === null), true);
  assert.equal(snapshotFor(s, A).queue[0].jumped, null);
});

test('credits: suggesting charges one; too few is refused before anything is spent', () => {
  const s = credited(2);
  assert.equal(creditsOf(s, A), 2); // a device with no balance yet has the starting amount
  assert.equal(spendCredits(s, A, SUGGEST_COST), 1);
  addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1, paid: 1 });
  assert.equal(spendCredits(s, A, SUGGEST_COST), 1);
  assert.equal(creditsOf(s, A), 0);
  assert.equal(spendCredits(s, A, SUGGEST_COST), null);
  assert.equal(creditsOf(s, A), 0);
  assert.match(QUEUE_MESSAGES.credits, /You need 1 credit to suggest a song\. Ask your teacher for more\./);
  assert.equal(snapshotFor(s, A).you.credits, 0);
  assert.equal(snapshotFor(s, B).you.credits, 2);
  assert.deepEqual(snapshotFor(s, null).students.map((x) => [x.nick, x.credits]), [['Ana', 0], ['Ben', 2], ['Cy', 2]]);
});

test('credits: a filter "no" refunds; the queue keeps what a song cost', () => {
  const s = credited(3);
  // explicit / blocklist / banned / theme: the room refunds what it took
  const paid = spendCredits(s, A, SUGGEST_COST);
  assert.equal(creditsOf(s, A), 2);
  assert.equal(refundCredits(s, A, paid), 3);
  // Joins the queue: spent for good, also when vetoed, banned or voted out.
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1, paid: spendCredits(s, A, SUGGEST_COST) });
  assert.equal(item.paid, 1);
  assert.equal(creditsOf(s, A), 2);
  veto(s, item.id);
  assert.equal(creditsOf(s, A), 2);
  const voted = addSuggestion(s, { device: A, nick: 'Ana', song: song(2), now: 2, paid: spendCredits(s, A, SUGGEST_COST) }).item;
  vote(s, B, voted.id, -1); vote(s, C, voted.id, -1); vote(s, A, voted.id, -1);
  assert.equal(s.queue.some((q) => q.id === voted.id), false);
  assert.equal(creditsOf(s, A), 1);
  // Nothing comes back for a device that was kicked.
  const p = spendCredits(s, B, SUGGEST_COST);
  kickDevice(s, B);
  assert.equal(refundCredits(s, B, p), null);
  assert.equal(s.credits[B], undefined);
});

test('credits: Needs a look holds the credit; Allow keeps it, Remove and a blocked word refund, Ban does not', () => {
  const s = credited(5, { maxWaitingPerStudent: 9 });
  const hold = (n) => addToReview(s, { device: A, nick: 'Ana', song: song(n, `Song ${n}`), now: n, paid: spendCredits(s, A, SUGGEST_COST) }).item;
  const allow = hold(1);
  const remove = hold(2);
  const ban = hold(3);
  const word = addToReview(s, { device: A, nick: 'Ana', song: song(4, 'Pineapple Song'), now: 4, paid: spendCredits(s, A, SUGGEST_COST) }).item;
  assert.equal(creditsOf(s, A), 1);
  assert.equal(allowReview(s, allow.id, 10).paid, 1); // Allow: stays spent
  assert.equal(creditsOf(s, A), 1);
  assert.equal(refundItem(s, takeReview(s, remove.id)), 2); // Remove: comes back
  takeReview(s, ban.id); // Ban: the room does not refund
  assert.equal(creditsOf(s, A), 2);
  s.settings.blocklist = ['pineapple'];
  const removed = applyBlocklist(s);
  assert.deepEqual(removed.map((i) => i.id), [word.id]);
  for (const i of removed) refundItem(s, i);
  assert.equal(creditsOf(s, A), 3);
  assert.equal(refundItem(s, removed[0]), null); // only once
  assert.equal(creditsOf(s, A), 3);
  // A held song of a student who suggested while credits were off cost nothing: nothing back.
  const free = addToReview(s, { device: B, nick: 'Ben', song: song(5), now: 5 }).item;
  assert.equal(refundItem(s, takeReview(s, free.id)), null);
  assert.equal(creditsOf(s, B), 5);
});

test('credits: a jump costs two and puts the song first; several jumps play in the order they were jumped', () => {
  const s = credited(4, { maxWaitingPerStudent: 9, allowJump: true });
  const add = (n, at) => addSuggestion(s, { device: C, nick: 'Cy', song: song(n), now: at }).item;
  const one = add(1, 1);
  const two = add(2, 2);
  const three = add(3, 3);
  const four = add(4, 4);
  vote(s, A, one.id, 1); vote(s, B, one.id, 1); // one: +2
  vote(s, A, two.id, 1); // two: +1
  assert.deepEqual(s.queue.map((q) => q.id), [one.id, two.id, three.id, four.id]);
  const j1 = jumpSong(s, { device: A, nick: 'Ana', id: four.id, now: 100 });
  assert.equal(j1.ok, true);
  assert.equal(creditsOf(s, A), 4 - JUMP_COST);
  assert.deepEqual(s.queue.map((q) => q.id), [four.id, one.id, two.id, three.id]);
  // Same millisecond: still after the first jump.
  assert.equal(jumpSong(s, { device: B, nick: 'Ben', id: three.id, now: 100 }).ok, true);
  assert.deepEqual(s.queue.map((q) => q.id), [four.id, three.id, one.id, two.id]);
  // Votes do not move a jumped song past an earlier jump, nor a plain song past a jumped one.
  vote(s, A, three.id, 1); vote(s, B, three.id, 1); vote(s, C, three.id, 1);
  vote(s, B, two.id, 1); vote(s, C, two.id, 1); // two: +3, more than one (+2)
  assert.deepEqual(s.queue.map((q) => q.id), [four.id, three.id, two.id, one.id]);
  const snap = snapshotFor(s, C);
  assert.deepEqual(snap.queue.map((q) => q.id), [four.id, three.id, two.id, one.id]);
  assert.deepEqual(snap.queue[0].jumped, { by: 'Ana', at: 100 });
  assert.equal(snap.queue[1].jumped.at, 101);
  assert.equal(snap.queue[0].jumped.device, undefined); // the jumper's device stays on the server
  assert.equal(snap.queue[2].jumped, null);
  // They play in that order.
  assert.equal(nextSong(s).id, four.id);
  assert.equal(nextSong(s).id, three.id);
  assert.equal(nextSong(s).id, two.id);
});

test('credits: jump refusals spend nothing (too few, already jumped, playing, gone, in review)', () => {
  const s = credited(3, { maxWaitingPerStudent: 9, allowJump: true });
  const a = addSuggestion(s, { device: C, nick: 'Cy', song: song(1), now: 1 }).item;
  const b = addSuggestion(s, { device: C, nick: 'Cy', song: song(2), now: 2 }).item;
  const held = addToReview(s, { device: C, nick: 'Cy', song: song(3), now: 3 }).item;
  assert.equal(jumpSong(s, { device: A, nick: 'Ana', id: b.id, now: 10 }).ok, true);
  assert.equal(creditsOf(s, A), 1);
  assert.deepEqual(jumpSong(s, { device: A, nick: 'Ana', id: a.id, now: 11 }), { ok: false, reason: 'credits' });
  assert.equal(creditsOf(s, A), 1);
  assert.deepEqual(jumpSong(s, { device: B, nick: 'Ben', id: b.id, now: 12 }), { ok: false, reason: 'jumped' });
  assert.deepEqual(jumpSong(s, { device: B, nick: 'Ben', id: held.id, now: 12 }), { ok: false, reason: 'no_item' });
  assert.deepEqual(jumpSong(s, { device: B, nick: 'Ben', id: 'nope', now: 12 }), { ok: false, reason: 'no_item' });
  nextSong(s); // b plays
  assert.deepEqual(jumpSong(s, { device: B, nick: 'Ben', id: b.id, now: 13 }), { ok: false, reason: 'playing' });
  assert.equal(creditsOf(s, B), 3);
  assert.match(JUMP_MESSAGES.credits, /You need 2 credits to jump a song\. Ask your teacher for more\./);
  // A jumped song can still be voted out (no refund).
  assert.equal(jumpSong(s, { device: B, nick: 'Ben', id: a.id, now: 14 }).ok, true);
  vote(s, A, a.id, -1); vote(s, B, a.id, -1); vote(s, C, a.id, -1);
  assert.equal(s.queue.length, 0);
  assert.equal(creditsOf(s, B), 1);
});

test('credits: the teacher gives (one student, everyone) and sets; amounts checked; capped at CREDITS_MAX', () => {
  const s = credited(0);
  assert.deepEqual(teacherCredits(s, { device: A, amount: 5 }), { ok: true, why: 'grant', changed: [{ device: A, amount: 5, credits: 5 }] });
  for (const bad of [0, -1, 101, 2.5, '5', null, undefined, true]) {
    assert.equal(teacherCredits(s, { device: A, amount: bad }).ok, false, String(bad));
  }
  assert.equal(teacherCredits(s, { device: 'deviceZZZZZZZZZZZZZZ', amount: 1 }).ok, false); // not in the room
  assert.equal(teacherCredits(s, { device: '__proto__', amount: 1 }).ok, false);
  assert.equal(teacherCredits(s, { device: { x: 1 }, amount: 1 }).ok, false);
  const all = teacherCredits(s, { all: true, amount: 3 });
  assert.deepEqual(all.changed.map((c) => [c.device, c.amount, c.credits]), [[A, 3, 8], [B, 3, 3], [C, 3, 3]]);
  assert.deepEqual(teacherCredits(s, { device: B, set: 0 }).changed, [{ device: B, amount: -3, credits: 0 }]);
  for (const bad of [-1, CREDITS_MAX + 1, 1.5, '3']) assert.equal(teacherCredits(s, { device: B, set: bad }).ok, false, String(bad));
  assert.equal(teacherCredits(s, { device: B, set: CREDITS_MAX }).changed[0].credits, CREDITS_MAX);
  assert.deepEqual(teacherCredits(s, { device: B, amount: 100 }).changed, [{ device: B, amount: 0, credits: CREDITS_MAX }]);
  assert.equal(refundCredits(s, B, 1), CREDITS_MAX);
});

test('credits: a new "Starting credits" applies to students who join later; turning credits on starts everyone', () => {
  const s = room();
  // Off → 3: students already in start with 3.
  settleCredits(s); // was off: nothing to keep
  s.settings.startingCredits = 3;
  assert.deepEqual([creditsOf(s, A), creditsOf(s, B)], [3, 3]);
  spendCredits(s, A, 1);
  // 3 → 10: everyone in the room keeps what they have; a student who joins later gets 10.
  settleCredits(s);
  s.settings.startingCredits = 10;
  assert.deepEqual([creditsOf(s, A), creditsOf(s, B), creditsOf(s, C)], [2, 3, 3]);
  const D = 'deviceDDDDDDDDDDDDDD';
  s.students[D] = { nick: 'Dee', joinedAt: 2 };
  assert.equal(creditsOf(s, D), 10);
  // Unlimited again: off; balances wait in case the teacher turns credits back on.
  settleCredits(s);
  s.settings.startingCredits = null;
  assert.equal(creditsOf(s, A), null);
  s.settings.startingCredits = 1;
  assert.deepEqual([creditsOf(s, A), creditsOf(s, D)], [2, 10]);
});

test('credits: rejoining on the same device keeps the balance; kick removes it; old rooms get credits off', () => {
  const s = credited(2);
  spendCredits(s, A, 1);
  delete s.students[A]; // (not kicked) the same device comes back
  s.students[A] = { nick: 'Ana again', joinedAt: 5 };
  assert.equal(creditsOf(s, A), 1);
  kickDevice(s, A);
  assert.equal(s.credits[A], undefined);
  const old = room();
  delete old.credits;
  delete old.settings.startingCredits;
  migrateRoomState(old);
  assert.deepEqual(old.credits, {});
  assert.equal(old.settings.startingCredits, null);
  assert.equal(creditsOn(old), false);
  assert.equal(old.settings.allowJump, false);
});

test('Priority jump: off by default; while off a jump is refused with reason off and costs nothing', () => {
  assert.equal(DEFAULT_SETTINGS.allowJump, false);
  const s = credited(5, { maxWaitingPerStudent: 9 }); // credits on, Priority jump off
  assert.equal(jumpOn(s), false);
  const { item } = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 });
  assert.deepEqual(jumpSong(s, { device: B, nick: 'Ben', id: item.id, now: 2 }), { ok: false, reason: 'off' });
  assert.equal(creditsOf(s, B), 5);
  assert.equal(item.jumped, undefined);
  assert.equal(JUMP_MESSAGES.off, 'Your teacher turned off jumping.');
  // Students see the switch (it decides whether they get Jump buttons).
  assert.equal(snapshotFor(s, B).settings.allowJump, false);
  // On: the jump works and costs JUMP_COST.
  s.settings.allowJump = true;
  assert.equal(jumpOn(s), true);
  assert.equal(jumpSong(s, { device: B, nick: 'Ben', id: item.id, now: 3 }).ok, true);
  assert.equal(creditsOf(s, B), 5 - JUMP_COST);
  // Off again mid-room: the jumped song keeps its place and its tag; new jumps are refused.
  const { item: two } = addSuggestion(s, { device: C, nick: 'Cy', song: song(2), now: 4 });
  for (let i = 0; i < 3; i++) two.votes[`v${i}`] = 1;
  s.settings.allowJump = false;
  assert.deepEqual(jumpSong(s, { device: B, nick: 'Ben', id: two.id, now: 5 }), { ok: false, reason: 'off' });
  assert.equal(creditsOf(s, B), 5 - JUMP_COST);
  const snap = snapshotFor(s, B);
  assert.equal(snap.queue[0].id, item.id);
  assert.deepEqual(snap.queue[0].jumped, { by: 'Ben', at: 3 });
  // Priority jump on but credits off: still off.
  s.settings.allowJump = true;
  s.settings.startingCredits = null;
  assert.equal(jumpOn(s), false);
  assert.deepEqual(jumpSong(s, { device: B, nick: 'Ben', id: two.id, now: 6 }), { ok: false, reason: 'off' });
});

// ---- 👎 limit (protocol.js DOWNVOTE LIMIT) ------------------------------------------------------

/** A room with `n` songs waiting (by C), and `limit` 👎 per student. */
function downRoom(limit = 3, n = 6) {
  const s = room({ maxDownvotes: limit, maxUpvotes: null, maxWaitingPerStudent: 10 });
  const items = [];
  for (let i = 1; i <= n; i++) items.push(addSuggestion(s, { device: C, nick: 'Cy', song: song(i), now: i }).item);
  return { s, items };
}

test('👎 limit: default 3; a 👎 over the limit is refused with downvotes; 👍 has its own limit', () => {
  assert.equal(DEFAULT_SETTINGS.maxDownvotes, 3);
  assert.deepEqual(DOWNVOTE_CHOICES, [1, 2, 3, 5]);
  const { s, items } = downRoom(2);
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 2);
  assert.deepEqual(vote(s, A, items[0].id, -1), { ok: true, removed: false });
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 1);
  assert.equal(vote(s, A, items[0].id, -1).ok, true, 'the same 👎 again uses nothing');
  assert.equal(vote(s, A, items[1].id, -1).ok, true);
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 0);
  assert.deepEqual(vote(s, A, items[2].id, -1), { ok: false, error: 'downvotes' });
  assert.equal(items[2].votes[A], undefined, 'nothing changed');
  assert.equal(VOTE_MESSAGES.downvotes, "You've used your 👎 for this class. You can still 👍 songs you like.");
  assert.equal(vote(s, A, items[2].id, 1).ok, true, '👍 still works');
  assert.deepEqual(vote(s, A, items[2].id, -1), { ok: false, error: 'vote_final' }, 'and cannot turn into a 👎');
  assert.equal(items[2].votes[A], 1);
  assert.equal(snapshotFor(s, B).you.downvotesLeft, 2, 'per device');
  assert.equal(snapshotFor(s, null).students.find((x) => x.device === A).downvotes, 2, 'the host sees what was used');
  assert.equal(snapshotFor(s, null).settings.maxDownvotes, 2);
});

test('👎 limit: votes are final, so a 👎 cannot be taken back or switched to free one', () => {
  const { s, items } = downRoom(1);
  assert.equal(vote(s, A, items[0].id, -1).ok, true);
  assert.equal(vote(s, A, items[1].id, -1).ok, false);
  assert.deepEqual(vote(s, A, items[0].id, 0), { ok: false, error: 'vote_final' });
  assert.deepEqual(vote(s, A, items[0].id, 1), { ok: false, error: 'vote_final' });
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 0);
});

test('👎 limit: spent once the song leaves the queue (plays, vetoed, removed by score); taking back on the song playing frees nothing', () => {
  const { s, items } = downRoom(3);
  for (const i of [0, 1, 2]) assert.equal(vote(s, A, items[i].id, -1).ok, true);
  // Plays: items[0] is first by order? Make sure the 👎 song is the one that plays.
  s.queue = [items[0], ...s.queue.filter((q) => q !== items[0])];
  items[0].pushed = { at: 1 };
  nextSong(s);
  assert.equal(s.nowPlaying.id, items[0].id);
  assert.equal(vote(s, A, items[0].id, 0).ok, false, 'no take-back on the song playing either');
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 0, 'it stays spent');
  veto(s, items[1].id);
  for (const d of ['x1', 'x2', 'x3']) vote(s, d, items[2].id, -1); // removed by its score
  assert.equal(s.queue.some((q) => q.id === items[2].id), false);
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 0, 'vetoed and removed songs keep their 👎 spent');
  assert.deepEqual(vote(s, A, items[3].id, -1), { ok: false, error: 'downvotes' });
});

test('👎 limit: the teacher is unlimited and never counted; null = unlimited', () => {
  const { s, items } = downRoom(1);
  for (const item of items) assert.equal(vote(s, TEACHER_DEVICE, item.id, -1).ok, true);
  assert.equal(s.downvotes[TEACHER_DEVICE], undefined);
  const free = downRoom(null);
  for (const item of free.items) assert.equal(vote(free.s, A, item.id, -1).ok, true);
  assert.equal(snapshotFor(free.s, A).you.downvotesLeft, null);
});

test('👎 limit: lowering it keeps every 👎 cast and blocks new ones until under; raising lets more in', () => {
  const { s, items } = downRoom(3);
  for (const i of [0, 1, 2]) vote(s, A, items[i].id, -1);
  s.settings.maxDownvotes = 1;
  assert.deepEqual(items.slice(0, 3).map((i) => i.votes[A]), [-1, -1, -1]);
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 0);
  assert.equal(vote(s, A, items[3].id, -1).ok, false, '3 of 1');
  s.settings.maxDownvotes = 5;
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 2);
  assert.equal(vote(s, A, items[3].id, -1).ok, true);
});

test('👎 limit: per device in the room (a rejoin keeps it), kick removes it, old rooms and saved settings read 3', () => {
  const { s, items } = downRoom(2);
  vote(s, A, items[0].id, -1);
  delete s.students[A]; // left and came back on the same device
  s.students[A] = { nick: 'Ana', joinedAt: 2 };
  assert.equal(snapshotFor(s, A).you.downvotesLeft, 1);
  kickDevice(s, A);
  assert.equal(s.downvotes[A], undefined);
  const old = room();
  delete old.settings.maxDownvotes;
  delete old.downvotes;
  migrateRoomState(old);
  assert.equal(old.settings.maxDownvotes, 3);
  assert.deepEqual(old.downvotes, {});
  const saved = { ...DEFAULT_SETTINGS };
  delete saved.maxDownvotes;
  assert.equal(validateSettings(saved).settings.maxDownvotes, 3);
  assert.equal(validateSettings({ maxDownvotes: null }).settings.maxDownvotes, null);
  assert.equal(validateSettings({ maxDownvotes: 20 }).settings.maxDownvotes, 20);
  assert.equal(validateSettings({ maxDownvotes: 4 }).settings.maxDownvotes, 4, 'any whole number 1..20');
  for (const bad of [0, 21, 2.5, '3', true]) assert.equal(validateSettings({ maxDownvotes: bad }).ok, false, String(bad));
});

test('👎 limit: the room sends the refusal with the song id and starts no back-to-work rest', () => {
  const src = readFileSync(new URL('../src/room.js', import.meta.url), 'utf8');
  const student = src.slice(src.indexOf('  async studentMessage(ws, a, msg)'), src.indexOf('  async jump(ws, a, id)'));
  const refused = student.indexOf('if (!result.ok)');
  assert.ok(refused > 0, 'a refused vote is answered');
  assert.match(student.slice(refused), /return this\.send\(ws, \{ t: 'error', error: result\.error, message, id: /);
  assert.doesNotMatch(student, /startRest/, 'no vote starts a rest (protocol.js BACK TO WORK: suggestions only)');
});

test('kick: the device leaves the admitted list (its slot frees up; kicked still refuses it)', () => {
  const s = newRoomState('r');
  s.admitted = [A, B];
  s.students[A] = { nick: 'Ann', joinedAt: 0 };
  kickDevice(s, A);
  assert.deepEqual(s.admitted, [B]);
  assert.ok(s.kicked.includes(A));
});

test('hidden counts: students and boards get no numbers, the host gets the real ones; order is real', () => {
  const s = room({ hideVoteCounts: true });
  const a = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 }).item;
  const b = addSuggestion(s, { device: B, nick: 'Ben', song: song(2), now: 2 }).item;
  vote(s, C, b.id, 1);
  vote(s, A, b.id, 1);
  for (const snap of [snapshotFor(s, C), boardSnapshot(s)]) {
    assert.equal(snap.voteCounts, false);
    assert.deepEqual(snap.queue.map((q) => q.id), [b.id, a.id], 'the order still shows');
    assert.deepEqual(snap.queue.map((q) => [q.up, q.down, q.score]), [[0, 0, 0], [0, 0, 0]]);
  }
  assert.equal(snapshotFor(s, C).queue[0].myVote, 1, 'my own vote still shows');
  const host = snapshotFor(s, null);
  assert.equal(host.voteCounts, true);
  assert.equal(host.queue[0].up, 2);
  assert.equal(DEFAULT_SETTINGS.hideVoteCounts, true, 'on by default');
  const old = room();
  delete old.settings.hideVoteCounts;
  assert.equal(migrateRoomState(old).settings.hideVoteCounts, false, 'rooms from before keep their counts');
});

test('next lock: the next song is locked near the end; later votes do not change it; a push after it wins', () => {
  const s = room();
  const a = addSuggestion(s, { device: A, nick: 'Ana', song: song(1), now: 1 }).item;
  const b = addSuggestion(s, { device: B, nick: 'Ben', song: song(2), now: 2 }).item;
  const c = addSuggestion(s, { device: C, nick: 'Cy', song: song(3), now: 3 }).item;
  nextSong(s); // a plays
  assert.equal(s.nowPlaying.id, a.id);
  assert.equal(lockNext(s, 'nope'), false, 'only for the song playing');
  assert.equal(lockNext(s, a.id, 10), true);
  assert.equal(lockNext(s, a.id, 11), false, 'once per song');
  assert.equal(snapshotFor(s, A).nextLocked, true);
  for (const d of ['x1', 'x2', 'x3']) vote(s, d, c.id, 1); // last-second sniping
  assert.equal(snapshotFor(s, A).queue[0].id, b.id, 'the locked song stays first');
  nextSong(s);
  assert.equal(s.nowPlaying.id, b.id);
  assert.equal(s.nextLock, undefined, 'the lock ends when the song starts');
  // A push after the lock wins; a locked song that leaves the queue frees the lock.
  const d = addSuggestion(s, { device: 'x9xxxxxxxxxxxxxxxx', nick: 'Dee', song: song(4), now: 20 }).item;
  assert.equal(lockNext(s, b.id, 30), true);
  assert.equal(s.nextLock.next, c.id);
  d.pushed = { at: 40 };
  assert.equal(snapshotFor(s, A).queue[0].id, d.id);
  delete d.pushed;
  veto(s, c.id);
  assert.equal(snapshotFor(s, A).nextLocked, false);
});

// ---- 👍 limit and 👍 off (protocol.js UPVOTE LIMIT) -----------------------------------------------

/** A room with `n` songs waiting (by C), 👍 `limit` per student. */
function upRoom(settings = {}, n = 6) {
  const s = room({ maxWaitingPerStudent: 10, ...settings });
  const items = [];
  for (let i = 1; i <= n; i++) items.push(addSuggestion(s, { device: C, nick: 'Cy', song: song(i), now: i }).item);
  return { s, items };
}

test('👍 limit: default on, 3 a student; over the limit is refused with upvotes; the teacher is never counted', () => {
  assert.equal(DEFAULT_SETTINGS.upvotes, true);
  assert.equal(DEFAULT_SETTINGS.maxUpvotes, 3);
  assert.deepEqual(UPVOTE_CHOICES, [1, 2, 3, 5]);
  const { s, items } = upRoom({ maxUpvotes: 2 });
  assert.equal(snapshotFor(s, A).upvotes, true);
  assert.equal(snapshotFor(s, A).you.upvotesLeft, 2);
  assert.deepEqual(vote(s, A, items[0].id, 1), { ok: true, removed: false });
  assert.equal(vote(s, A, items[0].id, 1).ok, true, 'the same 👍 again uses nothing');
  assert.equal(snapshotFor(s, A).you.upvotesLeft, 1);
  assert.equal(vote(s, A, items[1].id, 1).ok, true);
  assert.deepEqual(vote(s, A, items[2].id, 1), { ok: false, error: 'upvotes' });
  assert.equal(items[2].votes[A], undefined, 'nothing changed');
  assert.equal(VOTE_MESSAGES.upvotes, "You've used your 👍 for this class.");
  assert.equal(snapshotFor(s, A).you.upvotesLeft, 0);
  assert.equal(snapshotFor(s, B).you.upvotesLeft, 2, 'per device');
  assert.equal(snapshotFor(s, null).students.find((x) => x.device === A).upvotes, 2, 'the host sees what was used');
  for (const it of items) assert.equal(vote(s, TEACHER_DEVICE, it.id, 1).ok, true, 'the teacher is unlimited');
  // The song playing takes a 👍 too, and it uses one.
  const t = upRoom({ maxUpvotes: 1 });
  nextSong(t.s);
  assert.equal(vote(t.s, A, t.s.nowPlaying.id, 1).ok, true);
  assert.deepEqual(vote(t.s, A, t.s.queue[0].id, 1), { ok: false, error: 'upvotes' });
  // Unlimited.
  const u = upRoom({ maxUpvotes: null });
  for (const it of u.items) assert.equal(vote(u.s, A, it.id, 1).ok, true);
  assert.equal(snapshotFor(u.s, A).you.upvotesLeft, null);
  // Lowering the limit removes no 👍; kick forgets the count.
  s.settings.maxUpvotes = 1;
  assert.equal(items[1].votes[A], 1);
  kickDevice(s, A);
  assert.equal(s.upvotes[A], undefined);
});

test('👍 off: a new 👍 is refused (upvotes_off) for students and the teacher; 👍 already cast stay; no ghost 👍', () => {
  const { s, items } = upRoom({ upvotes: false, ghostVote: true });
  assert.deepEqual(vote(s, A, items[0].id, 1), { ok: false, error: 'upvotes_off' });
  assert.deepEqual(vote(s, TEACHER_DEVICE, items[0].id, 1), { ok: false, error: 'upvotes_off' });
  assert.equal(VOTE_MESSAGES.upvotes_off, '👍 is turned off in this class.');
  assert.equal(snapshotFor(s, A).upvotes, false);
  assert.equal(snapshotFor(s, A).you.upvotesLeft, null);
  assert.equal(ghostMs(s), null);
  s.settings.upvotes = true;
  assert.equal(vote(s, A, items[0].id, 1).ok, true);
  s.settings.upvotes = false;
  assert.equal(items[0].votes[A], 1, 'kept');
  assert.equal(snapshotFor(s, null).queue[0].id, items[0].id, 'and still counts');
});

test('👍 limit: settings validation; rooms saved before it stay on and unlimited', () => {
  assert.equal(validateSettings({}).settings.maxUpvotes, 3);
  assert.equal(validateSettings({}).settings.upvotes, true);
  for (const ok of [null, 1, 20]) assert.equal(validateSettings({ maxUpvotes: ok }).settings.maxUpvotes, ok);
  for (const bad of [0, 21, 2.5, '3', true]) assert.equal(validateSettings({ maxUpvotes: bad }).ok, false, String(bad));
  for (const bad of ['on', 1, null]) assert.equal(validateSettings({ upvotes: bad }).ok, false, String(bad));
  const old = room();
  delete old.settings.upvotes;
  delete old.settings.maxUpvotes;
  delete old.upvotes;
  migrateRoomState(old);
  assert.equal(old.settings.upvotes, true);
  assert.equal(old.settings.maxUpvotes, null);
  assert.deepEqual(old.upvotes, {});
});
