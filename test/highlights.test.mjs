// Top 5, the recap, the ⭐ Class favorites and the artist switches (shared/highlights.js,
// shared/queue.js, shared/filter.js mainArtist; protocol.js TOP 5 + RECAP, FAVORITES).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SETTINGS, FAVORITES_MAX, FAVORITES_STUDENT, FAVORITE_HALF_LIFE_DAYS, REASONS, TOP5_WEIGHT, whyText,
} from '../shared/protocol.js';
import {
  addSuggestion, addToReview, artistWaiting, creditsOf, kickDevice, migrateRoomState, newRoomState, nextSong,
  pickNext, refusalMessage, sameArtistWhy, snapshotFor, vote, jumpSong,
} from '../shared/queue.js';
import { banKey, mainArtist, mainArtistName } from '../shared/filter.js';
import {
  bumpFavorite, crowdFavorite, favoriteScore, favoritesValue, hostFavorites, pinFavorite, readFavorites, recapOf,
  recapText, removeFavorite, studentFavorites, top5View, topFive,
} from '../shared/highlights.js';
import { validateSettings } from '../shared/settings.js';

const DAY = 24 * 60 * 60 * 1000;
const devices = ['deviceAAAAAAAAAAAAAA', 'deviceBBBBBBBBBBBBBB', 'deviceCCCCCCCCCCCCCC', 'deviceDDDDDDDDDDDDDD', 'deviceEEEEEEEEEEEEEE'];
const [A, B, C, D, E] = devices;
const NICKS = { [A]: 'Ana', [B]: 'Ben', [C]: 'Cy', [D]: 'Dee', [E]: 'Eli' };
const song = (n, artist = `Artist ${n}`, extra = {}) => ({
  id: `it:${n}`, title: `Song ${n}`, artist, album: 'Album', artwork: 'https://is1-ssl.mzstatic.com/a.jpg', durationMs: 200_000,
  explicit: 'notExplicit', previewUrl: 'https://audio-ssl.itunes.apple.com/p.m4a', ...extra,
});

function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, hideVoteCounts: false, scoreFloor: false, downvoteMode: 'shown', ...settings, maxWaitingPerStudent: 10 }, 1000);
  for (const d of devices) s.students[d] = { nick: NICKS[d], joinedAt: 1 };
  return s;
}

/** Suggest a song for `device`, give it `up` and `down` votes from the other devices. */
function queued(s, n, device, { up = 0, down = 0, artist, now = n } = {}) {
  const r = addSuggestion(s, { device, nick: NICKS[device], song: song(n, artist), now });
  assert.equal(r.ok, true, JSON.stringify(r));
  const others = devices.filter((d) => d !== device);
  for (let i = 0; i < up; i++) vote(s, others[i], r.item.id, 1);
  for (let i = 0; i < down; i++) vote(s, others[up + i], r.item.id, -1);
  return r.item;
}

// ---- Artist normalization ------------------------------------------------------------------------

test('mainArtist: the main artist before feat. / ft. / & / x / , / with / brackets, case and accents ignored', () => {
  assert.equal(mainArtist('Drake feat. Rihanna'), 'drake');
  assert.equal(mainArtist('Drake ft Rihanna'), 'drake');
  assert.equal(mainArtist('DRAKE & Future'), 'drake');
  assert.equal(mainArtist('Marshmello x Bastille'), 'marshmello');
  assert.equal(mainArtist('Tyler, The Creator'), 'tyler');
  assert.equal(mainArtist('Beyoncé (with Jay-Z)'), 'beyonce');
  assert.equal(mainArtist('Calvin Harris with Dua Lipa'), 'calvin harris');
  assert.equal(mainArtist('Lil Nas X'), 'lil nas x', 'an X at the end is part of the name');
  assert.equal(mainArtist('X Ambassadors'), 'x ambassadors');
  assert.equal(mainArtist(''), '');
  assert.equal(mainArtist(undefined), '');
  assert.equal(mainArtistName('Drake feat. Rihanna'), 'Drake');
  // The same main artist as the ban list's key uses.
  assert.ok(banKey({ title: 'One Dance', artist: 'Drake feat. Wizkid' }).endsWith(`|${mainArtist('Drake feat. Wizkid')}`));
});

// ---- Top 5 ---------------------------------------------------------------------------------------

test('top 5: highest net score first; ties → more 👍, then the earlier song; at most 5; 👑 is #1', () => {
  const s = room();
  // One at a time: suggest, vote, play (votes freeze when it plays).
  const plays = [
    [1, A, { up: 1 }], // +1
    [2, B, { up: 3, down: 1 }], // +2, 3 up
    [3, C, { up: 2 }], // +2, 2 up (played later than 2? no: tie on score, fewer 👍)
    [4, D, { up: 2 }], // +2, 2 up, later than 3
    [5, E, { down: 1 }], // -1
    [6, A, { up: 4 }], // +4
    [7, B, {}], // 0
  ];
  let t = 10;
  for (const [n, d, v] of plays) {
    queued(s, n, d, { ...v, now: t });
    nextSong(s, { now: t++ });
  }
  nextSong(s, { now: t++ }); // 7 finishes, nothing left
  const top = topFive(s.history).map((e) => e.song.id);
  assert.deepEqual(top, ['it:6', 'it:2', 'it:3', 'it:4', 'it:1']);
  const view = snapshotFor(s, A).top5;
  assert.equal(view.length, 5);
  assert.deepEqual(Object.keys(view[0]).sort(), ['by', 'down', 'id', 'score', 'song', 'up']);
  assert.deepEqual(view[0].song, { id: 'it:6', title: 'Song 6', artist: 'Artist 6', artwork: song(6).artwork }, 'a short song');
  assert.equal(view[0].by, 'Ana');
  assert.equal(view[1].score, 2);
  assert.equal(view[1].up, 3);
});

test('top 5: a song counts with its final votes (👍 while it played too); skipped songs count, failed and banned ones do not', () => {
  const s = room();
  const one = queued(s, 1, A, { up: 3 });
  nextSong(s); // 1 plays with +3
  assert.equal(vote(s, B, one.id, -1).ok, false, 'the song playing takes no new 👎');
  queued(s, 2, B, { up: 4 });
  nextSong(s, { ended: 'skipped' }); // 1 skipped, 2 plays (+4)
  queued(s, 3, C, { up: 5 });
  nextSong(s, { ended: 'finished' }); // 2 finished, 3 plays (+5)
  queued(s, 4, D, { up: 2 });
  nextSong(s, { ended: 'banned' }); // 3 banned while playing: gone from the history; 4 plays
  nextSong(s, { ended: 'failed' }); // 4 would not play
  assert.deepEqual(s.history.map((e) => [e.song.id, e.status]), [['it:1', 'skipped'], ['it:2', 'finished'], ['it:4', 'failed']]);
  assert.deepEqual(top5View(s.history).map((t) => [t.song.id, t.score]), [['it:2', 4], ['it:1', 3]]);
});

test('top 5, recap, Crowd favorite and Top voter use the votes given while a song played', () => {
  const s = room();
  const one = queued(s, 1, A, { up: 1 }); // B 👍 in the queue
  const two = queued(s, 2, B, { up: 2 }); // A, C 👍 in the queue: +2, plays first
  nextSong(s, { now: 10 });
  assert.equal(s.nowPlaying.id, two.id);
  assert.equal(snapshotFor(s, A).top5[0].score, 2);
  nextSong(s, { now: 11, ended: 'finished' }); // 2 finished at +2; 1 plays at +1
  assert.equal(s.nowPlaying.id, one.id);
  // While 1 plays: C, D, E give it a 👍 (B's 👍 carried over); E takes one back and gives it again.
  for (const d of [C, D, E]) assert.equal(vote(s, d, one.id, 1).ok, true);
  vote(s, E, one.id, 0);
  vote(s, E, one.id, 1);
  assert.deepEqual(snapshotFor(s, A).top5.map((t) => [t.song.id, t.score]), [['it:1', 4], ['it:2', 2]], 'live while it plays');
  nextSong(s, { now: 12, ended: 'skipped' });
  const recap = recapOf(s, 20);
  assert.deepEqual(recap.top5.map((t) => [t.song.id, t.up, t.score]), [['it:1', 4, 4], ['it:2', 2, 2]], 'the final votes');
  assert.deepEqual(recap.totals, { songs: 2, votes: 6, up: 6, down: 0 });
  assert.deepEqual(recap.crowdFavorite, { nick: 'Ana', up: 4 }, 'most 👍 received, 👍 while playing included');
  const mostUp = recap.stats.find((x) => x.id === 'mostUp');
  assert.deepEqual([mostUp?.name, mostUp?.detail], ['Song 1', 'Artist 1 · 👍 4'], 'Most 👍 song');
  // Votes cast: C, D and E voted on the song playing (E's take-back and new 👍 count once).
  assert.deepEqual(s.tally.votes, { [B]: 1, [A]: 1, [C]: 2, [D]: 1, [E]: 1 });
});

test('top 5: a kicked student reads "a classmate" and never wins Crowd favorite; a rename shows the new nickname', () => {
  const s = room();
  queued(s, 1, A, { up: 4 });
  nextSong(s);
  queued(s, 2, B, { up: 1 });
  nextSong(s);
  assert.deepEqual(crowdFavorite(s.history), { nick: 'Ana', up: 4 });
  kickDevice(s, A);
  assert.equal(s.history[0].by, 'a classmate');
  assert.equal(s.history[0].device, null);
  assert.equal(snapshotFor(s, null).top5[0].by, 'a classmate');
  assert.deepEqual(crowdFavorite(s.history), { nick: 'Ben', up: 1 });
});

test('recap: songs in order, Top 5, totals, Crowd favorite (most 👍, ties → more songs), copy text', () => {
  const s = room();
  let t = 100;
  queued(s, 1, A, { up: 2, now: t });
  nextSong(s, { now: t++ });
  queued(s, 2, B, { up: 3, down: 1, now: t });
  nextSong(s, { now: t++ });
  queued(s, 3, A, { up: 1, now: t });
  nextSong(s, { now: t++ });
  queued(s, 4, C, { down: 2, now: t });
  nextSong(s, { ended: 'skipped', now: t++ });
  nextSong(s, { ended: 'skipped', now: t++ });
  const r = recapOf(s, 5000);
  assert.deepEqual(r.songs.map((x) => x.song.id), ['it:1', 'it:2', 'it:3', 'it:4']);
  assert.equal(r.songs[3].status, 'skipped');
  assert.deepEqual(r.totals, { songs: 4, votes: 9, up: 6, down: 3 });
  // Ana 2 + 1 = 3 👍 in 2 songs, Ben 3 👍 in 1 song: a tie on 👍, Ana has more songs.
  assert.deepEqual(r.crowdFavorite, { nick: 'Ana', up: 3 });
  assert.deepEqual(r.top5.map((x) => x.song.id), ['it:2', 'it:1', 'it:3', 'it:4'], 'a tie on +2: more 👍 first');
  assert.equal(r.from, 1000);
  const text = recapText(r, { date: 'Tue Oct 6' });
  assert.match(text, /RoomDJ class recap \(Tue Oct 6\)/);
  assert.match(text, /4 songs played, 9 votes \(👍 6, 👎 3\)\./);
  assert.match(text, /Crowd favorite: Ana \(👍 3\)/);
  assert.match(text, /👑 Song 2 by Artist 2 \(\+2\), suggested by Ben/);
  assert.match(text, /4\. Song 4 by Artist 4 \(-2\) \(skipped\)/);
  // An empty room: nothing to crown.
  const empty = recapOf(room());
  assert.equal(empty.crowdFavorite, null);
  assert.deepEqual(empty.totals, { songs: 0, votes: 0, up: 0, down: 0 });
  assert.doesNotThrow(() => recapText(empty));
});

test('no votes at all: no Crowd favorite', () => {
  const s = room();
  queued(s, 1, A);
  nextSong(s);
  assert.equal(crowdFavorite(s.history), null);
});

// ---- Favorites -----------------------------------------------------------------------------------

test('favorites: songs only (no nickname, device or room in what KV keeps)', () => {
  const s = room();
  queued(s, 1, A, { up: 3 });
  nextSong(s);
  const entry = s.history[0];
  const list = bumpFavorite([], { ...entry.song, by: 'Ana', device: A, room: s.room }, { net: entry.score }, 10 * DAY);
  const kv = JSON.stringify(favoritesValue(list));
  for (const secret of ['Ana', A, s.room, 'device', '"by"']) assert.ok(!kv.includes(secret), `${secret} must not be in KV`);
  assert.deepEqual(Object.keys(list[0]).sort(), ['firstAt', 'lastAt', 'net', 'pinned', 'plays', 'song', 'top5']);
  assert.deepEqual(Object.keys(list[0].song).sort(), ['album', 'artist', 'artwork', 'durationMs', 'explicit', 'id', 'previewUrl', 'title']);
  // Reading it back keeps only those fields too.
  const read = readFavorites(JSON.parse(JSON.stringify({ v: 1, list: [{ ...list[0], by: 'Ana', device: A }] })));
  assert.ok(!JSON.stringify(read).includes('Ana'));
  assert.deepEqual(readFavorites(null), []);
  assert.deepEqual(readFavorites({ list: [{ song: { id: 'nope' } }, 7, null] }), []);
});

test('favorites: score = 3 x Top 5 + net votes, halved every 30 days; bumping adds up', () => {
  const now = 100 * DAY;
  const list = [];
  bumpFavorite(list, song(1), { net: 4 }, now);
  bumpFavorite(list, song(1), { top5: 1, net: 0 }, now);
  assert.equal(list.length, 1);
  assert.equal(list[0].net, 4);
  assert.equal(list[0].top5, 1);
  assert.equal(list[0].plays, 2);
  assert.equal(favoriteScore(list[0], now), TOP5_WEIGHT + 4);
  assert.equal(favoriteScore(list[0], now + FAVORITE_HALF_LIFE_DAYS * DAY), (TOP5_WEIGHT + 4) / 2);
  // An old song with more votes falls below a fresh one.
  const old = { song: song(2), top5: 2, net: 8, plays: 3, pinned: false, firstAt: 0, lastAt: now - 90 * DAY };
  const fresh = { song: song(3), top5: 1, net: 3, plays: 1, pinned: false, firstAt: now, lastAt: now };
  assert.ok(favoriteScore(old, now) < favoriteScore(fresh, now), `${favoriteScore(old, now)} < ${favoriteScore(fresh, now)}`);
  const ranked = hostFavorites([old, fresh, list[0]], now);
  assert.deepEqual(ranked.map((e) => e.song.id), ['it:1', 'it:3', 'it:2']);
  assert.equal(ranked[0].score, 7);
});

test('favorites: at most 200, the lowest unpinned drop off; pinned ones stay and come first', () => {
  const now = 1000 * DAY;
  const list = [];
  for (let n = 1; n <= FAVORITES_MAX; n++) bumpFavorite(list, song(n), { net: n }, now);
  assert.equal(list.length, FAVORITES_MAX);
  assert.equal(pinFavorite(list, 'it:1', true), true); // the weakest, pinned
  assert.equal(pinFavorite(list, 'it:999', true), false);
  bumpFavorite(list, song(500), { net: 50 }, now);
  assert.equal(list.length, FAVORITES_MAX);
  assert.ok(list.some((e) => e.song.id === 'it:1'), 'the pinned song stays');
  assert.ok(!list.some((e) => e.song.id === 'it:2'), 'the lowest unpinned song went');
  assert.ok(list.some((e) => e.song.id === 'it:500'));
  assert.equal(hostFavorites(list, now)[0].song.id, 'it:1', 'pinned first');
  assert.equal(removeFavorite(list, 'it:500'), 1);
  assert.equal(removeFavorite(list, 'it:500'), 0);
  assert.equal(list.length, FAVORITES_MAX - 1);
});

test('favorites for students: the best 20 that pass the room filter; blocked, banned and explicit songs are left out', () => {
  const now = 50 * DAY;
  const list = [];
  for (let n = 1; n <= 30; n++) bumpFavorite(list, song(n, `Band ${n}`), { net: 100 - n }, now);
  bumpFavorite(list, song(40, 'Band 40', { title: 'Party Time' }), { net: 500 }, now);
  bumpFavorite(list, song(41, 'Band 41', { explicit: 'explicit' }), { net: 500 }, now);
  bumpFavorite(list, song(42, 'Band 42'), { net: 500 }, now);
  pinFavorite(list, 'it:30', true);
  const banned = new Set([banKey(song(42, 'Band 42'))]);
  const view = studentFavorites(list, { blocklist: ['party'], banned }, now);
  assert.equal(view.length, FAVORITES_STUDENT);
  const ids = view.map((v) => v.song.id);
  assert.equal(ids[0], 'it:30', 'pinned first');
  assert.ok(!ids.includes('it:40') && !ids.includes('it:41') && !ids.includes('it:42'));
  assert.deepEqual(ids.slice(1, 4), ['it:1', 'it:2', 'it:3']);
  assert.deepEqual(Object.keys(view[0]).sort(), ['pinned', 'song', 'top5']);
  assert.ok(!JSON.stringify(view).includes('party'.toUpperCase()));
});

// ---- 🎨 No back-to-back artist -------------------------------------------------------------------

test('noBackToBackArtist: the next song is the best-ranked one by a different main artist', () => {
  const s = room({ noBackToBackArtist: true });
  queued(s, 1, A, { artist: 'Taylor Swift' });
  nextSong(s); // Taylor Swift plays
  queued(s, 2, B, { artist: 'Taylor Swift feat. Ed Sheeran', up: 3 });
  queued(s, 3, C, { artist: 'Taylor Swift & Friends', up: 2 });
  queued(s, 4, D, { artist: 'Coldplay', up: 1 });
  queued(s, 5, E, { artist: 'Adele' });
  assert.equal(pickNext(s), 2, 'the queue is 2, 3, 4, 5: Coldplay (index 2) is next');
  assert.deepEqual(snapshotFor(s, A).queue.map((q) => q.song.id), ['it:4', 'it:2', 'it:3', 'it:5'], 'the state shows it first');
  assert.equal(nextSong(s).song.id, 'it:4');
  assert.equal(nextSong(s).song.id, 'it:2', 'after Coldplay, Taylor Swift is fine again');
  assert.equal(nextSong(s).song.id, 'it:5', 'not Taylor Swift twice: Adele');
  assert.equal(nextSong(s).song.id, 'it:3');
});

test('noBackToBackArtist: when every waiting song is by that artist, it plays anyway; off: plain order', () => {
  const s = room({ noBackToBackArtist: true });
  queued(s, 1, A, { artist: 'Queen' });
  nextSong(s);
  queued(s, 2, B, { artist: 'Queen', up: 1 });
  queued(s, 3, C, { artist: 'Queen feat. David Bowie' });
  assert.equal(nextSong(s).song.id, 'it:2');
  assert.equal(nextSong(s).song.id, 'it:3');
  // Nothing playing: the last song that played counts.
  nextSong(s);
  assert.equal(s.nowPlaying, null);
  queued(s, 4, D, { artist: 'Queen', up: 2 });
  queued(s, 5, E, { artist: 'ABBA' });
  assert.equal(snapshotFor(s, null).queue[0].song.id, 'it:5');
  assert.equal(nextSong(s).song.id, 'it:5');
  // Off (the default): votes decide.
  const off = room();
  queued(off, 1, A, { artist: 'Queen' });
  nextSong(off);
  queued(off, 2, B, { artist: 'Queen', up: 1 });
  queued(off, 3, C, { artist: 'ABBA' });
  assert.equal(nextSong(off).song.id, 'it:2');
});

test('noBackToBackArtist: a jumped song by the same artist waits one song', () => {
  const s = room({ noBackToBackArtist: true, startingCredits: 5, allowJump: true });
  queued(s, 1, A, { artist: 'Queen' });
  nextSong(s);
  const queen = queued(s, 2, B, { artist: 'Queen' });
  queued(s, 3, C, { artist: 'ABBA' });
  assert.equal(jumpSong(s, { device: D, nick: 'Dee', id: queen.id, now: 5 }).ok, true);
  assert.equal(nextSong(s).song.id, 'it:3');
  assert.equal(nextSong(s).song.id, 'it:2');
});

// ---- 🎨 One song per artist ----------------------------------------------------------------------

test('oneSongPerArtist: refused (same_artist) while a song by that main artist waits in the queue or Needs a look', () => {
  const s = room({ oneSongPerArtist: true, startingCredits: 3 });
  queued(s, 1, A, { artist: 'Drake' });
  const before = creditsOf(s, B);
  const r = addSuggestion(s, { device: B, nick: 'Ben', song: song(2, 'Drake feat. Rihanna') });
  assert.deepEqual(r, { ok: false, reason: 'same_artist' });
  assert.equal(creditsOf(s, B), before, 'nothing charged');
  assert.equal(artistWaiting(s, song(2, 'drake')).song.id, 'it:1');
  const why = sameArtistWhy(artistWaiting(s, song(2, 'DRAKE')));
  assert.deepEqual(why, { id: 'same_artist', evidence: 'A song by Drake is already waiting.' });
  assert.equal(whyText(why), '🎨 One song per artist: A song by Drake is already waiting.');
  assert.equal(REASONS.same_artist.emoji, '🎨');
  assert.match(refusalMessage(s, 'same_artist', 'it:2'), /artist is already waiting/);
  // Needs a look counts too.
  assert.equal(addToReview(s, { device: C, nick: 'Cy', song: song(3, 'Adele') }).ok, true);
  assert.equal(addSuggestion(s, { device: D, nick: 'Dee', song: song(4, 'Adele') }).reason, 'same_artist');
  assert.equal(addToReview(s, { device: D, nick: 'Dee', song: song(5, 'Adele') }).reason, 'same_artist');
  // Another artist is fine; once Drake plays, Drake is free again (now playing does not count).
  assert.equal(addSuggestion(s, { device: B, nick: 'Ben', song: song(6, 'Coldplay') }).ok, true);
  nextSong(s);
  assert.equal(s.nowPlaying.song.id, 'it:1');
  assert.equal(addSuggestion(s, { device: B, nick: 'Ben', song: song(2, 'Drake feat. Rihanna') }).ok, true);
  // Off (the default): no limit.
  const off = room();
  queued(off, 1, A, { artist: 'Drake' });
  assert.equal(addSuggestion(off, { device: B, nick: 'Ben', song: song(2, 'Drake') }).ok, true);
});

// ---- Settings ------------------------------------------------------------------------------------

test('settings: the three switches are booleans; old saved settings and rooms read the defaults', () => {
  assert.equal(DEFAULT_SETTINGS.showFavorites, true);
  assert.equal(DEFAULT_SETTINGS.noBackToBackArtist, false);
  assert.equal(DEFAULT_SETTINGS.oneSongPerArtist, false);
  for (const key of ['showFavorites', 'noBackToBackArtist', 'oneSongPerArtist']) {
    assert.equal(validateSettings({ [key]: 'yes' }).ok, false, key);
    assert.equal(validateSettings({ [key]: 1 }).ok, false, key);
    assert.equal(validateSettings({ [key]: null }).ok, false, key);
    assert.equal(validateSettings({ [key]: true }).settings[key], true, key);
  }
  const { showFavorites, noBackToBackArtist, oneSongPerArtist, ...old } = DEFAULT_SETTINGS;
  const v = validateSettings({ ...old, blocklist: [] });
  assert.equal(v.ok, true);
  assert.equal(v.settings.showFavorites, true);
  assert.equal(v.settings.noBackToBackArtist, false);
  assert.equal(v.settings.oneSongPerArtist, false);
  const saved = room();
  delete saved.history;
  for (const k of ['showFavorites', 'noBackToBackArtist', 'oneSongPerArtist']) delete saved.settings[k];
  migrateRoomState(saved);
  assert.deepEqual(saved.history, []);
  assert.equal(saved.settings.showFavorites, true);
  assert.equal(saved.settings.noBackToBackArtist, false);
  assert.equal(saved.settings.oneSongPerArtist, false);
  assert.deepEqual(snapshotFor(saved, A).top5, []);
});

test('teacher KV keys: the plain name without a profile (today), p:<id>:<name> with one', async () => {
  const { teacherKvKey } = await import('../src/teacher-kv.js');
  assert.equal(teacherKvKey('favorites'), 'favorites');
  assert.equal(teacherKvKey('favorites', null), 'favorites');
  assert.equal(teacherKvKey('favorites', 'ms-example'), 'p:ms-example:favorites');
  assert.throws(() => teacherKvKey('favorites', 'Ms Example'));
  assert.throws(() => teacherKvKey('favorites', 'a:b'));
  assert.equal(newRoomState('0123456789abcdef0123456789abcdef').profile, null);
});
