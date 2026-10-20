// Teacher picks (protocol.js TEACHER PICKS): the teacher suggests and votes from the host page as
// TEACHER_DEVICE. Queue rules, credits, tally, Crowd favorite, snapshots, Blocked today; and that
// the Room sends a host 'suggest' down the students' own suggest path (the full filter).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, DEVICE_ID_PATTERN, TEACHER_DEVICE, byLabel } from '../shared/protocol.js';
import {
  addSuggestion, addToReview, allowBlocked, boardSnapshot, creditsOf, isTeacher, kickDevice, newRoomState, nextSong,
  snapshotFor, suggestRefusal, teacherName, vote,
} from '../shared/queue.js';
import { crowdFavorite, recapOf, recapText, top5View } from '../shared/highlights.js';
import { versusStat } from '../shared/stats.js';
import { blockedView, logBlocked } from '../shared/reasons.js';
import { filterSong } from '../shared/filter.js';

const A = 'deviceAAAAAAAAAAAAAA';
const B = 'deviceBBBBBBBBBBBBBB';
const T = TEACHER_DEVICE;
const song = (n, extra = {}) => ({
  id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, album: 'Album', artwork: '', durationMs: 1000, explicit: 'notExplicit', previewUrl: 'https://x', ...extra,
});

function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, scoreFloor: false, downvoteMode: 'shown', ...settings }, 1000);
  s.profile = { id: 'teacher-1', name: 'Teacher 1', legacy: true };
  s.students[A] = { nick: 'Ana', joinedAt: 1 };
  s.students[B] = { nick: 'Ben', joinedAt: 1 };
  return s;
}

test('the teacher device can never be a student device', () => {
  assert.equal(DEVICE_ID_PATTERN.test(T), false);
  assert.equal(isTeacher(T), true);
  assert.equal(isTeacher(A), false);
});

test('teacherName: the room\'s profile, else "Teacher"', () => {
  assert.equal(teacherName(room()), 'Teacher 1');
  assert.equal(teacherName({ profile: null }), 'Teacher');
  assert.equal(teacherName({ profile: { name: '  ' } }), 'Teacher');
});

test('teacher picks: not held by the lock, cleanup or maxWaitingPerStudent; still duplicate and played', () => {
  const s = room({ maxWaitingPerStudent: 1 });
  s.locked = true;
  s.cleanup = true;
  assert.equal(suggestRefusal(s, A, 'it:9'), 'cleanup');
  assert.equal(suggestRefusal(s, T, 'it:9'), null);
  for (let n = 1; n <= 4; n++) assert.equal(addSuggestion(s, { device: T, nick: 'Teacher 1', song: song(n) }).ok, true);
  assert.equal(addSuggestion(s, { device: T, nick: 'Teacher 1', song: song(1) }).reason, 'duplicate');
  // Another version of a waiting song is a duplicate too (song key).
  assert.equal(suggestRefusal(s, T, 'it:99', song(99, { title: 'Song 1 (Remix)', artist: 'Artist 1' })), 'duplicate');
  s.locked = false;
  s.cleanup = false;
  nextSong(s);
  const playedId = s.nowPlaying.song.id;
  nextSong(s);
  assert.equal(suggestRefusal(s, T, playedId), 'played');
  s.open = false;
  assert.equal(suggestRefusal(s, T, 'it:50'), 'closed');
});

test('teacher picks: tagged teacher, by the teacher name, in the queue and Needs a look; never charged', () => {
  const s = room({ startingCredits: 3 });
  const q = addSuggestion(s, { device: T, nick: teacherName(s), song: song(1) });
  assert.equal(q.item.teacher, true);
  assert.equal(q.item.by, 'Teacher 1');
  assert.equal(q.item.paid, undefined);
  const r = addToReview(s, { device: T, nick: teacherName(s), song: song(2) });
  assert.equal(r.item.teacher, true);
  // Students' picks are not tagged.
  assert.equal(addSuggestion(s, { device: A, nick: 'Ana', song: song(3) }).item.teacher, undefined);
  // No balance was made for the teacher, and students keep theirs.
  assert.equal(Object.hasOwn(s.credits, T), false);
  assert.equal(creditsOf(s, A), 3);
  // A one-song-per-artist room still holds the teacher.
  const t = room({ oneSongPerArtist: true });
  addSuggestion(t, { device: A, nick: 'Ana', song: song(1) });
  assert.equal(addSuggestion(t, { device: T, nick: 'Teacher 1', song: song(2, { artist: 'Artist 1' }) }).reason, 'same_artist');
});

test('the teacher is never a student: snapshots, tally, Top contributor/voter, Crowd favorite', () => {
  const s = room();
  addSuggestion(s, { device: T, nick: 'Teacher 1', song: song(1) });
  addSuggestion(s, { device: A, nick: 'Ana', song: song(2) });
  assert.equal(vote(s, T, 's1', 1).ok, true);
  assert.equal(vote(s, T, 's2', 1).ok, true);
  assert.equal(vote(s, B, 's1', 1).ok, true);
  assert.deepEqual(s.tally.songs, { [A]: 1 });
  assert.deepEqual(s.tally.votes, { [B]: 1 });
  assert.equal(s.tally.log.length, 2); // the genre log counts every pick
  const host = snapshotFor(s, null);
  assert.equal(host.students.some((x) => x.device === T), false);
  assert.equal(host.teacherName, 'Teacher 1');
  const mine = host.queue.find((i) => i.id === 's1');
  assert.equal(mine.teacher, true);
  assert.equal(mine.mine, true);
  assert.equal(mine.myVote, 1);
  assert.equal(host.queue.find((i) => i.id === 's2').myVote, 1);
  const ana = snapshotFor(s, A);
  assert.equal(ana.queue.find((i) => i.id === 's1').teacher, true);
  assert.equal(ana.queue.find((i) => i.id === 's1').mine, false);
  assert.equal(ana.queue.find((i) => i.id === 's1').myVote, 0);
  assert.equal(boardSnapshot(s).queue.find((i) => i.id === 's1').teacher, true);
  // Both play; the teacher's song got 2 👍, Ana's 1: Ana is still the Crowd favorite.
  nextSong(s, { now: 10 });
  nextSong(s, { now: 20, ended: 'finished' });
  nextSong(s, { now: 30, ended: 'finished' });
  assert.deepEqual(crowdFavorite(s.history), { nick: 'Ana', up: 1 });
  const v = versusStat(s.tally, s.students);
  assert.equal(v.contributor.nick, 'Ana');
  assert.equal(v.voter.nick, 'Ben');
  // Top 5 and the recap still show the teacher's pick, as 🍎.
  const top = top5View(s.history);
  assert.equal(top[0].teacher, true);
  assert.equal(byLabel(top[0]), '🍎 Teacher 1');
  const recap = recapOf(s, 40);
  assert.equal(recap.songs.find((x) => x.song.id === 'it:1').teacher, true);
  assert.match(recapText(recap), /suggested by 🍎 Teacher 1/);
  // Only the teacher's picks: no Crowd favorite at all.
  const solo = room();
  addSuggestion(solo, { device: T, nick: 'Teacher 1', song: song(1) });
  vote(solo, A, 's1', 1);
  nextSong(solo);
  nextSong(solo);
  assert.equal(crowdFavorite(solo.history), null);
});

test('the teacher votes once: change, take back, playing song 👍 only', () => {
  const s = room();
  addSuggestion(s, { device: A, nick: 'Ana', song: song(1) });
  addSuggestion(s, { device: A, nick: 'Ana', song: song(2) });
  vote(s, T, 's1', 1);
  vote(s, T, 's1', 1);
  assert.deepEqual(s.queue.find((i) => i.id === 's1').votes, { [T]: 1 });
  vote(s, T, 's1', -1);
  assert.deepEqual(s.queue.find((i) => i.id === 's1').votes, { [T]: -1 });
  vote(s, A, 's1', -1);
  assert.equal(Object.keys(s.queue.find((i) => i.id === 's1').votes).length, 2); // never merged with a student
  vote(s, T, 's1', 0);
  assert.deepEqual(s.queue.find((i) => i.id === 's1').votes, { [A]: -1 });
  nextSong(s); // s2 plays (s1 is at -1)
  assert.equal(s.nowPlaying.id, 's2');
  assert.deepEqual(vote(s, T, 's2', -1), { ok: false, error: 'playing_down' });
  assert.equal(vote(s, T, 's2', 1).ok, true);
  assert.equal(snapshotFor(s, null).nowPlaying.myVote, 1);
  assert.equal(s.history.at(-1).up, 1);
  assert.equal(vote(s, T, 's2', 0).ok, true);
  assert.equal(s.history.at(-1).up, 0);
  assert.deepEqual(s.tally.votes, { [A]: 1 });
});

test('kick never touches the teacher; Allow anyway works for a teacher pick', () => {
  const s = room();
  addSuggestion(s, { device: T, nick: 'Teacher 1', song: song(1) });
  vote(s, T, 's1', 1);
  kickDevice(s, A);
  assert.equal(s.queue.length, 1);
  assert.deepEqual(s.queue[0].votes, { [T]: 1 });
  const log = [];
  const entry = logBlocked(log, { song: song(5), device: T, by: 'Teacher 1', why: { id: 'drugs' }, detail: 'AI checker: x', source: 'filter', action: 'suggest' });
  assert.equal(entry.teacher, true);
  assert.equal(blockedView(log)[0].teacher, true);
  assert.equal(blockedView(log)[0].canAllow, true);
  const done = allowBlocked(s, entry);
  assert.equal(done.ok, true);
  assert.equal(done.item.teacher, true);
  assert.equal(done.item.by, 'Teacher 1');
  assert.deepEqual(s.tally.songs, {}); // still never a Top contributor
});

test('the filter does not know who asks: an explicit song is refused for anyone', async () => {
  const verdict = await filterSong(song(7, { explicit: 'explicit' }), { settings: DEFAULT_SETTINGS, banned: [], env: {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'explicit');
});

test('the Room sends a host suggest down the students\' suggest path, with the full filter', () => {
  const src = readFileSync(new URL('../src/room.js', import.meta.url), 'utf8');
  assert.match(src, /case 'suggest':\s*\r?\n\s*return this\.suggest\(ws, \{ device: TEACHER_DEVICE \}/);
  assert.match(src, /const result = vote\(room, TEACHER_DEVICE,/);
  // suggest() runs filterSong, resting, too long and the artist rule for everyone (no teacher bypass).
  const body = src.slice(src.indexOf('  async suggest(ws, a, raw)'), src.indexOf('  async hostMessage(ws, msg)'));
  assert.match(body, /verdict = await filterSong\(song,/);
  assert.doesNotMatch(body, /if \(teacher\)[^\n]*filterSong/);
  for (const rule of ['tooLong(song, this.room.settings)', 'artistWaiting(this.room, song)', 'await this.resting(song)']) assert.ok(body.includes(rule), rule);
  assert.match(body, /teacher \? 0 : \(spendCredits/);
});
