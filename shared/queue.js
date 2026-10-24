// Queue and voting rules. Plain functions on a plain room-state object (no I/O), so the Room
// Durable Object and the Node tests share them. Functions that change the room change `state` in
// place and return what happened; the Room saves and broadcasts afterwards.
//
// RoomState (what the Room stores):
//   { room, until, codeHash, open, locked, settings, createdAt, lastActivity, seq,
//     queue: StoredItem[], nowPlaying: StoredItem|null,
//     review: StoredItem[],                     songs the AI did not know, waiting for the teacher
//                                               (oldest first; never shown to students)
//     played: string[],                         song ids already played this session
//     playedKeys: string[],                     their song keys (shared/repeats.js: any version)
//     restPending: { [songKey]: { at, title, artist } }   plays not yet written to KV `recent`
//     students: { [device]: { nick, joinedAt } },
//     admitted: string[],                       devices that joined with the class code
//     kicked: string[],
//     aiStatus: 'ok'|'failing',
//     service: 'preview'|'spotify'|'youtube'|'apple'|null,    what the host page plays through
//                                               (its 'service' message); 'spotify' lets the room
//                                               search Spotify's catalog
//     rest: { [device]: { from, grace, until } },   📚 back to work (shared/backtowork.js)
//     downvotes: { [device]: number },          👎 used this room (protocol.js DOWNVOTE LIMIT)
//     upvotes: { [device]: number },            👍 used this room (protocol.js UPVOTE LIMIT)
//     credits: { [device]: number },           credit balances (protocol.js CREDITS); a device
//                                               with none yet has settings.startingCredits
//     cleanupAt: number|null, cleanup: boolean, cleanup time (protocol.js CLEANUP)
//     history: HistoryEntry[],                  songs that played (shared/highlights.js: Top 5, recap)
//     tally: { songs: { [device]: n }, votes: { [device]: n }, log: [{ genre, at }] } }
//                                               the recap's numbers (shared/stats.js; no song names)
// StoredItem: { id, song, device, by, addedAt, votes: { [device]: -1|1 },
//               teacher?: true,                 a teacher pick (protocol.js TEACHER PICKS): device is
//                                               TEACHER_DEVICE, by the teacher's name
//               paid?: number,                  credits its suggestion cost (refunds give these back)
//               jumped?: { by, device, at },    a student spent credits to move it to the front
//               pushed?: { at },                the teacher's ⏫ Play next (protocol.js TEACHER PUSH):
//                                               before everything else, the latest push first
//               ghost?: 1,                      the song playing had a ghost 👍 when it started
//                                               (protocol.js GHOST VOTE; waiting songs: worked
//                                               out from addedAt, never stored)
//               checked?: 'lyrics' }            review only: the AI read its lyrics and is still
//                                               not sure (host only; dropped when allowed)

import {
  CREDITS_MAX, CREDIT_GRANT_MAX, DEFAULT_SETTINGS, HISTORY_MAX, JUMP_COST, QUEUE_MAX, REVIEW_MAX, SUGGEST_COST,
  TEACHER_DEVICE, TEACHER_FALLBACK_NAME,
} from './protocol.js';
import { blocklistHit, mainArtist, mainArtistName } from './filter.js';
import { CLASSMATE, downvoteModeOf, endPlay, relabelHistory, startPlay, top5View, updatePlay } from './highlights.js';
import { nickKey } from './nick.js';
import { legacySong, songId } from './catalog.js';
import { songKey } from './repeats.js';
import { restView } from './backtowork.js';

const PLAYED_MAX = 1000;

/** A fresh room. */
export function newRoomState(room, settings = DEFAULT_SETTINGS, now = Date.now(), until = now + 24 * 60 * 60 * 1000) {
  return {
    room, // the room id (src/room.js); the class code is kept only as codeHash
    until, // when the room closes itself (class ends)
    cleanupAt: null, // when cleanup starts (protocol.js CLEANUP); null = no cleanup
    cleanup: false, // cleanup mode: suggestions closed, the host fades the music out
    codeHash: null,
    open: true,
    locked: false,
    settings: { ...settings, blocklist: [...settings.blocklist] },
    createdAt: now,
    lastActivity: now,
    seq: 0,
    queue: [],
    nowPlaying: null,
    review: [],
    played: [],
    playedKeys: [], // song keys of `played` (shared/repeats.js: other versions count as played)
    restPending: {}, // plays not yet in the teacher's KV `recent` (repeat cooldown)
    students: {},
    admitted: [],
    kicked: [],
    aiStatus: 'ok',
    service: null,
    credits: {},
    rest: {}, // 📚 back to work: { [device]: { from, grace, until } } (shared/backtowork.js)
    downvotes: {}, // 👎 used per device this room (protocol.js DOWNVOTE LIMIT)
    upvotes: {}, // 👍 used per device this room (protocol.js UPVOTE LIMIT)
    history: [], // songs that played this period (shared/highlights.js; Top 5, recap)
    profile: null, // the teacher profile { id, name, legacy } (protocol.js TEACHER PROFILES); null = from before profiles = legacy
    tally: { songs: {}, votes: {}, log: [] }, // songs suggested and votes cast per device, suggestion genres (recap)
    art: {}, // 🖼 cover verdicts this room knows: { [artKey]: { v, r, t? } } (protocol.js ALBUM ART; src/room.js)
  };
}

/**
 * A room saved before catalog ids: its songs get 'it:<trackId>' ids and `played` holds ids.
 * Changes `state` in place; returns it.
 */
export function migrateRoomState(state, { testAiOff = false } = {}) {
  if (!state) return state;
  state.review ??= []; // rooms saved before the review list
  for (const item of [state.nowPlaying, ...(state.queue ?? []), ...state.review]) {
    if (item?.song) item.song = legacySong(item.song);
  }
  state.played = (state.played ?? []).map((p) => songId(p)).filter(Boolean);
  state.service ??= null;
  state.credits ??= {}; // rooms saved before credits
  state.settings.startingCredits ??= null;
  state.settings.allowJump ??= false; // rooms saved before the Priority jump switch
  // Rooms saved before class time: Max song length as the default, the rest off.
  if (state.settings.maxSongMinutes === undefined) state.settings.maxSongMinutes = DEFAULT_SETTINGS.maxSongMinutes;
  state.settings.instrumentalsOnly ??= false;
  state.settings.cleanupMinutes ??= DEFAULT_SETTINGS.cleanupMinutes;
  state.settings.bellSchedule ??= [];
  state.cleanupAt ??= null;
  state.cleanup ??= false;
  // Rooms saved before Top 5 and the artist switches.
  state.history ??= [];
  state.tally ??= { songs: {}, votes: {}, log: [] };
  state.profile ??= null;
  state.settings.showFavorites ??= DEFAULT_SETTINGS.showFavorites;
  state.settings.noBackToBackArtist ??= false;
  state.settings.oneSongPerArtist ??= false;
  // Rooms saved before repeats: song keys from the history, the cooldown as the default.
  state.playedKeys ??= [...new Set((state.history ?? []).map((e) => songKey(e.song)).filter(Boolean))];
  state.restPending ??= {};
  if (state.settings.cooldownDays === undefined) state.settings.cooldownDays = DEFAULT_SETTINGS.cooldownDays;
  // Rooms saved before recap music and back to work: the defaults.
  for (const k of ['recapMusic', 'recapVolume', 'backToWork', 'backToWorkMinutes']) state.settings[k] ??= DEFAULT_SETTINGS[k];
  state.rest ??= {};
  // Rooms saved before the album art check (protocol.js ALBUM ART): the defaults, no verdicts yet.
  for (const k of ['artCheck', 'hideAllArt']) state.settings[k] ??= DEFAULT_SETTINGS[k];
  state.settings.blockNotMusic ??= true; // 🙉 (protocol.js blockNotMusic)
  state.art ??= {};
  // Rooms saved before the downvote limit (protocol.js DOWNVOTE LIMIT): the default, none used yet.
  if (state.settings.maxDownvotes === undefined) state.settings.maxDownvotes = DEFAULT_SETTINGS.maxDownvotes;
  state.downvotes ??= {};
  // Rooms saved before the 👍 limit (protocol.js UPVOTE LIMIT): 👍 on and unlimited, as before.
  state.settings.upvotes ??= true;
  if (state.settings.maxUpvotes === undefined) state.settings.maxUpvotes = null;
  state.settings.hideUpvoteCounts ??= false; // protocol.js UPVOTE COUNTS: shown, as before
  state.upvotes ??= {};
  // Rooms saved before the score floor (protocol.js SCORE FLOOR): off, as before. (The DEFAULT is
  // on now, but a room that was running keeps what it had.)
  state.settings.scoreFloor ??= false;
  // Rooms saved before the 👎 mode (protocol.js DOWNVOTE MODE): 'shown', as before (the default for
  // new rooms is 'off'; a running class does not change mid-period).
  state.settings.downvoteMode ??= 'shown';
  // Rooms saved before the ghost 👍 (protocol.js GHOST VOTE): off, the default minutes.
  state.settings.ghostVote ??= false;
  state.settings.ghostVoteMinutes ??= DEFAULT_SETTINGS.ghostVoteMinutes;
  // Rooms saved before hidden counts (protocol.js HIDDEN COUNTS): shown, as before.
  state.settings.hideVoteCounts ??= false;
  // The AI review is locked on (Dalton, 2026-10-16): a room saved with either switch off gets it back
  // (except under the local-only TEST_AI_OFF=on, shared/settings.js validateSettings).
  if (!testAiOff) {
    state.settings.aiCheck = true;
    state.settings.blockUnknownSongs = true;
  }
  return state;
}

/** True while the room's scores never go below 0 (protocol.js SCORE FLOOR). */
export function floorOn(state) {
  return state?.settings?.scoreFloor === true;
}

/** The room's 👎 mode (protocol.js DOWNVOTE MODE): 'off' | 'hidden' | 'shown'. */
export function downvoteMode(state) {
  return downvoteModeOf(state?.settings);
}

/** True while students and boards see no vote numbers (protocol.js HIDDEN COUNTS). */
export function countsHidden(state) {
  return state?.settings?.hideVoteCounts === true;
}

/** ms a song waits before its ghost 👍 (protocol.js GHOST VOTE), or null while the setting is off. */
export function ghostMs(state) {
  const s = state?.settings;
  if (s?.ghostVote !== true || !upvotesOn(state)) return null; // no ghost 👍 while 👍 is off (UPVOTE LIMIT)
  const min = Number.isInteger(s.ghostVoteMinutes) ? s.ghostVoteMinutes : DEFAULT_SETTINGS.ghostVoteMinutes;
  return min * 60_000;
}

/**
 * How votes count and show for one recipient (protocol.js SCORE FLOOR + DOWNVOTE MODE + GHOST VOTE):
 * floor: scores never below 0; downs: 👎 count at all (false while 'off'); hide: the recipient
 * sees no 👎 numbers (`down` 0, `score` = 👍): 'off' for everyone, 'hidden' for all but the host.
 * ghostMs / now: a waiting song that has waited ghostMs at `now` has a ghost 👍 (null = off).
 */
export function voteRules(state, isHost = true, now = Date.now()) {
  const mode = downvoteMode(state);
  return {
    floor: floorOn(state), downs: mode !== 'off', hide: mode === 'off' || (mode === 'hidden' && !isHost),
    counts: isHost || !countsHidden(state), // HIDDEN COUNTS: students and boards get no numbers at all
    upCounts: isHost || state?.settings?.hideUpvoteCounts !== true, // UPVOTE COUNTS: no 👍 numbers
    ghostMs: ghostMs(state), now,
  };
}

/** A WAITING song's ghost 👍 under `rules` (voteRules): 1 once it has waited ghostMs, else 0. */
export function ghostFor(item, rules) {
  if (!item || rules?.ghostMs == null || !Number.isFinite(item.addedAt)) return 0;
  return rules.now - item.addedAt >= rules.ghostMs ? 1 : 0;
}

/**
 * The next moment a waiting song gets its ghost 👍 (after `now`), or null (off, or none left).
 * The room's alarm rings then too (src/room.js dueAt), to re-sort and broadcast.
 */
export function nextGhostAt(state, now = Date.now()) {
  const ms = ghostMs(state);
  if (ms === null) return null;
  let next = null;
  for (const item of state.queue ?? []) {
    const at = item.addedAt + ms;
    if (Number.isFinite(at) && at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * An item's votes: { score, up, down }. `floor` (protocol.js SCORE FLOOR): the score is
 * max(0, 👍 − 👎); off = 👍 − 👎. `downs` false (protocol.js DOWNVOTE MODE 'off'): stored 👎 are
 * ignored (down 0, score = 👍). `ghost` (protocol.js GHOST VOTE, 0 or 1) counts as one more 👍.
 * Without a ghost, up and down are the real counts.
 */
export function itemScore(item, floor = false, downs = true, ghost = 0) {
  let up = ghost === 1 ? 1 : 0;
  let down = 0;
  for (const v of Object.values(item.votes)) {
    if (v > 0) up++;
    else if (v < 0 && downs) down++;
  }
  return { score: floor ? Math.max(0, up - down) : up - down, up, down };
}

/**
 * The play order: the teacher's pushed songs first (the latest push first), then jumped songs (the
 * earliest jump first), then highest score first; ties go to the song added first. With the score
 * floor on (protocol.js SCORE FLOOR) the score is the floored one, and ties go to fewer 👎, then
 * more 👍, then the song added first.
 */
function playOrder(items, rules = {}) {
  const { floor = false, downs = true } = rules;
  const scored = items.map((item) => [itemScore(item, floor, downs, ghostFor(item, rules)), item]);
  scored.sort(([va, a], [vb, b]) => {
    if (a.pushed || b.pushed) {
      if (!a.pushed) return 1;
      if (!b.pushed) return -1;
      if (a.pushed.at !== b.pushed.at) return b.pushed.at - a.pushed.at;
    }
    if (a.jumped || b.jumped) {
      if (!a.jumped) return 1;
      if (!b.jumped) return -1;
      if (a.jumped.at !== b.jumped.at) return a.jumped.at - b.jumped.at;
    }
    if (floor || !downs) return vb.score - va.score || va.down - vb.down || vb.up - va.up || a.addedAt - b.addedAt || a.id.localeCompare(b.id);
    return vb.score - va.score || a.addedAt - b.addedAt || a.id.localeCompare(b.id);
  });
  return scored.map(([, item]) => item);
}

/** Pushed songs first (latest first), then jumped songs, then highest score first; ties go to the song added first. */
export function sortQueue(state, now = Date.now()) {
  state.queue = playOrder(state.queue, voteRules(state, true, now));
  return state.queue;
}

/** Rooms saved before the review list existed have no `review`. */
export function reviewList(state) {
  state.review ??= [];
  return state.review;
}

/** Songs of one device waiting for the teacher's look. */
export function reviewFor(state, device) {
  return reviewList(state).filter((item) => item.device === device).length;
}

/** Songs one device has waiting: queued plus waiting for a look (both count toward the limit). */
export function waitingFor(state, device) {
  return state.queue.filter((item) => item.device === device).length + reviewFor(state, device);
}

/** A test for "this song, in any version": its id, or (with the song known) its song key. */
function matcher(id, song = null) {
  const key = song ? songKey(song) : null;
  return (item) => Boolean(item) && (item.song.id === id || (key !== null && songKey(item.song) === key));
}

/** True when the song (any version, when `song` is given) is on the review list. */
export function inReview(state, id, song = null) {
  return reviewList(state).some(matcher(id, song));
}

/** True when the song (any version, when `song` is given) is playing, queued or in Needs a look. */
export function isWaiting(state, id, song = null) {
  const same = matcher(id, song);
  return same(state.nowPlaying) || state.queue.some(same) || inReview(state, id, song);
}

/** True when the song (any version, when `song` is given) already played this period. */
export function hasPlayed(state, id, song = null) {
  if (state.played.includes(id)) return true;
  const key = song ? songKey(song) : null;
  return key !== null && (state.playedKeys ?? []).includes(key);
}

/** True for the teacher's pseudo device (protocol.js TEACHER PICKS): never a student. */
export const isTeacher = (device) => device === TEACHER_DEVICE;

/** The name on the teacher's picks: the room's teacher profile, else "Teacher". */
export function teacherName(state) {
  const name = state?.profile?.name;
  return typeof name === 'string' && name.trim() ? name : TEACHER_FALLBACK_NAME;
}

/**
 * Queue rules a suggestion must pass (cheap, checked before and after the filter). With `song`
 * (once the room has its details), other versions of it count too (shared/repeats.js songKey).
 * The teacher (TEACHER_DEVICE) is not held by cleanup, the lock or the per-student limit.
 * @returns {null | 'cleanup'|'locked'|'duplicate'|'played'|'limit'|'closed'}
 */
export function suggestRefusal(state, device, id, song = null) {
  const teacher = isTeacher(device);
  if (!state.open) return 'closed';
  if (state.cleanup && !teacher) return 'cleanup';
  if (state.locked && !teacher) return 'locked';
  if (isWaiting(state, id, song)) return 'duplicate';
  if (hasPlayed(state, id, song)) return 'played';
  if (!teacher && waitingFor(state, device) >= state.settings.maxWaitingPerStudent) return 'limit';
  return null;
}

/** A new stored item (a teacher pick is tagged teacher: true). */
function newItem(state, { device, nick, song, now }) {
  state.seq += 1;
  const item = { id: `s${state.seq}`, song, device, by: nick, addedAt: now, votes: {} };
  if (isTeacher(device)) item.teacher = true;
  return item;
}

/**
 * One song per artist (settings.oneSongPerArtist): the waiting item (queue or Needs a look) by the
 * same main artist as `song`, or null (also null while the switch is off).
 */
export function artistWaiting(state, song) {
  if (state.settings.oneSongPerArtist !== true) return null;
  const artist = mainArtist(song?.artist);
  if (!artist) return null;
  return [...state.queue, ...reviewList(state)].find((item) => item.song.id !== song.id && mainArtist(item.song.artist) === artist) ?? null;
}

/** The student's why for a same_artist refusal (protocol.js REASONS). */
export function sameArtistWhy(item) {
  return { id: 'same_artist', evidence: `A song by ${mainArtistName(item.song.artist) || item.song.artist} is already waiting.` };
}

export const QUEUE_MESSAGES = Object.freeze({
  closed: 'This room is closed.',
  locked: 'Your teacher has paused new suggestions.',
  cleanup: '🧹 Cleanup time! Suggestions are closed for today.',
  duplicate: 'That song is already in the queue.',
  played: 'That song already played today.',
  limit: 'You have the most songs waiting that you can. Wait for one to play first.',
  queueFull: 'The queue is full right now. Vote for songs already in it, and try again after a few play.',
  reviewFull: 'Your teacher has a lot of songs to check right now. Try a song everyone knows, or try again in a little while.',
  credits: `You need ${SUGGEST_COST} credit to suggest a song. Ask your teacher for more.`,
  same_artist: 'A song by that artist is already waiting. Pick a different artist, or wait until it plays.',
});

/** The duplicate message, worded for a song that is waiting for the teacher rather than queued. */
export function refusalMessage(state, reason, id, song = null) {
  if (reason === 'duplicate' && inReview(state, id, song)) return 'Someone already suggested that song. Your teacher is checking it.';
  return QUEUE_MESSAGES[reason];
}

/**
 * Add a song (already filtered) to the queue. `paid`: the credits it cost (kept on the item).
 * @returns {{ ok: true, item: object } | { ok: false, reason: string }}
 */
export function addSuggestion(state, { device, nick, song, now = Date.now(), paid = 0 }) {
  const reason = suggestRefusal(state, device, song.id, song);
  if (reason) return { ok: false, reason };
  if (artistWaiting(state, song)) return { ok: false, reason: 'same_artist' };
  if (state.queue.length >= QUEUE_MAX) return { ok: false, reason: 'queueFull' };
  const item = newItem(state, { device, nick, song, now });
  if (paid) item.paid = paid;
  state.queue.push(item);
  sortQueue(state);
  countSuggestion(state, device, song, now);
  return { ok: true, item };
}

/**
 * Put a song the AI did not know on the review list (the same rules as the queue, plus a cap).
 * `paid`: the credits it cost, held while the teacher decides (Remove gives them back).
 * `checked`: 'lyrics' when the AI read the song's lyrics and is still not sure (the teacher sees it).
 * @returns {{ ok: true, item: object } | { ok: false, reason: string }}
 */
export function addToReview(state, { device, nick, song, now = Date.now(), paid = 0, checked = null }) {
  const reason = suggestRefusal(state, device, song.id, song);
  if (reason) return { ok: false, reason };
  if (artistWaiting(state, song)) return { ok: false, reason: 'same_artist' };
  const review = reviewList(state);
  if (review.length >= REVIEW_MAX) return { ok: false, reason: 'reviewFull' };
  const item = newItem(state, { device, nick, song, now });
  if (paid) item.paid = paid;
  if (checked === 'lyrics' || checked === 'nolyrics') item.checked = checked;
  review.push(item);
  countSuggestion(state, device, song, now);
  return { ok: true, item };
}

/** Take one item off the review list. Returns it, or null. */
export function takeReview(state, id) {
  const review = reviewList(state);
  const index = review.findIndex((i) => i.id === id);
  if (index < 0) return null;
  return review.splice(index, 1)[0];
}

/**
 * The teacher says yes: the song joins the queue, credited to its student. It goes in even when
 * the student is now over the limit or the room is locked (the teacher decided). Its place in a
 * tie counts from now, so it does not jump ahead of songs added while it waited.
 * @returns {object|null} the queued item
 */
export function allowReview(state, id, now = Date.now()) {
  const item = takeReview(state, id);
  if (!item) return null;
  item.addedAt = now;
  item.votes = {};
  delete item.checked;
  state.queue.push(item);
  sortQueue(state);
  return item;
}

/**
 * After the blocklist changes: matching queued and review songs leave.
 * `out` (optional) gets `queue`: the queued items removed, and `words`: Map item → the blocked word.
 * @returns {object[]} the review items removed (their students are told)
 */
export function applyBlocklist(state, out = {}, { prune = true } = {}) {
  out.words = new Map();
  const hit = (item) => {
    const word = blocklistHit([item.song.title, item.song.artist, item.song.album], state.settings.blocklist);
    if (word) out.words.set(item, word);
    return Boolean(word);
  };
  out.queue = state.queue.filter(hit);
  state.queue = state.queue.filter((item) => !out.queue.includes(item));
  const removed = reviewList(state).filter(hit);
  state.review = state.review.filter((item) => !removed.includes(item));
  if (prune) pruneLowScores(state);
  sortQueue(state);
  return removed;
}

/**
 * "Allow anyway" (Blocked today): a song the filter turned down joins the queue for the student
 * who suggested it, like the teacher's Allow in Needs a look (over their limit, while locked).
 * Nothing is charged: its credit came back when the filter said no.
 * @returns {{ ok: true, item: object } | { ok: false, reason: 'gone'|'duplicate' }}
 *   gone: that student left the room (kicked); duplicate: the song is already waiting or playing
 */
export function allowBlocked(state, { song, device, by }, now = Date.now()) {
  const teacher = isTeacher(device); // the teacher's own pick: the teacher never leaves
  if (!teacher && (!Object.hasOwn(state.students, device) || state.kicked.includes(device))) return { ok: false, reason: 'gone' };
  if (isWaiting(state, song.id, song)) {
    return { ok: false, reason: 'duplicate' };
  }
  const item = newItem(state, { device, nick: teacher ? teacherName(state) : (state.students[device]?.nick ?? by), song, now });
  state.queue.push(item);
  sortQueue(state);
  countSuggestion(state, device, song, now);
  return { ok: true, item };
}

/**
 * The recap's numbers (shared/stats.js): songs suggested per device, and the genre of each
 * suggestion. A teacher pick counts in the genre log, never toward Top contributor.
 */
function countSuggestion(state, device, song, now) {
  const t = tallies(state);
  if (!isTeacher(device)) t.songs[device] = (t.songs[device] ?? 0) + 1;
  t.log.push({ genre: song.genre ?? '', at: now });
  if (t.log.length > HISTORY_MAX) t.log.splice(0, t.log.length - HISTORY_MAX);
}

/** RoomState.tally (rooms saved before it get an empty one). */
function tallies(state) {
  state.tally ??= { songs: {}, votes: {}, log: [] };
  return state.tally;
}

/**
 * Remove queued songs at or below the remove score. Returns the removed items. Never a song the
 * teacher pushed (⏫ Play next: the teacher decided). Never anything while the score floor is on
 * (protocol.js SCORE FLOOR: only the teacher removes songs) or while 👎 is off (DOWNVOTE MODE: no
 * score goes below 0).
 */
export function pruneLowScores(state, now = Date.now()) {
  if (floorOn(state) || downvoteMode(state) === 'off') return [];
  const rules = voteRules(state, true, now); // GHOST VOTE: the ghost 👍 counts here too
  const removed = state.queue.filter((item) => !item.pushed && itemScore(item, false, true, ghostFor(item, rules)).score <= state.settings.removeAtScore);
  if (removed.length) state.queue = state.queue.filter((item) => !removed.includes(item));
  return removed;
}

export const VOTE_MESSAGES = Object.freeze({
  no_item: 'That song is not in the queue any more.',
  bad_vote: 'That vote did not work.',
  playing_down: 'You can only give a 👍 to the song playing now.',
  downvotes: "You've used your 👎 for this class. You can still 👍 songs you like.",
  downvotes_off: '👎 is turned off in this class.',
  upvotes: "You've used your 👍 for this class.",
  upvotes_off: '👍 is turned off in this class.',
  vote_final: 'Votes are final. You already voted on this song.',
});

/** The room's 👎 limit per student (protocol.js DOWNVOTE LIMIT), or null = unlimited. */
export function downvoteLimit(state) {
  const n = state.settings?.maxDownvotes;
  return Number.isInteger(n) ? n : null;
}

/** 👎 a device has used this room (the teacher: never counted). */
export function downvotesUsed(state, device) {
  return state.downvotes?.[device] ?? 0;
}

/** 👎 a device may still cast, or null when unlimited (or for the teacher, or while 👎 is off). */
export function downvotesLeft(state, device) {
  const limit = downvoteLimit(state);
  if (limit === null || isTeacher(device) || downvoteMode(state) === 'off') return null;
  return Math.max(0, limit - downvotesUsed(state, device));
}

/** True while students (and the teacher) may cast a new 👍 (protocol.js UPVOTE LIMIT). */
export function upvotesOn(state) {
  return state?.settings?.upvotes !== false;
}

/** The room's 👍 limit per student (protocol.js UPVOTE LIMIT), or null = unlimited. */
export function upvoteLimit(state) {
  const n = state.settings?.maxUpvotes;
  return Number.isInteger(n) ? n : null;
}

/** 👍 a device has used this room (the teacher: never counted). */
export function upvotesUsed(state, device) {
  return state.upvotes?.[device] ?? 0;
}

/** 👍 a device may still cast, or null when unlimited (or for the teacher, or while 👍 is off). */
export function upvotesLeft(state, device) {
  const limit = upvoteLimit(state);
  if (limit === null || isTeacher(device) || !upvotesOn(state)) return null;
  return Math.max(0, limit - upvotesUsed(state, device));
}

/**
 * One vote per device per song, queued or playing now. v = 0 takes the vote back. The song playing
 * takes 👍 (and a take-back) but no new 👎 ('playing_down'); its votes from the queue stay. Its
 * history entry follows its votes (Top 5, recap), and the remove score never touches it.
 * 👎 limit (protocol.js DOWNVOTE LIMIT): a new 👎 on a waiting song uses one of the student's
 * settings.maxDownvotes ('downvotes' when none are left); taking it back or switching to 👍 while the
 * song still waits frees it; once the song left the queue it stays spent. The teacher is unlimited.
 * 👎 off (protocol.js DOWNVOTE MODE): a new 👎 is refused for everyone ('downvotes_off'); 👎 already
 * cast stay stored (ignored while off) and may still be taken back or switched to 👍.
 * 👍 (protocol.js UPVOTE LIMIT): a new 👍 is refused while 👍 is off ('upvotes_off'), or once a student
 * has used settings.maxUpvotes ('upvotes'); each one is spent for good (votes are final).
 * @returns {{ ok: true, removed: boolean } | { ok: false, error: 'bad_vote'|'no_item'|'playing_down'|'downvotes'|'downvotes_off'|'upvotes'|'upvotes_off' }}
 */
export function vote(state, device, id, v) {
  if (v !== -1 && v !== 0 && v !== 1) return { ok: false, error: 'bad_vote' };
  const playing = state.nowPlaying?.id === id ? state.nowPlaying : null;
  const item = playing ?? state.queue.find((i) => i.id === id);
  if (!item) return { ok: false, error: 'no_item' };
  const before = item.votes[device] ?? 0;
  // VOTES ARE FINAL (Dalton, 2026-10-16): a student cannot take back or switch a vote. A 👎 kept from
  // before 👎 was turned off reads as no vote, so it can still become a 👍.
  const cast = before === -1 && downvoteMode(state) === 'off' ? 0 : before;
  if (!isTeacher(device) && cast !== 0 && v !== cast) return { ok: false, error: 'vote_final' };
  if (v === -1 && before !== -1 && downvoteMode(state) === 'off') return { ok: false, error: 'downvotes_off' };
  if (playing && v === -1) return { ok: false, error: 'playing_down' };
  if (v === 1 && before !== 1) {
    if (!upvotesOn(state)) return { ok: false, error: 'upvotes_off' };
    if (!isTeacher(device)) {
      const left = upvotesLeft(state, device);
      if (left !== null && left <= 0) return { ok: false, error: 'upvotes' };
      state.upvotes ??= {};
      state.upvotes[device] = upvotesUsed(state, device) + 1; // spent for good (votes are final)
    }
  }
  const counted = !isTeacher(device) && !playing; // 👎 on the song playing: spent, never freed
  if (v === -1 && before !== -1 && !isTeacher(device)) {
    const left = downvotesLeft(state, device);
    if (left !== null && left <= 0) return { ok: false, error: 'downvotes' };
  }
  if (counted && (v === -1) !== (before === -1)) {
    state.downvotes ??= {};
    const used = Math.max(0, downvotesUsed(state, device) + (v === -1 ? 1 : -1));
    if (used) state.downvotes[device] = used;
    else delete state.downvotes[device];
  }
  // Votes cast (the recap's Top voter): a new vote counts, taking one back un-counts it. The
  // teacher's vote is one vote on the song, never a Top voter count.
  const had = Object.hasOwn(item.votes, device);
  const counts = tallies(state).votes;
  if (!isTeacher(device)) {
    if (!had && v !== 0) counts[device] = (counts[device] ?? 0) + 1;
    if (had && v === 0) counts[device] = Math.max(0, (counts[device] ?? 1) - 1);
  }
  if (v === 0) delete item.votes[device];
  else item.votes[device] = v;
  if (playing) {
    updatePlay(state, playing.id, itemScore(playing));
    return { ok: true, removed: false };
  }
  const removed = pruneLowScores(state).includes(item);
  sortQueue(state);
  return { ok: true, removed };
}

/**
 * Which song in `order` (play order) plays next: the first, or with noBackToBackArtist on, the first
 * whose main artist is not the one of the song playing (or, with nothing playing, the last one that
 * played). Every waiting song by that artist: the first anyway. A song the teacher pushed plays
 * next whatever its artist (the teacher decided). -1 for an empty queue.
 */
export function pickNext(state, order = playOrder(state.queue, voteRules(state))) {
  if (!order.length) return -1;
  // NEXT LOCK: the song locked in near the end of the one playing, unless the teacher pushed one since.
  const lock = nextLockOf(state);
  if (lock && !(order[0].pushed && order[0].pushed.at > lock.at)) {
    const i = order.findIndex((item) => item.id === lock.next);
    if (i >= 0) return i;
  }
  if (state.settings.noBackToBackArtist !== true || order[0].pushed) return 0;
  const last = mainArtist((state.nowPlaying ?? state.history?.at(-1))?.song?.artist);
  if (!last) return 0;
  const i = order.findIndex((item) => mainArtist(item.song.artist) !== last);
  return i < 0 ? 0 : i;
}

/** The room's NEXT LOCK while it belongs to the song playing and its song still waits, else null. */
export function nextLockOf(state) {
  const lock = state?.nextLock;
  if (!lock || !state.nowPlaying || lock.playing !== state.nowPlaying.id) return null;
  return state.queue?.some((item) => item.id === lock.next) ? lock : null;
}

/**
 * NEXT LOCK (protocol.js): the host page says the song `playingId` is in its last NEXT_LOCK_S
 * seconds, so the song that would play next now is locked in. Once per song. Returns true when
 * something was locked.
 */
export function lockNext(state, playingId, now = Date.now()) {
  if (!state.nowPlaying || state.nowPlaying.id !== playingId || state.nextLock?.playing === playingId) return false;
  sortQueue(state, now);
  const index = pickNext(state, state.queue);
  if (index < 0) return false;
  state.nextLock = { playing: playingId, next: state.queue[index].id, at: now };
  return true;
}

/**
 * The next song becomes the now-playing song (null when the queue is empty). `ended`: how the song
 * playing until now ended ('finished' | 'skipped' | 'failed' | 'banned'), for the history (Top 5).
 */
export function nextSong(state, { ended = 'finished', now = Date.now() } = {}) {
  sortQueue(state, now);
  const index = pickNext(state, state.queue);
  delete state.nextLock;
  if (state.nowPlaying) {
    updatePlay(state, state.nowPlaying.id, itemScore(state.nowPlaying)); // its final votes
    endPlay(state, state.nowPlaying.id, ended);
  }
  const item = index < 0 ? null : state.queue.splice(index, 1)[0];
  state.nowPlaying = item;
  if (item) {
    delete item.pushed; // ⏫ Play next is for waiting songs
    // GHOST VOTE: the ghost 👍 it had while waiting stays with it (the song playing, Top 5, recap).
    if (ghostFor(item, voteRules(state, true, now))) item.ghost = 1;
    else delete item.ghost;
    state.played.push(item.song.id);
    if (state.played.length > PLAYED_MAX) state.played.splice(0, state.played.length - PLAYED_MAX);
    const key = songKey(item.song);
    state.playedKeys ??= [];
    if (key && !state.playedKeys.includes(key)) state.playedKeys.push(key);
    if (state.playedKeys.length > PLAYED_MAX) state.playedKeys.splice(0, state.playedKeys.length - PLAYED_MAX);
    startPlay(state, item, itemScore(item), now);
  }
  return item;
}

/**
 * True when a host's next/skip still fits: `from` is the item it is moving on from (null = nothing
 * was playing). A late or doubled message (two clicks on Skip, a duplicated host tab) is ignored
 * instead of skipping a second song. `from` left out (an older page): always.
 */
export function nextIsFor(state, from) {
  if (from === undefined) return true;
  return (from === null || typeof from === 'string') && (state.nowPlaying?.id ?? null) === from;
}

/**
 * True when another device that is in the room right now (`online`) has this nickname (ignoring
 * case, spaces, accents and look-alike letters: shared/nick.js nickKey). Only online ones: a room
 * lasts the day, and a later class may have its own Jake.
 */
export function nickTaken(state, device, nick, online = new Set(Object.keys(state.students))) {
  const key = nickKey(nick);
  if (!key) return false;
  return Object.entries(state.students).some(([d, s]) => d !== device && online.has(d) && nickKey(s.nick) === key);
}

/** A song banned while it played is not "already played" (any version): a new try hears it is banned. */
export function unplay(state, song) {
  const key = songKey(song);
  state.played = state.played.filter((t) => t !== song.id);
  state.playedKeys = (state.playedKeys ?? []).filter((k) => k !== key);
}

/** Remove one queued song. Returns the removed item or null. */
export function veto(state, id) {
  const index = state.queue.findIndex((i) => i.id === id);
  if (index < 0) return null;
  return state.queue.splice(index, 1)[0];
}

/** A kicked device loses its waiting songs (queued and in review) and its votes, and cannot rejoin. */
export function kickDevice(state, device) {
  if (!state.kicked.includes(device)) state.kicked.push(device);
  // Its ADMITTED_MAX slot frees up; `kicked` is checked first everywhere, so it never gets back in.
  if (Array.isArray(state.admitted)) state.admitted = state.admitted.filter((d) => d !== device);
  delete state.students[device];
  state.queue = state.queue.filter((item) => item.device !== device);
  state.review = reviewList(state).filter((item) => item.device !== device);
  for (const item of state.queue) delete item.votes[device];
  delete state.credits?.[device];
  delete state.rest?.[device];
  delete state.downvotes?.[device];
  delete state.upvotes?.[device];
  relabelHistory(state, device, CLASSMATE, { forget: true }); // never on the Top 5 board by name
  delete tallies(state).songs[device];
  delete state.tally.votes[device];
  pruneLowScores(state);
  sortQueue(state);
}

/**
 * One item as `device` sees it; the host (null) sees the teacher's own vote, and teacher picks as its own.
 * `rules` (voteRules): the floored score while the floor is on; with `hide` (DOWNVOTE MODE) no 👎
 * numbers: down 0, score = 👍. While 👎 is off a stored 👎 reads as no vote (myVote 0).
 */
function itemView(item, device, rules = { floor: false, downs: true, hide: false }, ghost = 0) {
  if (!item) return null;
  const { score, up, down } = itemScore(item, rules.floor, rules.downs, ghost);
  const who = device === null ? TEACHER_DEVICE : device;
  const myVote = item.votes[who] ?? 0;
  return {
    id: item.id,
    song: item.song,
    score: rules.counts === false || rules.upCounts === false ? 0 : rules.hide ? up : score,
    up: rules.counts === false || rules.upCounts === false ? 0 : up,
    down: rules.counts === false || rules.hide ? 0 : down,
    by: item.by,
    mine: item.device === who,
    myVote: myVote === -1 && !rules.downs ? 0 : myVote,
    addedAt: item.addedAt,
    jumped: item.jumped ? { by: item.jumped.by, at: item.jumped.at } : null,
    pushed: item.pushed ? { at: item.pushed.at } : null,
    ...(item.teacher === true ? { teacher: true } : {}),
    // GHOST VOTE: only the host may learn a 👍 is a ghost; everyone else just sees the 👍.
    ...(ghost === 1 && device === null ? { ghost: 1 } : {}),
  };
}

/**
 * The State one recipient sees (protocol.js). `device` null = the host.
 * Students get the settings without the blocklist (no need to show them the blocked words).
 * The host also gets `students`, `aiStatus` and the `review` list; a student gets only a count of
 * their own songs waiting for a look (`you.review`, also counted in `you.waiting`).
 * @param {object} state RoomState
 * @param {string|null} device
 * @param {{ online?: Set<string>, boards?: number }} [extra] boards: boards connected (host only)
 */
export function snapshotFor(state, device, { online = new Set(), boards = 0, now = Date.now() } = {}) {
  const isHost = device === null;
  const rules = voteRules(state, isHost, now); // protocol.js SCORE FLOOR + DOWNVOTE MODE + GHOST VOTE
  const queue = playOrder(state.queue, rules);
  const next = pickNext(state, queue);
  if (next > 0) queue.unshift(...queue.splice(next, 1)); // noBackToBackArtist: the song that plays next first
  // GHOST VOTE is invisible to students: not even the setting reaches them.
  const { blocklist, bellSchedule, ghostVote, ghostVoteMinutes, ...publicSettings } = state.settings;
  const snap = {
    room: state.room,
    until: state.until,
    cleanupAt: state.cleanupAt ?? null,
    cleanup: state.cleanup === true,
    // BELL OFFSET (protocol.js): until/cleanupAt are the real moments; pages show them minus this.
    bellOffsetSeconds: Number.isInteger(state.settings?.bellOffsetSeconds) ? state.settings.bellOffsetSeconds : 0,
    serverNow: now, // SERVER CLOCK: pages correct their own clock with it
    downvoteMode: downvoteMode(state), // 👎 off / counts hidden / shown (protocol.js DOWNVOTE MODE)
    upvotes: upvotesOn(state), // 👍 on or off (protocol.js UPVOTE LIMIT)
    upvoteCounts: rules.upCounts, // false: draw no 👍 numbers (protocol.js UPVOTE COUNTS)
    voteCounts: rules.counts, // false: draw no 👍/👎 numbers (protocol.js HIDDEN COUNTS)
    nextLocked: nextLockOf(state) !== null, // 🔒 the song up next is locked in (protocol.js NEXT LOCK)
    teacher: typeof state.profile?.name === 'string' ? state.profile.name : null, // "Ms Rivera's class"
    open: state.open,
    locked: state.locked,
    nowPlaying: itemView(state.nowPlaying, device, rules, state.nowPlaying?.ghost === 1 ? 1 : 0),
    queue: queue.map((item) => itemView(item, device, rules, ghostFor(item, rules))),
    settings: isHost ? { ...state.settings, blocklist: [...blocklist], bellSchedule: [...(bellSchedule ?? [])] } : publicSettings,
    top5: top5View(state.history, rules),
    you: isHost ? null : {
      nick: state.students[device]?.nick ?? '', waiting: waitingFor(state, device), review: reviewFor(state, device),
      credits: creditsOf(state, device),
      downvotesLeft: downvotesLeft(state, device), // 👎 limit (protocol.js DOWNVOTE LIMIT); null = unlimited
      upvotesLeft: upvotesLeft(state, device), // 👍 limit (protocol.js UPVOTE LIMIT); null = unlimited or off
      ...restView(state, device, now), // 📚 back to work (shared/backtowork.js)
    },
  };
  if (isHost) {
    snap.students = Object.entries(state.students)
      .map(([d, s]) => ({ device: d, nick: s.nick, online: online.has(d), credits: creditsOf(state, d), downvotes: downvotesUsed(state, d), upvotes: upvotesUsed(state, d), ...restOfStudent(state, d, now) }))
      .sort((a, b) => a.nick.localeCompare(b.nick));
    snap.aiStatus = state.aiStatus ?? 'ok';
    snap.profile = state.profile?.id ?? null;
    snap.review = reviewList(state).map((item) => ({ ...itemView(item, null, rules), ...(item.checked ? { checked: item.checked } : {}) }));
    snap.boards = boards; // boards connected (protocol.js BOARD + REMOTE)
    snap.teacherName = teacherName(state); // the name on the teacher's own picks (TEACHER PICKS)
  }
  return snap;
}

/** A student row's rest for the host (📚 back to work): when it ends, and ms left now. */
function restOfStudent(state, device, now) {
  const { restUntil, restLeft } = restView(state, device, now);
  return { restUntil, restLeft };
}

/**
 * The State a board sees (protocol.js BOARD + REMOTE): what students see (no settings, no `you`,
 * no votes of its own), plus the Needs a look COUNT (never the songs) and the host page's status.
 * @param {object} state RoomState
 * @param {{ host?: { online: boolean, code: string|null, display: object|null, player: object|null } }} [o]
 */
export function boardSnapshot(state, { host = null } = {}) {
  // '' matches no device (device ids are 16+ letters): mine false, myVote 0 on every item.
  const { you, settings, ...snap } = snapshotFor(state, '');
  return { ...snap, reviewCount: reviewList(state).length, host: host ?? { online: false, code: null, display: null, player: null } };
}

// ---- Credits (protocol.js CREDITS) ----------------------------------------------------------------

/** True while the room uses credits (startingCredits is a number; null = Unlimited = off). */
export function creditsOn(state) {
  return Number.isInteger(state.settings.startingCredits);
}

/** True while students may jump a song: credits on and the Priority jump switch on. */
export function jumpOn(state) {
  return creditsOn(state) && state.settings.allowJump === true;
}

/** A device's balance, or null while credits are off. A device with none yet has the starting amount. */
export function creditsOf(state, device) {
  if (!creditsOn(state)) return null;
  return state.credits?.[device] ?? state.settings.startingCredits;
}

function setBalance(state, device, n) {
  state.credits ??= {};
  state.credits[device] = Math.max(0, Math.min(CREDITS_MAX, n));
  return state.credits[device];
}

const isStudent = (state, device) => typeof device === 'string' && Object.hasOwn(state.students, device);
const whole = (n, [lo, hi]) => Number.isInteger(n) && n >= lo && n <= hi;

/**
 * Take `cost` credits from a device. Free while credits are off.
 * @returns {number|null} what was taken (0 when credits are off), or null when it has too few
 */
export function spendCredits(state, device, cost) {
  if (!creditsOn(state)) return 0;
  const have = creditsOf(state, device);
  if (have < cost) return null;
  setBalance(state, device, have - cost);
  return cost;
}

/**
 * Give back `paid` credits (a filter "no", Remove in Needs a look). Not to a device that left
 * (kicked). Returns the new balance, or null when nothing came back.
 */
export function refundCredits(state, device, paid) {
  if (!paid || !isStudent(state, device)) return null;
  return setBalance(state, device, (state.credits?.[device] ?? state.settings.startingCredits ?? 0) + paid);
}

/** Refund what one stored item's suggestion cost (once). Returns the balance or null. */
export function refundItem(state, item) {
  const paid = item?.paid ?? 0;
  if (!paid) return null;
  item.paid = 0;
  return refundCredits(state, item.device, paid);
}

/**
 * Before new settings replace the old ones: students already in the room keep the balance they
 * have now, so a new "Starting credits" applies to students who join later. (When credits were
 * off, they have none yet and start with the new amount.)
 */
export function settleCredits(state) {
  if (!creditsOn(state)) return;
  state.credits ??= {};
  for (const device of Object.keys(state.students)) state.credits[device] ??= state.settings.startingCredits;
}

/**
 * The teacher's 'credits' message: { device, amount } | { all: true, amount } | { device, set }.
 * @returns {{ ok: true, why: 'grant'|'set', changed: { device: string, amount: number, credits: number }[] }
 *   | { ok: false, message: string }}
 */
export function teacherCredits(state, msg) {
  if (!creditsOn(state)) return { ok: false, message: 'Credits are off. Set Starting credits in Settings first.' };
  if (msg.set !== undefined) {
    if (!isStudent(state, msg.device)) return { ok: false, message: 'No such student.' };
    if (!whole(msg.set, [0, CREDITS_MAX])) return { ok: false, message: `Set credits to a whole number from 0 to ${CREDITS_MAX}.` };
    const before = creditsOf(state, msg.device);
    const credits = setBalance(state, msg.device, msg.set);
    return { ok: true, why: 'set', changed: [{ device: msg.device, amount: credits - before, credits }] };
  }
  if (!whole(msg.amount, [1, CREDIT_GRANT_MAX])) return { ok: false, message: `Give 1 to ${CREDIT_GRANT_MAX} credits at a time.` };
  let devices;
  if (msg.all === true) devices = Object.keys(state.students);
  else if (isStudent(state, msg.device)) devices = [msg.device];
  else return { ok: false, message: 'No such student.' };
  const changed = devices.map((device) => {
    const before = creditsOf(state, device);
    const credits = setBalance(state, device, before + msg.amount);
    return { device, amount: credits - before, credits };
  });
  return { ok: true, why: 'grant', changed };
}

/**
 * A coupon's credits (shared/coupon.js COUPONS) for one student: only while credits are on. Never
 * above CREDITS_MAX. → the new balance, or null (credits off, or not a student here).
 */
export function couponCredits(state, device, amount) {
  if (!creditsOn(state) || !isStudent(state, device) || !Number.isInteger(amount) || amount < 1) return null;
  return setBalance(state, device, creditsOf(state, device) + amount);
}

export const JUMP_MESSAGES = Object.freeze({
  credits: `You need ${JUMP_COST} credits to jump a song. Ask your teacher for more.`,
  off: 'Your teacher turned off jumping.',
  jumped: 'Someone already jumped that song. It plays soon!',
  playing: 'That song is playing now.',
  no_item: 'That song is not in the queue any more.',
  rate: 'That is a lot of jumping. Wait a minute and try again.',
});

/**
 * Spend JUMP_COST credits to move a waiting song to the front: it plays after the songs jumped
 * before it, and before every song that was not jumped. Any waiting song, once; never the one
 * playing or one in Needs a look; only while jumpOn (credits and Priority jump on). Nothing is
 * spent when it is refused.
 * @returns {{ ok: true, item: object } | { ok: false, reason: 'off'|'playing'|'no_item'|'jumped'|'credits' }}
 */
export function jumpSong(state, { device, nick, id, now = Date.now() }) {
  if (!jumpOn(state)) return { ok: false, reason: 'off' };
  if (state.nowPlaying?.id === id) return { ok: false, reason: 'playing' };
  const item = state.queue.find((i) => i.id === id);
  if (!item) return { ok: false, reason: 'no_item' };
  if (item.jumped) return { ok: false, reason: 'jumped' };
  if (spendCredits(state, device, JUMP_COST) === null) return { ok: false, reason: 'credits' };
  // Strictly after every earlier jump, even in the same millisecond.
  const last = Math.max(0, ...state.queue.map((i) => i.jumped?.at ?? 0));
  item.jumped = { by: nick, device, at: Math.max(now, last + 1) };
  sortQueue(state);
  return { ok: true, item };
}

// ---- The teacher's ⏫ Play next and ▶ Play now (protocol.js TEACHER PUSH) ------------------------

export const PUSH_MESSAGES = Object.freeze({
  playing: 'That song is playing now.',
  review: 'That song is in Needs a look. Allow it first.',
  no_item: 'That song is not in the queue any more.',
});

/** Why the teacher cannot push (or play now) this item, or null. */
function pushRefusal(state, id) {
  if (state.nowPlaying?.id === id) return 'playing';
  if (reviewList(state).some((i) => i.id === id)) return 'review';
  if (!state.queue.some((i) => i.id === id)) return 'no_item';
  return null;
}

/** Mark one waiting item pushed, strictly after every earlier push (even in the same millisecond). */
function markPushed(state, item, now) {
  const last = Math.max(0, ...state.queue.map((i) => i.pushed?.at ?? 0));
  item.pushed = { at: Math.max(now, last + 1) };
}

/**
 * ⏫ Play next (on: true) or ⏬ Undo (on: false) on a waiting song. Free, with credits on or off. A
 * pushed song plays before every other waiting song (jumped ones too); the latest push first. Undo
 * puts it back in its own place (its student jump, if it had one, else its votes). Never the song
 * playing or a Needs a look item. Pushing a pushed song again moves it to the top of the pushes.
 * @returns {{ ok: true, item: object } | { ok: false, reason: 'playing'|'review'|'no_item' }}
 */
export function pushSong(state, { id, on, now = Date.now() }) {
  const reason = pushRefusal(state, id);
  if (reason) return { ok: false, reason };
  const item = state.queue.find((i) => i.id === id);
  if (on) markPushed(state, item, now);
  else delete item.pushed;
  sortQueue(state);
  return { ok: true, item };
}

/**
 * ▶ Play now: the song playing ends as a Skip ('skipped') and this waiting song plays at once
 * (pushed to the front, so noBackToBackArtist cannot pass it over). With nothing playing it just
 * starts. Refused like pushSong. `done`: the item that was playing (null: nothing was).
 * @returns {{ ok: true, item: object, done: object|null } | { ok: false, reason: 'playing'|'review'|'no_item' }}
 */
export function playNowSong(state, { id, now = Date.now() }) {
  const reason = pushRefusal(state, id);
  if (reason) return { ok: false, reason };
  const item = state.queue.find((i) => i.id === id);
  markPushed(state, item, now);
  const done = state.nowPlaying;
  nextSong(state, { ended: 'skipped', now });
  return { ok: true, item, done };
}
