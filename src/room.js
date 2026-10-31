// One Durable Object per open room, named by its random room id (ROOM_ID_PATTERN). It holds the
// queue, votes, nicknames and sockets. Sockets use the WebSocket Hibernation API: the object can
// sleep between messages, so everything that matters lives in DO storage (one "state" key) and
// each socket's attachment ({ role, device, nick }). The room closes itself at `until` (the
// teacher's choice, an alarm), when the teacher closes it, or after 12 idle hours (the backstop);
// closing deletes it all, and the class code's KV route (src/codes.js).
// Class time (protocol.js CLEANUP): at cleanupAt the same alarm puts the room in cleanup mode
// (suggestions closed; the host page fades the music out); the alarm rings at the earliest of
// cleanupAt, until and 12 idle hours (shared/classtime.js nextAlarmAt), and the next waiting song's
// 👻 ghost 👍 moment (protocol.js GHOST VOTE, queue.js nextGhostAt: the order changes with no message,
// so that alarm re-sorts and broadcasts).
// Top 5 + recap (shared/highlights.js): the room's `history` of songs that played, deleted with it.
// ⭐ Class favorites: KV `favorites` (songs only); a song that finishes with net ≥ +2 gets in, and
// at close the period's Top 5 count once more (protocol.js FAVORITES).
// Teacher profiles (protocol.js TEACHER PROFILES): the room keeps its profile ({ id, name, legacy };
// null = a room from before profiles = legacy) and reads and writes that teacher's KV records only:
// banned, approved:*, favorites (src/teacher-kv.js). Reclaim keeps it.
// 😴 Repeats (protocol.js REPEATS, shared/repeats.js): other versions of a song count as the song
// (played, duplicate); the teacher's KV `recent` (songs only) holds when each song last played, for
// the repeat cooldown (settings.cooldownDays).
// 📚 Back to work (protocol.js BACK TO WORK, shared/backtowork.js): a student's suggestion, vote or
// jump starts that device's rest; while it rests, its suggest / vote / jump are refused here, before
// anything is checked or charged. The teacher never rests; 'letBackIn' ends one student's rest.
// Teacher picks (protocol.js TEACHER PICKS): the host page suggests and votes as TEACHER_DEVICE, a
// pseudo device no student id can be. Its suggestions take the students' path (suggest() below:
// the same filter, repeats and artist rules), without credits, the per-student limit, the lock or
// cleanup; its searches ('search') run the room's own search through the same relay and cache.
// Song search: "the teacher's computer searches" (src/host-relay.js). Each iTunes call goes to
// the host page over the host socket; the room maps and checks the raw results itself.
// The class code: the room keeps only its hash (codeHash) and compares in constant time. A device
// that joined with the code is admitted for the room's life, so changing the code never sends
// anyone out; a device that was never admitted cannot open a student socket or search the room.
//
// Internal routes (only the Worker calls these; paths are not public):
//   POST /init   { id, codeHash, until, cleanupAt, settings, hostHash, profile }  → 201, or 409 if already open
//   POST /admit  { codeHash, device }           → 200 { room, until } | 403 code | 403 kicked | 403 full
//   POST /teacherInfo { profile }               → 200 { room, code, until, period, songs, students, hostOnline } | 404
//   POST /teacherResume { profile, hostHash }   → 200 { room, until, cleanupAt, code } | 404  ("Your open rooms":
//                                                 a new host token; host sockets get host_moved, then 4002)
//   POST /teacherClose { profile }              → 200 { closed } | 404  ("Close my open rooms")
//   GET  /info                                  → 200 { open: true, until } | 404
//   GET  /search?q=   header x-device           → 200 { results }
//   GET  /ws?role=...                           → WebSocket
//   GET  /youtube?song=&skip=     header x-host-token   → 200 { videoId } (host only)
//   GET  /host                    header x-host-token   → 200 { ok: true } | 403 host | 404 (Apple token check)
//   POST /boardToken { profile: { id, legacy } }  → 200 { room, boardToken, until } | 404 no_room (closed, or
//                                                 another teacher's room): the board's sign-in (protocol.js
//                                                 BOARD SIGN-IN); a new sign-in board token, nobody kicked
//
// The board (protocol.js BOARD + REMOTE): a projector page with its own token (only its hash in the
// room state, like the host token). Its socket opens as 'boardWait' and must send { t: 'board',
// token } first; then it is a 'board': it gets boardSnapshot states and may send only what
// shared/board.js boardMessage lets through. Play / pause / volume go to the host page (it owns
// the player); the board never plays anything.
// Board tokens (shared/board.js boardTokens): hashes only, at most one 'link' token (📺 Board link)
// plus the newest BOARD_SIGNIN_MAX 'signin' tokens (POST /boardToken). A board socket remembers
// which hash it used, so a dropped token closes only its own boards.
// The teacher's KV signpost of open rooms (src/open-rooms.js): this room adds itself on init,
// teacherResume and 'times', and takes itself out when it closes.

import { DurableObject } from 'cloudflare:workers';
import { couponsOn, redeemCoupon } from './coupons.js';
import { COUPON_MESSAGES } from '../shared/coupon.js';
import { ADMITTED_MAX, DEVICE_ID_PATTERN, FILTER_REASONS, NICK_MAX, QUERY_MAX, SHELF_MAX } from '../shared/protocol.js';
import { TEACHER_DEVICE, TEACHER_SEARCH_RATE, TEACHER_SUGGEST_RATE } from '../shared/protocol.js';
import {
  addSuggestion, addToReview, allowBlocked, lockNext, allowReview, applyBlocklist, kickDevice, migrateRoomState, newRoomState,
  nextIsFor, nextSong, nickTaken, refusalMessage, reviewList, snapshotFor, suggestRefusal, takeReview, veto, vote, VOTE_MESSAGES,
} from '../shared/queue.js';
import { PUSH_MESSAGES, nextGhostAt, playNowSong, pushSong, sortQueue } from '../shared/queue.js';
import {
  JUMP_MESSAGES, couponCredits, creditsOf, jumpSong, refundCredits, refundItem, settleCredits, spendCredits, teacherCredits,
} from '../shared/queue.js';
import { ART_RATE, JUMP_COST, SUGGEST_COST } from '../shared/protocol.js';
import { ART_WAIT_MS, artFields, artJson, artKey, validArtKey } from '../shared/art.js';
import { cachedArtVerdict, checkCover, putTeacherArtOk, teacherArtOk } from './art.js';
import { backToWorkMessage, backToWorkOn, clearRests, letBackIn, restRefusal, startRest } from '../shared/backtowork.js';
import { SPOTIFY, catalogOf, legacySong, songId } from '../shared/catalog.js';
import { approveSong, banKey, checkFromKv, filterSong, quickCheck } from '../shared/filter.js';
import {
  BLOCKED_WORD_EVIDENCE, blockedView, canAllow, canBan, filterWhy, logBlocked, teacherWhy,
} from '../shared/reasons.js';
import { askNickAi, cachedNickVerdict, nickAllowed, nickKey } from '../shared/nick.js';
import { isGeneratedNick } from '../shared/nickgen.js';
import { validateSettings } from '../shared/settings.js';
import { validateCode } from '../shared/code.js';
import { bellOffsetMs, cleanupDue, nextAlarmAt, shiftTimes, tooLong, validateTimes } from '../shared/classtime.js';
import { CatalogError, cleanQuery } from './catalog-base.js';
import { HostRelay } from './host-relay.js';
import { LYRICS_PATIENT_MS, judgeFromLyrics } from './lyrics.js';
import { NIGHT_SEARCH_MAX, addToNight, nightSong, nightWorthy } from './night.js';
import { lookupCatalog, roomCatalog } from './catalog.js';
import { readBanned, searchAllowed } from './search.js';
import { GROWN_KEY, SHELF_READS, archiveReady, isShelf, readGrown, shelfSongs } from './songbook.js';
import { ASKS_KV, noteAsks, readAsks, readPopular } from './popular.js';
import { askEntry, finishAsks, logAsk, requestLog } from '../shared/requests.js';
import { claimCode, codeHash, codeInUse, deleteCodeRoute, putCodeRoute, releaseCode } from './codes.js';
import { YoutubeError, resolveVideo } from './youtube.js';
import { VIDEO_ID_PATTERN } from '../shared/youtube-match.js';
import { teacherKvKey, teacherScope } from './teacher-kv.js';
import { PROFILE_ID_PATTERN, PROFILE_NAME_MAX, isFreeTeacher } from '../shared/protocol.js';
import { spendFree } from './free.js';
import { FAVORITE_MIN_NET } from '../shared/protocol.js';
import { artistWaiting, boardSnapshot, sameArtistWhy, teacherName, unplay } from '../shared/queue.js';
import { BOARDS_MAX, BOARD_TOKEN_PATTERN, PROGRESS_RATE } from '../shared/protocol.js';
import { addSigninToken, boardMessage, boardTokens, cleanBoardInfo, cleanProgress, replaceLinkToken } from '../shared/board.js';
import { addOpenRoom, removeOpenRoom, updateOpenRooms } from './open-rooms.js';
import { REPEAT_MIN_MS, REST_WRITE_MS } from '../shared/protocol.js';
import {
  mergeRecent, notePlayed, pruneRecent, readRecent, recentValue, restingFor, restingList,
} from '../shared/repeats.js';
import {
  bumpFavorite, favoritesValue, hostFavorites, pinFavorite, readFavorites, recapOf, relabelHistory, removeFavorite,
  studentFavorites, topFive, downvoteModeOf, netOf, shownScore,
} from '../shared/highlights.js';

/** KV key of the teacher's ⭐ Class favorites (protocol.js FAVORITES); songs only. */
const KV_FAVORITES = 'favorites';
/** How long a room trusts its copy of the favorites before reading KV again. */
const FAVORITES_FRESH_MS = 60_000;
/** KV key of the teacher's repeat record (protocol.js REPEATS); songs only. */
const KV_RECENT = 'recent';
const RECENT_FRESH_MS = 60_000;
const RESTING = 'That song played not long ago, so it is resting. Pick a different song.';
/** Until the page words it in its own time zone (repeats.js restingEvidence). */
const RESTING_EVIDENCE = 'This song played not long ago. It can come back later.';

export const IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_HOST_MESSAGE_BYTES = 64 * 1024; // lookup results
const BANNED_MAX = 2000;
/** Songs a room keeps from its own searches (memory and storage), so a suggestion rarely needs the catalog again. */
const RECENT_MAX = 2000;
const SERVICES = ['preview', 'spotify', 'youtube', 'apple'];

// [count, window ms]
const LIMITS = {
  search: [15, 60_000],
  youtube: [30, 60_000], // host only; a search costs 100 of YouTube's 10,000 units a day
  roomSearch: [90, 60_000],
  suggest: [6, 60_000],
  // Student suggestions per room: each may cost a Workers AI call, and one student who knows the
  // code can admit many device ids. A whole class at the bell fits easily.
  roomSuggest: [90, 60_000],
  teacherSuggest: [TEACHER_SUGGEST_RATE, 60_000], // the host's own picks (protocol.js TEACHER PICKS)
  teacherSearch: [TEACHER_SEARCH_RATE, 60_000], // the host's own searches (roomSearch counts them too)
  jump: [6, 60_000],
  coupon: [5, 60_000], // coupons tried per device (shared/coupon.js; a bad one costs a signature check)
  message: [120, 60_000],
  connect: [20, 60_000], // student sockets opened per device (a refresh is one)
  nickAi: [2, 60_000], // AI nickname checks per device (cached verdicts do not count)
  nickAiRoom: [60, 60_000], // AI nickname checks per room; past it a nickname the word lists passed is let in
  lyrics: [10, 60_000], // LRCLIB lookups per room (src/lyrics.js); past it an unknown song waits in Needs a look
  boardConnect: [30, 60_000], // board sockets opened per room (before the token is checked)
  boardAuth: [20, 60_000], // board tokens checked per room
  progress: [PROGRESS_RATE, 60_000], // the host's player position, relayed to boards
  art: [ART_RATE, 60_000], // 🖼 album art checks per room (AI calls; cached covers do not count)
};
/** Cover verdicts a room keeps in its state before it drops the ones no song of its own uses. */
const ART_KEEP = 400;
/** How long a room trusts a cover verdict it read from KV for a search (none found: a minute). */
const ART_MEM_MS = 10 * 60_000;
const ART_NONE_MS = 60_000;
/** Search tags (Room.withReady): a ready song is remembered for the room's life, any other this long. */
const READY_NONE_MS = 3 * 60_000;
const READY_MAX_READS = 30;
/** How long a room keeps its copy of 🔥 Popular on RoomDJ (made once a day). */
const POPULAR_MEM_MS = 30 * 60_000;
/** A cover whose check failed is not asked again for this long. */
const ART_RETRY_MS = 60_000;
/** A board socket that has not sent its token after this long is closed when the next one opens. */
const BOARD_WAIT_MS = 30_000;
const BOARD_WAIT_MAX = 4;
const BOARD_INVALID = 'This board link does not work any more. On the teacher computer, open 📺 Board link and use the link there.';
const BOARD_MOVED = 'A new board link was made on the teacher computer, so this board stopped. Open the new link.';
const BOARD_SIGNIN_MOVED = 'A newer board signed in to this room, so this one stopped.';
const BOARDS_FULL = 'The board is open on too many screens, so this one stopped. Reload it to use it here.';
const NO_HOST_COMPUTER = 'The teacher computer is not connected.';
const START_FIRST = 'Start the music on the teacher computer first.';
/** Nicknames the teacher asked students to change (Rename), kept so nobody uses them again here. */
const RENAMED_MAX = 200;
/** Open student sockets per device (tabs); a newer one closes the oldest. */
const SOCKETS_PER_DEVICE = 3;

// WebSocket close codes the pages can tell apart.
export const CLOSE = { closed: 4000, kicked: 4001, refused: 4002 };

const encoder = new TextEncoder();

/** 32 random bytes, base64url (a board token: BOARD_TOKEN_PATTERN). */
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export async function sha256Hex(text) {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexBytes(hex) {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const NO_ROOM = { error: 'no_room', message: 'This room is closed. Ask your teacher for today\'s class code.' };
const NOT_JOINED = { error: 'join', message: 'Type today\'s class code to join.' };
const NO_ITEM = { t: 'error', error: 'no_item', message: 'That song is not in the queue any more.' };
// Never says why (no rude word repeated, no mention of the AI).
const PICK_NICK = 'Please pick a different nickname.';
const PICK_NICK_TYPED = PICK_NICK;
const TOO_LONG = 'That song is longer than your teacher allows right now. Pick a shorter one.';
const NICK_TAKEN = 'Someone in this room already has that nickname. Pick another one.';
/** When a Needs a look song whose lyrics lookup failed for a passing reason is checked again (Room.scheduleRecheck). */
const RECHECK_DELAYS_MS = [30_000, 90_000, 240_000, 600_000];

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {object|null} RoomState from shared/queue.js, null when there is no open room */
    this.room = null;
    /** "Blocked today" (protocol.js BLOCKED; shared/reasons.js), DO storage key 'blocked'. */
    this.blocked = [];
    this.alarmAt = 0;
    /** Rate-limit hits per key. In memory only: lost on hibernation, which only happens when idle. */
    this.hits = new Map();
    /** Songs from this room's searches, by id (also in storage as song:<id>; gone when the room closes). */
    this.recent = new Map();
    /** iTunes calls through the host page (in memory: a pending call keeps the object awake). */
    this.hostRelay = new HostRelay({
      host: () => this.hostSockets()[0] ?? null,
      send: (ws, msg) => this.send(ws, msg),
      // Local tests only (a `wrangler dev --var`): no server fetch when no host page answers.
      ownFetch: env.ITUNES_SERVER_FETCH !== 'off',
    });
    this.relay = this.hostRelay.fetch;
    /**
     * Songs the AI does not know, judged from their lyrics (src/lyrics.js; filter.js opts.lyrics).
     * At most LIMITS.lyrics a minute in this room and LYRICS_RATE_ALL for everyone together.
     * patientLyrics: the same with LYRICS_PATIENT_MS for LRCLIB (a waiting song's recheck: no student waits on it).
     */
    this.lyrics = (song, want) => this.lyricsWithin(song, want);
    this.patientLyrics = (song, want) => this.lyricsWithin(song, want, LYRICS_PATIENT_MS);
    this.lyricsWithin = (song, want, timeoutMs) => judgeFromLyrics(song, this.env, {
      ...want,
      timeoutMs,
      allow: async () => this.allow('lyrics', 'room')
        && (!this.env.LYRICS_RATE_ALL || (await this.env.LYRICS_RATE_ALL.limit({ key: 'everyone' })).success)
        && this.spendFree('ai'), // a free teacher's daily AI checks (protocol.js FREE TEACHERS)
    });
    /** One at a time, so two checks at once cannot both take the last one of the day. */
    this.freeChain = Promise.resolve(true);
    /** The teacher's favorites (KV), read at most once a FAVORITES_FRESH_MS: { list, at }. */
    this.favorites = null;
    /** 🔥 Popular on RoomDJ (src/popular.js), read at most once a POPULAR_MEM_MS: { list, at }. */
    this.popular = null;
    this.grown = null;
    /** The teacher's repeat record (KV `recent`), read at most once a RECENT_FRESH_MS: { map, at }. */
    this.rest = null;
    this.restWrittenAt = 0;
    /** 🖼 Cover verdicts read from KV for searches and favorites: key → { v, r, t, until } (memory only). */
    this.artMem = new Map();
    /** Cover checks running now (one per key) and when a key's check last failed. */
    this.artFlight = new Map();
    this.artFailed = new Map();
    /** Search tags read from KV: '<instrumentalsOnly>|<kidzBop>|<banKey>' → { check, until } (memory only). */
    this.readyMem = new Map();
    /** Searched songs not ✓ Checked yet, for the night list at close (src/night.js; memory only, best effort). */
    this.nightSongs = new Map();
    ctx.blockConcurrencyWhile(async () => {
      this.room = migrateRoomState((await ctx.storage.get('state')) ?? null, { testAiOff: env.TEST_AI_OFF === 'on' });
      this.blocked = (this.room && (await ctx.storage.get('blocked'))) || [];
      this.alarmAt = (await ctx.storage.getAlarm()) ?? 0;
    });
    // Keep-alives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  // ---- helpers --------------------------------------------------------------------------------

  /** True when the key is under its limit (and counts this hit). */
  /** A free teacher's daily cap, per Spotify account (src/free.js): true = go ahead (counted). */
  spendFree(kind) {
    if (!isFreeTeacher(this.profile?.id)) return Promise.resolve(true);
    const next = this.freeChain.catch(() => true).then(() => spendFree(this.env, this.profile, kind));
    this.freeChain = next.catch(() => true);
    return next.catch((e) => {
      console.error(JSON.stringify({ message: 'free cap check failed', error: String(e) }));
      return false; // storage trouble: no AI spend (the song waits for the teacher)
    });
  }

  allow(kind, key) {
    const [max, windowMs] = LIMITS[kind];
    const now = Date.now();
    const id = `${kind}:${key}`;
    const recent = (this.hits.get(id) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(id, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(id, recent);
    if (this.hits.size > 2000) this.hits.clear();
    return true;
  }

  async save() {
    if (this.room) await this.ctx.storage.put('state', this.room);
  }

  /**
   * When the alarm should next look: cleanup start, the room's `until`, 12 idle hours, or the next
   * ghost 👍 moment (protocol.js GHOST VOTE), whichever comes first.
   */
  dueAt(now = Date.now()) {
    return nextAlarmAt(this.room, IDLE_MS, nextGhostAt(this.room, now));
  }

  /** Set the alarm to dueAt() now (after the class times changed: it may have to ring later). */
  async rescheduleAlarm() {
    const due = this.dueAt();
    await this.ctx.storage.setAlarm(due);
    this.alarmAt = due;
  }

  /** Cleanup time (protocol.js CLEANUP): suggestions close, every page is told by the next state. */
  async startCleanup() {
    this.room.cleanup = true;
    console.log(JSON.stringify({ message: 'cleanup started' }));
    await this.save();
    await this.rescheduleAlarm();
    this.broadcast();
  }

  /** Note activity and push the idle alarm out (only when it moved more than 10 minutes). */
  async touch() {
    if (!this.room) return;
    this.room.lastActivity = Date.now();
    const due = this.dueAt();
    if (!this.alarmAt || due < this.alarmAt || due - this.alarmAt > 10 * 60 * 1000) {
      await this.ctx.storage.setAlarm(due);
      this.alarmAt = due;
    }
  }

  /** True while the room is open. Past `until` it closes now (the alarm may not have run yet). */
  async live() {
    if (this.room?.open && Date.now() >= this.room.until) await this.closeRoom('until');
    else if (cleanupDue(this.room)) await this.startCleanup();
    return Boolean(this.room?.open);
  }

  admitted(device) {
    return (this.room.admitted ?? []).includes(device);
  }

  async commit() {
    await this.touch();
    await this.save();
    this.broadcast();
  }

  sockets(except = null) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  onlineDevices(except = null) {
    const online = new Set();
    for (const ws of this.sockets(except)) {
      const a = ws.deserializeAttachment();
      if (a?.role === 'student') online.add(a.device);
    }
    return online;
  }

  send(ws, msg) {
    try {
      ws.send(this.artText(msg, ws.deserializeAttachment()?.role ?? null));
    } catch {
      // Socket already gone; its close handler tidies up.
    }
  }

  broadcast(except = null) {
    if (!this.room) return;
    const online = this.onlineDevices(except);
    const boards = this.socketsOf('board', except).length;
    let boardState = null;
    for (const ws of this.sockets(except)) {
      const a = ws.deserializeAttachment();
      if (a?.role === 'board') {
        this.send(ws, { t: 'state', state: (boardState ??= boardSnapshot(this.room, { host: this.hostInfo(except) })) });
        continue;
      }
      const device = a?.role === 'host' ? null : a?.device;
      if (device === undefined) continue;
      this.send(ws, { t: 'state', state: snapshotFor(this.room, device, { online, boards }) });
    }
  }

  /** Open sockets of one role ('host', 'board', 'boardWait', 'student'), oldest first. */
  socketsOf(role, except = null) {
    return this.sockets(except)
      .map((ws) => [ws, ws.deserializeAttachment()])
      .filter(([, a]) => a?.role === role)
      .sort((x, y) => (x[1].at ?? 0) - (y[1].at ?? 0))
      .map(([ws]) => ws);
  }

  /** A message to every board. */
  sendBoards(msg) {
    for (const ws of this.socketsOf('board')) this.send(ws, msg);
  }

  /** Every board gets a new state (the host's board info changed; nothing in the room did). */
  broadcastBoards() {
    const boards = this.socketsOf('board');
    if (!boards.length || !this.room) return;
    const state = boardSnapshot(this.room, { host: this.hostInfo() });
    for (const ws of boards) this.send(ws, { t: 'state', state });
  }

  /** The host page as the board sees it: the newest host socket (one that sent 'boardInfo' first). */
  hostInfo(except = null) {
    const hosts = this.socketsOf('host', except).map((ws) => ws.deserializeAttachment()).reverse();
    const a = hosts.find((h) => h.board) ?? hosts[0];
    if (!a) return { online: false, code: null, display: null, player: null };
    return { online: true, code: a.board?.code ?? null, display: a.board?.display ?? null, player: a.player ?? null };
  }

  /** Close a socket with a last message (it does not reconnect after 4002). */
  sendAway(ws, msg, code = CLOSE.refused) {
    this.send(ws, msg);
    try {
      ws.close(code, msg.error ?? 'Closed');
    } catch {
      // already closing
    }
  }

  /** Tell the student (all their open pages) what the teacher decided about a review item. */
  sendReviewed(item, allowed, refunded = false, why = null) {
    this.sendStudent(item.device, {
      t: 'reviewed', song: item.song.id, title: item.song.title, allowed, ...(refunded ? { refunded } : {}), ...(why ? { why } : {}),
    });
  }

  /**
   * Needs a look "Could not find the lyrics to double-check" (shared/filter.js unconfirmedOk) after a
   * PASSING failure (the room's lyrics limit, LRCLIB busy or slow): the room runs the song check again
   * by itself after each of RECHECK_DELAYS_MS (Dalton, 2026-10-23: too many songs, "some are old",
   * waited for the teacher). Lyrics confirm it: into the queue, like Allow (but not remembered for the
   * teacher's other rooms). Lyrics say no: out, as the filter's no (credit back, Blocked today).
   * LRCLIB has no lyrics, or still not sure: it stays for the teacher. A timer lost with the room's
   * memory only means the song waits for the teacher, as before.
   */
  scheduleRecheck(itemId, attempt = 0) {
    const delay = RECHECK_DELAYS_MS[attempt];
    // The student sees when it tries next (protocol.js MY CHECKS); the caller saves and sends it.
    const item = this.room?.open ? reviewList(this.room).find((i) => i.id === itemId) : null;
    if (item && delay === undefined) delete item.recheckAt;
    else if (item) item.recheckAt = Date.now() + delay;
    if (delay === undefined) return;
    setTimeout(() => {
      this.recheckReview(itemId, attempt).catch((e) => console.error(JSON.stringify({ message: 'recheck failed', error: String(e) })));
    }, delay);
  }

  async recheckReview(itemId, attempt) {
    const waiting = () => (this.room?.open ? reviewList(this.room).find((i) => i.id === itemId && i.checked === 'nolyrics') : null);
    const item = waiting();
    if (!item) return; // the teacher already decided, or the room closed
    const verdict = await filterSong(item.song, {
      settings: this.room.settings, banned: await this.banned(), env: this.env, scope: this.scope, lyrics: this.patientLyrics, budget: () => this.spendFree('ai'),
    });
    if (!waiting()) return; // decided while the check ran
    if (verdict.ok) {
      const moved = allowReview(this.room, itemId);
      if (!moved) return;
      console.log(JSON.stringify({ message: 'recheck: lyrics confirmed, queued', song: moved.song.id }));
      this.sendReviewed(moved, true);
      return this.commit();
    }
    if (verdict.reason === 'review') {
      if (verdict.unconfirmed && verdict.ai?.lyrics !== 'none') {
        this.scheduleRecheck(itemId, attempt + 1);
        return this.commit();
      }
      delete item.recheckAt; // no more tries by itself: the teacher decides
      if (verdict.ai?.lyrics === 'found' && verdict.ai.verdict === 'unknown') item.checked = 'lyrics'; // read, still not sure
      return this.commit();
    }
    // The lyrics (or a new blocked word, ban...) say no: the filter's answer, as on a suggestion.
    const taken = takeReview(this.room, itemId);
    if (!taken) return;
    const { why, detail } = filterWhy(taken.song, verdict, { banNote: verdict.reason === 'banned' ? await this.banNote(taken.song) : '' });
    console.log(JSON.stringify({ message: 'recheck: blocked', song: taken.song.id, reason: verdict.reason }));
    this.sendReviewed(taken, false, refundItem(this.room, taken) !== null, why);
    await this.addBlocked({ song: taken.song, device: taken.device, by: taken.by, why, detail, source: 'filter', action: 'suggest' });
    return this.commit();
  }

  /** Tell a student their queued (or playing) song was taken out, and why. */
  sendRemoved(item, why) {
    this.sendStudent(item.device, { t: 'removed', id: item.id, song: item.song.id, title: item.song.title, why });
  }

  // ---- 🖼 Album art (protocol.js ALBUM ART, shared/art.js, src/art.js) ------------------------------

  /** What this room knows about a cover: its verdict and reason, and the teacher's Show anyway. */
  artInfo(key) {
    const k = this.room?.art?.[key];
    const m = this.artMem.get(key);
    return { key, verdict: k?.v ?? m?.v ?? null, reason: k?.r ?? m?.r ?? '', teacherOk: k?.t === true || m?.t === true };
  }

  /** A message as JSON, every song in it carrying the server's art fields for `role` (shared/art.js). */
  artText(msg, role) {
    const settings = this.room?.settings ?? {};
    return artJson(msg, (url) => artFields(url, role, settings, (key) => this.artInfo(key)));
  }

  /** Read the cached verdicts of these songs' covers (search results, favorites): KV only, never the AI. */
  async loadArt(songs) {
    const s = this.room?.settings;
    if (!s || s.hideAllArt === true || s.artCheck === false) return;
    const now = Date.now();
    const keys = [...new Set(songs.map((x) => artKey(x?.artwork)).filter(Boolean))]
      .filter((k) => !this.room.art?.[k] && !(this.artMem.get(k)?.until > now))
      .slice(0, 50);
    if (this.artMem.size > 3000) this.artMem.clear();
    await Promise.all(keys.map(async (k) => {
      const v = await cachedArtVerdict(this.env, k);
      const t = v && v.verdict !== 'ok' ? await teacherArtOk(this.env, k, this.profile) : false;
      this.artMem.set(k, { v: v?.verdict ?? null, r: v?.reason ?? '', t, until: now + (v ? ART_MEM_MS : ART_NONE_MS) });
    }));
  }

  /**
   * Search results tagged, ✓ Checked songs first (Dalton, 2026-10-28): each gets `check` ('ready' |
   * 'teacher' | 'unchecked': filter.js checkStatus) from its cached verdict and the teacher's allow,
   * so classes pick songs that cost no AI or LRCLIB call and a kid can tell "Clean edit" from
   * "checked". KV only (checkFromKv), never the AI. Copies: the room's remembered songs stay plain.
   */
  async withReady(results, maxReads = READY_MAX_READS) {
    const now = Date.now();
    const instrumentalsOnly = this.room?.settings.instrumentalsOnly === true;
    const kidzBop = this.room?.settings.kidzBop ?? 'check';
    if (this.readyMem.size > 3000) this.readyMem.clear();
    const keys = new Map(results.map((s) => [s, banKey(s) && `${instrumentalsOnly ? 1 : 0}|${kidzBop}|${banKey(s)}`]));
    const toRead = [...new Set([...keys.values()].filter((k) => k && !(this.readyMem.get(k)?.until > now)))].slice(0, maxReads);
    await Promise.all(toRead.map(async (k) => {
      const song = results.find((s) => keys.get(s) === k);
      const check = await checkFromKv(song, this.env, { scope: this.scope, instrumentalsOnly, kidzBop });
      this.readyMem.set(k, { check, until: check === 'ready' ? Infinity : now + READY_NONE_MS });
    }));
    const marked = results.map((s) => ({ ...s, check: this.readyMem.get(keys.get(s))?.check ?? 'unchecked' }));
    // The night shift checks the top ones the class looked at (src/night.js).
    for (const s of marked.slice(0, 10)) {
      if (this.nightSongs.size >= NIGHT_SEARCH_MAX) break;
      if (s.check === 'unchecked' && nightSong(s)) this.nightSongs.set(banKey(s), s);
    }
    // Stable: ready songs first, each group in the catalog's order.
    return [...marked.filter((s) => s.check === 'ready'), ...marked.filter((s) => s.check !== 'ready')];
  }

  /**
   * Check a song's cover (a suggestion, or a waiting song still unchecked): the KV cache, else the
   * vision model (rate-limited; a failure waits ART_RETRY_MS). Resolves true when the room learned a
   * verdict; then it saves and sends new states. null when nothing needs checking. Never throws.
   */
  artCheckFor(song) {
    const s = this.room?.settings;
    if (!s || s.hideAllArt === true || s.artCheck === false) return null;
    const key = artKey(song?.artwork);
    if (!key || this.room.art?.[key]) return null;
    if (this.artFlight.has(key)) return this.artFlight.get(key);
    const run = (async () => {
      let v = await cachedArtVerdict(this.env, key);
      if (!v) {
        if (Date.now() - (this.artFailed.get(key) ?? 0) < ART_RETRY_MS || !this.allow('art', 'room')) return false;
        if (!(await this.spendFree('art'))) return false; // a free teacher's daily cover checks: 🎵 tile
        try {
          v = await checkCover(this.env, key, song.artwork);
        } catch (e) {
          this.artFailed.set(key, Date.now());
          if (this.artFailed.size > 500) this.artFailed.clear();
          console.error(JSON.stringify({ message: 'album art check failed', song: song.id, error: String(e) }));
          return false;
        }
      }
      const t = v.verdict !== 'ok' && (await teacherArtOk(this.env, key, this.profile));
      if (!this.room?.open) return false;
      this.room.art[key] = { v: v.verdict, r: v.reason, ...(t ? { t: true } : {}) };
      this.pruneArt();
      await this.save();
      this.broadcast();
      return true;
    })().catch((e) => {
      console.error(JSON.stringify({ message: 'album art check failed', error: String(e) }));
      return false;
    }).finally(() => this.artFlight.delete(key));
    this.artFlight.set(key, run);
    return run;
  }

  /** Waiting and playing songs whose covers are still unchecked get checked (in the background). */
  checkWaitingArt() {
    if (!this.room) return;
    const songs = [this.room.nowPlaying, ...this.room.queue, ...(this.room.review ?? [])].map((i) => i?.song).filter(Boolean);
    for (const song of songs.slice(0, 10)) this.artCheckFor(song);
  }

  /** Keep the room's cover verdicts small: past ART_KEEP, only the covers of its own songs stay. */
  pruneArt() {
    const art = this.room?.art;
    if (!art || Object.keys(art).length <= ART_KEEP) return;
    const used = new Set([this.room.nowPlaying, ...this.room.queue, ...(this.room.review ?? []), ...(this.room.history ?? [])]
      .map((i) => artKey(i?.song?.artwork)).filter(Boolean));
    for (const k of Object.keys(art)) if (!used.has(k)) delete art[k];
  }

  /** 🖼 Show anyway (host): this teacher profile sees the cover from now on. */
  async artShow(ws, key) {
    if (!validArtKey(key)) return this.send(ws, { t: 'error', error: 'bad_message', message: 'The page sent something the server could not read.' });
    await putTeacherArtOk(this.env, key, this.profile);
    if (!this.room?.open) return;
    const had = this.room.art[key] ?? this.artMem.get(key);
    this.room.art[key] = { v: had?.v ?? null, r: had?.r ?? '', t: true };
    this.artMem.delete(key);
    this.pruneArt();
    await this.commit();
    this.sendBlocked();
    await this.sendFavorites();
  }

  // ---- Blocked today (protocol.js BLOCKED) ----------------------------------------------------

  /** Log one rejected suggestion, keep it, and send the host the new list. Returns the entry. */
  async addBlocked(fields) {
    const entry = logBlocked(this.blocked, fields);
    await this.saveBlocked();
    return entry;
  }

  async saveBlocked() {
    if (this.room) await this.ctx.storage.put('blocked', this.blocked);
    this.sendBlocked();
  }

  /** The list to every host page (or just `ws`). */
  sendBlocked(ws = null) {
    const msg = { t: 'blocked', list: blockedView(this.blocked) };
    if (ws) return this.send(ws, msg);
    for (const s of this.sockets()) if (s.deserializeAttachment()?.role === 'host') this.send(s, msg);
  }

  /** The host's { reason, note } for a veto, remove or ban; a refused note is dropped and the host told. */
  teacherReason(ws, msg, fallback) {
    const r = teacherWhy(msg, fallback);
    if (r.refused) {
      this.send(ws, { t: 'error', error: 'note', message: 'Your note was not sent: it has a word students should not see. The song was still taken out.' });
    }
    return r;
  }

  /** A message to every open page of one student. */
  sendStudent(device, msg) {
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment();
      if (a?.role === 'student' && a.device === device) this.send(ws, msg);
    }
  }

  /** This room's teacher profile (null: from before profiles = legacy). */
  get profile() {
    return this.room?.profile ?? null;
  }

  /** KV names scoped to this room's teacher profile (src/teacher-kv.js). */
  get scope() {
    return teacherScope(this.profile);
  }

  /** The teacher's ban list as a Set (src/search.js), for this room's profile. */
  banned() {
    return readBanned(this.env, this.profile);
  }

  /** Ban a song for good (KV "banned" of this room's teacher); the teacher's reason and note are kept with it. */
  async addBan(song, why = null) {
    const list = (await this.env.CLASS_KV?.get(this.scope('banned'), 'json').catch(() => null)) ?? [];
    const banned = Array.isArray(list) ? list.filter((b) => songId(b?.id ?? b?.trackId) !== song.id) : [];
    const entry = { id: song.id, title: song.title, artist: song.artist, at: Date.now() };
    if (why?.id && why.id !== 'banned') entry.reason = why.id;
    if (why?.evidence) entry.note = why.evidence;
    banned.push(entry);
    await this.env.CLASS_KV?.put(this.scope('banned'), JSON.stringify(banned.slice(-BANNED_MAX)));
    // A banned song (any version) leaves the favorites; students get their list again either way.
    const key = banKey(song);
    const gone = await this.changeFavorites((fav) => removeFavorite(fav, (e) => e.song.id === song.id || (key && banKey(e.song) === key)) > 0);
    if (!gone) await this.sendFavorites();
  }

  /**
   * The teacher turned this song down (Remove in Needs a look, Ban): the night shift settles it for
   * everyone (src/night.js; a settled song costs nothing there). This teacher's own no stays.
   */
  rejectedByTeacher(song) {
    const key = banKey(song);
    return key ? addToNight(this.env, `t:${key}`, [song]) : null;
  }

  /** The teacher's note on the ban list for this song (any version), or ''. Never throws. */
  async banNote(song) {
    try {
      const list = await this.env.CLASS_KV?.get(this.scope('banned'), 'json');
      const key = banKey(song);
      const hit = (Array.isArray(list) ? list : []).findLast((b) => songId(b?.id ?? b?.trackId) === song.id || (key && banKey(b ?? {}) === key));
      return typeof hit?.note === 'string' ? hit.note : '';
    } catch {
      return '';
    }
  }

  // ---- ⭐ Class favorites (protocol.js FAVORITES; KV, songs only) ---------------------------------

  /** The favorites list (read again at most once a FAVORITES_FRESH_MS, or now with `fresh`). Never throws. */
  async favoriteList(fresh = false) {
    if (!fresh && this.favorites && Date.now() - this.favorites.at < FAVORITES_FRESH_MS) return this.favorites.list;
    try {
      this.favorites = { list: readFavorites(await this.env.CLASS_KV?.get(this.favoritesKey(), 'json')), at: Date.now() };
    } catch (e) {
      console.error(JSON.stringify({ message: 'favorites read failed', error: String(e) }));
      if (!this.favorites) return [];
    }
    return this.favorites.list;
  }

  /** The favorites' KV key: this room's teacher profile (src/teacher-kv.js). */
  favoritesKey() {
    return teacherKvKey(KV_FAVORITES, this.profile);
  }

  /**
   * Change the favorites: read KV fresh, `fn(list)` changes it in place (false = nothing changed),
   * save, then tell the pages (students their list, hosts the whole list) unless `tell` is false.
   * Two rooms writing at once: the last write wins (one song's bump may be lost; accepted).
   */
  async changeFavorites(fn, { tell = true } = {}) {
    const list = [...(await this.favoriteList(true))];
    if (fn(list) === false) return false;
    try {
      await this.env.CLASS_KV?.put(this.favoritesKey(), JSON.stringify(favoritesValue(list)));
    } catch (e) {
      console.error(JSON.stringify({ message: 'favorites write failed', error: String(e) }));
      return false;
    }
    this.favorites = { list, at: Date.now() };
    if (tell) {
      await this.sendFavorites();
      const all = hostFavorites(list);
      await this.loadArt(all.map((f) => f.song));
      for (const s of this.sockets()) if (s.deserializeAttachment()?.role === 'host') this.send(s, { t: 'favoritesAll', list: all });
    }
    return true;
  }

  /** ⭐ Class favorites to every student page (or one socket): the best ones the room's filter lets show. */
  async sendFavorites(ws = null) {
    if (!this.room) return;
    let list = [];
    if (this.room.settings.showFavorites !== false) {
      const [all, banned] = await Promise.all([this.favoriteList(), this.banned()]);
      if (!this.room) return;
      list = studentFavorites(all, { blocklist: this.room.settings.blocklist, banned, notMusic: this.room.settings.blockNotMusic !== false, kidzBop: this.room.settings.kidzBop });
      await this.loadArt(list.map((f) => f.song));
    }
    const msg = { t: 'favorites', list };
    if (ws) return this.send(ws, msg);
    for (const s of this.sockets()) if (s.deserializeAttachment()?.role === 'student') this.send(s, msg);
  }

  /** A song finished with a net score of FAVORITE_MIN_NET or more: it joins (or climbs) the favorites. */
  async favoriteFinished(id) {
    const e = this.room?.history?.findLast((x) => x.id === id);
    // DOWNVOTE MODE: while 👎 is off the net counts 👍 only (the stored 👎 are ignored).
    const downs = downvoteModeOf(this.room?.settings) !== 'off';
    if (!e || e.status !== 'finished' || e.fav || netOf(e, downs) < FAVORITE_MIN_NET) return;
    e.fav = true;
    await this.save();
    await this.changeFavorites((list) => void bumpFavorite(list, e.song, { net: netOf(e, downs) }));
    await this.changePeriodFavorites((list) => void bumpFavorite(list, e.song, { net: netOf(e, downs) }));
  }

  // ---- 🏅 The period's own running favorite (Dalton, 2026-10-14) ----
  // A room opened for a bell period ("P3") also keeps that period's favorites (KV, per teacher,
  // songs only, same rules as the class favorites), so the recap shows THAT period's favorite, never
  // one made from every class. A room with no period (custom time, end of today) has none.

  periodKey() {
    const slug = String(this.room?.period ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return slug ? teacherKvKey(`favorites:period:${slug}`, this.profile) : null;
  }

  async changePeriodFavorites(fn) {
    const key = this.periodKey();
    if (!key || !this.env.CLASS_KV) return;
    try {
      const list = readFavorites(await this.env.CLASS_KV.get(key, 'json'));
      if (fn(list) === false) return;
      await this.env.CLASS_KV.put(key, JSON.stringify(favoritesValue(list)));
    } catch (e) {
      console.error(JSON.stringify({ message: 'period favorites write failed', error: String(e) }));
    }
  }

  /** The recap's "🏅 <period> favorite": { period, song } or null. */
  async periodFavorite() {
    const key = this.periodKey();
    if (!key || !this.env.CLASS_KV) return null;
    try {
      const song = hostFavorites(readFavorites(await this.env.CLASS_KV.get(key, 'json')))[0]?.song ?? null;
      return song ? { period: this.room.period, song } : null;
    } catch {
      return null;
    }
  }

  /**
   * 🔥 The room closes: its students' requests that played to the end go into the teacher's KV `asks`
   * (src/popular.js noteAsks; songs only), one read and one write. The cron merges every teacher's.
   */
  async asksAtClose() {
    const history = this.room?.history ?? [];
    if (!this.env.CLASS_KV || !history.some((h) => h.teacher !== true && h.status === 'finished')) return;
    const key = teacherKvKey(ASKS_KV, this.profile);
    const list = noteAsks(readAsks(await this.env.CLASS_KV.get(key, 'json')), history);
    await this.env.CLASS_KV.put(key, JSON.stringify({ v: 1, list }));
  }

  /** 📈 The room closes: its students' asks go to the request log, with no device ids (shared/requests.js). */
  async requestsAtClose() {
    const log = requestLog(this.env);
    const rows = finishAsks(this.room?.askLog ?? [], this.room?.history ?? []);
    if (!log || !rows.length) return;
    await log.add(rows);
    this.room.askLog = [];
  }

  /** The room closes: its Top 5 (finished or still playing, net above 0) each count one more Top 5. */
  async favoritesAtClose() {
    // SCORE FLOOR + DOWNVOTE MODE: the Top 5 as the class saw it; a net > 0 is the same raw or floored.
    const floor = this.room?.settings?.scoreFloor === true;
    const downs = downvoteModeOf(this.room?.settings) !== 'off';
    const picks = topFive(this.room?.history ?? [], { floor, downs }).filter((e) => ['finished', 'playing'].includes(e.status) && shownScore(e, false, downs) > 0);
    if (!picks.length) return;
    const bump = (list) => {
      for (const e of picks) bumpFavorite(list, e.song, { top5: 1, net: e.fav ? 0 : netOf(e, downs) });
    };
    await this.changeFavorites(bump, { tell: false });
    await this.changePeriodFavorites(bump);
  }

  // ---- 😴 Repeats (protocol.js REPEATS; KV `recent`, songs only) -----------------------------------

  /** The record's KV key: per teacher profile (src/teacher-kv.js; null today). */
  restKey() {
    return teacherKvKey(KV_RECENT, this.room?.profile ?? null);
  }

  /** The record plus this room's plays not yet written (KV read at most once a RECENT_FRESH_MS). Never throws. */
  async restMap(fresh = false) {
    if (fresh || !this.rest || Date.now() - this.rest.at >= RECENT_FRESH_MS) {
      try {
        this.rest = { map: readRecent(await this.env.CLASS_KV?.get(this.restKey(), 'json')), at: Date.now() };
      } catch (e) {
        console.error(JSON.stringify({ message: 'recent read failed', error: String(e) }));
        this.rest ??= { map: {}, at: Date.now() };
      }
    }
    return mergeRecent({ ...this.rest.map }, this.room?.restPending);
  }

  /** Is this song resting (the cooldown is on)? { key, at, until } or null. */
  async resting(song) {
    const days = this.room?.settings.cooldownDays ?? null;
    if (!days) return null;
    return restingFor(await this.restMap(), song, days);
  }

  /**
   * Write this room's pending plays to KV (read fresh, merge, prune, write). At most once a
   * REST_WRITE_MS unless `force` (closing). Two rooms at once: the last write wins (accepted).
   */
  async flushRest(force = false) {
    const pending = { ...(this.room?.restPending ?? {}) };
    if (!Object.keys(pending).length) return;
    if (!force && Date.now() - this.restWrittenAt < REST_WRITE_MS) return;
    this.restWrittenAt = Date.now();
    try {
      const map = mergeRecent(readRecent(await this.env.CLASS_KV?.get(this.restKey(), 'json')), pending);
      pruneRecent(map);
      await this.env.CLASS_KV?.put(this.restKey(), JSON.stringify(recentValue(map)));
      this.rest = { map, at: Date.now() };
      if (this.room) {
        for (const [key, e] of Object.entries(pending)) if (this.room.restPending?.[key]?.at === e.at) delete this.room.restPending[key];
        await this.save();
      }
    } catch (e) {
      console.error(JSON.stringify({ message: 'recent write failed', error: String(e) }));
    }
  }

  /** A song played for real (finished, or REPEAT_MIN_MS or more before a skip): it goes on the record. */
  async notePlay(entry, ended, now = Date.now()) {
    if (!entry || !this.room) return;
    if (!(ended === 'finished' || (ended === 'skipped' && now - entry.at >= REPEAT_MIN_MS))) return;
    this.room.restPending ??= {};
    notePlayed(this.room.restPending, entry.song, now);
    await this.save();
    await this.flushRest();
  }

  /**
   * 'repeats' to every student and host page (or one socket): song keys played this period, and the
   * resting songs (the host marks its own search results with them: TEACHER PICKS).
   */
  async sendRepeats(ws = null) {
    if (!this.room) return;
    const days = this.room.settings.cooldownDays ?? null;
    const resting = days ? restingList(await this.restMap(), days).map((e) => [e.key, e.at, e.until]) : [];
    if (!this.room) return;
    const msg = { t: 'repeats', played: [...(this.room.playedKeys ?? [])], resting };
    if (ws) return this.send(ws, msg);
    for (const s of this.sockets()) if (['student', 'host'].includes(s.deserializeAttachment()?.role)) this.send(s, msg);
  }

  /** The resting songs to one host socket (or every host page). */
  async sendResting(ws = null) {
    if (!this.room) return;
    const days = this.room.settings.cooldownDays ?? null;
    const list = restingList(await this.restMap(true), days);
    if (!this.room) return;
    const msg = { t: 'restingAll', cooldownDays: days, list };
    if (ws) return this.send(ws, msg);
    for (const s of this.sockets()) if (s.deserializeAttachment()?.role === 'host') this.send(s, msg);
  }

  /** Wake a resting song early: its entry leaves the record (KV and this room's pending plays). */
  async wake(ws, key) {
    if (typeof key !== 'string' || !key || key.length > 300) return this.send(ws, NO_ITEM);
    delete this.room.restPending?.[key];
    try {
      const map = readRecent(await this.env.CLASS_KV?.get(this.restKey(), 'json'));
      if (map[key]) {
        delete map[key];
        await this.env.CLASS_KV?.put(this.restKey(), JSON.stringify(recentValue(map)));
      }
      this.rest = { map, at: Date.now() };
    } catch (e) {
      console.error(JSON.stringify({ message: 'recent write failed', error: String(e) }));
      return this.send(ws, { t: 'error', error: 'server', message: 'Could not wake that song. Try again.' });
    }
    await this.save();
    await this.sendResting();
    await this.sendRepeats();
  }

  async closeRoom(why = 'teacher') {
    if (this.room?.open) {
      // The recap goes to the host pages first (they keep it in memory for the closed screen), and
      // the period's Top 5 to the favorites; then everything of the room is deleted.
      const recap = recapOf(this.room, Date.now(), { periodFavorite: await this.periodFavorite() });
      if (!this.room?.open) return; // closed meanwhile
      this.room.open = false; // once (live() and the alarm may both get here)
      for (const ws of this.sockets()) if (ws.deserializeAttachment()?.role === 'host') this.send(ws, { t: 'recap', recap, closing: true });
      try {
        await this.favoritesAtClose();
      } catch (e) {
        console.error(JSON.stringify({ message: 'favorites at close failed', error: String(e) }));
      }
      try {
        await this.asksAtClose();
      } catch (e) {
        console.error(JSON.stringify({ message: 'asks at close failed', error: String(e) }));
      }
      try {
        await this.requestsAtClose();
      } catch (e) {
        console.error(JSON.stringify({ message: 'request log at close failed', error: String(e) }));
      }
      // The song still playing at the bell counts once it ran REPEAT_MIN_MS; then the pending plays go to KV.
      const playing = this.room.nowPlaying ? this.room.history?.findLast((x) => x.id === this.room.nowPlaying.id) : null;
      if (playing && Date.now() - playing.at >= REPEAT_MIN_MS) notePlayed((this.room.restPending ??= {}), playing.song, Date.now());
      await this.flushRest(true);
      if (this.nightSongs.size) {
        await addToNight(this.env, `s:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, [...this.nightSongs.values()]);
        this.nightSongs.clear();
      }
    }
    if (this.room?.codeHash) {
      console.log(JSON.stringify({ message: 'room closed', why }));
      await deleteCodeRoute(this.env, this.room.codeHash, this.room.room);
      await releaseCode(this.env, this.room.codeHash, this.room.room);
    }
    if (this.room?.room) {
      const id = this.room.room;
      await updateOpenRooms(this.env, this.profile, (list) => removeOpenRoom(list, id));
    }
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { t: 'closed', why });
      try {
        ws.close(CLOSE.closed, 'Room closed');
      } catch {
        // already closing
      }
    }
    this.room = null;
    this.blocked = [];
    this.alarmAt = 0;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** A socket that only says why it was refused, then closes (the page cannot read an HTTP error). */
  refuseSocket(msg, code = CLOSE.refused) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Accepted through the hibernation API too: a plain accept() closed straight away logs
    // "Network connection lost" once the request ends.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: 'refused' });
    if (msg) server.send(JSON.stringify(msg));
    server.close(code, msg?.error ?? msg?.t ?? 'Try again');
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- HTTP -----------------------------------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/init' && request.method === 'POST') return await this.init(request);
      if (url.pathname === '/admit' && request.method === 'POST') return await this.admit(request);
      if (url.pathname === '/info') return (await this.live()) ? json(200, { open: true, until: this.room.until }) : json(404, NO_ROOM);
      if (url.pathname === '/search') return await this.search(request, url);
      if (url.pathname === '/songbook') return await this.songbook(request, url);
      if (url.pathname === '/youtube') return await this.youtube(request, url);
      if (url.pathname === '/host') return await this.hostCheck(request);
      if (url.pathname === '/boardToken' && request.method === 'POST') return await this.signinBoardToken(request);
      if (url.pathname === '/teacherClose' && request.method === 'POST') return await this.teacherClose(request);
      if (url.pathname === '/teacherInfo' && request.method === 'POST') return await this.teacherInfo(request);
      if (url.pathname === '/teacherResume' && request.method === 'POST') return await this.teacherResume(request);
      if (url.pathname === '/ws') return await this.connect(request, url);
      return json(404, { error: 'not_found', message: 'No such API.' });
    } catch (e) {
      console.error(JSON.stringify({ message: 'room request failed', path: url.pathname, error: String(e), stack: e?.stack }));
      return json(500, { error: 'server', message: 'Something went wrong on the server. Try again.' });
    }
  }

  async init(request) {
    if (this.room?.open) return json(409, { error: 'taken', message: 'That room is already open.' });
    const { id, codeHash: hash, until, cleanupAt = null, settings, hostHash, profile = null, period = null, code = null } = await request.json();
    this.room = newRoomState(id, settings, Date.now(), until);
    // The bell period (the Worker checked it is on the teacher's bell schedule): its own favorites.
    if (typeof period === 'string' && period.trim()) this.room.period = period.trim().slice(0, 40);
    // The Worker checked the profile against the list (src/profiles.js); kept for the room's life.
    if (profile && PROFILE_ID_PATTERN.test(profile.id ?? '') && typeof profile.name === 'string') {
      this.room.profile = { id: profile.id, name: profile.name.slice(0, PROFILE_NAME_MAX * 2), legacy: profile.legacy === true };
    }
    this.room.cleanupAt = cleanupAt; // the Worker checked it (validateTimes)
    this.room.codeHash = hash;
    // The code as typed, for "Your open rooms" on the teacher's start screen (teacherInfo/teacherResume):
    // in THIS room's own storage only (gone with the room), handed only to its own teacher. KV keeps
    // only the hash (invariant 7).
    if (typeof code === 'string') this.room.codeShown = code.slice(0, 80);
    this.room.hostHash = hostHash;
    this.blocked = [];
    await this.ctx.storage.delete('blocked');
    this.alarmAt = 0;
    await this.touch();
    await this.save();
    await this.listOpen();
    return json(201, { room: id });
  }

  // A device that typed the right class code (the Worker found this room by the code's hash; the
  // hash is checked again here, in constant time, so an old KV copy of a changed code fails).
  async admit(request) {
    const { codeHash: hash, device } = await request.json();
    const wrong = json(403, { error: 'code', message: 'That class code is not right. Check the board and type it again.' });
    if (!(await this.live()) || typeof hash !== 'string' || !this.room.codeHash) return wrong;
    if (!crypto.subtle.timingSafeEqual(hexBytes(hash), hexBytes(this.room.codeHash))) return wrong;
    if (!DEVICE_ID_PATTERN.test(device ?? '')) return json(400, { error: 'device', message: 'Reload the page and join again.' });
    if (this.room.kicked.includes(device)) return json(403, { error: 'kicked', message: 'Your teacher removed you from this room, so you cannot join it again.' });
    this.room.admitted ??= [];
    if (!this.admitted(device)) {
      // Full: the oldest device that joined but never opened the room (no nickname, no socket) makes
      // way, so a script with the code cannot fill the room with device ids that never show up.
      if (this.room.admitted.length >= ADMITTED_MAX) {
        const online = new Set(this.sockets().map((ws) => ws.deserializeAttachment()?.device).filter(Boolean));
        const idle = this.room.admitted.findIndex((d) => !this.room.students[d] && !online.has(d));
        if (idle < 0) return json(403, { error: 'full', message: 'This room is full. Tell your teacher.' });
        this.room.admitted.splice(idle, 1);
      }
      this.room.admitted.push(device);
      await this.save();
    }
    return json(200, { room: this.room.room, until: this.room.until });
  }

  /** A new host token for this room; host pages still running it are told and closed (4002). */
  async takeOver(hostHash) {
    if (typeof hostHash !== 'string' || !/^[0-9a-f]{64}$/.test(hostHash)) return json(400, { error: 'host', message: 'Try again.' });
    this.room.hostHash = hostHash;
    await this.touch();
    await this.save();
    await this.listOpen(true);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.role !== 'host') continue;
      this.send(ws, { t: 'error', error: 'host_moved', message: 'This room was opened on another computer.' });
      try {
        ws.close(CLOSE.refused, 'Host moved');
      } catch {
        // already closing
      }
    }
    console.log(JSON.stringify({ message: 'room taken back' }));
    return json(200, { room: this.room.room, until: this.room.until, cleanupAt: this.room.cleanupAt ?? null, code: this.room.codeShown ?? null });
  }

  /**
   * "Your open rooms" (the teacher's start screen; the Worker checked the sign-in): this room's code
   * and times, only for its own teacher (another teacher's: 404).
   */
  async teacherInfo(request) {
    const { profile } = await request.json().catch(() => ({}));
    if (!(await this.live()) || !this.teachersRoom(profile)) return json(404, NO_ROOM);
    return json(200, {
      room: this.room.room, code: this.room.codeShown ?? null, until: this.room.until,
      period: this.room.period ?? null, songs: (this.room.queue?.length ?? 0) + (this.room.nowPlaying ? 1 : 0),
      students: Object.keys(this.room.students ?? {}).length,
      hostOnline: this.ctx.getWebSockets().some((ws) => ws.deserializeAttachment()?.role === 'host'),
    });
  }

  /** "Open here" on "Your open rooms": this teacher's own room moves to this computer (no code typed). */
  async teacherResume(request) {
    const { profile, hostHash } = await request.json().catch(() => ({}));
    if (!(await this.live()) || !this.teachersRoom(profile)) return json(404, NO_ROOM);
    return this.takeOver(hostHash);
  }

  async search(request, url) {
    if (!(await this.live())) return json(404, NO_ROOM);
    const device = request.headers.get('x-device') ?? '';
    if (!DEVICE_ID_PATTERN.test(device)) return json(400, { error: 'device', message: 'Reload the page and join again.' });
    if (this.room.kicked.includes(device)) return json(403, { error: 'kicked', message: 'You were removed from this room.' });
    if (!this.admitted(device)) return json(403, NOT_JOINED);
    const q = cleanQuery(url.searchParams.get('q'));
    if (!q) return json(200, { results: [] });
    if (!this.allow('search', device) || !this.allow('roomSearch', 'room')) {
      return json(429, { error: 'rate', message: 'That is a lot of searching. Wait a minute and try again.' });
    }
    const banned = await this.banned();
    try {
      const catalog = roomCatalog(this.room.service, this.env);
      const found = await searchAllowed(q, this.env, { blocklist: this.room?.settings.blocklist ?? [], banned, notMusic: this.room?.settings.blockNotMusic !== false, kidzBop: this.room?.settings.kidzBop, catalog, fetchImpl: this.relay });
      await this.remember(found.results);
      await this.loadArt(found.results);
      found.results = await this.withReady(found.results);
      return new Response(this.artText(found, 'student'), {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (e) {
      if (e instanceof CatalogError) return json(503, { error: `search_${e.code}`, message: e.message });
      throw e;
    }
  }

  /**
   * A songbook shelf (protocol.js SONGBOOK, invariant 40): the shelf's songs this room's rules let
   * show (quickCheck: explicit, 🙉, Kidz Bop, blocked words, bans), tagged like search, and ONLY the
   * ✓ Checked ones sent, in shelf order. No catalog call, never the AI: the cron checks them.
   */
  async songbook(request, url) {
    if (!(await this.live())) return json(404, NO_ROOM);
    const device = request.headers.get('x-device') ?? '';
    if (!DEVICE_ID_PATTERN.test(device)) return json(400, { error: 'device', message: 'Reload the page and join again.' });
    if (this.room.kicked.includes(device)) return json(403, { error: 'kicked', message: 'You were removed from this room.' });
    if (!this.admitted(device)) return json(403, NOT_JOINED);
    const shelf = url.searchParams.get('shelf') ?? '';
    if (!isShelf(shelf)) return json(400, { error: 'shelf', message: 'Pick one of the lists.' });
    if (!this.allow('search', device) || !this.allow('roomSearch', 'room')) {
      return json(429, { error: 'rate', message: 'That is a lot of searching. Wait a minute and try again.' });
    }
    const s = this.room.settings;
    const ctx = { blocklist: s.blocklist ?? [], banned: await this.banned(), notMusic: s.blockNotMusic !== false, kidzBop: s.kidzBop };
    const grown = shelf === 'popular' ? [] : await this.grownSongs();
    const shown = (shelf === 'popular' ? await this.popularSongs() : shelfSongs(shelf, undefined, undefined, grown)).filter((song) => !quickCheck(song, ctx));
    // The archive's and the cron's songs are ✓ Checked already (src/songbook.js archiveReady): no KV read.
    const pre = shelf === 'popular' ? new Set() : archiveReady({ instrumentalsOnly: s.instrumentalsOnly === true }, undefined, grown);
    const known = shown.filter((song) => pre.has(banKey(song))).map((song) => ({ ...song, check: 'ready' }));
    const asked = await this.withReady(shown.filter((song) => !pre.has(banKey(song))), shelf === 'popular' ? SHELF_MAX : SHELF_READS);
    const results = [...known, ...asked.filter((song) => song.check === 'ready')].slice(0, SHELF_MAX);
    const ready = new Set(results.map((song) => song.id));
    const plain = shown.filter((song) => ready.has(song.id)); // remembered like search's: without the tag
    await this.remember(plain);
    await this.loadArt(plain);
    return new Response(this.artText({ results, shelf }, 'student'), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /** The shelf songs the chart cron found ✓ Checked (src/songbook.js GROWN_KEY): read like 🔥 Popular. */
  async grownSongs() {
    if (!this.grown || Date.now() - this.grown.at > POPULAR_MEM_MS) {
      let list = [];
      try {
        list = readGrown(await this.env.CLASS_KV?.get(GROWN_KEY, 'json'));
      } catch (e) {
        console.error(JSON.stringify({ message: 'grown shelves read failed', error: String(e) }));
      }
      this.grown = { list, at: Date.now() };
    }
    return this.grown.list;
  }

  /** 🔥 Popular on RoomDJ (src/popular.js): KV read at most once a POPULAR_MEM_MS per room. */
  async popularSongs() {
    if (!this.popular || Date.now() - this.popular.at > POPULAR_MEM_MS) this.popular = { list: await readPopular(this.env), at: Date.now() };
    return this.popular.list;
  }

  /**
   * The teacher's search (host 'search', protocol.js TEACHER PICKS): exactly a student's room search
   * (src/search.js through this room's relay, the same KV cache, kept in this room's songs), over
   * the host socket. The relay may ask this same host page for the iTunes call: that answer comes
   * in as its own 'lookupResult' message while this one waits, so it cannot block itself.
   */
  async hostSearch(ws, raw) {
    const asked = typeof raw === 'string' ? raw.slice(0, QUERY_MAX) : '';
    const reply = (body) => this.send(ws, { t: 'searchResults', q: asked, ...body });
    const q = cleanQuery(asked);
    if (!q) return reply({ results: [] });
    if (!this.allow('teacherSearch', 'host') || !this.allow('roomSearch', 'room')) {
      return reply({ error: 'rate', message: 'That is a lot of searching. Wait a minute and try again.' });
    }
    const banned = await this.banned();
    try {
      const catalog = roomCatalog(this.room?.service ?? null, this.env);
      const found = await searchAllowed(q, this.env, { blocklist: this.room?.settings.blocklist ?? [], banned, notMusic: this.room?.settings.blockNotMusic !== false, kidzBop: this.room?.settings.kidzBop, catalog, fetchImpl: this.relay });
      await this.remember(found.results);
      await this.loadArt(found.results);
      found.results = await this.withReady(found.results);
      return reply(found);
    } catch (e) {
      if (e instanceof CatalogError) return reply({ error: `search_${e.code}`, message: e.message });
      throw e;
    }
  }

  /** Host pages that answer lookups (they said so in their 'service' message), newest first. */
  hostSockets() {
    return this.sockets()
      .map((ws) => [ws, ws.deserializeAttachment()])
      .filter(([, a]) => a?.role === 'host' && a.lookups)
      .sort((x, y) => (y[1].at ?? 0) - (x[1].at ?? 0))
      .map(([ws]) => ws);
  }

  /** Keep songs this room's search found (the server's own data), for suggestions of them. */
  async remember(songs) {
    if (this.recent.size > RECENT_MAX) this.recent.clear();
    const fresh = {};
    for (const song of songs) {
      if (this.recent.has(song.id)) continue;
      this.recent.set(song.id, song);
      fresh[`song:${song.id}`] = song;
    }
    try {
      // storage.put takes at most 128 keys at once (a songbook shelf sends up to SHELF_MAX songs).
      const entries = Object.entries(fresh);
      for (let i = 0; i < entries.length; i += 100) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
    } catch (e) {
      console.error(JSON.stringify({ message: 'recent songs write failed', error: String(e) }));
    }
  }

  /** A song from this room's searches, or null. */
  async recentSong(id) {
    const hit = this.recent.get(id);
    if (hit) return hit;
    try {
      const stored = legacySong((await this.ctx.storage.get(`song:${id}`)) ?? null);
      if (stored?.id === id) {
        this.recent.set(id, stored);
        return stored;
      }
    } catch (e) {
      console.error(JSON.stringify({ message: 'recent songs read failed', error: String(e) }));
    }
    return null;
  }

  /** True when `token` is this room's host token (compared in constant time). */
  async hostTokenOk(token) {
    return Boolean(this.room?.hostHash) && crypto.subtle.timingSafeEqual(await sha256(token ?? ''), hexBytes(this.room.hostHash));
  }

  // Is this the open room's host? (The Worker asks before it hands out the Apple Music token.)
  async hostCheck(request) {
    if (!(await this.live())) return json(404, NO_ROOM);
    if (!(await this.hostTokenOk(request.headers.get('x-host-token')))) {
      return json(403, { error: 'host', message: 'This host link is not valid for that room.' });
    }
    return json(200, { ok: true, free: isFreeTeacher(this.profile?.id) });
  }

  // The YouTube video for a song now playing or queued in this room. Host only (its token), so
  // students cannot spend the YouTube quota; the song comes from the room, never from the page.
  async youtube(request, url) {
    if (!this.room?.open) return json(404, NO_ROOM);
    if (!(await this.hostTokenOk(request.headers.get('x-host-token')))) {
      return json(403, { error: 'host', message: 'This host link is not valid for that room.' });
    }
    // Free teachers: no YouTube (the quota is shared by everyone; protocol.js FREE TEACHERS).
    if (isFreeTeacher(this.profile?.id)) return json(403, { error: 'youtube_off', message: 'YouTube is not available on free RoomDJ. Use Spotify.' });
    // ?trackId=<n>: a host page from before catalog ids.
    const id = songId(url.searchParams.get('song') ?? Number(url.searchParams.get('trackId')));
    const skip = url.searchParams.get('skip') || null;
    if (skip !== null && !VIDEO_ID_PATTERN.test(skip)) return json(400, { error: 'skip', message: 'That video id is not valid.' });
    const item = [this.room.nowPlaying, ...this.room.queue].find((q) => q && q.song.id === id);
    if (!item) return json(404, { error: 'no_item', message: 'That song is not in the queue any more.' });
    // Spotify's Developer Policy: its content is never used to find another service's stream.
    if (catalogOf(id) === SPOTIFY) return json(404, { error: 'youtube_none', message: 'This song came from Spotify, so only Spotify can play it.' });
    if (!this.allow('youtube', 'host')) return json(429, { error: 'rate', message: 'Slow down a little.' });
    try {
      const { videoId } = await resolveVideo(item.song, this.env, { skip });
      return json(200, { videoId });
    } catch (e) {
      if (!(e instanceof YoutubeError)) throw e;
      const status = { none: 404, down: 502 }[e.code] ?? 503;
      return json(status, { error: `youtube_${e.code}`, message: e.message });
    }
  }

  async connect(request, url) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json(426, { error: 'upgrade', message: 'This address needs a WebSocket.' });
    }
    if (!(await this.live())) return this.refuseSocket({ t: 'error', ...NO_ROOM });
    const role = url.searchParams.get('role');
    let attachment;
    if (role === 'host') {
      const token = url.searchParams.get('token') ?? '';
      const ok = this.room.hostHash && crypto.subtle.timingSafeEqual(await sha256(token), hexBytes(this.room.hostHash));
      if (!ok) return this.refuseSocket({ t: 'error', error: 'host', message: 'This host link is not valid for that room.' });
      attachment = { role: 'host', at: Date.now() };
    } else if (role === 'student') {
      const device = url.searchParams.get('device') ?? '';
      const nick = (url.searchParams.get('nick') ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
      if (!DEVICE_ID_PATTERN.test(device)) return this.refuseSocket({ t: 'error', error: 'device', message: 'Reload the page and join again.' });
      if (this.room.kicked.includes(device)) return this.refuseSocket({ t: 'kicked' }, CLOSE.kicked);
      if (!this.admitted(device)) return this.refuseSocket({ t: 'error', ...NOT_JOINED });
      // Every socket costs a save and a state message to everyone: one device cannot open hundreds.
      // 1013 (try again later) is not a final close code, so the page just retries after a while.
      if (!this.allow('connect', device)) return this.refuseSocket(null, 1013);
      if (!nick || [...nick].length > NICK_MAX) {
        return this.refuseSocket({ t: 'error', error: 'nick', message: `Pick a nickname of 1 to ${NICK_MAX} letters.` });
      }
      const refuseNick = (message) => this.refuseSocket({ t: 'error', error: 'nick', message });
      // Made, never typed (shared/nickgen.js): only an "Adjective Noun" from the two lists gets in, so
      // no AI nickname check is needed. The word lists and the teacher's blocklist still apply.
      // TYPED_NICKNAMES=on (local tests only, .dev.vars) keeps the old typed nicknames + AI check.
      const typed = this.env.TYPED_NICKNAMES === 'on';
      if (/[\p{C}]/u.test(nick) || (!typed && !isGeneratedNick(nick)) || !nickAllowed(nick, this.room.settings.blocklist) || (this.room.renamed ?? []).includes(nickKey(nick))) {
        return refuseNick(typed ? PICK_NICK_TYPED : PICK_NICK);
      }
      if (nickTaken(this.room, device, nick, this.onlineDevices())) return refuseNick(NICK_TAKEN);
      // The AI check (typed nicknames only), for a nickname this device is not already using here.
      const before = this.room.students[device];
      if (typed && this.room.settings.aiCheck && !(before && nickKey(before.nick) === nickKey(nick))) {
        const verdict = await this.nickAiCheck(device, nick);
        if (!(await this.live())) return this.refuseSocket({ t: 'error', ...NO_ROOM });
        if (verdict === 'limit') return refuseNick('That is a lot of nickname tries. Wait a minute and try again.');
        if (verdict === 'no') return refuseNick(PICK_NICK_TYPED);
        // Things may have changed while the AI thought.
        if (this.room.kicked.includes(device)) return this.refuseSocket({ t: 'kicked' }, CLOSE.kicked);
        if (nickTaken(this.room, device, nick, this.onlineDevices())) return refuseNick(NICK_TAKEN);
      }
      const known = this.room.students[device];
      this.room.students[device] = { nick, joinedAt: known?.joinedAt ?? Date.now() };
      if (known?.nick !== nick) this.relabel(device, nick);
      attachment = { role: 'student', device, nick, at: Date.now() };
      this.closeOldTabs(device);
    } else if (role === 'board') {
      // The board token comes in the first message (never in the URL: protocol.js BOARD + REMOTE).
      if (!this.allow('boardConnect', 'room')) return this.refuseSocket(null, 1013);
      this.closeWaitingBoards();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: 'boardWait', at: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    } else {
      return this.refuseSocket({ t: 'error', error: 'role', message: 'Reload the page and join again.' });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    await this.commit();
    if (attachment.role === 'host') this.sendBlocked(server);
    else await this.sendFavorites(server);
    await this.sendRepeats(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Layer 2 of the nickname check (shared/nick.js): the cached verdict, else Workers AI.
   * @returns {Promise<'ok'|'no'|'limit'>} 'limit': this device asked too often (try again in a
   *   minute). AI trouble lets the nickname in (the word lists passed it) and shows the host the
   *   AI warning, like the song check.
   */
  async nickAiCheck(device, nick) {
    const hit = await cachedNickVerdict(nick, this.env);
    if (hit) return hit.verdict === 'inappropriate' ? 'no' : 'ok';
    if (!this.allow('nickAi', device)) return 'limit';
    if (!this.allow('nickAiRoom', 'room')) {
      console.log(JSON.stringify({ message: 'AI nickname checks busy; nickname allowed on the word lists' }));
      return 'ok';
    }
    const ai = await askNickAi(nick, this.env);
    if (this.room) {
      const status = ai.failed ? 'failing' : 'ok';
      if (this.room.aiStatus !== status) {
        this.room.aiStatus = status;
        await this.commit();
      }
    }
    if (ai.verdict === 'inappropriate') console.log(JSON.stringify({ message: 'nickname refused by the AI check' }));
    return ai.verdict === 'inappropriate' ? 'no' : 'ok';
  }

  /** A student's songs show their current nickname (after a Rename). */
  relabel(device, nick) {
    for (const item of [this.room.nowPlaying, ...this.room.queue, ...(this.room.review ?? [])]) {
      if (item?.device === device) item.by = nick;
    }
    relabelHistory(this.room, device, nick);
  }

  /** Before a device's new student socket opens: close its oldest ones beyond SOCKETS_PER_DEVICE - 1. */
  closeOldTabs(device) {
    const mine = this.sockets()
      .map((ws) => [ws, ws.deserializeAttachment()])
      .filter(([, a]) => a?.role === 'student' && a.device === device)
      .sort((x, y) => (x[1].at ?? 0) - (y[1].at ?? 0));
    for (const [ws] of mine.slice(0, Math.max(0, mine.length - (SOCKETS_PER_DEVICE - 1)))) {
      this.send(ws, { t: 'error', error: 'tabs', message: 'RoomDJ is open in another tab on this computer, so this tab stopped. Reload it to use it here.' });
      try {
        ws.close(CLOSE.refused, 'Too many tabs');
      } catch {
        // already closing
      }
    }
  }

  // ---- WebSocket ------------------------------------------------------------------------------

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    if (!(await this.live())) {
      this.send(ws, { t: 'closed' });
      try {
        ws.close(CLOSE.closed, 'Room closed');
      } catch {
        // closeRoom closed it already
      }
      return;
    }
    if (typeof raw !== 'string' || raw.length > (a?.role === 'host' ? MAX_HOST_MESSAGE_BYTES : MAX_MESSAGE_BYTES)) {
      return this.send(ws, { t: 'error', error: 'bad_message', message: 'The page sent something the server could not read.' });
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { t: 'error', error: 'bad_message', message: 'The page sent something the server could not read.' });
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ping') return this.send(ws, { t: 'pong' });
    // A board's first message is its token; nothing else is read before it.
    if (a?.role === 'boardWait') return this.boardHello(ws, msg);
    // Lookup answers do not count against the host's message limit (the room asked for them).
    if (msg.t === 'lookupResult' && a?.role === 'host') return void this.hostRelay.answer(msg);
    // The player's position for the boards: its own limit, never stored in the room.
    if (msg.t === 'progress' && a?.role === 'host') return this.progress(ws, a, msg);
    if (!this.allow('message', a?.role === 'host' || a?.role === 'board' ? a.role : a?.device)) {
      return this.send(ws, { t: 'error', error: 'rate', message: 'Slow down a little.' });
    }
    try {
      if (a?.role === 'host') await this.hostMessage(ws, msg);
      else if (a?.role === 'board') await this.boardRemote(ws, msg);
      else if (a?.role === 'student') await this.studentMessage(ws, a, msg);
    } catch (e) {
      console.error(JSON.stringify({ message: 'socket message failed', t: msg.t, error: String(e), stack: e?.stack }));
      this.send(ws, { t: 'error', error: 'server', message: 'Something went wrong on the server. Try again.' });
    }
  }

  async webSocketClose(ws) {
    try {
      ws.close();
    } catch {
      // auto-replied already
    }
    // The host sees who went offline.
    this.broadcast(ws);
  }

  async webSocketError(ws, error) {
    console.error(JSON.stringify({ message: 'socket error', error: String(error) }));
  }

  async studentMessage(ws, a, msg) {
    if (this.room.kicked.includes(a.device)) {
      this.send(ws, { t: 'kicked' });
      ws.close(CLOSE.kicked, 'Removed');
      return;
    }
    // 📚 Back to work: a resting device may not suggest or jump (nothing checked or charged). Votes
    // are never refused by a rest, and only a suggestion starts one (protocol.js BACK TO WORK).
    if (msg.t === 'suggest' || msg.t === 'jump') {
      const rest = restRefusal(this.room, a.device);
      if (rest) {
        const refusal = { reason: 'back_to_work', message: backToWorkMessage(rest.left), left: rest.left };
        if (msg.t === 'jump') return this.send(ws, { t: 'jumped', ok: false, id: String(msg.id ?? ''), ...refusal });
        const id = songId(msg.song ?? msg.trackId);
        return this.send(ws, { t: 'suggested', ok: false, song: id ?? null, ...refusal });
      }
    }
    if (msg.t === 'vote') {
      const result = vote(this.room, a.device, String(msg.id ?? ''), msg.v);
      if (!result.ok) {
        // playing_down: a new 👎 on the song playing now (it takes 👍 only). downvotes: the 👎 limit
        // (protocol.js DOWNVOTE LIMIT); the page undoes its vote by id.
        const message = VOTE_MESSAGES[result.error] ?? VOTE_MESSAGES.bad_vote;
        return this.send(ws, { t: 'error', error: result.error, message, id: String(msg.id ?? '') });
      }
      return this.commit(); // a vote never starts a back-to-work rest
    }
    // `trackId` (a number): a student page from before catalog ids.
    if (msg.t === 'suggest') return this.suggest(ws, a, msg.song ?? msg.trackId);
    if (msg.t === 'jump') return this.jump(ws, a, String(msg.id ?? ''));
    if (msg.t === 'coupon') return this.coupon(ws, a, msg.code);
    this.send(ws, { t: 'error', error: 'bad_message', message: 'The page sent something the server does not know.' });
  }

  // 🎟 A coupon from another class tool (shared/coupon.js COUPONS, src/coupons.js): its credits go to
  // this student. Refused, and NOT used up, while the server or the teacher has coupons off or the
  // room has credits off. → couponResult { ok, amount, credits } | { ok: false, reason, message }.
  async coupon(ws, a, code) {
    const no = (reason) => this.send(ws, { t: 'couponResult', ok: false, reason, message: COUPON_MESSAGES[reason] });
    if (!couponsOn(this.env) || this.room.settings.coupons === false) return no('off');
    if (creditsOf(this.room, a.device) === null) return no('credits_off'); // null: credits are off
    if (!this.allow('coupon', a.device)) return no('rate');
    const done = await redeemCoupon(this.env, code);
    if (!done.ok) return no(done.reason);
    const credits = couponCredits(this.room, a.device, done.credits);
    if (credits === null) {
      // Credits went off (or the student was removed) while the coupon was checked: it is used up.
      console.log(JSON.stringify({ message: 'coupon used, no credits given', issuer: done.issuer }));
      return no('credits_off');
    }
    console.log(JSON.stringify({ message: 'coupon used', issuer: done.issuer, credits: done.credits }));
    this.send(ws, { t: 'couponResult', ok: true, amount: done.credits, credits });
    return this.commit();
  }

  // Spend JUMP_COST credits so a waiting song plays next (shared/queue.js jumpSong). Refusals
  // spend nothing.
  async jump(ws, a, id) {
    const no = (reason) => this.send(ws, { t: 'jumped', ok: false, id, reason, message: JUMP_MESSAGES[reason] });
    if (!this.allow('jump', a.device)) return no('rate');
    const nick = this.room.students[a.device]?.nick ?? a.nick;
    const done = jumpSong(this.room, { device: a.device, nick, id });
    if (!done.ok) return no(done.reason);
    console.log(JSON.stringify({ message: 'song jumped', cost: JUMP_COST }));
    this.send(ws, { t: 'jumped', ok: true, id, title: done.item.song.title });
    await this.commit();
  }

  /**
   * A suggestion: a student's (a = their socket attachment) or the teacher's (a.device is
   * TEACHER_DEVICE: the host's 'suggest', protocol.js TEACHER PICKS). One path for both, so the
   * teacher's picks pass the same filter, repeats and artist rules; only credits, the per-student
   * limit, the lock, cleanup and the rate limit differ (shared/queue.js suggestRefusal and below).
   */
  async suggest(ws, a, raw) {
    const teacher = a.device === TEACHER_DEVICE;
    const id = songId(raw);
    const no = (reason, message) => this.send(ws, { t: 'suggested', ok: false, reason, message, song: id ?? null });
    // 📈 The request log (shared/requests.js): a student's ask of a known song and what happened to it.
    const asked = (song, outcome, extra = {}) => {
      if (!teacher && this.room?.open) logAsk(this.room, askEntry(song, outcome, { device: a.device, ...extra }));
    };
    if (!id) return no('unavailable', 'We could not find that song.');
    // A Spotify song only while the host plays through Spotify (Spotify's Developer Policy). A
    // page with old results after the teacher switched services gets this.
    if (catalogOf(id) === SPOTIFY && this.room.service !== 'spotify') {
      return no('unavailable', 'Your teacher changed where the music comes from. Search again and pick the song from the new list.');
    }
    const early = suggestRefusal(this.room, a.device, id);
    if (early) return no(early, refusalMessage(this.room, early, id));
    // Max song length, before anything is charged, for a song this room's search already found.
    const tooLongNo = (song) => {
      const long = tooLong(song, this.room.settings);
      if (!long) return false;
      asked(song, 'refused', { reason: 'too_long' });
      this.send(ws, { t: 'suggested', ok: false, reason: 'too_long', message: TOO_LONG, song: id, why: { id: 'too_long', evidence: long.evidence } });
      return true;
    };
    // One song per artist, also before anything is charged (never charged: not the filter's no).
    const sameArtistNo = (song) => {
      const waiting = artistWaiting(this.room, song);
      if (!waiting) return false;
      asked(song, 'refused', { reason: 'same_artist' });
      this.send(ws, { t: 'suggested', ok: false, reason: 'same_artist', message: refusalMessage(this.room, 'same_artist', id), song: id, why: sameArtistWhy(waiting) });
      return true;
    };
    // Another version of a song already waiting or played, and the repeat cooldown: never charged.
    const queueNo = (song) => {
      const reason = suggestRefusal(this.room, a.device, id, song);
      if (!reason) return false;
      asked(song, 'refused', { reason });
      no(reason, refusalMessage(this.room, reason, id, song));
      return true;
    };
    const restingNo = async (song) => {
      const rest = await this.resting(song);
      if (!rest || !this.room?.open) return false;
      asked(song, 'refused', { reason: 'resting' });
      this.send(ws, {
        t: 'suggested', ok: false, reason: 'resting', message: RESTING, song: id,
        why: { id: 'resting', evidence: RESTING_EVIDENCE }, at: rest.at, until: rest.until,
      });
      return true;
    };
    const seen = await this.recentSong(id);
    if (seen && (queueNo(seen) || tooLongNo(seen) || sameArtistNo(seen) || (await restingNo(seen)))) return;
    if (!this.room?.open) return;
    // Credits (when on): checked before the rate limit, taken now so two quick suggestions cannot
    // both spend the last one. Only a filter "no" refunds out loud; every other way out gives the
    // credit back quietly, because it never really cost anything (protocol.js CREDITS).
    // The teacher never pays (and has no balance), and has a gentler limit of their own.
    const credits = teacher ? null : creditsOf(this.room, a.device); // null: credits are off
    if (credits !== null && credits < SUGGEST_COST) return no('credits', refusalMessage(this.room, 'credits', id));
    if (!(teacher ? this.allow('teacherSuggest', 'host') : this.allow('suggest', a.device) && this.allow('roomSuggest', 'room'))) {
      return no('rate', 'That is a lot of suggestions. Wait a minute and try again.');
    }
    const paid = teacher ? 0 : (spendCredits(this.room, a.device, SUGGEST_COST) ?? 0);
    const giveBack = async () => {
      if (!paid || !this.room?.open || refundCredits(this.room, a.device, paid) === null) return false;
      await this.commit();
      return true;
    };
    const quietNo = async (reason, message) => {
      await giveBack();
      return no(reason, message);
    };
    let song;
    try {
      song = seen ?? (await this.recentSong(id)) ?? (await lookupCatalog(id, this.env, { fetchImpl: this.relay }));
    } catch (e) {
      if (e instanceof CatalogError) return quietNo('unavailable', e.message);
      await giveBack();
      throw e;
    }
    if (!song) return quietNo('unavailable', 'We could not find that song.');
    if (!this.room?.open) return;
    if (!seen && suggestRefusal(this.room, a.device, id, song)) {
      await giveBack(); // never really charged (a refusal that is not the filter's)
      return void queueNo(song);
    }
    if (!seen && (await this.resting(song))) {
      await giveBack();
      return void (await restingNo(song));
    }
    if (!this.room?.open) return;
    if (tooLong(song, this.room.settings)) {
      await giveBack(); // never really charged (a refusal that is not the filter's)
      return void tooLongNo(song);
    }
    if (artistWaiting(this.room, song)) {
      await giveBack();
      return void sameArtistNo(song);
    }
    // 🖼 The cover is checked at the same time as the song (ALBUM ART): it never blocks the song, and
    // the suggestion waits for it at most ART_WAIT_MS (after that it finishes in the background).
    const artStarted = Date.now();
    const artCheck = this.artCheckFor(song);
    let verdict;
    try {
      const banned = await this.banned();
      verdict = await filterSong(song, { settings: this.room.settings, banned, env: this.env, scope: this.scope, lyrics: this.lyrics, budget: () => this.spendFree('ai') });
    } catch (e) {
      await giveBack();
      throw e;
    }
    if (artCheck) {
      let timer;
      const wait = new Promise((r) => { timer = setTimeout(r, Math.max(0, ART_WAIT_MS - (Date.now() - artStarted))); });
      await Promise.race([artCheck, wait]).finally(() => clearTimeout(timer));
    }
    if (!this.room?.open) return;
    let changed = false;
    if (verdict.ai && !verdict.ai.cached) {
      const status = verdict.ai.failed ? 'failing' : 'ok';
      if (this.room.aiStatus !== status) {
        this.room.aiStatus = status;
        changed = true;
      }
    }
    const nick = teacher ? teacherName(this.room) : (this.room.students[a.device]?.nick ?? a.nick);
    if (!verdict.ok && verdict.reason === 'review') {
      // The AI did not know it (or failed): the teacher decides. Queue rules are checked again.
      // The credit is held with it: Allow keeps it, Remove gives it back, Ban does not.
      // checked 'lyrics': the AI read its lyrics and is still not sure (the teacher sees it).
      // 'nolyrics': the AI said OK but its lyrics could not be found or read to confirm it.
      const checked = verdict.unconfirmed ? 'nolyrics'
        : verdict.ai?.lyrics === 'found' && verdict.ai.verdict === 'unknown' ? 'lyrics' : null;
      const held = addToReview(this.room, { device: a.device, nick, song, paid, checked });
      if (!held.ok) {
        if (!(await giveBack()) && changed) await this.commit();
        if (held.reason === 'same_artist' && sameArtistNo(song)) return;
        asked(song, 'refused', { reason: held.reason });
        return no(held.reason, refusalMessage(this.room, held.reason, id, song));
      }
      if (!teacher) startRest(this.room, a.device); // 📚 the pick is in: back to work
      // The lyrics lookup failed for a passing reason (a limit, LRCLIB busy): try again by itself.
      if (checked === 'nolyrics' && verdict.ai?.lyrics !== 'none') this.scheduleRecheck(held.item.id);
      // And at night, for everyone's next class, whatever the teacher decides now (src/night.js).
      if (nightWorthy(song, verdict.ai)) await addToNight(this.env, `look:${banKey(song)}`, [song]);
      console.log(JSON.stringify({ message: 'suggestion waits for review', song: id, ai: verdict.ai?.reason }));
      const { why, detail } = filterWhy(song, verdict);
      asked(song, 'review', { reason: verdict.unconfirmed ? 'nolyrics' : 'review', why: why?.id, item: held.item.id });
      this.send(ws, { t: 'suggested', ok: false, reason: 'review', message: FILTER_REASONS.review, song: id, why, ...(teacher && detail ? { detail } : {}) });
      return this.commit();
    }
    if (!verdict.ok) {
      console.log(JSON.stringify({ message: 'suggestion blocked', song: id, reason: verdict.reason, ai: verdict.ai?.reason }));
      const banNote = verdict.reason === 'banned' ? await this.banNote(song) : '';
      const { why, detail } = filterWhy(song, verdict, { banNote });
      if (!this.room?.open) return;
      asked(song, 'blocked', { reason: verdict.reason, why: why?.id });
      await this.addBlocked({ song, device: a.device, by: nick, why, detail, source: 'filter', action: 'suggest' });
      const refunded = await giveBack(); // the filter said no: the credit comes back
      if (!refunded && changed) await this.commit();
      // The teacher also gets the full detail (the blocked word, the AI's evidence), like Blocked today.
      return this.send(ws, {
        t: 'suggested', ok: false, reason: verdict.reason, message: FILTER_REASONS[verdict.reason], song: id, why,
        ...(refunded ? { refunded } : {}), ...(teacher && detail ? { detail } : {}),
      });
    }
    // Things may have changed while the filter ran, so the queue rules are checked again.
    const added = addSuggestion(this.room, { device: a.device, nick, song, paid });
    if (!added.ok) {
      if (!(await giveBack()) && changed) await this.commit();
      if (added.reason === 'same_artist' && sameArtistNo(song)) return;
      asked(song, 'refused', { reason: added.reason });
      return no(added.reason, refusalMessage(this.room, added.reason, id, song));
    }
    asked(song, 'queued', { item: added.item.id });
    if (!teacher) startRest(this.room, a.device); // 📚 the pick is in: back to work
    this.send(ws, { t: 'suggested', ok: true, title: song.title, song: id });
    await this.commit();
  }

  async hostMessage(ws, msg) {
    const room = this.room;
    switch (msg.t) {
      // Teacher picks (protocol.js TEACHER PICKS): the student shapes, as the teacher's pseudo device.
      case 'suggest':
        return this.suggest(ws, { device: TEACHER_DEVICE }, msg.song ?? msg.trackId);
      case 'vote': {
        const result = vote(room, TEACHER_DEVICE, String(msg.id ?? ''), msg.v);
        if (!result.ok) return this.send(ws, { t: 'error', error: result.error, message: VOTE_MESSAGES[result.error] ?? VOTE_MESSAGES.bad_vote });
        return this.commit();
      }
      case 'search':
        return this.hostSearch(ws, msg.q);
      case 'next':
      case 'skip': {
        if (!nextIsFor(room, msg.from)) return; // already moved on (its state is on the way)
        // How the song playing ended, for the Top 5 and the favorites (only a finish counts there).
        const ended = msg.t === 'skip' ? 'skipped' : msg.failed === true ? 'failed' : 'finished';
        const done = room.nowPlaying?.id ?? null;
        const entry = done ? room.history?.findLast((x) => x.id === done) : null;
        nextSong(room, { ended });
        await this.commit();
        this.checkWaitingArt(); // 🖼 a cover still unchecked is asked again
        if (done && ended === 'finished') await this.favoriteFinished(done);
        await this.notePlay(entry, ended);
        return this.sendRepeats(); // played this period, and maybe a new resting song
      }
      // The teacher's ⏫ Play next / ⏬ Undo and ▶ Play now (protocol.js TEACHER PUSH). Host only:
      // students and boards never reach hostMessage with these (studentMessage, boardMessage).
      case 'push': {
        const done = pushSong(room, { id: String(msg.id ?? ''), on: msg.on === true });
        if (!done.ok) return this.send(ws, { t: 'error', error: done.reason, message: PUSH_MESSAGES[done.reason] });
        return this.commit();
      }
      case 'playNow': {
        // The same `from` guard as Skip: a doubled click or a second tab cannot skip twice. Unlike
        // 'next', no page ever sent playNow without it, so a missing `from` is refused too.
        if (msg.from === undefined || !nextIsFor(room, msg.from)) return;
        const id = String(msg.id ?? '');
        const playing = room.nowPlaying?.id ?? null;
        const entry = playing ? room.history?.findLast((x) => x.id === playing) : null;
        const done = playNowSong(room, { id });
        if (!done.ok) return this.send(ws, { t: 'error', error: done.reason, message: PUSH_MESSAGES[done.reason] });
        await this.commit();
        await this.notePlay(entry, 'skipped'); // exactly a Skip of the song playing
        return this.sendRepeats();
      }
      case 'lockNext':
        // NEXT LOCK (protocol.js): the song playing is in its last seconds; the next song is locked in.
        if (lockNext(room, String(msg.id ?? ''))) return this.commit();
        return;
      case 'resting':
        return this.sendResting(ws);
      case 'wake':
        return this.wake(ws, msg.key);
      case 'recap': {
        const recap = recapOf(room, Date.now(), { periodFavorite: await this.periodFavorite() });
        await this.loadArt([...recap.songs, ...recap.top5].map((x) => x.song));
        return this.send(ws, { t: 'recap', recap });
      }
      case 'recapShow':
        return this.recapShow();
      case 'boardLink':
        return this.newBoardLink(ws);
      case 'boardInfo':
        // The class code (the room keeps only its hash) and the big-screen preferences, for the
        // boards: in this host socket's attachment only, gone with it (protocol.js BOARD + REMOTE).
        ws.serializeAttachment({ ...ws.deserializeAttachment(), board: cleanBoardInfo(msg) });
        return this.broadcastBoards();
      case 'favorites': {
        const all = hostFavorites(await this.favoriteList(true));
        await this.loadArt(all.map((f) => f.song));
        return this.send(ws, { t: 'favoritesAll', list: all });
      }
      case 'favoriteRemove':
      case 'favoritePin': {
        const id = String(msg.id ?? '');
        const ok = await this.changeFavorites((list) => (msg.t === 'favoriteRemove' ? removeFavorite(list, id) > 0 : pinFavorite(list, id, msg.on === true)));
        if (!ok) this.send(ws, { t: 'error', error: 'no_item', message: 'That song is not on the favorites list any more.' });
        return;
      }
      case 'veto': {
        // Works on the queue and on the review list (there it is the Remove button). The teacher's
        // reason + note (optional) go to the student and into Blocked today.
        const id = String(msg.id ?? '');
        const reviewed = takeReview(room, id);
        const item = reviewed ?? veto(room, id);
        if (!item) return this.send(ws, NO_ITEM);
        const { why, detail } = this.teacherReason(ws, msg, 'teacher');
        // Remove in Needs a look is the filter's answer: the credit comes back (a queue veto: no).
        if (reviewed) this.sendReviewed(reviewed, false, refundItem(room, reviewed) !== null, why);
        else this.sendRemoved(item, why);
        await this.addBlocked({ song: item.song, device: item.device, by: item.by, why, detail, source: 'teacher', action: reviewed ? 'remove' : 'veto' });
        if (reviewed) await this.rejectedByTeacher(item.song);
        return this.commit();
      }
      case 'allow': {
        const item = allowReview(room, String(msg.id ?? ''));
        if (!item) return this.send(ws, NO_ITEM);
        try {
          await approveSong(item.song, this.env, this.scope);
        } catch (e) {
          // The song is still allowed in this room; only the "every room" memory failed.
          console.error(JSON.stringify({ message: 'approved write failed', song: item.song.id, error: String(e) }));
        }
        this.sendReviewed(item, true);
        return this.commit();
      }
      case 'ban': {
        const id = String(msg.id ?? '');
        const playing = room.nowPlaying?.id === id ? room.nowPlaying : null;
        const reviewed = playing ? null : takeReview(room, id);
        const item = playing ?? reviewed ?? veto(room, id);
        if (!item) return this.send(ws, NO_ITEM);
        const { why, detail } = this.teacherReason(ws, msg, 'banned');
        if (reviewed) this.sendReviewed(reviewed, false, false, why);
        else this.sendRemoved(item, why);
        if (playing) {
          nextSong(room, { ended: 'banned' }); // it leaves the Top 5 too
          // Not "already played": a student who tries it again should hear it is banned.
          unplay(room, item.song);
        }
        await this.addBan(item.song, why);
        await this.rejectedByTeacher(item.song);
        const entry = logBlocked(this.blocked, { song: item.song, device: item.device, by: item.by, why, detail, source: 'teacher', action: 'ban' });
        entry.status = 'banned';
        await this.saveBlocked();
        return this.commit();
      }
      case 'blockedAllow':
        return this.blockedAllow(ws, String(msg.id ?? ''));
      case 'blockedBan':
        return this.blockedBan(ws, msg);
      case 'kick': {
        const device = String(msg.device ?? '');
        if (!DEVICE_ID_PATTERN.test(device)) return this.send(ws, { t: 'error', error: 'device', message: 'No such student.' });
        kickDevice(room, device);
        for (const other of this.ctx.getWebSockets()) {
          if (other.deserializeAttachment()?.device === device) {
            this.send(other, { t: 'kicked' });
            try {
              other.close(CLOSE.kicked, 'Removed');
            } catch {
              // already closing
            }
          }
        }
        return this.commit();
      }
      case 'letBackIn': {
        // 📚 Back to work: the teacher ends one student's rest now.
        const device = String(msg.device ?? '');
        if (!DEVICE_ID_PATTERN.test(device) || !room.students[device]) return this.send(ws, { t: 'error', error: 'device', message: 'No such student.' });
        if (letBackIn(room, device)) return this.commit();
        return;
      }
      case 'rename': {
        // The teacher asks a student to pick a different nickname. The device stays admitted; its
        // pages go back to the join screen, and nobody may use that nickname in this room again.
        const device = String(msg.device ?? '');
        const student = DEVICE_ID_PATTERN.test(device) ? room.students[device] : null;
        if (!student) return this.send(ws, { t: 'error', error: 'device', message: 'No such student.' });
        const key = nickKey(student.nick);
        room.renamed = [...(room.renamed ?? []).filter((k) => k !== key), key].slice(-RENAMED_MAX);
        delete room.students[device];
        this.relabel(device, 'a classmate');
        for (const other of this.ctx.getWebSockets()) {
          const a = other.deserializeAttachment();
          if (a?.role !== 'student' || a.device !== device) continue;
          this.send(other, { t: 'error', error: 'nick', message: 'Your teacher asked you to pick a different nickname.' });
          try {
            other.close(CLOSE.refused, 'Rename');
          } catch {
            // already closing
          }
        }
        return this.commit();
      }
      case 'lock':
        room.locked = msg.on === true;
        return this.commit();
      case 'service': {
        // What the host page plays through (a Spotify room would search Spotify's catalog, which
        // stays off), and whether this page answers the room's iTunes lookups.
        if (!SERVICES.includes(msg.service)) return this.send(ws, { t: 'error', error: 'bad_message', message: 'The page sent something the server does not know.' });
        const a = ws.deserializeAttachment();
        if (msg.lookups === true && !a?.lookups) ws.serializeAttachment({ ...a, lookups: true });
        if (room.service === msg.service) return;
        room.service = msg.service;
        await this.touch();
        return this.save();
      }
      case 'settings': {
        // A page may send only the fields it changes.
        const v = validateSettings(msg.settings && typeof msg.settings === 'object' ? { ...room.settings, ...msg.settings } : msg.settings, { testAiOff: this.env.TEST_AI_OFF === 'on' });
        if (!v.ok) return this.send(ws, { t: 'error', error: 'invalid_settings', message: 'Some of those values are not allowed.', details: v.errors });
        settleCredits(room); // a new "Starting credits" is for students who join later
        const offsetChange = bellOffsetMs(v.settings) - bellOffsetMs(room.settings);
        // SCORE FLOOR (protocol.js): turning it off removes nothing now; the remove score applies
        // again from the next vote (no surprise mass removal). The queue re-sorts at once.
        // DOWNVOTE MODE: turning 👎 back on restores the stored 👎; that switch removes nothing either.
        const floorOff = (room.settings.scoreFloor === true && v.settings.scoreFloor !== true)
          || (downvoteModeOf(room.settings) === 'off' && v.settings.downvoteMode !== 'off');
        room.settings = v.settings;
        if (offsetChange) await this.moveTimes(offsetChange); // BELL OFFSET: same bell times, new real moments
        if (!backToWorkOn(room)) clearRests(room); // 📚 off: everyone is back in at once
        // New blocked words also clear matching songs that are already waiting (queue and review).
        // A held review song's credit comes back (the filter said no); a queued one's does not.
        const out = {};
        const why = { id: 'blocked_word', evidence: BLOCKED_WORD_EVIDENCE };
        for (const item of applyBlocklist(room, out, { prune: !floorOff })) this.sendReviewed(item, false, refundItem(room, item) !== null, why);
        for (const item of out.queue) this.sendRemoved(item, why);
        for (const [item, word] of out.words) {
          logBlocked(this.blocked, { song: item.song, device: item.device, by: item.by, why, detail: `Blocked word: "${word}"`, source: 'filter', action: 'blocklist' });
        }
        if (out.words.size) await this.saveBlocked();
        await this.commit();
        await this.sendRepeats(); // the repeat cooldown may have changed
        if (msg.settings?.cooldownDays !== undefined) await this.sendResting();
        this.checkWaitingArt(); // 🖼 the art check may have come back on
        this.sendBlocked(); // 🖼 covers shown or hidden by the art switches
        return this.sendFavorites(); // blocked words, Class favorites on/off
      }
      case 'credits': {
        // Give credits to one student or everyone, or set one student's balance (validated in
        // shared/queue.js teacherCredits). Counted by the host's message limit like every action.
        const done = teacherCredits(room, msg);
        if (!done.ok) return this.send(ws, { t: 'error', error: 'credits', message: done.message });
        for (const c of done.changed) {
          if (c.amount !== 0) this.sendStudent(c.device, { t: 'credits', why: done.why, amount: c.amount, credits: c.credits });
        }
        return this.commit();
      }
      case 'code':
        return this.changeCode(ws, msg.code);
      case 'times':
        return this.changeTimes(ws, msg);
      case 'cleanup':
        if (msg.on === true) {
          if (!room.cleanup) await this.startCleanup();
          return;
        }
        // "Keep the music going": cleanup ends for today (a new cleanup time can be set in Change times).
        room.cleanup = false;
        room.cleanupAt = null;
        await this.rescheduleAlarm();
        return this.commit();
      case 'artShow':
        return this.artShow(ws, msg.key);
      case 'close':
        return this.closeRoom();
      default:
        return this.send(ws, { t: 'error', error: 'bad_message', message: 'The page sent something the server does not know.' });
    }
  }

  // "Allow anyway" on a Blocked today entry: the filter said no (AI theme check or a blocked word),
  // the teacher says yes. Into the queue for that student (nothing charged: refunded already),
  // approved like Needs a look's Allow, and the student is told.
  async blockedAllow(ws, id) {
    const entry = this.blocked.find((e) => e.id === id);
    if (!entry || !canAllow(entry)) return this.send(ws, { t: 'error', error: 'no_item', message: 'That song cannot be allowed from here any more.' });
    const done = allowBlocked(this.room, entry);
    if (!done.ok) {
      const message = done.reason === 'gone' ? 'That student is not in this room any more.' : 'That song is already in the queue.';
      return this.send(ws, { t: 'error', error: 'no_item', message });
    }
    try {
      await approveSong(entry.song, this.env, this.scope);
    } catch (e) {
      // The song is still allowed in this room; only the "every room" memory failed.
      console.error(JSON.stringify({ message: 'approved write failed', song: entry.song.id, error: String(e) }));
    }
    entry.status = 'allowed';
    this.sendReviewed(done.item, true);
    await this.saveBlocked();
    return this.commit();
  }

  // "Ban" on a Blocked today entry (a song that slipped through, or one to stop for good). If the
  // song is waiting in the queue or in Needs a look, it leaves too and its student is told.
  async blockedBan(ws, msg) {
    const entry = this.blocked.find((e) => e.id === String(msg.id ?? ''));
    if (!entry || !canBan(entry)) return this.send(ws, { t: 'error', error: 'no_item', message: 'That song is banned already.' });
    const { why } = this.teacherReason(ws, msg, 'banned');
    const queued = this.room.queue.find((i) => i.song.id === entry.song.id);
    if (queued) {
      veto(this.room, queued.id);
      this.sendRemoved(queued, why);
    }
    const held = (this.room.review ?? []).find((i) => i.song.id === entry.song.id);
    if (held) {
      takeReview(this.room, held.id);
      this.sendReviewed(held, false, false, why);
    }
    await this.addBan(entry.song, why);
    await this.rejectedByTeacher(entry.song);
    entry.status = 'banned';
    await this.saveBlocked();
    return this.commit();
  }

  // A new class code mid-day. Admitted students stay in; the old code stops working at once here
  // (the room compares the hash), and its KV route is removed.
  async changeCode(ws, raw) {
    const v = validateCode(raw);
    if (!v.ok) return this.send(ws, { t: 'code', ok: false, error: 'invalid_code', message: v.message });
    const hash = await codeHash(v.code);
    if (hash !== this.room.codeHash) {
      if ((await codeInUse(this.env, hash, this.room.room)) || !(await claimCode(this.env, hash, this.room.room, this.room.until))) {
        return this.send(ws, { t: 'code', ok: false, error: 'code_taken', message: 'Another open room is using that class code. Pick a different one.' });
      }
      if (!this.room?.open) return releaseCode(this.env, hash, this.room?.room);
      await putCodeRoute(this.env, hash, this.room.room, this.room.until);
      const old = this.room.codeHash;
      this.room.codeHash = hash;
      this.room.codeShown = v.code;
      await this.save();
      if (old) {
        await deleteCodeRoute(this.env, old, this.room.room);
        await releaseCode(this.env, old, this.room.room);
      }
    }
    this.send(ws, { t: 'code', ok: true, code: v.code });
    await this.commit();
  }

  // "Change times": class end and cleanup start (protocol.js 'times'). A cleanup time still ahead
  // ends cleanup mode; one that is now (or just passed) starts it.
  // The page sends BELL times; the room keeps the real moments (+ settings.bellOffsetSeconds, protocol.js BELL OFFSET).
  async changeTimes(ws, msg) {
    const v = validateTimes(shiftTimes({ until: msg.until, cleanupAt: msg.cleanupAt ?? null }, this.room?.settings?.bellOffsetSeconds ?? 0));
    if (!v.ok) return this.send(ws, { t: 'times', ok: false, error: v.error, message: v.message });
    const room = this.room;
    if (v.until !== room.until && room.codeHash) {
      await putCodeRoute(this.env, room.codeHash, room.room, v.until);
      await claimCode(this.env, room.codeHash, room.room, v.until); // the lock follows the class end
    }
    if (!this.room?.open) return;
    room.until = v.until;
    room.cleanupAt = v.cleanupAt;
    room.cleanup = v.cleanupAt !== null && v.cleanupAt <= Date.now();
    await this.rescheduleAlarm();
    await this.listOpen(true);
    this.send(ws, { t: 'times', ok: true });
    await this.commit();
  }

  // The bell offset changed (protocol.js BELL OFFSET): the class end and a cleanup not yet started
  // move by the difference, so they stay the same BELL times. The alarm, the code route's expiry and
  // the open-room list follow. A class end moved into the past closes the room at the next alarm.
  async moveTimes(deltaMs) {
    const room = this.room;
    if (!room?.open || !Number.isSafeInteger(room.until)) return;
    room.until += deltaMs;
    if (!room.cleanup && Number.isSafeInteger(room.cleanupAt)) room.cleanupAt += deltaMs;
    if (room.codeHash) {
      await putCodeRoute(this.env, room.codeHash, room.room, room.until);
      await claimCode(this.env, room.codeHash, room.room, room.until);
    }
    await this.rescheduleAlarm();
    await this.listOpen(true);
  }

  // ---- The board + remote (protocol.js BOARD + REMOTE) ----------------------------------------

  /** The hash of this room's board token that `token` is, or null (every hash compared, in constant time). */
  async boardTokenHash(token) {
    const given = await sha256(token);
    let hit = null;
    for (const t of boardTokens(this.room)) if (crypto.subtle.timingSafeEqual(given, hexBytes(t.hash))) hit = t.hash;
    return hit;
  }

  /**
   * Boards on tokens that stopped working get `msg` and 4002. `untagged`: also boards connected
   * before sockets remembered their token (they were on the one link token).
   */
  closeBoardsOn(hashes, msg, { untagged = false } = {}) {
    if (!hashes.length) return;
    for (const s of this.socketsOf('board')) {
      const tok = s.deserializeAttachment()?.tok;
      if (tok ? hashes.includes(tok) : untagged) this.sendAway(s, msg);
    }
  }

  /** This room is on its teacher's KV signpost of open rooms (the board's sign-in finds it). */
  async listOpen(keepAt = false) {
    if (!this.room?.open) return;
    const { room: id, until } = this.room;
    await updateOpenRooms(this.env, this.profile, (list) => addOpenRoom(list, { room: id, until }, Date.now(), { keepAt }));
  }

  /**
   * The board's sign-in (the Worker checked the teacher key and profile): a new sign-in token for
   * this room if it is live and this teacher's. Its hash joins the list; no board is kicked except
   * one on a sign-in token past BOARD_SIGNIN_MAX.
   */
/** True when `profile` ({ id, legacy }) is this room's teacher. A room from before profiles (null) is the legacy teacher's. */
  teachersRoom(profile) {
    const mine = this.room.profile;
    return profile?.legacy === true ? (!mine || mine.legacy === true) : Boolean(mine) && mine.legacy !== true && mine.id === profile?.id;
  }

/**
   * "Close my open rooms" from the start screen (the Worker checked the sign-in): closes this room
   * only if it is this teacher's, exactly like the host's Close room. Another teacher's: 404.
   */
  async teacherClose(request) {
    const { profile } = await request.json().catch(() => ({}));
    if (!(await this.live())) return json(404, NO_ROOM);
    if (!this.teachersRoom(profile)) return json(404, NO_ROOM);
    await this.closeRoom();
    return json(200, { closed: true });
  }

  async signinBoardToken(request) {
    const { profile } = await request.json().catch(() => ({}));
    if (!(await this.live())) return json(404, NO_ROOM);
    if (!this.teachersRoom(profile)) return json(404, NO_ROOM); // another teacher's room: never handed out
    const token = randomToken();
    const { list, dropped } = addSigninToken(boardTokens(this.room), await sha256Hex(token));
    this.room.boardTokens = list;
    delete this.room.boardHash;
    await this.save();
    this.closeBoardsOn(dropped, { t: 'error', error: 'board_moved', message: BOARD_SIGNIN_MOVED });
    return json(200, { room: this.room.room, boardToken: token, until: this.room.until });
  }

  /** Board sockets still waiting for their token: the stale ones (and any past BOARD_WAIT_MAX) go. */
  closeWaitingBoards() {
    const waiting = this.socketsOf('boardWait');
    const now = Date.now();
    waiting.forEach((ws, i) => {
      const a = ws.deserializeAttachment();
      if (now - (a?.at ?? 0) > BOARD_WAIT_MS || i < waiting.length - (BOARD_WAIT_MAX - 1)) {
        this.sendAway(ws, { t: 'error', error: 'board', message: BOARD_INVALID });
      }
    });
  }

  /** A board's first message: its token. Right: it becomes a board (the newest BOARDS_MAX stay). */
  async boardHello(ws, msg) {
    if (!this.allow('boardAuth', 'room')) {
      try {
        ws.close(1013, 'Try again'); // not final: the page tries again after its backoff
      } catch {
        // already closing
      }
      return;
    }
    const token = msg.t === 'board' && typeof msg.token === 'string' && BOARD_TOKEN_PATTERN.test(msg.token) ? msg.token : null;
    const tok = token ? await this.boardTokenHash(token) : null;
    if (!tok) return this.sendAway(ws, { t: 'error', error: 'board', message: BOARD_INVALID });
    if (!this.room?.open) return;
    const boards = this.socketsOf('board');
    for (const old of boards.slice(0, Math.max(0, boards.length - (BOARDS_MAX - 1)))) {
      this.sendAway(old, { t: 'error', error: 'boards', message: BOARDS_FULL });
    }
    ws.serializeAttachment({ role: 'board', at: Date.now(), tok });
    this.broadcast(); // the board's first state; the host's "📺 Board connected"
  }

  /** "🔁 New board link": a new link token (only its hash kept); every board on the old link stops. Sign-in boards stay. */
  async newBoardLink(ws) {
    const token = randomToken();
    const { list, dropped } = replaceLinkToken(boardTokens(this.room), await sha256Hex(token));
    this.room.boardTokens = list;
    delete this.room.boardHash;
    await this.save();
    this.closeBoardsOn(dropped, { t: 'error', error: 'board_moved', message: BOARD_MOVED }, { untagged: true });
    this.send(ws, { t: 'boardLink', token }); // this host socket only
    this.broadcast();
  }

  /** The host's player position, relayed to the boards (kept on the host socket for a new board). */
  progress(ws, a, msg) {
    if (!this.allow('progress', 'host')) return;
    const p = cleanProgress(msg);
    if (!p) return;
    ws.serializeAttachment({ ...a, player: p });
    this.sendBoards({ t: 'progress', ...p });
  }

  /** ▶ Play recap on the board(s): every board and host page gets the recap with show: true. */
  async recapShow() {
    const recap = recapOf(this.room, Date.now(), { periodFavorite: await this.periodFavorite() });
    if (!this.room?.open) return;
    // The preview links are for the host's recap music only: a board never plays audio (invariant 16).
    const boardRecap = { ...recap, top5: recap.top5.map(({ previewUrl, ...t }) => t) };
    for (const s of this.socketsOf('host')) this.send(s, { t: 'recap', recap, show: true });
    for (const s of this.socketsOf('board')) this.send(s, { t: 'recap', recap: boardRecap, show: true });
  }

  /** A board's remote: only what shared/board.js boardMessage lets through. */
  async boardRemote(ws, raw) {
    const msg = boardMessage(raw);
    if (!msg) return this.send(ws, { t: 'error', error: 'bad_message', message: 'The board cannot do that. Use the teacher computer.' });
    switch (msg.t) {
      case 'skip':
      case 'lock':
        return this.hostMessage(ws, msg); // exactly the host's skip (the `from` guard) and lock
      case 'veto':
        return this.vetoPlaying(ws, msg.id);
      case 'recapShow':
        return this.recapShow();
      case 'recapCue':
        // The board's show: the host page (it owns the speakers) plays the recap music and sounds.
        for (const h of this.socketsOf('host')) this.send(h, { t: 'recapCue', cue: msg.cue });
        return;
      case 'remote': {
        // The host page owns the player: it does what its own button does.
        const hosts = this.socketsOf('host');
        const result = (ok, reason, message) => this.send(ws, { t: 'remoteResult', action: msg.action, ok, ...(reason ? { reason, message } : {}) });
        if (!hosts.length) return result(false, 'nohost', NO_HOST_COMPUTER);
        const started = hosts.filter((h) => h.deserializeAttachment()?.player?.started);
        for (const h of started.length ? started : hosts) this.send(h, { t: 'remote', action: msg.action });
        if (!started.length && msg.action === 'playPause') return result(false, 'start', START_FIRST);
        return result(true);
      }
    }
  }

  /** 🚫 Veto the song playing (from the board): it stops, leaves the Top 5, and its student is told. */
  async vetoPlaying(ws, id) {
    const room = this.room;
    const item = room.nowPlaying;
    if (!item || item.id !== id) return this.send(ws, NO_ITEM);
    const { why, detail } = this.teacherReason(ws, {}, 'teacher');
    nextSong(room, { ended: 'banned' }); // out of the history (Top 5); it still counts as played this period
    this.sendRemoved(item, why);
    await this.addBlocked({ song: item.song, device: item.device, by: item.by, why, detail, source: 'teacher', action: 'veto' });
    await this.commit();
    return this.sendRepeats();
  }

  // ---- closing time ---------------------------------------------------------------------------

  async alarm() {
    this.alarmAt = 0;
    if (!this.room) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    if (now >= this.room.until) {
      await this.closeRoom('until');
    } else if (now >= this.room.lastActivity + IDLE_MS) {
      await this.closeRoom('idle 12 hours');
    } else if (cleanupDue(this.room, now)) {
      await this.startCleanup();
    } else {
      // GHOST VOTE: a song may have just got its ghost 👍; the order and the 👍 shown change.
      if (this.room.settings?.ghostVote === true && this.room.queue?.length) {
        sortQueue(this.room, now);
        await this.save();
        this.broadcast();
      }
      const due = this.dueAt();
      await this.ctx.storage.setAlarm(due);
      this.alarmAt = due;
    }
  }
}
