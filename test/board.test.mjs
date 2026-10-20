// The board + remote (protocol.js BOARD + REMOTE; shared/board.js): the board link's fragment, the
// allow-list of what a board socket may send, the host's board info and progress, and the State a
// board sees (no settings, no Needs a look songs, no votes of its own).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addSigninToken, boardLink, boardMessage, boardTokens, cleanBoardInfo, cleanProgress, parseBoardFragment, replaceLinkToken,
} from '../shared/board.js';
import { BOARD_REMOTE_ACTIONS, BOARD_SIGNIN_MAX, BOARD_TOKEN_PATTERN } from '../shared/protocol.js';
import { addSuggestion, addToReview, boardSnapshot, newRoomState, nextSong, snapshotFor, vote } from '../shared/queue.js';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';

const ROOM = '0123456789abcdef0123456789abcdef';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

test('a board token is 43 base64url letters', () => {
  assert.equal(TOKEN.length, 43);
  assert.ok(BOARD_TOKEN_PATTERN.test(TOKEN));
  assert.ok(!BOARD_TOKEN_PATTERN.test(`${TOKEN}x`));
  assert.ok(!BOARD_TOKEN_PATTERN.test(TOKEN.replace('A', '+')));
});

test('boardLink puts room and token in the fragment, never the query', () => {
  const url = boardLink('https://roomdj.com/', ROOM, TOKEN);
  assert.equal(url, `https://roomdj.com/board/#${ROOM}.${TOKEN}`);
  const u = new URL(url);
  assert.equal(u.search, '');
  assert.equal(u.pathname, '/board/');
  assert.deepEqual(parseBoardFragment(u.hash), { room: ROOM, token: TOKEN });
});

test('parseBoardFragment takes exactly #<room>.<token>', () => {
  assert.deepEqual(parseBoardFragment(`#${ROOM}.${TOKEN}`), { room: ROOM, token: TOKEN });
  assert.deepEqual(parseBoardFragment(`${ROOM}.${TOKEN}`), { room: ROOM, token: TOKEN }, 'the # is optional');
  for (const bad of [
    '', '#', null, undefined, `#${ROOM}`, `#${ROOM}.`, `#.${TOKEN}`,
    `#${ROOM.toUpperCase()}.${TOKEN}`, // room ids are lower-case hex
    `#${ROOM}.${TOKEN}.extra`, `#${ROOM}.${TOKEN}x`, `#${ROOM}.${TOKEN.slice(1)}`,
    `#${ROOM}.${TOKEN}&x=1`, `#${ROOM}x.${TOKEN}`, `#${ROOM}.${TOKEN.replace('A', '/')}`,
  ]) assert.equal(parseBoardFragment(bad), null, String(bad));
});

test('boardMessage lets through only the remote actions', () => {
  assert.deepEqual(boardMessage({ t: 'skip', from: 'q1' }), { t: 'skip', from: 'q1' });
  assert.deepEqual(boardMessage({ t: 'skip', from: null }), { t: 'skip', from: null });
  assert.deepEqual(boardMessage({ t: 'veto', id: 'q7', reason: 'x', note: 'y' }), { t: 'veto', id: 'q7' }, 'only the id');
  assert.deepEqual(boardMessage({ t: 'lock', on: true }), { t: 'lock', on: true });
  assert.deepEqual(boardMessage({ t: 'lock', on: false }), { t: 'lock', on: false });
  assert.deepEqual(boardMessage({ t: 'recapShow', extra: 1 }), { t: 'recapShow' });
  for (const action of BOARD_REMOTE_ACTIONS) assert.deepEqual(boardMessage({ t: 'remote', action }), { t: 'remote', action });
  assert.deepEqual([...BOARD_REMOTE_ACTIONS], ['playPause', 'volUp', 'volDown']);
});

test('boardMessage refuses everything a host may send and malformed remote actions', () => {
  for (const t of ['next', 'ban', 'allow', 'kick', 'rename', 'settings', 'credits', 'code', 'times', 'cleanup', 'close',
    'service', 'lookupResult', 'blockedAllow', 'blockedBan', 'favoritePin', 'favoriteRemove', 'wake', 'recap',
    'boardLink', 'boardInfo', 'progress', 'board', 'suggest', 'vote', 'jump', 'push', 'playNow']) {
    assert.equal(boardMessage({ t, id: 'q1', on: true, from: 'q1' }), null, t);
  }
  assert.equal(boardMessage({ t: 'skip' }), null, 'skip needs from');
  assert.equal(boardMessage({ t: 'skip', from: 5 }), null);
  assert.equal(boardMessage({ t: 'veto' }), null);
  assert.equal(boardMessage({ t: 'veto', id: 'x'.repeat(65) }), null);
  assert.equal(boardMessage({ t: 'lock', on: 'yes' }), null);
  assert.equal(boardMessage({ t: 'remote', action: 'close' }), null);
  assert.equal(boardMessage({ t: 'remote', action: 'toString' }), null);
  assert.equal(boardMessage(null), null);
  assert.equal(boardMessage([{ t: 'skip', from: null }]), null);
  assert.equal(boardMessage('skip'), null);
});

test('cleanBoardInfo: a normalized code and the three display choices', () => {
  assert.deepEqual(cleanBoardInfo({ code: 'Blue Robot 42', display: { size: 'l', who: false, art: true } }),
    { code: 'blue-robot-42', display: { size: 'l', who: false, art: true } });
  assert.deepEqual(cleanBoardInfo({}), { code: null, display: { size: 'm', who: true, art: true } });
  assert.equal(cleanBoardInfo({ code: 'x'.repeat(41) }).code, null, 'too long');
  assert.equal(cleanBoardInfo({ code: '<script>' }).code, 'script', 'only letters, numbers and dashes');
  assert.equal(cleanBoardInfo({ display: { size: 'xl' } }).display.size, 'm');
});

test('cleanProgress: numbers in range, booleans, an id or null', () => {
  assert.deepEqual(cleanProgress({ id: 'q3', pos: 12.345, dur: 30, started: true, paused: false }), { id: 'q3', pos: 12.3, dur: 30, started: true, paused: false });
  assert.equal(cleanProgress({ id: 'q3', t: 'progress' }).t, undefined, 'never a `t` that could clobber the message type');
  assert.deepEqual(cleanProgress({ id: null, pos: -1, dur: Infinity }), { id: null, pos: 0, dur: 0, started: false, paused: false });
  assert.equal(cleanProgress({ id: 5 }), null);
  assert.equal(cleanProgress({}), null);
});

const song = (n) => ({ id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, album: '', artwork: '', durationMs: 0, explicit: 'notExplicit', previewUrl: '' });
const A = 'device-aaaaaaaaaaaa';
const B = 'device-bbbbbbbbbbbb';

test('boardSnapshot: what students see, the Needs a look count only, no settings and no votes of its own', () => {
  const s = newRoomState(ROOM, { ...DEFAULT_SETTINGS, hideVoteCounts: false, blocklist: ['secretword'], bellSchedule: [{ name: 'P1', ends: '08:00' }], maxWaitingPerStudent: 5 }, Date.now(), Date.now() + 3_600_000);
  s.students[A] = { nick: 'Ava', joinedAt: 1 };
  s.students[B] = { nick: 'Ben', joinedAt: 1 };
  s.profile = { id: 'teacher-1', name: 'Teacher 1', legacy: true };
  for (const n of [1, 2, 3]) assert.ok(addSuggestion(s, { device: A, nick: 'Ava', song: song(n) }).ok);
  assert.ok(addToReview(s, { device: B, nick: 'Ben', song: song(9) }).ok);
  nextSong(s);
  vote(s, B, s.queue[0].id, 1);
  const host = { online: true, code: 'blue-robot', display: { size: 'm', who: true, art: true }, player: null };
  const b = boardSnapshot(s, { host });
  assert.equal(b.reviewCount, 1);
  assert.equal(b.review, undefined, 'never the Needs a look songs');
  assert.equal(b.settings, undefined);
  assert.equal(b.you, undefined);
  assert.equal(b.students, undefined);
  assert.equal(b.aiStatus, undefined);
  assert.equal(b.profile, undefined);
  assert.equal(b.boards, undefined);
  assert.ok(!JSON.stringify(b).includes('secretword'), 'no blocked word');
  assert.ok(!JSON.stringify(b).includes(A) && !JSON.stringify(b).includes(B), 'no device id');
  assert.ok(!JSON.stringify(b).includes('Song 9'), 'no review song');
  assert.equal(b.teacher, 'Teacher 1');
  assert.equal(b.nowPlaying.song.id, 'it:1');
  assert.equal(b.queue.length, 2);
  assert.ok(b.queue.every((q) => q.mine === false && q.myVote === 0));
  assert.equal(b.queue[0].up, 1);
  assert.deepEqual(b.host, host);
  assert.deepEqual(boardSnapshot(s).host, { online: false, code: null, display: null, player: null });
  // The host sees how many boards are connected; students never do.
  assert.equal(snapshotFor(s, null, { boards: 2 }).boards, 2);
  assert.equal(snapshotFor(s, A, { boards: 2 }).boards, undefined);
});

// ---- Board tokens (protocol.js BOARD SIGN-IN): one link token + the newest sign-in tokens ----
const H = (n) => n.toString(16).padStart(64, '0');

test('boardTokens: a room from before sign-in (one boardHash) reads as one link token', () => {
  assert.deepEqual(boardTokens({ boardHash: H(1) }), [{ hash: H(1), kind: 'link', at: 0 }]);
  assert.deepEqual(boardTokens({}), []);
  assert.deepEqual(boardTokens(null), []);
  assert.deepEqual(boardTokens({ boardHash: 'nope' }), []);
  assert.deepEqual(boardTokens({ boardTokens: [{ hash: H(2), kind: 'signin', at: 5 }], boardHash: H(1) }), [{ hash: H(2), kind: 'signin', at: 5 }],
    'the list wins over an old boardHash');
  assert.deepEqual(boardTokens({ boardTokens: [{ hash: 'x', kind: 'link' }, { hash: H(3), kind: 'other' }, null, { hash: H(4), kind: 'link', at: 1 }] }),
    [{ hash: H(4), kind: 'link', at: 1 }], 'bad entries dropped');
});

test('addSigninToken adds a hash and drops nothing until the sign-in tokens are full', () => {
  const link = { hash: H(1), kind: 'link', at: 1 };
  let { list, dropped } = addSigninToken([link], H(2), 2);
  assert.deepEqual(dropped, []);
  assert.deepEqual(list.map((t) => [t.hash, t.kind]), [[H(1), 'link'], [H(2), 'signin']], 'the link stays (no rotate, no kick)');
  for (let i = 3; i < 2 + BOARD_SIGNIN_MAX; i++) ({ list, dropped } = addSigninToken(list, H(i), i));
  assert.deepEqual(dropped, []);
  assert.equal(list.filter((t) => t.kind === 'signin').length, BOARD_SIGNIN_MAX);
  ({ list, dropped } = addSigninToken(list, H(99), 99));
  assert.deepEqual(dropped, [H(2)], 'past the cap: the oldest sign-in token goes');
  assert.equal(list.filter((t) => t.kind === 'signin').length, BOARD_SIGNIN_MAX);
  assert.ok(list.some((t) => t.hash === H(1) && t.kind === 'link'), 'never the link token');
  assert.equal(list.at(-1).hash, H(99));
});

test('replaceLinkToken: the old link goes, sign-in tokens stay', () => {
  const before = [{ hash: H(1), kind: 'link', at: 1 }, { hash: H(2), kind: 'signin', at: 2 }];
  const { list, dropped } = replaceLinkToken(before, H(3), 3);
  assert.deepEqual(dropped, [H(1)]);
  assert.deepEqual(list.map((t) => [t.hash, t.kind]), [[H(2), 'signin'], [H(3), 'link']]);
  assert.deepEqual(replaceLinkToken([], H(4), 4), { list: [{ hash: H(4), kind: 'link', at: 4 }], dropped: [] });
});
