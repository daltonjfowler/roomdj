// The board (protocol.js BOARD + REMOTE): the projector page on a second computer. It shows what
// the host's big screen shows (join address + class code, now playing with art and progress, the
// top of the queue with votes and ⚡ Jumped tags, 🏆 Top 5, the 🧹 cleanup banner, the Needs a look
// COUNT) and has a small remote. It NEVER plays music: no player here, and its CSP says
// media-src 'none'. Play / pause / volume go to the host page, which owns the player.
// The board token comes from the link's fragment (#<room>.<token>): it is taken out of the address
// bar at once (the projector shows it), kept in cq.board (session + local storage, like the host
// entry) so a reload works, and sent in the socket's FIRST message, never in the URL.
// Sign-in (protocol.js BOARD SIGN-IN): /board with no link asks for the teacher key (teacher-key.js:
// this tab, and this computer only when "Remember" is ticked, like the host page) and who's teaching
// (cq.boardTeacher, per computer), then asks POST /api/teacher/board for that teacher's open room
// every BOARD_POLL_MS while it waits (slower after an hour, never while hidden). The token it gets
// is kept in cq.boardAuto (like cq.board) so a reload reuses it; the room closing sends the board
// back to waiting, so it follows the teacher to the next room. The key never goes in a URL.

import './style.css';
import './host.css';
import './classtime.css';
import './board.css';
import { initThemeButton } from './theme.js';
import { $, announce, artHtml, ask, esc, spotifyMark, toast } from './dom.js';
import { connectRoom, roomSocketUrl } from './room-socket.js';
import { showTimes } from './times.js';
import { parseBoardFragment } from '../../shared/board.js';
import { BOARD_POLL_MS, BOARD_POLL_SLOW_AFTER_MS, BOARD_POLL_SLOW_MS, BOARD_TOKEN_PATTERN, PROFILE_ID_PATTERN, PUSH_TAG, ROOM_ID_PATTERN, byLabel } from '../../shared/protocol.js';
import { fetchProfiles, forgetTeacherKey, rememberedKey, saveTeacherKey, teacherKey } from './teacher-key.js';
import { forgetSignin, sessionHeaders, signOut, signedInAs } from './account.js';
import { displayCode } from '../../shared/code.js';
import { countdownText } from '../../shared/classtime.js';
import { noteServerTime, serverClock } from './server-clock.js';
import { pickStats } from '../../shared/stats.js';
import { top5Html } from './highlights.js';
import { initRecapShow } from './recap-show.js';
import { cueFor } from '../../shared/recap-music.js';
import { initLayout } from './layout.js';

const KEY = 'cq.board';
const AUTO = 'cq.boardAuto';
const TEACHER = 'cq.boardTeacher';
const IDLE_MS = 4000;
const OFFLINE = 'Could not reach RoomDJ. Check the internet; the board keeps trying.';

initThemeButton($('#theme'));

// ---- The board entry: { room, token } (a link: cq.board; a sign-in: cq.boardAuto, with its profile) ----
function entryStore(key) {
  return {
    get() {
      for (const area of [sessionStorage, localStorage]) {
        try {
          const v = JSON.parse(area.getItem(key));
          if (v && ROOM_ID_PATTERN.test(v.room ?? '') && BOARD_TOKEN_PATTERN.test(v.token ?? '')) return v;
        } catch { /* blocked or broken */ }
      }
      return null;
    },
    set(v) {
      for (const area of [sessionStorage, localStorage]) try { area.setItem(key, JSON.stringify(v)); } catch { /* blocked */ }
    },
    del() {
      for (const area of [sessionStorage, localStorage]) try { area.removeItem(key); } catch { /* blocked */ }
    },
  };
}
const store = entryStore(KEY);
const autoStore = entryStore(AUTO);

/** The teacher this board follows (per computer): { id, name }, or null. */
const boardTeacher = {
  get() {
    try {
      const v = JSON.parse(localStorage.getItem(TEACHER));
      return v && PROFILE_ID_PATTERN.test(v.id ?? '') && typeof v.name === 'string' ? { id: v.id, name: v.name } : null;
    } catch {
      return null;
    }
  },
  set(p) { try { localStorage.setItem(TEACHER, JSON.stringify({ id: p.id, name: p.name })); } catch { /* blocked */ } },
  del() { try { localStorage.removeItem(TEACHER); } catch { /* blocked */ } },
};

/** 'link': a board link (#<room>.<token>); 'signin': the teacher key + who's teaching. */
let mode = 'link';

let conn = null;
let entry = null;
let state = null;
let lastCode = null;
let lastNowId;
let anchor = null; // the host player's position: { id, pos, dur, started, paused, at (this computer's clock) }

function show(screen) {
  $('#boardScreen').hidden = screen !== 'board';
  $('#msgScreen').hidden = screen !== 'msg';
  $('#signinScreen').hidden = screen !== 'signin';
  $('#waitScreen').hidden = screen !== 'wait';
  $('#remote').hidden = screen !== 'board';
  $('#connPill').hidden = screen !== 'board';
  if (screen !== 'board') $('#reviewPill').hidden = true;
  if (screen !== 'wait') stopWaiting();
  if (screen !== 'board') boardLayout.leave({ focus: false });
}

// ---- ✏️ Edit layout (layout.js): the remote's ⋯ menu or E; kept on this computer (cq.layout:board) ----
const boardLayout = initLayout({
  stage: $('#boardScreen'),
  view: () => 'board',
  storageKey: () => 'cq.layout:board',
  canEdit: () => !$('#boardScreen').hidden,
  returnFocus: () => $('#rMenu'),
  onToggle(on) { if (on) wake(); },
});

function showMsg(title, text) {
  $('#msgTitle').textContent = title;
  $('#msgText').textContent = text;
  $('#msgRetry').hidden = mode !== 'signin';
  $('#msgSignin').hidden = mode !== 'link';
  document.title = 'RoomDJ board';
  show('msg');
}

function stop() {
  conn?.stop();
  conn = null;
  state = null;
  clearInterval(countdown);
  countdown = 0;
  recapShow.close();
}

// ---- Connect: the token in the first message ----
function start(e) {
  entry = e;
  $('#nowPlaying').innerHTML = '<p class="note">Connecting…</p>';
  $('#joinHost').textContent = location.host;
  conn = connectRoom(roomSocketUrl(e.room, { role: 'board' }), { onMessage, onStatus });
}

function onStatus(status, n) {
  const pill = $('#connPill');
  if (status === 'open') {
    conn?.send({ t: 'board', token: entry.token });
    pill.classList.remove('off');
    $('#connText').textContent = 'Connected';
    return;
  }
  if (status === 'ended') {
    // Normally the server's last message came first; this is the backup.
    if (n === 4000) return closed();
    if (!$('#msgScreen').hidden || !$('#waitScreen').hidden) return;
    stop();
    if (mode === 'signin') return roomGone();
    return showMsg('This board stopped', 'Open the board link again from the teacher computer (📺 Board link).');
  }
  pill.classList.add('off');
  $('#connText').textContent = 'Reconnecting…';
}

function closed() {
  stop();
  if (mode === 'signin') return roomGone();
  store.del();
  showMsg('The room is closed', 'All of the room\'s songs, votes and nicknames are deleted.');
}

/** A new room (sign-in or link): nothing of the last room's screen is kept. */
function resetRoomView() {
  lastCode = null;
  lastNowId = undefined;
  anchor = null;
}

function onMessage(msg) {
  switch (msg.t) {
    case 'state':
      noteServerTime(msg.state); // SERVER CLOCK: on arrival, not when drawn
      render(msg.state);
      break;
    case 'progress':
      setAnchor(msg);
      break;
    case 'recap':
      if (msg.show && msg.recap) recapShow.play(msg.recap, pickStats(msg.recap.stats ?? [], 4));
      break;
    case 'remoteResult':
      if (!msg.ok) {
        note(msg.message || 'The teacher computer did not answer.');
        toast(msg.message || 'The teacher computer did not answer.', 'warn');
      }
      break;
    case 'closed':
      closed();
      break;
    case 'error':
      if ((msg.error === 'board' || msg.error === 'board_moved') && mode === 'signin') {
        stop();
        roomGone(); // this token stopped: ask for the teacher's room again
      } else if (msg.error === 'board' || msg.error === 'board_moved') {
        stop();
        store.del();
        showMsg(msg.error === 'board_moved' ? 'A new board link was made' : 'This board link does not work', msg.message);
      } else if (msg.error === 'boards') {
        stop();
        showMsg('This board stopped', msg.message);
      } else if (msg.error === 'no_room') {
        closed();
      } else {
        toast(msg.message || 'Something went wrong.', 'warn');
      }
      break;
  }
}

// ---- Rendering (the host's big screen classes) ----
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function render(s) {
  const first = !state;
  state = s;
  show('board');
  if (first) keepAwake();
  const host = s.host ?? {};
  // The class code: from the host page (the server keeps only its hash); the last one stays.
  if (host.code) lastCode = host.code;
  const shown = lastCode ? displayCode(lastCode) : '';
  $('#bigCode').innerHTML = shown.split(' ').filter(Boolean).map((w) => `<span>${esc(w)}</span>`).join('');
  $('#bigCode').setAttribute('aria-label', shown);
  $('#codeWait').hidden = Boolean(lastCode);
  document.title = shown ? `RoomDJ board: ${shown}` : 'RoomDJ board';
  // The teacher's big-screen preferences (text size, who suggested, album art).
  const d = host.display;
  if (d) {
    const b = document.body.classList;
    b.toggle('big-size-s', d.size === 's');
    b.toggle('big-size-l', d.size === 'l');
    b.toggle('big-no-who', d.who === false);
    b.toggle('big-no-art', d.art === false);
  }
  showTimes(s);

  // 🧹 Cleanup: the banner with its countdown to the bell, and the Top 5 under it.
  const cleanup = s.cleanup === true;
  $('#cleanupBanner').hidden = !cleanup;
  document.body.classList.toggle('cleanup', cleanup);
  if (cleanup && !countdown) countdown = setInterval(tick, 1000);
  if (!cleanup && countdown) {
    clearInterval(countdown);
    countdown = 0;
  }
  tick();
  const top5 = Array.isArray(s.top5) ? s.top5 : [];
  $('#top5Board').hidden = !(cleanup && top5.length);
  // 👎 numbers only while the teacher shows them (protocol.js DOWNVOTE MODE; a room from before: shown).
  const downs = (s.downvoteMode ?? 'shown') === 'shown';
  if (cleanup && top5.length) $('#top5BoardList').innerHTML = top5Html(top5, { downs });

  const now = s.nowPlaying;
  // Redrawn when the song changes, or its cover's state does (🖼 ALBUM ART: a check that finishes later).
  const nowKey = now ? `${now.id}|${now.song.art}|${now.song.artwork}` : null;
  if (nowKey !== lastNowId) {
    lastNowId = nowKey;
    $('#nowPlaying').innerHTML = now
      ? `<div class="now-song">
          ${artHtml(now.song, 600, { cls: 'now-art' })}
          <div class="now-text">
            <p class="now-title">${esc(now.song.title)}</p>
            <p class="now-artist">${esc(now.song.artist)}</p>
            <p class="now-by">Suggested by ${esc(byLabel(now))}</p>
            <p class="now-votes"><span aria-hidden="true">👍</span> <span class="n"></span><span class="sr-only"> thumbs up</span></p>
            ${spotifyMark(now.song) ? `<p class="now-sp">${spotifyMark(now.song)}</p>` : ''}
          </div>
        </div>`
      : '<p class="now-empty"></p>';
    if (now) announce(`Now playing: ${now.song.title} by ${now.song.artist}.`);
  }
  // The song playing takes 👍 too (protocol.js VOTES): its count, live.
  // HIDDEN COUNTS (protocol.js): the teacher hides vote numbers from the class, the board too.
  const counts = s.voteCounts !== false;
  const nowVotes = $('.now-votes');
  if (nowVotes) nowVotes.hidden = !counts;
  const nowUp = $('.now-votes .n');
  if (counts && nowUp && now && nowUp.textContent !== String(now.up)) nowUp.textContent = now.up;
  const empty = $('.now-empty');
  if (empty) empty.textContent = s.queue.length ? 'Up next soon.' : 'Waiting for songs. Students, suggest one!';
  if (host.player && (!anchor || anchor.id !== host.player.id)) setAnchor(host.player);

  $('#queueCount').textContent = s.queue.length ? `(${s.queue.length})` : '';
  $('#queueEmpty').hidden = s.queue.length > 0;
  $('#boardLocked').hidden = !s.locked;
  $('#queue').innerHTML = s.queue.slice(0, 5).map((item, i) => `<li class="qitem${item.jumped ? ' jumped' : ''}${item.pushed ? ' pushed' : ''}" data-id="${esc(item.id)}">
      <span class="rank">${i + 1}</span>
      ${artHtml(item.song, 100)}
      <span class="song-text"><span class="song-title">${esc(item.song.title)}</span>
        <span class="song-artist">${spotifyMark(item.song)}${esc(item.song.artist)}<span class="qby"> · by ${esc(byLabel(item))}</span>${item.jumped ? ` · <span class="jtag">⚡ Jumped by ${esc(item.jumped.by)}</span>` : ''}</span>
        ${item.pushed ? `<span class="ptag">${PUSH_TAG}</span>` : i === 0 && s.nextLocked ? '<span class="ptag">🔒 Locked in</span>' : ''}</span>
      ${!counts ? '' : downs ? `<span class="score" title="👍 ${item.up}, 👎 ${item.down}"><b>${signed(item.score)}</b><small>👍 ${item.up} · 👎 ${item.down}</small></span>`
    : `<span class="score" title="👍 ${item.up}"><b>👍 ${item.up}</b></span>`}
    </li>`).join('');

  // Needs a look: the count only (the teacher decides on the teacher computer).
  const review = Number(s.reviewCount) || 0;
  $('#reviewPill').hidden = review === 0;
  $('#reviewPillCount').textContent = String(review);
  $('#reviewPill').setAttribute('aria-label', `Needs a look: ${review} ${review === 1 ? 'song' : 'songs'} on the teacher computer`);
  renderRemote();
}

let countdown = 0;
function tick() {
  if (state?.cleanup) $('#cleanupCount').textContent = countdownText(state.until - serverClock.now());
}

// ---- Progress: the host's player position, moved along on this computer's clock ----
function setAnchor(p) {
  anchor = { id: p.id ?? null, pos: Number(p.pos) || 0, dur: Number(p.dur) || 0, started: p.started === true, paused: p.paused === true, at: Date.now() };
  drawProgress();
  renderRemote();
}
function drawProgress() {
  const now = state?.nowPlaying;
  let pct = 0;
  if (now && anchor && anchor.id === now.id) {
    const moving = anchor.started && !anchor.paused;
    const t = anchor.pos + (moving ? (Date.now() - anchor.at) / 1000 : 0);
    const d = anchor.dur || 30;
    pct = Math.min(100, (t / d) * 100);
  }
  $('#progressBar').style.width = `${pct}%`;
  $('#pausedNote').hidden = !(now && anchor && anchor.id === now.id && anchor.started && anchor.paused);
}
setInterval(drawProgress, 500);

// ---- The remote ----
function note(text) {
  $('#rNote').textContent = text;
}

function renderRemote() {
  if (!state) return;
  const host = state.host ?? {};
  const online = host.online === true;
  const p = anchor ?? host.player ?? null;
  const playing = Boolean(p?.started && !p.paused);
  $('#rPlay').textContent = playing ? '⏸ Pause' : '▶ Play';
  $('#rPlay').disabled = !online;
  $('#rVolUp').disabled = !online;
  $('#rVolDown').disabled = !online;
  $('#rSkip').disabled = !state.nowPlaying;
  $('#rVeto').disabled = !state.nowPlaying;
  $('#rLock').textContent = state.locked ? '🔒 Unlock suggestions' : '🔓 Lock suggestions';
  $('#rLock').setAttribute('aria-pressed', String(state.locked));
  $('#rLock').classList.toggle('on', state.locked);
  if (!online) note('The teacher computer is not connected.');
  else if (!p?.started) note('Start the music on the teacher computer first.');
  else note('');
}

function send(msg) {
  if (conn?.send(msg)) return true;
  toast('Reconnecting to the room. Try again in a moment.', 'warn');
  return false;
}

const actions = {
  playPause() {
    if (!state?.host?.online) return void note('The teacher computer is not connected.');
    send({ t: 'remote', action: 'playPause' });
  },
  skip() {
    const now = state?.nowPlaying;
    if (!now) return announce('Nothing is playing.');
    if (send({ t: 'skip', from: now.id })) announce('Skipped.');
  },
  async veto() {
    const now = state?.nowPlaying;
    if (!now) return announce('Nothing is playing.');
    const ok = await ask(`Veto "${now.song.title}"?`, 'Veto',
      'It stops now and its student is told. It shows in Blocked today on the teacher computer.');
    if (ok && state?.nowPlaying?.id === now.id) send({ t: 'veto', id: now.id });
  },
  lock() {
    if (!state) return;
    const on = !state.locked;
    if (send({ t: 'lock', on })) announce(on ? 'Suggestions locked.' : 'Suggestions unlocked.');
  },
  recap() {
    if (send({ t: 'recapShow' })) note('Getting the recap…');
  },
  volUp() {
    if (state?.host?.online) send({ t: 'remote', action: 'volUp' });
  },
  volDown() {
    if (state?.host?.online) send({ t: 'remote', action: 'volDown' });
  },
};
$('#rPlay').addEventListener('click', actions.playPause);
$('#rSkip').addEventListener('click', actions.skip);
$('#rVeto').addEventListener('click', actions.veto);
$('#rLock').addEventListener('click', actions.lock);
$('#rRecap').addEventListener('click', actions.recap);
$('#rVolUp').addEventListener('click', actions.volUp);
$('#rVolDown').addEventListener('click', actions.volDown);

// Keys (never with Ctrl/Alt/Meta, never while a dialog is open; the recap show has its own keys).
const KEYS = { e: 'layout', ' ': 'playPause', k: 'playPause', s: 'skip', v: 'veto', l: 'lock', r: 'recap', '+': 'volUp', '=': 'volUp', '-': 'volDown', f: 'full' };
addEventListener('keydown', (e) => {
  wake();
  if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
  if (document.querySelector('dialog[open]') || $('#boardScreen').hidden) return;
  // Space / Enter on a focused button: the button's own click.
  if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.('button')) return;
  const act = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!act) return;
  e.preventDefault();
  if (act === 'full') return void toggleFull();
  if (act === 'layout') return void boardLayout.toggle();
  actions[act]();
});

// The remote hides after a few seconds without the mouse (it stays while it has focus).
let idleTimer = 0;
function wake() {
  document.body.classList.remove('remote-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!$('#remote').contains(document.activeElement)) document.body.classList.add('remote-idle');
  }, IDLE_MS);
}
for (const type of ['mousemove', 'pointerdown', 'touchstart', 'focusin']) addEventListener(type, wake, { passive: true });
wake();

// ---- Full screen (⛶ and F) and the wake lock (the laptop screen must not sleep) ----
async function toggleFull() {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  try {
    await document.documentElement.requestFullscreen();
  } catch {
    toast('This browser would not go full screen. Try F11.', 'warn');
  }
}
document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement);
  $('#fullBtn').setAttribute('aria-pressed', String(on));
  $('#fullBtn').textContent = on ? '✕ Leave full screen' : '⛶ Full screen';
  announce(on ? 'Full screen on.' : 'Full screen off.');
});
$('#fullBtn').addEventListener('click', toggleFull);

let wakeLock = null;
async function keepAwake() {
  // While it shows a room, and while it waits for one (it sits on the projector all day).
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible' || (!state && $('#waitScreen').hidden)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    // Not allowed (battery saver, an old browser): the screen may sleep as usual.
  }
}
document.addEventListener('visibilitychange', keepAwake);

// ---- ▶ Play recap: the awards show plays here ----
// The board stays silent (invariant 16): its slides send cues to the teacher computer, which plays
// the recap music and the ta-das on its own speakers (protocol.js RECAP MUSIC). Quiet if offline.
const cue = (c) => { if (c) conn?.send({ t: 'recapCue', cue: c }); };
const recapShow = initRecapShow({
  onStart: () => cue('start'),
  onReveal: (slide) => cue(cueFor(slide)),
  onFinish: () => cue('end'),
  onEnd() {
    note('');
    cue('end');
  },
});

// ---- Sign-in (protocol.js BOARD SIGN-IN): the key, who's teaching, then the teacher's room ----
function teacherHeaders() {
  return sessionHeaders() ?? { 'x-teacher-key': teacherKey() ?? '', 'x-teacher-profile': boardTeacher.get()?.id ?? '' };
}

// "Use the teacher key instead" (only while the server has one: local tests), remembered on this
// computer until a Spotify sign-in (host.js USE_KEY).
let usingKey = (() => { try { return localStorage.getItem('cq.useKey') === '1'; } catch { return false; } })();
fetch('/api/config').then((r) => r.json()).then((c) => { $('#boardUseKey').hidden = !c?.teacherKey; }).catch(() => {});
// The sign-in happens on the host page (Spotify comes back there), which sends this tab back here.
$('#boardSignin').addEventListener('click', () => location.assign('/host/?then=board'));
$('#boardUseKey').addEventListener('click', () => {
  usingKey = true;
  try { localStorage.setItem('cq.useKey', '1'); } catch { /* blocked */ }
  showSignin('key');
});

/** Signed in with Spotify on this computer, or holding the teacher key. */
const canSignIn = () => Boolean(signedInAs() || teacherKey());

function showSignin(step, message = '') {
  stop();
  show('signin');
  if (step === 'key' && !usingKey && !teacherKey()) step = 'spotify';
  $('#spotifyStep').hidden = step !== 'spotify';
  $('#keyStep').hidden = step !== 'key';
  $('#whoStep').hidden = step !== 'who';
  document.title = 'RoomDJ board: sign in';
  if (step === 'spotify') {
    $('#spotifyMsg').textContent = message;
    $('#boardSignin').focus();
  } else if (step === 'key') {
    $('#keyStepMsg').textContent = message;
    $('#remember').checked = Boolean(rememberedKey());
    $('#key').focus();
  } else $('#whoMsg').textContent = message;
}

/** Sign-in mode from the start: the steps this computer still needs, then the teacher's room. */
function startSignin(message = '') {
  mode = 'signin';
  const signed = signedInAs();
  signinButtons();
  if (signed) {
    // Signed in with Spotify: the board is that teacher's.
    if (boardTeacher.get()?.id !== signed.account.profile.id) autoStore.del();
    boardTeacher.set(signed.account.profile);
    return follow();
  }
  if (!teacherKey()) return showSignin('key', message);
  if (!boardTeacher.get()) return showWho(message);
  follow();
}

/** Follow the picked teacher: the kept sign-in token for this teacher first, else ask. */
function follow() {
  mode = 'signin';
  const kept = autoStore.get();
  if (kept && kept.profile === boardTeacher.get()?.id) {
    resetRoomView();
    return start(kept);
  }
  autoStore.del();
  waitFor();
}

let profiles = [];
async function showWho(message = '') {
  showSignin('who', 'Loading the teachers…');
  const r = await fetchProfiles(teacherKey());
  if (r.status === 401) {
    forgetTeacherKey();
    return showSignin('key', 'That teacher key does not work any more. Type the new one.');
  }
  if (!r.ok || !Array.isArray(r.data.profiles)) return void ($('#whoMsg').textContent = r.data.message || OFFLINE);
  profiles = r.data.profiles.filter((p) => !p.archived);
  const cur = boardTeacher.get()?.id;
  $('#whoList').innerHTML = profiles.map((p) => `<li data-id="${esc(p.id)}">
      <button type="button" class="who-pick" aria-current="${p.id === cur}">${esc(p.name)}${p.id === cur ? ' <small>· this board\'s teacher</small>' : ''}</button>
    </li>`).join('');
  $('#whoMsg').textContent = message;
  ($('#whoList .who-pick[aria-current="true"]') ?? $('#whoList .who-pick'))?.focus();
}

$('#whoList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-id]');
  const p = li && profiles.find((x) => x.id === li.dataset.id);
  if (!p) return;
  if (boardTeacher.get()?.id !== p.id) autoStore.del();
  boardTeacher.set(p);
  follow();
});

$('#keyStep').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('#key').value;
  if (!key) return $('#key').focus();
  $('#keyNext').disabled = true;
  $('#keyStepMsg').textContent = '';
  const r = await fetchProfiles(key);
  $('#keyNext').disabled = false;
  if (r.status === 401) {
    $('#keyStepMsg').textContent = r.data.message || 'That teacher key did not work.';
    return $('#key').select();
  }
  if (!r.ok) return void ($('#keyStepMsg').textContent = r.data.message || OFFLINE);
  saveTeacherKey(key, $('#remember').checked);
  $('#key').value = '';
  const p = boardTeacher.get();
  if (p && r.data.profiles?.some((x) => x.id === p.id && !x.archived)) follow();
  else showWho();
});

/** Switch teacher (waiting screen, the remote's ⋯ menu): stop following, pick again. */
function switchTeacher() {
  if (signedInAs()) return forgetComputer(); // signed in: another teacher signs in with Spotify
  if ($('#menuDlg').open) $('#menuDlg').close();
  autoStore.del();
  showWho();
}

/** Forget this computer: the remembered key or Spotify sign-in, the teacher and the sign-in token go. */
function forgetComputer() {
  if ($('#menuDlg').open) $('#menuDlg').close();
  const signed = Boolean(signedInAs());
  if (signed) signOut();
  forgetTeacherKey();
  boardTeacher.del();
  autoStore.del();
  const said = signed ? 'This board is signed out.' : 'This computer forgot the teacher key.';
  showSignin('key', said);
  toast(said, 'ok');
}
$('#otherKey').addEventListener('click', forgetComputer);
$('#waitSwitch').addEventListener('click', switchTeacher);
$('#waitForget').addEventListener('click', forgetComputer);
$('#menuSwitch').addEventListener('click', switchTeacher);
$('#menuForget').addEventListener('click', forgetComputer);
$('#menuLayout').addEventListener('click', () => {
  $('#menuDlg').close();
  boardLayout.toggle();
});
$('#rMenu').addEventListener('click', () => {
  // A link board shows only Edit layout (it follows no teacher).
  for (const id of ['#menuFollow', '#menuSwitch', '#menuForget']) $(id).hidden = mode !== 'signin';
  signinButtons();
  $('#menuTitle').textContent = mode === 'signin' ? 'Board' : 'Board (link)';
  $('#menuTeacher').textContent = boardTeacher.get()?.name ?? '';
  $('#menuDlg').showModal();
});
$('#msgRetry').addEventListener('click', () => startSignin());
$('#msgSignin').addEventListener('click', () => {
  store.del();
  startSignin();
});

// ---- Waiting for the teacher's room: a clock, and a call every BOARD_POLL_MS (never while hidden) ----
let pollTimer = 0;
let clockTimer = 0;
let waitingSince = 0;
let polling = false;

function stopWaiting() {
  clearTimeout(pollTimer);
  clearInterval(clockTimer);
  pollTimer = 0;
  clockTimer = 0;
}

function drawClock() {
  $('#waitClock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The waiting screen (once), then ask now. */
function waitFor() {
  if (!waitingSince) waitingSince = Date.now();
  poll();
}

/**
 * Signed in with Spotify, the board is that teacher's: no "Switch teacher" (from the old shared key;
 * another teacher signs in on their own), and "Forget this computer" is plainly "Sign out".
 */
function signinButtons() {
  const signed = Boolean(signedInAs());
  for (const id of ['#waitSwitch', '#menuSwitch']) if (signed) $(id).hidden = true;
  $('#waitForget').textContent = signed ? 'Sign out of this board' : 'Forget this computer';
  $('#menuForget').textContent = signed ? 'Sign out of this board' : 'Forget this computer';
}

function showWaiting(note = '') {
  signinButtons();
  const name = boardTeacher.get()?.name ?? 'the teacher';
  if ($('#waitScreen').hidden) {
    show('wait');
    announce(`Waiting for ${name} to open a room.`);
  }
  $('#waitTitle').textContent = `Waiting for ${name} to open a room…`;
  $('#waitMsg').textContent = note;
  document.title = `RoomDJ board: waiting for ${name}`;
  drawClock();
  if (!clockTimer) clockTimer = setInterval(drawClock, 1000);
  keepAwake();
}

function nextPoll() {
  clearTimeout(pollTimer);
  if (document.visibilityState !== 'visible') return; // back on screen: asks at once (below)
  pollTimer = setTimeout(poll, Date.now() - waitingSince > BOARD_POLL_SLOW_AFTER_MS ? BOARD_POLL_SLOW_MS : BOARD_POLL_MS);
}

/** Ask for the teacher's open room (POST /api/teacher/board; the key in a header, never the URL). */
async function poll() {
  clearTimeout(pollTimer);
  pollTimer = 0;
  if (mode !== 'signin' || polling || conn) return;
  const profile = boardTeacher.get();
  if (!canSignIn()) return showSignin('key');
  if (!profile) return signedInAs() ? startSignin() : showWho();
  polling = true;
  let r = null;
  let data = {};
  try {
    r = await fetch('/api/teacher/board', { method: 'POST', headers: teacherHeaders() });
    data = await r.json().catch(() => ({}));
  } catch {
    r = null;
  } finally {
    polling = false;
  }
  if (mode !== 'signin' || conn || boardTeacher.get()?.id !== profile.id) return; // switched meanwhile
  if (r?.status === 401) {
    if (signedInAs()) {
      forgetSignin();
      boardTeacher.del();
      autoStore.del();
      return showSignin('spotify', data.message || 'Sign in with Spotify again.');
    }
    forgetTeacherKey();
    return showSignin('key', 'The teacher key changed (or this one does not work any more). Type the new one.');
  }
  if (r?.status === 400 && data.error === 'profile') {
    boardTeacher.del();
    return showWho('That teacher is not on the list any more. Pick who is teaching.');
  }
  if (r?.ok && ROOM_ID_PATTERN.test(data.room ?? '') && BOARD_TOKEN_PATTERN.test(data.boardToken ?? '')) {
    const entry = { room: data.room, token: data.boardToken, profile: profile.id };
    autoStore.set(entry);
    waitingSince = 0;
    resetRoomView();
    return start(entry);
  }
  showWaiting(r && (r.status === 404 || r.status === 429) ? '' : (data.message && r?.status !== 404 ? data.message : OFFLINE));
  nextPoll();
}

/** The room closed (or this board's token stopped): back to waiting; the teacher's next room is found by itself. */
function roomGone() {
  autoStore.del();
  state = null;
  waitingSince = Date.now();
  showWaiting();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, 1500);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mode === 'signin' && !$('#waitScreen').hidden && !polling) poll();
});

// ---- Start: the link's fragment, else the link kept from earlier, else the sign-in ----
/** The fragment's room + token (null: none), taken out of the address bar at once (the projector shows it). */
function takeFragment() {
  const link = parseBoardFragment(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (link) store.set(link);
  return link;
}
const saved = takeFragment() ?? store.get();
if (saved) start(saved);
else startSignin();

// A new link pasted into this same tab only changes the fragment (no reload): start over with it.
addEventListener('hashchange', () => {
  const link = takeFragment();
  if (!link) return;
  stop();
  mode = 'link';
  resetRoomView();
  start(link);
});
