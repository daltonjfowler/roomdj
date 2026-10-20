// The board + remote (protocol.js BOARD + REMOTE): pure pieces the Room, the host page, the board
// page and the Node tests share. The board token rides in the URL fragment and in the board's first
// WebSocket message; only what this file lets through ever reaches the room's handlers.

import { BOARD_REMOTE_ACTIONS, BOARD_SIGNIN_MAX, BOARD_TOKEN_PATTERN, CODE_MAX, RECAP_CUES, ROOM_ID_PATTERN } from './protocol.js';
import { normalizeCode } from './code.js';

/** The board page's address for a room: <origin>/board/#<room id>.<board token>. */
export function boardLink(origin, room, token) {
  return `${String(origin).replace(/\/+$/, '')}/board/#${room}.${token}`;
}

/**
 * The room id and board token from a location.hash ("#<room>.<token>", the "#" optional), or null
 * when it is not exactly that. Nothing else is accepted: no query, no extra parts.
 */
export function parseBoardFragment(hash) {
  const m = /^#?([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(String(hash ?? '').trim());
  if (!m || !ROOM_ID_PATTERN.test(m[1]) || !BOARD_TOKEN_PATTERN.test(m[2])) return null;
  return { room: m[1], token: m[2] };
}

/**
 * A board socket's message, cleaned to exactly what a board may ask for, or null (refused). The
 * allow-list: skip (with `from`), veto (the playing song's id), lock, recapShow, recapCue, and the remote
 * actions the host page carries out (BOARD_REMOTE_ACTIONS). Never settings, ban, kick, close, code,
 * credits, allow or anything else a host may send.
 */
export function boardMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
  switch (msg.t) {
    case 'skip':
      return msg.from === null || id(msg.from) ? { t: 'skip', from: msg.from } : null;
    case 'veto':
      return id(msg.id) ? { t: 'veto', id: msg.id } : null;
    case 'lock':
      return typeof msg.on === 'boolean' ? { t: 'lock', on: msg.on } : null;
    case 'recapShow':
      return { t: 'recapShow' };
    case 'recapCue': // the board's show, so the host's recap music and sounds follow it (RECAP MUSIC)
      return RECAP_CUES.includes(msg.cue) ? { t: 'recapCue', cue: msg.cue } : null;
    case 'remote':
      return BOARD_REMOTE_ACTIONS.includes(msg.action) ? { t: 'remote', action: msg.action } : null;
    default:
      return null;
  }
}

const SIZES = ['s', 'm', 'l'];

/** The host's 'boardInfo' cleaned: { code (normalized, or null), display: { size, who, art } }. */
export function cleanBoardInfo(msg) {
  const code = normalizeCode(typeof msg?.code === 'string' ? msg.code.slice(0, CODE_MAX * 2) : '');
  const d = msg?.display && typeof msg.display === 'object' ? msg.display : {};
  return {
    code: code && code.length <= CODE_MAX ? code : null,
    display: { size: SIZES.includes(d.size) ? d.size : 'm', who: d.who !== false, art: d.art !== false },
  };
}

/** The host's 'progress' cleaned, or null: { id, pos, dur, started, paused } (seconds, 0 to 24 h). */
export function cleanProgress(msg) {
  const sec = (v) => (Number.isFinite(v) && v >= 0 && v <= 86_400 ? Math.round(v * 10) / 10 : 0);
  if (msg?.id !== null && !(typeof msg?.id === 'string' && msg.id.length <= 64)) return null;
  return { id: msg.id, pos: sec(msg.pos), dur: sec(msg.dur), started: msg.started === true, paused: msg.paused === true };
}

// ---- The room's board tokens (protocol.js BOARD SIGN-IN): hashes only, [{ hash, kind, at }] ----
// kind 'link': the host's 📺 Board link (at most one); kind 'signin': a board that signed in with
// the teacher key (POST /api/teacher/board; the newest BOARD_SIGNIN_MAX are kept).

const HASH = /^[0-9a-f]{64}$/;
const goodToken = (t) => t && typeof t === 'object' && HASH.test(t.hash ?? '') && (t.kind === 'link' || t.kind === 'signin');

/** The room's board tokens, oldest first. A room saved before sign-in (one `boardHash`) reads as one link token. */
export function boardTokens(room) {
  if (Array.isArray(room?.boardTokens)) {
    return room.boardTokens.filter(goodToken).map((t) => ({ hash: t.hash, kind: t.kind, at: Number(t.at) || 0 }));
  }
  return typeof room?.boardHash === 'string' && HASH.test(room.boardHash) ? [{ hash: room.boardHash, kind: 'link', at: 0 }] : [];
}

/**
 * A sign-in token's hash joins the list; nothing else changes (no board is kicked) except that past
 * `max` sign-in tokens the oldest sign-in ones go. The link token is never dropped here.
 * → { list, dropped: hashes that stopped working }
 */
export function addSigninToken(list, hash, at = Date.now(), max = BOARD_SIGNIN_MAX) {
  const next = [...list, { hash, kind: 'signin', at }];
  const dropped = [];
  while (next.filter((t) => t.kind === 'signin').length > max) {
    dropped.push(next.splice(next.findIndex((t) => t.kind === 'signin'), 1)[0].hash);
  }
  return { list: next, dropped };
}

/** 🔁 New board link: the old link token goes (its boards stop), sign-in tokens stay. → { list, dropped } */
export function replaceLinkToken(list, hash, at = Date.now()) {
  return {
    list: [...list.filter((t) => t.kind !== 'link'), { hash, kind: 'link', at }],
    dropped: list.filter((t) => t.kind === 'link').map((t) => t.hash),
  };
}
