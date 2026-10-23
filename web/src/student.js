// The student page: look for songs before joining (no room needed), join with today's class code
// and a nickname, search songs, suggest them, and vote on the queue. The server decides everything
// (filter, limits, order); this page only shows the state snapshots it sends (shared/protocol.js)
// and sends the student's clicks. After joining, the page keeps the room id (not the code), so a
// refresh rejoins even if the teacher changed the code since.

import './style.css';
import './student.css';
import './build-stamp.js';
import './student-highlights.css';
import { initThemeButton } from './theme.js';
import { $, announce, artHtml, esc, keepFocus, spotifyIcon, spotifyMark, toast } from './dom.js';
import { connectRoom, roomExists, roomSocketUrl } from './room-socket.js';
import { noteServerTime } from './server-clock.js';
import { showBell } from './bell-pill.js';
import { generateNick, isGeneratedNick } from '../../shared/nickgen.js';
import { AI_CATEGORIES, DEVICE_ID_PATTERN, FILTER_REASONS, NICK_MAX, QUERY_MAX, ROOM_ID_PATTERN, PUSH_TAG, byLabel, whyText } from '../../shared/protocol.js';
import { JUMP_COST, SUGGEST_COST } from '../../shared/protocol.js';
import { couponFromHash } from '../../shared/coupon.js';
import { tooLong } from '../../shared/classtime.js';
import { mainArtist, mainArtistName } from '../../shared/filter.js';
import { restingEvidence, restingUntilLabel, songKey } from '../../shared/repeats.js';
import { displayCode, normalizeCode } from '../../shared/code.js';
import { clockLeft } from '../../shared/backtowork.js';
import { cleanQuery, isCleanItunesVersion, itunesSearchUrl, parseItunes, toSong } from '../../shared/itunes.js';

const SEARCH_DELAY_MS = 350;
// Reasons that are not filter reasons (protocol.js 'suggested'); the server's message wins.
const OTHER_REASONS = {
  limit: 'You already have songs waiting. Wait until one plays, then suggest another.',
  reviewFull: 'Your teacher has a lot of songs to check right now. Try a song everyone knows, or try again in a little while.',
  locked: 'Your teacher has paused new suggestions for now.',
  duplicate: 'That song is already in the queue. Give it a 👍 instead!',
  played: 'That song already played in this room.',
  rate: 'That is a lot of suggestions. Wait a minute, then try again.',
  unavailable: 'We could not find that song right now. Try again in a moment.',
  queueFull: 'The queue is full right now. Vote for songs already in it, and try again after a few play.',
  credits: `You need ${SUGGEST_COST} credit to suggest a song. Ask your teacher for more.`,
  too_long: 'That song is longer than your teacher allows right now. Pick a shorter one.',
  cleanup: '🧹 Cleanup time! Suggestions are closed for today.',
  same_artist: 'A song by that artist is already waiting. Pick a different artist, or wait until it plays.',
  resting: 'That song played not long ago, so it is resting. Pick a different song.',
  back_to_work: '📚 Back to work! You can suggest again soon.',
};
const JUMP_NEED = `You need ${JUMP_COST} credits to jump a song. Ask your teacher for more.`;
const DOWN_SPENT = "You've used your 👎 for this class. You can still 👍 songs you like."; // protocol.js DOWNVOTE LIMIT
const UP_SPENT = "You've used your 👍 for this class."; // protocol.js UPVOTE LIMIT
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** A full stop at the end, unless it already ends a sentence. */
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
// Clean edits (Dalton, 2026-10-08): "Clean" read like "allowed", then the song check said no. A clean
// edit only bleeps the swear words; the song is still about the same thing.
const CLEAN_TIP = 'Swear words bleeped out. RoomDJ still checks what the song is about.';
const cleanTag = () => `<span class="tag" title="${CLEAN_TIP}" aria-label="Clean edit: ${CLEAN_TIP}">Clean edit</span>`;
const CLEAN_NO = 'Even the clean edit is not allowed: clean edits only bleep out swear words, and the song is still about the same thing.';
const AI_WHY = new Set(AI_CATEGORIES);
/** A song this page showed (search results, favorites), or null. */
const shownSong = (id) => results.find((x) => x.id === id) ?? favorites.find((f) => f.song.id === id)?.song ?? null;
/** For a clean edit the AI turned down (what it is about), the line that says why clean was not enough. */
const cleanNo = (id, why) => (why && AI_WHY.has(why.id) && shownSong(id)?.explicit === 'cleaned' ? `${CLEAN_NO} ` : '');
// A refusal that will not change today: the result shows this instead of a Suggest button.
const REFUSED_LABEL = {
  explicit: 'Not allowed', blocklist: 'Not allowed', banned: 'Not allowed', theme: 'Not allowed', played: 'Played already',
};
// A refusal that is "wait", not "no": the toast is amber, not red.
const WAIT_REASONS = new Set(['limit', 'locked', 'duplicate', 'rate', 'reviewFull', 'unavailable', 'queueFull', 'credits', 'cleanup', 'too_long', 'same_artist', 'resting', 'back_to_work']);
// Max song length (shared/classtime.js): the result says so before anyone tries (the server checks too).
const TOO_LONG = '⏱ Too long';
const longWhy = (song) => {
  const long = tooLong(song, state?.settings);
  return long ? whyText({ id: 'too_long', evidence: long.evidence }) : '';
};
// One song per artist: a result by an artist already in the queue says so (the server checks
// Needs a look too).
const ARTIST_WAITING = '🎨 Artist waiting';
const artistWhy = (song) => {
  if (state?.settings?.oneSongPerArtist !== true) return '';
  const artist = mainArtist(song.artist);
  const hit = artist && state.queue.find((q) => q.song.id !== song.id && mainArtist(q.song.artist) === artist);
  return hit ? whyText({ id: 'same_artist', evidence: `A song by ${mainArtistName(hit.song.artist) || hit.song.artist} is already waiting.` }) : '';
};
// 😴 Repeat cooldown (protocol.js REPEATS): the room sends the songs resting now by song key, with
// when each played and may come back; this page words it in its own time zone.
const RESTING = '😴 Resting';
const restingOf = (song) => {
  const r = resting.get(songKey(song));
  return r && Date.now() < r[1] ? r : null;
};
const restingWhy = (song) => {
  const r = restingOf(song);
  return r ? whyText({ id: 'resting', evidence: restingEvidence(r[0], r[1]) }) : '';
};
/** The reason a result says now (Too long, Artist waiting, Resting), for its Why? button; '' for none. */
const liveWhy = (song, label) => (label === TOO_LONG ? longWhy(song) : label === ARTIST_WAITING ? artistWhy(song)
  : label.startsWith(RESTING) ? restingWhy(song) : '');

initThemeButton($('#theme'));

const TOASTS_MAX = 3;
/** Show a toast and say it once to screen readers (#toasts itself is not a live region). */
function tell(text, kind = '', ms = 6000) {
  const box = $('#toasts');
  while (box.children.length >= TOASTS_MAX) box.firstElementChild.remove();
  toast(text, kind, ms);
  announce(text);
}

// ---- Device id: random, kept on this device so a refresh keeps the same votes ----
let memoryDevice = null;
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}
function deviceId() {
  try {
    let id = localStorage.getItem('cq.device');
    if (!id || !DEVICE_ID_PATTERN.test(id)) {
      id = newId();
      localStorage.setItem('cq.device', id);
    }
    return id;
  } catch {
    memoryDevice ??= newId(); // site data blocked: works until the page reloads
    return memoryDevice;
  }
}
const store = {
  get(area, key) { try { return JSON.parse(window[area].getItem(key)); } catch { return null; } },
  set(area, key, v) { try { window[area].setItem(key, JSON.stringify(v)); } catch { /* blocked */ } },
  del(area, key) { try { window[area].removeItem(key); } catch { /* blocked */ } },
};

// ---- Page state ----
let conn = null;
let room = null; // { id, nick }
let state = null; // last State snapshot
let joined = false; // got a state since this join
let results = [];
const pending = new Set(); // song ids sent, waiting for 'suggested'
let lastNowId; // undefined until the first snapshot after joining
let lastNowArt = ''; // the cover state drawn for the song playing (🖼 ALBUM ART)
let myIds = new Map(); // my queued item ids → title, to tell the student when one leaves
const checking = new Set(); // my song ids waiting for the teacher's look ('suggested' reason 'review')
const jumping = new Set(); // queue item ids sent in a 'jump', waiting for 'jumped'
// Songs this page knows cannot be suggested, so a result says why instead of offering a button
// that only gets a "no": songs seen playing (a room never plays a song twice) and refusals.
const played = new Set();
let playedKeys = new Set(); // song keys played this period (any version: 'repeats')
let resting = new Map(); // song key → [at, until] (the repeat cooldown: 'repeats')
const refused = new Map(); // song id → short label
const refusedWhy = new Map(); // song id → why it was turned down ("Why?" on its result)
let resultsKey = []; // what each result row shows now, to update only the rows that change
let favorites = []; // ⭐ Class favorites from the room ('favorites': { song, pinned, top5 })
let favKey = []; // like resultsKey, for the favorites list
let favMode = false; // the ⭐ Class favorites view instead of search
let lockTimer = null; // the wrong-code lockout countdown
// The teacher's Rename: { id, code } of the room this device is still admitted to, so the next
// Join goes straight back in with the new nickname (no class code needed; it may have changed).
let rejoin = null;

// ---- Screens ----
function show(screen) {
  for (const id of ['joinScreen', 'roomScreen', 'endScreen']) $(`#${id}`).hidden = id !== screen;
  const inRoom = screen === 'roomScreen';
  $('#roomPill').hidden = !inRoom;
  $('#leave').hidden = !inRoom;
  document.body.classList.toggle('in-room', inRoom);
}

/** The join screen; `field` is where the cursor goes ('code', 'nick' or 'join'), else a good guess. */
function showJoin(message = '', field = null) {
  show('joinScreen');
  $('#joinMsg').textContent = message;
  if (!lockTimer) {
    $('#joinBtn').disabled = false;
    $('#joinBtn').textContent = 'Join';
  }
  field ??= message || !$('#code').value ? 'code' : !$('#nick').value.trim() ? 'nick' : 'join';
  const el = { code: $('#code'), nick: typedNicks ? $('#nick') : $('#nickRoll'), join: $('#joinBtn') }[field];
  if (el.disabled) return $('#code').focus();
  el.focus();
  if (message && el.select) el.select(); // a wrong code or nickname: typing replaces it
}

/** The end screen. `again` = { label, room } offers to come back into the same room (tabs). */
let endAgain = null;
function showEnd(title, text, again = null) {
  rejoin = null;
  stopRoom();
  store.del('sessionStorage', 'cq.join');
  endAgain = again;
  $('#toasts').replaceChildren(); // old news
  $('#endTitle').textContent = title;
  $('#endText').textContent = text;
  $('#endBtn').textContent = again?.label ?? 'Join another room';
  show('endScreen');
  $('#endBtn').focus();
}

function stopRoom() {
  conn?.stop();
  conn = null;
  joined = false;
  state = null;
  cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  results = [];
  resultsKey = [];
  favorites = [];
  favKey = [];
  setFavMode(false);
  $('#favResults').innerHTML = '';
  $('#top5Card').hidden = true;
  top5Key = '';
  pending.clear();
  checking.clear();
  jumping.clear();
  played.clear();
  playedKeys = new Set();
  resting = new Map();
  refused.clear();
  refusedWhy.clear();
  myIds = new Map();
  lastNowId = undefined;
  voteUndo.clear();
  showBell(null);
  setRest(null);
  $('#queue').innerHTML = ''; // the next room may have credits on or off
  $('#q').value = '';
  $('#results').innerHTML = '';
  $('#searchMsg').textContent = '';
  setNet(null);
}

// ---- Join ----
const params = new URLSearchParams(location.search);
$('#code').value = params.get('code') ? displayCode(params.get('code')) : '';
$('#nick').value = store.get('localStorage', 'cq.nick') ?? '';
$('#nick').maxLength = NICK_MAX;

// Made nicknames (shared/nickgen.js): the page picks "Adjective Noun", 🎲 picks another, nothing is
// typed; the server takes only these. GET /api/config `typedNicknames` (local tests only) brings
// back the typed box.
let typedNicks = false;
function setNick(nick) {
  $('#nick').value = nick;
  $('#nickShown').textContent = nick;
}
setNick(isGeneratedNick($('#nick').value) ? $('#nick').value : generateNick());
$('#nickRoll').addEventListener('click', () => setNick(generateNick()));
// ---- 🎟 Coupons (shared/coupon.js COUPONS): a coupon from another class tool, spent for credits ----
// A link like roomdj.com/#coupon=RDJ1... keeps the coupon for this tab (out of the address bar at
// once) and uses it after the student joins a room that takes coupons. Or "Have a coupon?": paste it.
let couponsServer = false; // GET /api/config `coupons`
let couponSent = null; // the coupon waiting for its couponResult
const linkCoupon = couponFromHash(location.hash);
if (linkCoupon) {
  store.set('sessionStorage', 'cq.coupon', linkCoupon);
  history.replaceState(history.state, '', location.pathname + location.search);
  tell('🎟️ Coupon saved. Join your class and it is used for you.', 'ok', 8000);
}
const couponsHere = (s) => couponsServer && s?.settings?.coupons !== false && (s?.you?.credits ?? null) !== null;
function useCoupon(code) {
  if (!conn?.send({ t: 'coupon', code })) return tell('Reconnecting. Try again in a moment.', 'warn');
  couponSent = code;
  $('#couponUse').disabled = true;
}
/** After each state: show "Have a coupon?", and use a coupon from a link once the room takes it. */
function renderCoupons(s) {
  const here = couponsHere(s);
  $('#couponOpen').hidden = !here;
  if (!here) $('#couponForm').hidden = true;
  const kept = store.get('sessionStorage', 'cq.coupon');
  if (here && kept && !couponSent) useCoupon(kept);
}
function couponResult(msg) {
  const code = couponSent;
  couponSent = null;
  $('#couponUse').disabled = false;
  const fromLink = code && code === store.get('sessionStorage', 'cq.coupon');
  // Used, expired or not a coupon: forget it. Off, busy or offline: a link's coupon waits for later.
  if (msg.ok || ['used', 'expired', 'bad'].includes(msg.reason)) {
    if (fromLink) store.del('sessionStorage', 'cq.coupon');
  }
  if (msg.ok) {
    $('#couponCode').value = '';
    $('#couponForm').hidden = true;
    $('#couponOpen').setAttribute('aria-expanded', 'false');
    return tell(`🎟️ Coupon used: +${plural(msg.amount, 'credit')}. You have ${plural(msg.credits, 'credit')}.`, 'ok', 7000);
  }
  tell(msg.message || 'That coupon did not work.', msg.reason === 'bad' || msg.reason === 'used' || msg.reason === 'expired' ? 'bad' : 'warn', 7000);
}
$('#couponOpen').addEventListener('click', () => {
  const open = $('#couponForm').hidden;
  $('#couponForm').hidden = !open;
  $('#couponOpen').setAttribute('aria-expanded', String(open));
  if (open) $('#couponCode').focus();
});
$('#couponForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#couponCode').value.trim();
  if (!code) return $('#couponCode').focus();
  useCoupon(code);
});

fetch('/api/config').then((r) => r.json()).then((c) => {
  couponsServer = c?.coupons === true;
  if (state) renderCoupons(state);
  if (!c?.typedNicknames) return;
  typedNicks = true;
  $('#nickGen').hidden = true;
  $('#nickField').hidden = false;
  $('#nick').value = store.get('localStorage', 'cq.nick') ?? '';
  joinNote();
  if (!$('#joinScreen').hidden && !$('#joinBtn').disabled && $('#code').value && !$('#nick').value) $('#nick').focus();
}).catch(() => { /* offline: made nicknames */ });

/** Came from the join link (Google Classroom): only the nickname is left. */
function joinNote() {
  if (!$('#code').value) return;
  $('#joinNote').textContent = !typedNicks
    ? 'The class code is filled in. Check your nickname and tap Join.'
    : $('#nick').value
      ? 'The class code is filled in. Check your nickname and tap Join.'
      : 'The class code is filled in. Pick a nickname and tap Join.';
}
$('#q').maxLength = QUERY_MAX;
$('#bq').maxLength = QUERY_MAX;
joinNote();

const CLOSED_TEXT = {
  until: 'The room closed for today. Thanks for listening!',
  teacher: 'Your teacher closed the room. Thanks for listening!',
};

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (lockTimer) return;
  const code = normalizeCode($('#code').value);
  const nick = $('#nick').value.trim().replace(/\s+/g, ' ');
  const back = rejoin && (!code || code === rejoin.code) ? rejoin.id : null;
  if (!code && !back) return showJoin('Type the class code from the board.');
  if (!nick) {
    $('#joinMsg').textContent = 'Pick a nickname so the class knows who suggested what.';
    return $('#nick').focus();
  }
  if (nick.length > NICK_MAX) {
    $('#joinMsg').textContent = `Nicknames can be up to ${NICK_MAX} letters.`;
    return $('#nick').focus();
  }
  $('#joinMsg').textContent = '';
  $('#joinBtn').disabled = true;
  $('#joinBtn').textContent = 'Joining…';
  if (back) return join(back, nick);
  rejoin = null;
  let r, data;
  try {
    r = await fetch('/api/join', {
      method: 'POST',
      headers: { 'x-device': deviceId(), 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    data = await r.json().catch(() => ({}));
  } catch {
    return showJoin('Could not reach RoomDJ. Check your internet and try again.', 'join');
  }
  if (r.status === 429 && data.error === 'locked' && data.retryAfter > 0) return lockFor(data.retryAfter);
  // Wrong code, kicked, busy: the server's sentence says what to do.
  if (!r.ok || !ROOM_ID_PATTERN.test(data.room ?? '')) return showJoin(data.message || 'Could not join. Try again.');
  join(data.room, nick);
});

// Too many wrong codes: count down on the page, so nobody taps Join into the same answer.
function lockFor(seconds) {
  clearInterval(lockTimer);
  const end = Date.now() + seconds * 1000;
  const btn = $('#joinBtn');
  const tick = () => {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(lockTimer);
      lockTimer = null;
      btn.disabled = false;
      btn.textContent = 'Join';
      $('#joinMsg').textContent = 'You can try again now. Check the code on the board.';
      return;
    }
    btn.disabled = true;
    btn.textContent = `Wait ${left}…`;
    $('#joinMsg').textContent = `Too many wrong tries. Wait ${left} ${left === 1 ? 'second' : 'seconds'} and try again.`;
  };
  lockTimer = setInterval(tick, 1000);
  tick();
  show('joinScreen');
  $('#code').focus();
  $('#code').select();
}

function join(id, nick) {
  stopRoom();
  room = { id, nick };
  store.set('sessionStorage', 'cq.join', room);
  $('#roomPillText').textContent = 'Joining…';
  conn = connectRoom(roomSocketUrl(id, { role: 'student', device: deviceId(), nick }), { onMessage, onStatus });
}

async function onStatus(status, fails) {
  const pill = $('#roomPill');
  if (status === 'open') {
    pill.classList.remove('off');
    pending.clear(); // an answer lost with the old socket never comes
    jumping.clear();
    renderResults();
    $('#roomPillText').textContent = `In class as ${room.nick}`;
    setNet(null);
    return;
  }
  // Normally the server's last message (closed / kicked / error) got here first and stopped us.
  if (status === 'ended') {
    if (fails === 4000) return showEnd('The room is closed', CLOSED_TEXT.teacher);
    if (fails === 4001) return showEnd('You are out of this room', 'Your teacher removed you from this room, so you cannot join it again.');
    stopRoom();
    store.del('sessionStorage', 'cq.join');
    return showJoin('Could not join that room. Check the class code and try again.');
  }
  pill.classList.add('off');
  $('#roomPillText').textContent = 'Reconnecting…';
  if (joined) setNet(navigator.onLine === false ? 'offline' : fails >= 4 ? 'stuck' : 'lost');
  const mine = conn;
  if (!joined) {
    // Never got in: the room is gone, or the server turned the join down (e.g. the nickname).
    const exists = await roomExists(room.id);
    if (conn !== mine) return;
    if (exists === false) {
      stopRoom();
      store.del('sessionStorage', 'cq.join');
      return showJoin('That room is closed now. Ask your teacher for today\'s class code.');
    }
    if (exists === true && fails >= 2) {
      stopRoom();
      store.del('sessionStorage', 'cq.join');
      return showJoin('Could not join that room. Try a different nickname. If it keeps happening, tell your teacher.', 'nick');
    }
  } else if (fails >= 3 && (await roomExists(room.id)) === false && conn === mine) {
    showEnd('The room is closed', 'This room has ended. Thanks for listening!');
  }
}

function onMessage(msg) {
  switch (msg.t) {
    case 'state':
      noteServerTime(msg.state); // SERVER CLOCK (protocol.js): on arrival, not when drawn
      if (!joined) {
        joined = true;
        rejoin = null;
        store.set('localStorage', 'cq.nick', room.nick); // remembered for next time, once accepted
        show('roomScreen');
        $('#q').focus();
        render(msg.state);
      } else {
        scheduleRender(msg.state);
      }
      break;
    case 'suggested':
      pending.clear();
      if (msg.ok) {
        tell(`"${msg.title}" joined the queue. Ask your friends to vote for it!`, 'ok');
      } else if (msg.reason === 'back_to_work') {
        restRefused(msg);
      } else if (msg.reason === 'review') {
        // Not a refusal: the teacher decides, and a 'reviewed' message follows.
        checking.add(msg.song);
        tell(msg.why ? `${sentence(whyText(msg.why))} It joins the queue if they say yes.` : msg.message || FILTER_REASONS.review, '', 7000);
      } else if (msg.reason === 'resting' && Number.isFinite(msg.until)) {
        // The page words the cooldown in its own time zone (the server sends ms).
        const song = shownSong(msg.song);
        const key = song ? songKey(song) : null;
        if (key) resting.set(key, [msg.at, msg.until]);
        tell(sentence(whyText({ id: 'resting', evidence: restingEvidence(msg.at, msg.until) })), 'warn', 8000);
      } else {
        if (REFUSED_LABEL[msg.reason]) refused.set(msg.song, REFUSED_LABEL[msg.reason]);
        const clean = msg.reason === 'theme' ? cleanNo(msg.song, msg.why) : '';
        if (msg.why) refusedWhy.set(msg.song, `${clean}${whyText(msg.why)}`);
        const text = msg.why ? `${clean || 'That song is not allowed. '}${sentence(whyText(msg.why))}`
          : msg.message || FILTER_REASONS[msg.reason] || OTHER_REASONS[msg.reason] || 'That song could not be added.';
        tell(`${text}${msg.refunded ? ' Your credit came back.' : ''}`, WAIT_REASONS.has(msg.reason) ? 'warn' : 'bad', 7000);
      }
      renderResults();
      break;
    case 'reviewed': {
      checking.delete(msg.song);
      if (msg.allowed) {
        refused.delete(msg.song);
        refusedWhy.delete(msg.song);
      } else {
        refused.set(msg.song, 'Not this time');
        if (msg.why) refusedWhy.set(msg.song, `${cleanNo(msg.song, msg.why)}${whyText(msg.why)}`);
      }
      const because = msg.why ? ` ${msg.allowed ? '' : cleanNo(msg.song, msg.why)}${sentence(whyText(msg.why))}` : '';
      const text = msg.allowed
        ? `🎉 Your teacher said yes to "${msg.title}". It joined the queue!`
        : `Your teacher said no to "${msg.title}" this time.${because} Try a different song!${msg.refunded ? ' Your credit came back.' : ''}`;
      tell(text, msg.allowed ? 'ok' : 'warn', 9000);
      renderResults();
      break;
    }
    case 'removed':
      // The teacher took one of my songs out (veto, ban, or a new blocked word): say why, once
      // (not also "left the queue" from the next snapshot).
      myIds.delete(msg.id);
      tell(`Your teacher took "${msg.title}" out of the queue. ${sentence(whyText(msg.why))}`, 'warn', 9000);
      break;
    case 'jumped':
      jumping.delete(msg.id);
      if (msg.reason === 'back_to_work') restRefused(msg);
      else if (msg.ok) tell(`⚡ "${msg.title}" plays next!`, 'ok');
      else tell(msg.message || 'That jump did not work.', msg.reason === 'credits' || msg.reason === 'rate' ? 'warn' : 'bad', 7000);
      if (state) renderQueue(state.queue);
      break;
    case 'repeats':
      playedKeys = new Set(Array.isArray(msg.played) ? msg.played : []);
      resting = new Map((Array.isArray(msg.resting) ? msg.resting : []).filter((r) => Array.isArray(r) && r.length === 3).map(([k, at, until]) => [k, [at, until]]));
      renderResults();
      break;
    case 'favorites':
      favorites = Array.isArray(msg.list) ? msg.list.filter((f) => f?.song?.id) : [];
      if (state) renderFind(state);
      renderResults();
      break;
    case 'couponResult':
      couponResult(msg);
      break;
    case 'credits':
      tell(msg.why === 'set'
        ? `Your teacher set your credits to ${msg.credits}.`
        : `🎟 Your teacher gave you ${plural(msg.amount, 'credit')}!`, 'ok', 7000);
      break;
    case 'error':
      if (!joined || msg.error === 'nick') {
        // In the room and 'nick': the teacher asked for a different nickname (this device is still
        // admitted). A refused nickname keeps the way back in; anything else drops it.
        if (joined) rejoin = { id: room.id, code: normalizeCode($('#code').value) };
        if (msg.error !== 'nick') rejoin = null;
        if (joined) store.del('localStorage', 'cq.nick');
        stopRoom();
        store.del('sessionStorage', 'cq.join');
        // Made nicknames: a refused one is replaced right away; the student just taps Join.
        if (msg.error === 'nick' && !typedNicks) setNick(generateNick());
        const again = msg.error === 'nick' && !typedNicks ? ' Here is a new one: tap Join.' : '';
        showJoin(`${msg.message || 'Could not join that room.'}${again}`, msg.error === 'nick' ? (typedNicks ? 'nick' : 'join') : null);
      } else if (msg.error === 'tabs') {
        // A newer tab on this device took over; this one can take it back.
        showEnd('RoomDJ is open in another tab', 'This tab stopped because RoomDJ is open in another tab on this device.',
          { label: 'Use this tab instead', room });
      } else if (['back_to_work', 'downvotes', 'downvotes_off', 'upvotes', 'upvotes_off', 'vote_final'].includes(msg.error)) {
        // A vote while resting, a 👎 over the limit (this page thought it had one left) or a 👎 while the
        // teacher has 👎 off (protocol.js DOWNVOTE MODE; the snapshot may not have arrived yet): undo it on the page.
        const undo = voteUndo.get(msg.id);
        const item = state?.nowPlaying?.id === msg.id ? state.nowPlaying : state?.queue.find((q) => q.id === msg.id);
        if (undo && item) Object.assign(item, undo);
        voteUndo.delete(msg.id);
        if (msg.error === 'downvotes' && state?.you) state.you.downvotesLeft = 0;
        if (msg.error === 'upvotes' && state?.you) state.you.upvotesLeft = 0;
        if (state) renderQueue(state.queue);
        if (state?.nowPlaying) renderNowVote(state.nowPlaying);
        if (msg.error === 'downvotes') tell(msg.message || DOWN_SPENT, 'warn', 7000);
        else if (msg.error === 'downvotes_off') tell(msg.message || '👎 is turned off in this class.', 'warn', 7000);
        else if (msg.error === 'upvotes') tell(msg.message || UP_SPENT, 'warn', 7000);
        else if (msg.error === 'upvotes_off') tell(msg.message || '👍 is turned off in this class.', 'warn', 7000);
        else if (msg.error === 'vote_final') tell(msg.message || VOTE_FINAL, 'warn', 5000);
        else restRefused(msg);
      } else {
        pending.clear();
        renderResults();
        tell(msg.message || 'Something went wrong. Try again.', 'bad');
      }
      break;
    case 'kicked':
      showEnd('You are out of this room', 'Your teacher removed you from this room, so you cannot join it again.');
      break;
    case 'closed':
      showEnd('The room is closed', CLOSED_TEXT[msg.why] ?? CLOSED_TEXT.teacher);
      break;
  }
}

$('#leave').addEventListener('click', () => {
  rejoin = null;
  stopRoom();
  store.del('sessionStorage', 'cq.join');
  showJoin();
});
$('#endBtn').addEventListener('click', () => {
  if (!endAgain) return showJoin();
  const { id, nick } = endAgain.room;
  endAgain = null;
  show('joinScreen');
  $('#joinBtn').disabled = true;
  $('#joinBtn').textContent = 'Joining…';
  join(id, nick);
});

// ---- Connection banner: fixed under the title bar, so nothing below it moves ----
const NET_TEXT = {
  lost: 'Lost the connection. Getting back in…',
  offline: 'You are offline. Check the Wi-Fi. RoomDJ gets back in by itself.',
  stuck: 'Still not back in. Try reloading this page.', // after about 15 s of failed tries
};
function setNet(kind) {
  const b = $('#netBanner');
  b.hidden = !kind;
  if (kind && b.textContent !== NET_TEXT[kind]) b.textContent = NET_TEXT[kind];
}
addEventListener('offline', () => { if (joined) setNet('offline'); });
addEventListener('online', () => { if (conn?.isOpen) setNet(null); });

// ---- Rendering ----
/** blur: a list to pick from (search results, favorites): a cover not checked yet shows blurred. */
function songHtml(song, size = 100, blur = false) {
  return `${artHtml(song, size, { blur, lazy: true })}
    <span class="song-text" title="${esc(`${song.title} · ${song.artist}`)}"><span class="song-title">${esc(song.title)}</span><span class="song-artist">${esc(song.artist)}</span></span>${spotifyMark(song)}`;
}

// A burst of votes is a burst of snapshots: draw at most one per frame, the newest.
let renderFrame = 0;
function scheduleRender(s) {
  state = s;
  renderFrame ||= requestAnimationFrame(() => {
    renderFrame = 0;
    if (state) render(state);
  });
}

function render(s) {
  state = s;
  voteUndo.clear(); // the server's counts
  setRest(s.you);
  showBell(s); // 🔔 the bell countdown (bell-pill.js)
  // "Ms Rivera's class": the room's own teacher (null for a room opened before teacher profiles).
  const classOf = s.teacher ? `${s.teacher}'s class` : '';
  $('#classOf').textContent = classOf;
  $('#classOf').hidden = !classOf;
  $('#roomTitle').textContent = classOf ? `${classOf}: music` : "Your class's music";
  const now = s.nowPlaying;
  if (now) played.add(now.song.id);
  const card = $('#nowPlaying').closest('.now');
  card.classList.toggle('playing', Boolean(now));
  // 🖼 Only the cover's state changed (its check finished later, ALBUM ART): redraw just the cover.
  const nowArt = now ? `${now.song.art}|${now.song.artwork}` : '';
  if (now && now.id === lastNowId && nowArt !== lastNowArt) {
    const el = $('#nowPlaying .now-song > .art');
    if (el) el.outerHTML = artHtml(now.song, 300, { lazy: true });
  }
  lastNowArt = nowArt;
  if ((now?.id ?? null) !== lastNowId) {
    const first = lastNowId === undefined; // just joined: no party for a song already playing
    lastNowId = now?.id ?? null;
    $('#nowPlaying').innerHTML = now
      ? `<div class="song now-song">${songHtml(now.song, 300)}</div>
         <div class="now-meta"><p class="song-by">${now.mine ? '🎉 You suggested this one!' : `Suggested by ${esc(byLabel(now))}`}</p>
         <button type="button" id="nowUp" class="vote up" aria-pressed="false"><span aria-hidden="true">👍</span> <span class="n"></span></button></div>`
      : '<p class="note">Nothing is playing yet. Suggest a song and vote. Your teacher starts the music.</p>';
    card.classList.toggle('mine', Boolean(now?.mine));
    if (now?.mine && !first) {
      tell(`🎉 Your song is playing! "${now.song.title}"`, 'party', 7000);
      card.classList.remove('cheer');
      void card.offsetWidth; // restart the animation
      card.classList.add('cheer');
    } else if (now) {
      announce(`Now playing: ${now.song.title} by ${now.song.artist}.`);
    }
  }
  if (now) renderNowVote(now);

  // Tell the student when one of their songs leaves the queue without playing.
  const ids = new Map(s.queue.filter((q) => q.mine).map((q) => [q.id, q.song.title]));
  for (const [id, title] of myIds) {
    if (!ids.has(id) && now?.id !== id) tell(`Your song "${title}" left the queue.`, 'warn');
  }
  myIds = ids;

  $('#lockedNote').hidden = !s.locked || s.cleanup === true;
  $('#cleanupNote').hidden = s.cleanup !== true;
  $('#instrumentalNote').hidden = s.settings?.instrumentalsOnly !== true || s.cleanup === true;
  const max = s.settings?.maxWaitingPerStudent;
  const waiting = s.you?.waiting ?? 0;
  const inReview = s.you?.review ?? 0;
  if (!inReview) checking.clear(); // missed a 'reviewed' while offline
  const full = Boolean(max) && waiting >= max;
  $('#waiting').textContent = max
    ? `Your songs waiting: ${waiting} of ${max}${inReview ? ` (${inReview} waiting for your teacher to check)` : ''}.${full && !s.locked ? ' When one plays, you can suggest another.' : ''}`
    : '';
  $('#waiting').classList.toggle('full', full);
  // Credits (null = off): the pill shows only while the teacher has them on.
  const credits = s.you?.credits ?? null;
  $('#credits').hidden = credits === null;
  if (credits !== null) $('#creditsN').textContent = plural(credits, 'credit');
  $('#credits').classList.toggle('empty', credits === 0);
  $('#creditsJump').hidden = s.settings?.allowJump !== true; // Priority jump off: no Jump at all
  renderCoupons(s);

  $('#queueCount').textContent = s.queue.length ? `(${s.queue.length})` : '';
  $('#queueEmpty').hidden = s.queue.length > 0;
  renderQueue(s.queue);
  renderTop5(s.top5 ?? []);
  renderFind(s);
  renderResults();
}

// ---- 🏆 Top 5 so far (protocol.js TOP 5 + RECAP): a small card once a song has played ----
let top5Key = '';
function renderTop5(top5) {
  // 👎 counts are shown only while the teacher has them 'shown' (protocol.js DOWNVOTE MODE): else 👍 alone.
  const net = downMode() === 'shown';
  const key = JSON.stringify([net, top5.map((t) => [t.id, t.score, t.by])]);
  if (key === top5Key) return;
  top5Key = key;
  $('#top5Card').hidden = top5.length === 0;
  $('#top5').innerHTML = top5.map((t, i) => `<li class="top5-row${i === 0 ? ' crown' : ''}">
      <span class="top5-rank" aria-label="${i === 0 ? 'Number 1' : `Number ${i + 1}`}">${i === 0 ? '👑' : i + 1}</span>
      <span class="song-text"><span class="song-title">${esc(t.song.title)}</span><span class="song-artist">${esc(t.song.artist)} · by ${esc(byLabel(t))}</span></span>
      ${net ? `<b class="top5-net" title="👍 ${t.up}, 👎 ${t.down}">${t.score > 0 ? '+' : ''}${t.score}</b>`
    : `<b class="top5-net" title="👍 ${t.up}">👍 ${t.up}</b>`}
    </li>`).join('');
}

// ---- ⭐ Class favorites (protocol.js FAVORITES): a second way to find a song, next to search ----
function setFavMode(on) {
  favMode = on;
  $('#findSearch').setAttribute('aria-pressed', String(!on));
  $('#findFav').setAttribute('aria-pressed', String(on));
  for (const sel of ['#searchForm', '#searchMsg', '#results']) $(sel).hidden = on;
  if (on) $('#searchCredit').hidden = true;
  $('#favPane').hidden = !on;
}
function renderFind(s) {
  const on = s.settings?.showFavorites !== false;
  $('#findBy').hidden = !on;
  if (!on && favMode) setFavMode(false);
  $('#favEmpty').hidden = favorites.length > 0;
}
$('#findSearch').addEventListener('click', () => {
  setFavMode(false);
  $('#q').focus();
});
$('#findFav').addEventListener('click', () => {
  setFavMode(true);
  renderResults();
  announce(favorites.length ? `Class favorites: ${plural(favorites.length, 'song')}.` : 'No class favorites yet.');
});

const votesLabel = (label, n) => `${label}, ${n} ${n === 1 ? 'vote' : 'votes'}`;

/** The room's 👎 mode (protocol.js DOWNVOTE MODE): 'off' (no 👎 buttons), 'hidden' (👎, no counts), 'shown'. */
const downMode = () => (['off', 'hidden', 'shown'].includes(state?.downvoteMode) ? state.downvoteMode : 'shown');

/** False while the teacher has 👍 off (protocol.js UPVOTE LIMIT): no 👍 buttons. */
const upOn = () => state?.upvotes !== false;

/** False while the teacher hides vote numbers (protocol.js HIDDEN COUNTS): buttons with no counts. */
const countsOn = () => state?.voteCounts !== false;

/** False while 👍 numbers are hidden (protocol.js HIDDEN COUNTS or UPVOTE COUNTS): 👍 buttons with no count. */
const upCountsOn = () => countsOn() && state?.upvoteCounts !== false;
const VOTE_FINAL = 'Votes are final. You already voted on this song.';

/** The hint over the queue: what the votes do in this mode. Votes are final (protocol.js VOTES ARE FINAL). */
function renderVoteHint(mode) {
  const up = upOn();
  const text = (!up && mode === 'off' ? 'Songs play in the order they were suggested.'
    : !up ? '👎 the songs you do not want: they play later.'
      : mode === 'off' ? '👍 the songs you want. Most 👍 plays next, and every song gets its turn.'
        : '👍 the songs you want, 👎 the ones you do not. Most votes plays next.')
    + (up || mode !== 'off' ? ' Votes are final.' : '') + (state?.nextLocked ? ' 🔒 The next song is locked in.' : '');
  const el = $('#voteHint');
  if (el.textContent !== text) el.textContent = text;
}

function queueItemHtml(item) {
  const vote = (act, v, emoji, label, n) => `<button type="button" class="vote ${act}" data-act="${act}"
      aria-pressed="${item.myVote === v}" aria-label="${votesLabel(label, n)}">
      <span aria-hidden="true">${emoji}</span> <span class="n">${n}</span></button>`;
  return `<span class="rank" aria-hidden="true"></span>
    <div class="song">${songHtml(item.song)}</div>
    <span class="qby"><span class="ptag" hidden></span>${item.mine ? '⭐ Your song' : `by ${esc(byLabel(item))}`}<span class="jtag" hidden></span></span>
    <span class="votes">${vote('up', 1, '👍', 'Thumbs up', item.up)}${vote('down', -1, '👎', 'Thumbs down', item.down)}<button type="button" class="jump" data-act="jump" hidden></button></span>`;
}

/**
 * My balance while I may jump songs, else null (credits off, or the teacher's Priority jump switch
 * off: then there are no Jump buttons at all; the "Jumped by" tags still show).
 */
const jumpCredits = () => (state?.settings?.allowJump === true ? (state?.you?.credits ?? null) : null);

/**
 * The jump button and the "Jumped by" tag of one queue song. The button never turns `disabled`
 * (a focused button would lose focus): without enough credits a click says why instead.
 */
function updateJump(li, item, credits) {
  // The teacher's ⏫ Play next (protocol.js TEACHER PUSH): a tag only, nothing to press.
  const ptag = li.querySelector('.ptag');
  const ptagText = item.pushed ? `${PUSH_TAG} · ` : ''; // first, so a long name never hides it
  if (ptag.textContent !== ptagText) ptag.textContent = ptagText;
  ptag.hidden = !item.pushed;
  li.classList.toggle('pushed', Boolean(item.pushed));
  const tag = li.querySelector('.jtag');
  const tagText = item.jumped ? ` · ⚡ Jumped by ${item.jumped.by}` : '';
  if (tag.textContent !== tagText) tag.textContent = tagText;
  tag.hidden = !item.jumped;
  li.classList.toggle('jumped', Boolean(item.jumped));
  const btn = li.querySelector('.jump');
  btn.hidden = credits === null;
  if (credits === null) return;
  const busy = jumping.has(item.id);
  const short = !item.jumped && !busy && credits < JUMP_COST;
  const text = item.jumped ? '⚡ Jumped' : busy ? 'Jumping…' : `⚡ Jump (${JUMP_COST})`;
  if (btn.textContent !== text) btn.textContent = text;
  btn.setAttribute('aria-disabled', String(Boolean(item.jumped) || busy || short));
  btn.classList.toggle('done', Boolean(item.jumped));
  btn.classList.toggle('short', short);
  btn.title = item.jumped ? `Jumped by ${item.jumped.by}. It plays soon.`
    : short ? JUMP_NEED : `Spend ${JUMP_COST} credits so this song plays next.`;
  btn.setAttribute('aria-label', item.jumped ? `${item.song.title}: jumped by ${item.jumped.by}, it plays soon`
    : short ? `Jump ${item.song.title}: ${JUMP_NEED}` : `Jump ${item.song.title} so it plays next, for ${JUMP_COST} credits`);
}

/**
 * 👎 I may still cast this class (protocol.js DOWNVOTE LIMIT), or null = unlimited: the server's
 * count, moved by this page's votes the server has not answered yet (voteUndo holds what they were).
 * A take-back on the song playing frees nothing, so only queue songs count.
 */
function downLeft() {
  const left = state?.you?.downvotesLeft;
  if (!Number.isInteger(left)) return null;
  let n = left;
  for (const [id, before] of voteUndo) {
    const item = state.queue.find((q) => q.id === id);
    if (!item) continue;
    if (item.myVote === -1 && before.myVote !== -1) n--;
    if (before.myVote === -1 && item.myVote !== -1) n++;
  }
  return Math.max(0, n);
}

/**
 * 👍 I may still cast this class (protocol.js UPVOTE LIMIT), or null = unlimited (or 👍 off): the
 * server's count less this page's new 👍 the server has not answered yet. A 👍 is spent for good.
 */
function upLeft() {
  const left = state?.you?.upvotesLeft;
  if (!Number.isInteger(left) || !upOn()) return null;
  let n = left;
  for (const [id, before] of voteUndo) {
    const item = state.nowPlaying?.id === id ? state.nowPlaying : state.queue.find((q) => q.id === id);
    if (item?.myVote === 1 && before.myVote !== 1) n--;
  }
  return Math.max(0, n);
}

/** "👍 2 left" / "👎 2 left" next to the voting hint; hidden while unlimited. */
function renderLeft(sel, emoji, words, left) {
  const el = $(sel);
  el.hidden = left === null;
  if (left === null) return;
  const text = `${emoji} ${left} left`;
  if (el.textContent !== text) el.textContent = text;
  el.setAttribute('aria-label', left === 0 ? `No ${words} left this class` : `${left} ${words} left this class`);
  el.classList.toggle('empty', left === 0);
}

/**
 * Update the queue in place: each song keeps its own <li> (so pictures do not reload and a focused
 * vote button stays a button), only counts change, and a song that moves slides to its new place
 * instead of jumping (not with reduced motion).
 */
const SLIDE_CALM_MS = 400;
let lastReorder = -Infinity;
function renderQueue(queue) {
  const list = $('#queue');
  const mode = downMode();
  const left = mode === 'off' ? null : downLeft();
  const ups = upLeft();
  renderLeft('#upLeft', '👍', 'thumbs up', ups);
  renderLeft('#downLeft', '👎', 'thumbs down', left);
  renderVoteHint(mode);
  // Reading positions costs two layouts of the page (slow on a Chromebook with 40 songs): only
  // when the order really changes, and not in a burst of votes (sliding then is only a blur).
  const reorder = queue.map((q) => q.id).join() !== [...list.children].map((li) => li.dataset.id).join();
  const calm = performance.now() - lastReorder > SLIDE_CALM_MS;
  if (reorder) lastReorder = performance.now();
  const slide = reorder && calm && list.children.length > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const oldTop = new Map();
  const old = new Map();
  for (const li of list.children) {
    old.set(li.dataset.id, li);
    if (slide) oldTop.set(li, li.getBoundingClientRect().top);
  }
  keepFocus(() => {
    queue.forEach((item, i) => {
      let li = old.get(item.id);
      old.delete(item.id);
      if (!li) {
        li = document.createElement('li');
        li.dataset.id = item.id;
        li.className = `qitem${item.mine ? ' mine' : ''}`;
        li.innerHTML = queueItemHtml(item);
        li.dataset.art = `${item.song.art}|${item.song.artwork}`;
      }
      // 🖼 The cover's state changed (a check finished, Show anyway, the art switches): redraw it.
      const artNow = `${item.song.art}|${item.song.artwork}`;
      if (li.dataset.art !== artNow) {
        li.dataset.art = artNow;
        const el = li.querySelector('.art');
        if (el) el.outerHTML = artHtml(item.song, 100, { lazy: true });
      }
      li.querySelector('.rank').textContent = i + 1;
      li.classList.toggle('next', i === 0);
      for (const [act, v, label, n] of [['up', 1, 'Thumbs up', item.up], ['down', -1, 'Thumbs down', item.down]]) {
        const btn = li.querySelector(`.vote.${act}`);
        // DOWNVOTE MODE: 'off' = no 👎 button at all; 'hidden' = a 👎 button with no count.
        if (act === 'down') btn.hidden = mode === 'off';
        else btn.hidden = !upOn(); // UPVOTE LIMIT: 👍 off = no 👍 button
        const counted = act === 'up' ? upCountsOn() : countsOn() && mode === 'shown';
        btn.setAttribute('aria-pressed', String(item.myVote === v));
        // All used: a new vote says why on click (never a dead button).
        const spent = item.myVote !== v && (act === 'down' ? left === 0 : ups === 0);
        btn.setAttribute('aria-disabled', String(spent));
        btn.title = spent ? (act === 'down' ? DOWN_SPENT : UP_SPENT) : '';
        const said = counted ? votesLabel(label, n) : label;
        btn.setAttribute('aria-label', spent ? `${said}. No ${label.toLowerCase()} left this class` : said);
        const shown = counted ? String(n) : '';
        if (btn.querySelector('.n').textContent !== shown) btn.querySelector('.n').textContent = shown;
      }
      updateJump(li, item, jumpCredits());
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
    });
    for (const li of old.values()) li.remove();
  });
  if (!slide) return;
  // All reads first, then all writes (a read after a write forces another layout), then one frame.
  const moves = [];
  for (const [li, top] of oldTop) {
    const dy = li.isConnected ? top - li.getBoundingClientRect().top : 0;
    if (dy) moves.push([li, dy]);
  }
  for (const [li, dy] of moves) {
    li.style.transition = 'none';
    li.style.transform = `translateY(${dy}px)`;
  }
  requestAnimationFrame(() => {
    for (const [li] of moves) {
      li.style.transition = 'transform .25s ease';
      li.style.transform = '';
    }
  });
}

// After a vote, say the song's new counts once things settle (the server's snapshot has the real
// numbers), so a screen reader hears one sentence, not one per click or per snapshot.
const VOTE_SAY_MS = 1200;
let voteSay = null;
function sayVotes(id) {
  clearTimeout(voteSay);
  voteSay = setTimeout(() => {
    const item = state?.nowPlaying?.id === id ? state.nowPlaying : state?.queue.find((q) => q.id === id);
    if (!item) return;
    const mine = item.myVote ? `Your vote: thumbs ${item.myVote > 0 ? 'up' : 'down'}.` : 'You have no vote on it.';
    const counts = [upCountsOn() ? votesLabel('thumbs up', item.up) : '',
      countsOn() && downMode() === 'shown' ? votesLabel('thumbs down', item.down) : ''].filter(Boolean).join(', ');
    announce(counts ? `${item.song.title}: ${counts}. ${mine}` : `${item.song.title}: ${mine}`);
  }, VOTE_SAY_MS);
}

$('#queue').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !state) return;
  const id = btn.closest('[data-id]').dataset.id;
  const item = state.queue.find((q) => q.id === id);
  if (!item) return;
  if (btn.dataset.act === 'jump') {
    if (restingNow()) return renderRest();
    const credits = jumpCredits();
    if (credits === null || item.jumped || jumping.has(id)) return;
    if (credits < JUMP_COST) return tell(JUMP_NEED, 'warn', 7000);
    if (!conn?.send({ t: 'jump', id })) return tell('Reconnecting. Try again in a moment.', 'warn');
    jumping.add(id);
    announce('Jumping that song…');
    return renderQueue(state.queue);
  }
  const want = btn.dataset.act === 'up' ? 1 : -1;
  if (want === -1 && downMode() === 'off') return; // no 👎 while the teacher has it off (the button is hidden)
  if (want === 1 && !upOn()) return; // no 👍 while the teacher has it off (the button is hidden)
  if (item.myVote !== 0) return tell(VOTE_FINAL, 'warn', 5000); // votes are final
  if (want === -1 && downLeft() === 0) return tell(DOWN_SPENT, 'warn', 7000);
  if (want === 1 && upLeft() === 0) return tell(UP_SPENT, 'warn', 7000);
  if (!sendVote(item, want)) return;
  renderQueue(state.queue);
  sayVotes(id);
});

/** Send a vote and show it at once; the next snapshot from the server has the real counts. */
function sendVote(item, v) {
  if (!conn?.send({ t: 'vote', id: item.id, v })) {
    tell('Reconnecting. Try again in a moment.', 'warn');
    return false;
  }
  if (!voteUndo.has(item.id)) voteUndo.set(item.id, { up: item.up, down: item.down, myVote: item.myVote });
  if (item.myVote === 1) item.up--;
  if (item.myVote === -1) item.down--;
  if (v === 1) item.up++;
  if (v === -1) item.down++;
  item.myVote = v;
  return true;
}

// The song playing now takes a 👍 (or a take-back) only, never a new 👎 (protocol.js VOTES).
function renderNowVote(now) {
  const btn = $('#nowUp');
  if (!btn) return;
  btn.hidden = !upOn(); // UPVOTE LIMIT: 👍 off
  btn.setAttribute('aria-disabled', String(now.myVote !== 1 && upLeft() === 0));
  btn.setAttribute('aria-pressed', String(now.myVote === 1));
  btn.setAttribute('aria-label', upCountsOn() ? votesLabel('Thumbs up for the song playing now', now.up) : 'Thumbs up for the song playing now');
  btn.querySelector('.n').textContent = upCountsOn() ? now.up : '';
}

$('#nowPlaying').addEventListener('click', (e) => {
  const now = state?.nowPlaying;
  if (!e.target.closest('#nowUp') || !now || !upOn()) return;
  if (now.myVote !== 0) return tell(VOTE_FINAL, 'warn', 5000); // votes are final
  if (upLeft() === 0) return tell(UP_SPENT, 'warn', 7000);
  if (!sendVote(now, 1)) return;
  renderNowVote(now);
  sayVotes(now.id);
});

// ---- 📚 Back to work (protocol.js BACK TO WORK) ----
// Only a suggestion that went in (the queue, or Needs a look) rests this device for the teacher's
// minutes; votes never do (the server refuses suggestions and jumps sooner, so a reload or another
// tab changes nothing). One calm card replaces search, the queue and the votes, with a countdown.
// Timed from the snapshot's restLeft (relative ms), never this computer's clock.
let restEnd = 0; // Date.now() when the rest ends (0: not resting)
let restShown = false;
let restTimer = 0;
const voteUndo = new Map(); // item id → { up, down, myVote } before this page's vote (a refused vote is undone)
const restingNow = () => restEnd > Date.now();

function setRest(you) {
  const left = Number(you?.restLeft) || 0;
  restEnd = you?.restUntil && left > 0 ? Date.now() + left : 0;
  renderRest();
}
/** The server said back_to_work (msg.left ms): rest now. */
function restRefused(msg) {
  const left = Number(msg.left) || 0;
  if (left > 0) restEnd = Date.now() + left;
  tell(msg.message || OTHER_REASONS.back_to_work, 'warn', 7000);
  renderResults();
  renderRest();
}

function renderRest() {
  clearTimeout(restTimer);
  restTimer = 0;
  const now = Date.now();
  const left = restEnd - now;
  const resting = left > 0;
  const roomEl = $('#roomScreen');
  roomEl.classList.toggle('resting', resting);
  $('#restScreen').hidden = !resting;
  if (resting) {
    const mins = Math.max(1, Math.ceil(left / 60_000));
    $('#restText').textContent = `Your pick is in. Check back in ${plural(mins, 'minute')}.`;
    $('#restClock').textContent = clockLeft(left);
    const playing = state?.nowPlaying;
    $('#restNow').hidden = !playing;
    if (playing) $('#restNow').textContent = `🎵 Now playing: ${playing.song.title} · ${playing.song.artist}`;
  }
  if (roomEl.hidden) {
    restShown = false;
  } else if (resting !== restShown) {
    restShown = resting;
    if (resting) {
      $('#restTitle').focus();
      announce(`Back to work! ${$('#restText').textContent}`);
    } else {
      announce('You can suggest again.');
      const at = document.activeElement;
      if (!at || at === document.body || at === $('#restTitle')) $('#q').focus();
    }
  }
  if (left > 0) {
    // Tick on the second.
    restTimer = setTimeout(renderRest, (left % 1000 || 1000) + 5);
  }
}

// ---- Search ----
/** While searching: a spinner by the message and the old results faded (nothing jumps). */
function busy(msgSel, listSel, on) {
  $(msgSel).classList.toggle('busy', on);
  $(listSel).classList.toggle('stale', on);
  if (on) $(msgSel).textContent = 'Searching…';
}

const noneText = (what) => `No ${what} found. Try other words, or just the artist's name.`;

let searchTimer = null;
let searchAbort = null;

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  search();
});
$('#q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, SEARCH_DELAY_MS);
});

/** Spotify's attribution under the search box while the results come from Spotify's catalog. */
function showCredit(on) {
  const credit = $('#searchCredit');
  if (on && !credit.childElementCount) credit.innerHTML = `Songs from ${spotifyIcon()} <span>Spotify</span>`;
  credit.hidden = !on;
}

async function search() {
  const q = $('#q').value.trim();
  searchAbort?.abort();
  if (q.length < 2 || !room) {
    results = [];
    busy('#searchMsg', '#results', false);
    $('#searchMsg').textContent = q.length === 1 ? 'Keep typing…' : '';
    showCredit(false);
    return renderResults();
  }
  const abort = (searchAbort = new AbortController());
  busy('#searchMsg', '#results', true);
  try {
    const r = await fetch(`/api/rooms/${room.id}/search?q=${encodeURIComponent(q.slice(0, QUERY_MAX))}`, {
      headers: { 'x-device': deviceId() },
      signal: abort.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      results = [];
      $('#searchMsg').textContent = data.message || 'Search is not working right now. Try again in a moment.';
    } else {
      results = data.results ?? [];
      $('#searchMsg').textContent = results.length
        ? `${results.length} ${results.length === 1 ? 'song' : 'songs'} found.`
        : noneText('songs');
    }
    showCredit(r.ok && data.catalog === 'spotify');
  } catch (err) {
    if (err.name === 'AbortError') return;
    results = [];
    $('#searchMsg').textContent = 'Could not search. Check your internet and try again.';
  }
  busy('#searchMsg', '#results', false);
  renderResults();
}

/** What a result's button says, and how: '' Suggest, 'off' Suggest but not now, 'status' a label. */
function resultState(song, queued, playing, full, credits) {
  const id = song.id;
  const key = songKey(song); // other versions of a song count as the song (protocol.js REPEATS)
  if (id === playing || (key && key === playingKey)) return ['▶ Playing now', 'status'];
  if (queued.has(id) || (key && queued.has(key))) return ['✓ In the queue', 'status'];
  if (pending.has(id)) return ['Checking…', 'status'];
  if (checking.has(id)) return ['⏳ Teacher checking', 'status'];
  if (played.has(id) || playedKeys.has(key)) return ['Played already', 'status'];
  if (refused.has(id)) return [refused.get(id), 'status'];
  const rest = restingOf(song);
  if (rest) return [`${RESTING} ${restingUntilLabel(rest[1])}`, 'status'];
  if (state?.cleanup) return ['🧹 Cleanup', 'status'];
  if (state?.locked) return ['Paused', 'status'];
  if (longWhy(song)) return [TOO_LONG, 'status'];
  if (artistWhy(song)) return [ARTIST_WAITING, 'status'];
  if (full) return ['Limit reached', 'status'];
  if (credits !== null && credits < SUGGEST_COST) return [NO_CREDITS, 'status'];
  const label = credits === null ? 'Suggest' : SUGGEST_PAID;
  if (pending.size > 0) return [label, 'off'];
  return [label, ''];
}
// With credits on, the button says what a suggestion costs.
const SUGGEST_PAID = `Suggest · ${SUGGEST_COST} 🎟`;
const NO_CREDITS = 'No credits';
const SPOKEN = { [SUGGEST_PAID]: `Suggest for ${plural(SUGGEST_COST, 'credit')}` };
const TIPS = {
  'Limit reached': 'You have the most songs waiting that you can. Wait until one plays.',
  '🧹 Cleanup': 'Cleanup time! Suggestions are closed for today.',
  [NO_CREDITS]: `You need ${SUGGEST_COST} credit to suggest a song. Ask your teacher for more.`,
};

let playingKey = null;
function renderResults() {
  const queued = new Set((state?.queue ?? []).flatMap((q) => [q.song.id, songKey(q.song)]).filter(Boolean));
  const playing = state?.nowPlaying?.song.id;
  playingKey = state?.nowPlaying ? songKey(state.nowPlaying.song) : null;
  const max = state?.settings?.maxWaitingPerStudent ?? Infinity;
  const full = (state?.you?.waiting ?? 0) >= max;
  const credits = state?.you?.credits ?? null;
  const state1 = (song) => [song, ...resultState(song, queued, playing, full, credits)];
  resultsKey = renderList($('#results'), results.map(state1), resultsKey);
  // ⭐ Class favorites: the same buttons (and the same server path) as search results.
  const favs = favMode ? favorites.map((f) => [...state1(f.song), f]) : [];
  favKey = renderList($('#favResults'), favs, favKey);
}

/**
 * Draw one list of result rows ([song, label, kind, favorite?]). Every vote by anyone sends a
 * snapshot: touch only the rows whose button changes, so pictures do not flicker. Returns the keys.
 */
function renderList(list, rows, before) {
  const keys = rows.map(([song, label, kind, fav]) => `${song.id}|${label}|${kind}|${(refusedWhy.has(song.id) && refused.get(song.id) === label) || liveWhy(song, label) ? 1 : 0}|${fav ? `${fav.pinned}${fav.top5}` : ''}`);
  const sameSongs = before.length === keys.length && keys.every((k, i) => k.split('|')[0] === before[i].split('|')[0]);
  keepFocus(() => {
    if (!sameSongs) list.innerHTML = rows.map(resultHtml).join('');
    else rows.forEach((row, i) => { if (keys[i] !== before[i]) list.children[i].outerHTML = resultHtml(row); });
  });
  return keys;
}

function resultHtml([song, label, kind, fav = null]) {
  const tip = TIPS[label] ?? '';
  const spoken = SPOKEN[label] ?? label.replace(/^[^A-Za-z]+/, '');
  // A song this student tried and was told no, or one the room's rules stop now: "Why?" says why.
  const why = (refused.get(song.id) === label && refusedWhy.has(song.id)) || Boolean(liveWhy(song, label));
  const button = `<button type="button" class="suggest ${kind === 'status' ? 'status' : 'primary'}" data-act="suggest" ${kind ? 'disabled' : ''}
      ${tip ? `title="${esc(tip)}"` : ''} aria-label="${esc(`${spoken}: ${song.title} by ${song.artist}`)}">${esc(label)}</button>`;
  const favTag = fav?.pinned ? '<span class="tag fav-tag" title="Your teacher\'s pick">📌</span>'
    : fav?.top5 ? `<span class="tag fav-tag" title="${esc(`In a class's Top 5 ${plural(fav.top5, 'time')}`)}">🏆 ${fav.top5}</span>` : '';
  return `<li class="result" data-id="${esc(song.id)}">
    <div class="song">${songHtml(song, 100, true)}</div>
    ${song.explicit === 'cleaned' ? cleanTag() : favTag}
    ${why ? `<span class="refused">${button}<button type="button" class="why" data-act="why"
      aria-label="${esc(`Why is ${song.title} not allowed?`)}">Why?</button></span>` : button}
  </li>`;
}

function onResultClick(e) {
  const whyBtn = e.target.closest('button[data-act="why"]');
  if (whyBtn) {
    const id = whyBtn.closest('[data-id]').dataset.id;
    const song = results.find((s) => s.id === id) ?? favorites.find((f) => f.song.id === id)?.song;
    const label = whyBtn.closest('li').querySelector('button[data-act="suggest"]')?.textContent ?? '';
    const text = (refused.has(id) && refusedWhy.get(id)) || (song && liveWhy(song, label)) || refusedWhy.get(id);
    if (text) tell(sentence(text), 'warn', 8000);
    return;
  }
  const btn = e.target.closest('button[data-act="suggest"]');
  if (!btn || btn.disabled) return;
  if (restingNow()) return renderRest();
  const id = btn.closest('[data-id]').dataset.id;
  if (!conn?.send({ t: 'suggest', song: id })) return tell('Reconnecting. Try again in a moment.', 'warn');
  pending.add(id);
  announce('Checking your song…');
  renderResults();
}
$('#results').addEventListener('click', onResultClick);
$('#favResults').addEventListener('click', onResultClick);

// ---- Browse before joining: which songs are allowed (GET /api/search, no room, no AI) ----
let browseTimer = null;
let browseAbort = null;

$('#browseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(browseTimer);
  browse();
});
$('#bq').addEventListener('input', () => {
  clearTimeout(browseTimer);
  browseTimer = setTimeout(browse, SEARCH_DELAY_MS);
});

/**
 * Browsing before joining: this browser searches iTunes itself (iTunes answers a school's own
 * address, not the server's), swaps an explicit song for its clean version from the same results,
 * and asks the server which may show (the teacher's blocked words and bans stay on the server).
 * Display only: suggesting needs a room, which takes every song from its own iTunes data.
 * @returns {Promise<{ songs: object[] } | { message: string }>}
 */
async function browseSongs(q, signal) {
  const r = await fetch(itunesSearchUrl(cleanQuery(q.slice(0, QUERY_MAX)).toLowerCase()), { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (r.status === 403 || r.status === 429) return { message: 'The song search is busy right now. Wait a minute and try again.' };
  const results = r.ok ? parseItunes(await r.text()) : null;
  if (!results) return { message: 'Search is not working right now. Try again in a moment.' };
  const all = results.map(toSong).filter(Boolean);
  const seen = new Set();
  const picks = [];
  for (const song of all) {
    const pick = song.explicit === 'explicit' ? all.find((c) => isCleanItunesVersion(c, song)) : song;
    if (pick && !seen.has(pick.id)) {
      seen.add(pick.id);
      picks.push(pick);
    }
  }
  if (!picks.length) return { songs: [] };
  const check = await fetch('/api/browse', {
    method: 'POST',
    headers: { 'x-device': deviceId(), 'content-type': 'application/json' },
    body: JSON.stringify({ songs: picks.slice(0, 30).map(({ id, title, artist, album, explicit, artwork }) => ({ id, title, artist, album, explicit, artwork })) }),
    signal,
  });
  const data = await check.json().catch(() => ({}));
  if (!check.ok || !Array.isArray(data.allowed)) return { message: data.message || 'Search is not working right now. Try again in a moment.' };
  // 🖼 The server says which covers may show (protocol.js ALBUM ART); no answer: none do.
  const art = Array.isArray(data.art) ? data.art : [];
  return { songs: picks.slice(0, 30).map((s, i) => ({ ...s, art: ['ok', 'unchecked'].includes(art[i]) ? art[i] : 'hidden' })).filter((_, i) => data.allowed[i] === true) };
}

async function browse() {
  const q = $('#bq').value.trim();
  browseAbort?.abort();
  const list = $('#browseResults');
  if (q.length < 2) {
    list.innerHTML = '';
    busy('#browseMsg', '#browseResults', false);
    $('#browseMsg').textContent = q.length === 1 ? 'Keep typing…' : '';
    return;
  }
  const abort = (browseAbort = new AbortController());
  busy('#browseMsg', '#browseResults', true);
  let songs = [];
  try {
    const found = await browseSongs(q, abort.signal);
    if (found.message) {
      $('#browseMsg').textContent = found.message;
    } else {
      songs = found.songs;
      $('#browseMsg').textContent = songs.length
        ? `${songs.length} ${songs.length === 1 ? 'song' : 'songs'} found. Join with the class code to suggest one.`
        : noneText('songs');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('#browseMsg').textContent = 'Could not search. Check your internet and try again.';
  }
  busy('#browseMsg', '#browseResults', false);
  list.innerHTML = songs.map((song) => `<li class="result" data-id="${esc(song.id)}">
      <div class="song">${songHtml(song, 100, true)}</div>
      ${song.explicit === 'cleaned' ? cleanTag() : '<span class="tag" title="Not a promise: each song is checked again when you suggest it.">Passed quick check</span>'}
    </li>`).join('');
}

// ---- Start: a refresh rejoins the same room (by its id: the code may have changed since) ----
const saved = store.get('sessionStorage', 'cq.join');
if (ROOM_ID_PATTERN.test(saved?.id ?? '') && saved.nick) {
  $('#nick').value = saved.nick;
  show('joinScreen');
  $('#joinBtn').disabled = true;
  $('#joinBtn').textContent = 'Joining…';
  join(saved.id, saved.nick);
} else {
  showJoin();
}
