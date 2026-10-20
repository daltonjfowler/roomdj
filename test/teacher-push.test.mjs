// The teacher's ⏫ Play next / ⏬ Undo and ▶ Play now (protocol.js TEACHER PUSH): order, undo,
// refusals, the remove score, noBackToBackArtist, Play now as a Skip, and that only the host may.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import {
  addSuggestion, addToReview, boardSnapshot, jumpSong, newRoomState, nextIsFor, nextSong, playNowSong, pushSong,
  snapshotFor, veto, vote,
} from '../shared/queue.js';
import { boardMessage } from '../shared/board.js';

const A = 'deviceAAAAAAAAAAAAAA';
const B = 'deviceBBBBBBBBBBBBBB';
const C = 'deviceCCCCCCCCCCCCCC';
const song = (n, extra = {}) => ({
  id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, album: 'Album', artwork: '', durationMs: 1000, explicit: 'notExplicit', previewUrl: 'https://x', ...extra,
});

function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, scoreFloor: false, downvoteMode: 'shown', maxWaitingPerStudent: 10, ...settings }, 1000);
  for (const [d, nick] of [[A, 'Ana'], [B, 'Ben'], [C, 'Cy']]) s.students[d] = { nick, joinedAt: 1 };
  return s;
}

/** Add songs 1..n (by A), returning their item ids. */
function fill(s, n, extra = () => ({})) {
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push(addSuggestion(s, { device: A, nick: 'Ana', song: song(i, extra(i)), now: 1000 + i }).item.id);
  return ids;
}
const order = (s) => snapshotFor(s, null).queue.map((q) => q.id);

test('push: the pushed song goes first, before votes; free; shows in every snapshot', () => {
  const s = room();
  const [s1, s2, s3] = fill(s, 3);
  vote(s, B, s1, 1);
  vote(s, C, s1, 1);
  assert.deepEqual(order(s), [s1, s2, s3]);
  const r = pushSong(s, { id: s3, on: true, now: 5000 });
  assert.equal(r.ok, true);
  assert.deepEqual(order(s), [s3, s1, s2]);
  for (const snap of [snapshotFor(s, null), snapshotFor(s, B), boardSnapshot(s)]) {
    assert.deepEqual(snap.queue[0].pushed, { at: 5000 });
    assert.equal(snap.queue[1].pushed, null);
  }
  // Votes still count and show.
  vote(s, B, s3, -1);
  assert.equal(snapshotFor(s, null).queue[0].score, -1);
  assert.equal(snapshotFor(s, null).queue[0].id, s3);
});

test('push beats a student jump; several pushes stack (the latest first), even in the same millisecond', () => {
  const s = room({ startingCredits: 10, allowJump: true });
  const [s1, s2, s3, s4] = fill(s, 4);
  assert.equal(jumpSong(s, { device: B, nick: 'Ben', id: s2, now: 2000 }).ok, true);
  assert.deepEqual(order(s), [s2, s1, s3, s4]);
  pushSong(s, { id: s3, on: true, now: 3000 });
  pushSong(s, { id: s4, on: true, now: 3000 });
  assert.deepEqual(order(s), [s4, s3, s2, s1]);
  assert.ok(s.queue.find((q) => q.id === s4).pushed.at > s.queue.find((q) => q.id === s3).pushed.at);
  // Pushing again moves it back to the top of the pushes.
  pushSong(s, { id: s3, on: true, now: 3000 });
  assert.deepEqual(order(s), [s3, s4, s2, s1]);
  // Works with credits off and jump off too (free).
  const t = room();
  const [t1, t2] = fill(t, 2);
  assert.equal(pushSong(t, { id: t2, on: true }).ok, true);
  assert.deepEqual(order(t), [t2, t1]);
});

test('undo: back to its own place (its student jump, else its votes)', () => {
  const s = room({ startingCredits: 10, allowJump: true });
  const [s1, s2, s3] = fill(s, 3);
  jumpSong(s, { device: B, nick: 'Ben', id: s3, now: 2000 });
  pushSong(s, { id: s3, on: true, now: 3000 });
  pushSong(s, { id: s2, on: true, now: 4000 });
  assert.deepEqual(order(s), [s2, s3, s1]);
  pushSong(s, { id: s3, on: false });
  assert.deepEqual(order(s), [s2, s3, s1], 's3 still jumped');
  assert.ok(s.queue.find((q) => q.id === s3).jumped);
  pushSong(s, { id: s2, on: false });
  assert.deepEqual(order(s), [s3, s1, s2]);
  assert.equal(snapshotFor(s, null).queue.find((q) => q.id === s2).pushed, null);
  assert.equal(pushSong(s, { id: s1, on: false }).ok, true, 'undo on a song not pushed: nothing to do');
});

test('refused: the song playing, a Needs a look item, a gone song', () => {
  const s = room();
  const [s1] = fill(s, 2);
  nextSong(s);
  assert.equal(s.nowPlaying.id, s1);
  assert.deepEqual(pushSong(s, { id: s1, on: true }), { ok: false, reason: 'playing' });
  const r = addToReview(s, { device: B, nick: 'Ben', song: song(9) }).item;
  assert.deepEqual(pushSong(s, { id: r.id, on: true }), { ok: false, reason: 'review' });
  assert.deepEqual(pushSong(s, { id: 'nope', on: true }), { ok: false, reason: 'no_item' });
  assert.deepEqual(playNowSong(s, { id: s1 }), { ok: false, reason: 'playing' });
  assert.deepEqual(playNowSong(s, { id: r.id }), { ok: false, reason: 'review' });
  assert.deepEqual(playNowSong(s, { id: 'nope' }), { ok: false, reason: 'no_item' });
  assert.equal(s.nowPlaying.id, s1, 'nothing moved on');
});

test('the remove score never removes a pushed song; a veto still does', () => {
  const s = room({ removeAtScore: -2 });
  const [s1, s2] = fill(s, 2);
  pushSong(s, { id: s2, on: true });
  assert.equal(vote(s, B, s2, -1).removed, false);
  assert.equal(vote(s, C, s2, -1).removed, false);
  assert.ok(s.queue.some((q) => q.id === s2), 'still waiting at -2');
  assert.deepEqual(order(s), [s2, s1]);
  // An unpushed song at the remove score still goes.
  vote(s, B, s1, -1);
  assert.equal(vote(s, C, s1, -1).removed, true);
  assert.ok(veto(s, s2));
  assert.equal(s.queue.length, 0);
});

test('noBackToBackArtist never passes over a pushed song', () => {
  const s = room({ noBackToBackArtist: true, oneSongPerArtist: false });
  const [s1, s2, s3] = fill(s, 3, (i) => ({ artist: i === 3 ? 'Other' : 'Same' }));
  nextSong(s); // s1 (Same) plays
  assert.equal(s.nowPlaying.id, s1);
  assert.equal(snapshotFor(s, null).queue[0].id, s3, 'without a push: another artist first');
  pushSong(s, { id: s2, on: true });
  assert.equal(snapshotFor(s, null).queue[0].id, s2);
  assert.equal(nextSong(s).id, s2, 'the teacher decided');
  assert.equal(s.nowPlaying.pushed, undefined, 'a song that starts loses its push');
  assert.equal(snapshotFor(s, null).nowPlaying.pushed, null);
});

test('it plays next when the current song ends', () => {
  const s = room();
  const [s1, s2, s3] = fill(s, 3);
  nextSong(s);
  pushSong(s, { id: s3, on: true });
  assert.equal(nextSong(s).id, s3);
  assert.equal(nextSong(s).id, s2);
  assert.equal(s1, s.history[0].id);
});

test('▶ Play now: the song playing ends as a Skip and the chosen one plays at once', () => {
  const s = room({ startingCredits: 10, allowJump: true });
  const [s1, s2, s3, s4] = fill(s, 4);
  nextSong(s, { now: 2000 });
  jumpSong(s, { device: B, nick: 'Ben', id: s2 });
  pushSong(s, { id: s3, on: true });
  const r = playNowSong(s, { id: s4, now: 9000 });
  assert.equal(r.ok, true);
  assert.equal(r.done.id, s1);
  assert.equal(s.nowPlaying.id, s4);
  assert.equal(s.nowPlaying.pushed, undefined);
  assert.equal(s.history.find((e) => e.id === s1).status, 'skipped');
  assert.ok(s.played.includes('it:4'));
  assert.deepEqual(order(s), [s3, s2], 'the other push and jump keep their places');
  // A doubled Play now (same `from`) is ignored by the guard; the same id again is refused.
  assert.equal(nextIsFor(s, s1), false);
  assert.deepEqual(playNowSong(s, { id: s4 }), { ok: false, reason: 'playing' });
  assert.equal(s.history.length, 2, 'no double advance');
});

test('▶ Play now with nothing playing just starts it; noBackToBackArtist does not stop it', () => {
  const s = room({ noBackToBackArtist: true });
  const [, s2] = fill(s, 2, () => ({ artist: 'Same' }));
  s.history.push({ id: 'old', song: song(0, { artist: 'Same' }) });
  const r = playNowSong(s, { id: s2 });
  assert.equal(r.ok, true);
  assert.equal(r.done, null);
  assert.equal(s.nowPlaying.id, s2);
});

test('only the host may push or play now: boards and students are refused', () => {
  for (const t of ['push', 'playNow']) assert.equal(boardMessage({ t, id: 's1', on: true, from: null }), null, t);
  const src = readFileSync(new URL('../src/room.js', import.meta.url), 'utf8');
  const student = src.slice(src.indexOf('  async studentMessage(ws, a, msg)'), src.indexOf('  async jump(ws, a, id)'));
  assert.doesNotMatch(student, /push|playNow/);
  const host = src.slice(src.indexOf('  async hostMessage(ws, msg)'));
  assert.match(host, /case 'push': \{\s*\r?\n\s*const done = pushSong\(room, \{ id: String\(msg\.id \?\? ''\), on: msg\.on === true \}\)/);
  assert.match(host, /case 'playNow': \{[^}]*if \(msg\.from === undefined \|\| !nextIsFor\(room, msg\.from\)\) return;/);
  // The board's remote reaches hostMessage only for skip and lock.
  const remote = src.slice(src.indexOf('  async boardRemote(ws, raw)'));
  assert.match(remote, /case 'skip':\s*\r?\n\s*case 'lock':\s*\r?\n\s*return this\.hostMessage/);
});
