// The teacher's host page (the classroom computer on the projector): open today's room with the
// teacher key and a class code (suggested, or the teacher's own) and how long it stays open, show
// the code and the site address, play the top song, and run the room (skip, veto, ban, lock, kick,
// settings, change code, close, and the "Needs a look" list of songs the AI checker did not know).
// The server owns the queue; this page plays what it says is nowPlaying. The server keeps only
// the code's hash, so this page remembers the code it set (cq.host, below) to show it. Closing the
// window does not close the room: reopening /host on this computer rejoins it, and "Take back my
// room" is gone: "Your open rooms" on the start screen opens one here (POST /api/teacher/rooms/resume).
// Before a room: the teacher key, then "Who's teaching?" (teacher profiles, protocol.js TEACHER
// PROFILES; profile.js remembers the pick on this computer), then the open-room form.

import './style.css';
import './host.css';
import './build-stamp.js';
import './menu.css';
import { initThemeButton } from './theme.js';
import { $, announce, artHtml, ask, esc, keepFocus, spotifyMark, toast } from './dom.js';
import { connectRoom, roomExists, roomSocketUrl } from './room-socket.js';
import { createPlayer } from './player.js';
import { initMusic } from './music.js';
import { answerLookup } from './host-lookup.js';
import { initShortcuts } from './shortcuts.js';
import { initFiller } from './filler.js';
import { NOTE_MAX, REASONS, ROOM_ID_PATTERN, SETTINGS_LIMITS, TEACHER_REASONS, whyText } from '../../shared/protocol.js';
import { screenNote } from '../../shared/reasons.js';
import { CREDITS_MAX, CREDIT_GRANT_MAX, DISCLAIMER_SECONDS } from '../../shared/protocol.js';
import { SPOTIFY, catalogOf } from '../../shared/catalog.js';
import { displayCode, generateCode, normalizeCode, validateCode } from '../../shared/code.js';
import { fillSongSettings, initClassTime, readSongSettings } from './classtime.js';
import { initHighlights } from './highlights.js';
import { chooseProfile, currentProfile, forgetProfile, prefKey } from './profile.js';
import { PROFILES_MAX } from '../../shared/protocol.js';
import { cleanProfileName } from '../../shared/profiles.js';
import { showTimes } from './times.js';
import { noteServerTime } from './server-clock.js';
import { initRepeats } from './repeats-host.js';
import { initBoardHost } from './board-host.js';
import { forgetTeacherKey, KEY_ALLOWED, rememberedKey, saveTeacherKey, teacherKey } from './teacher-key.js';
import { acceptDisclaimer, checkSignin, finish, forgetSignin, login, sessionHeaders, signOut, signedInAs, signinReturn, staysSignedIn, updateAccount } from './account.js';
import { cleanClientId } from '../../shared/accounts.js';
import { isFreeTeacher } from '../../shared/protocol.js';
import { initTeacherSuggest } from './teacher-suggest.js';
import { NEXT_LOCK_S, PUSH_TAG, byLabel } from '../../shared/protocol.js';
import { BACK_TO_WORK_MINUTES, DEFAULT_SETTINGS, DOWNVOTE_CHOICES, UPVOTE_CHOICES } from '../../shared/protocol.js';
import { clockLeft } from '../../shared/backtowork.js';
import { afterShow, holdForShow } from '../../shared/recap-music.js';
import { initRecapAudio } from './recap-audio.js';
import { closeMenu, menuButtonOf, openMenu, openMenuIn } from './menu.js';
import { initTabs } from './tabs.js';
import { initLayout } from './layout.js';

const HOST = 'cq.host';
const NEXT_RETRY_MS = 5000;

initThemeButton($('#theme'));

const session = {
  get(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
  set(key, v) { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* blocked */ } },
  del(key) { try { sessionStorage.removeItem(key); } catch { /* blocked */ } },
};

// The teacher key lives for this tab only, unless the teacher ticks "Remember on this computer"
// (then also in localStorage, like uploadmymodel's teacher page). Only on their own computer.
// teacher-key.js: the board's sign-in uses the same key, the same way.
const getKey = teacherKey;
const saveKey = (key) => saveTeacherKey(key, $('#remember').checked);
function forgetKey() {
  forgetTeacherKey();
  $('#remember').checked = false;
}
$('#remember').checked = Boolean(rememberedKey());

// cq.host: { room (the room id), classCode, token, until }. players/youtube.js and players/apple.js
// read room + token from sessionStorage for their /api/rooms/<room>/youtube and /api/apple/token
// calls. It is ALSO kept in localStorage until the room's `until`, so closing the window does not
// lock the teacher out of their own room: reopening /host on this computer rejoins. Unlike the
// teacher key, the host token is per room, ends with the room and controls only that room.
const hostStore = {
  get() {
    const fresh = (v) => (v && Number(v.until) > Date.now() ? v : null);
    let local = null;
    try { local = JSON.parse(localStorage.getItem(HOST)); } catch { /* blocked */ }
    if (local && !fresh(local)) try { localStorage.removeItem(HOST); } catch { /* blocked */ }
    return fresh(session.get(HOST)) ?? fresh(local);
  },
  set(v) {
    session.set(HOST, v);
    try { localStorage.setItem(HOST, JSON.stringify(v)); } catch { /* blocked */ }
  },
  /** Forget it; the localStorage copy only while it is still this token (another tab may have a newer one). */
  del(token) {
    session.del(HOST);
    try {
      const local = JSON.parse(localStorage.getItem(HOST));
      if (!local || local.token === token) localStorage.removeItem(HOST);
    } catch { /* blocked */ }
  },
};

let conn = null;
let room = null;
let state = null;
let joined = false;

// The board on a second computer (board-host.js; protocol.js BOARD + REMOTE). Its token is kept
// with the room entry (cq.host); another tab of this computer may have made a newer one.
let lastT = 0;
let lockAsked = { id: null, at: 0 }; // NEXT LOCK: the last lockNext sent
let lastD = 0;
const boardHost = initBoardHost({
  send: (msg) => Boolean(conn?.send(msg)),
  room: () => room,
  saveToken(token) {
    if (!room) return;
    room.boardToken = token;
    hostStore.set(room);
  },
  latestToken() {
    try {
      const local = JSON.parse(localStorage.getItem(HOST));
      return local && room && local.room === room.room && local.token === room.token ? local.boardToken ?? null : null;
    } catch {
      return null;
    }
  },
  display: () => ({ size: prefs.size, who: prefs.who, art: prefs.art }),
  player: () => ({ id: loadedId, pos: lastT, dur: lastD, started, paused }),
});

// ---- Screens ----
let hostLayout = null; // ✏️ Edit layout (below)
function show(screen) {
  if (screen !== 'hostScreen') hostLayout?.leave({ focus: false });
  for (const id of ['startScreen', 'hostScreen', 'closedScreen']) $(`#${id}`).hidden = id !== screen;
  // The logo goes home: in this tab, except while a room runs here (a new tab, so the music plays on).
  const running = screen === 'hostScreen';
  document.body.classList.toggle('room-open', running); // host.css: the bar's room tools need the space
  $('#brandHome').target = running ? '_blank' : '';
  $('#brandHome').rel = running ? 'noopener' : '';
  $('#brandHome').setAttribute('aria-label', running ? 'RoomDJ home (opens in a new tab, the music keeps playing)' : 'RoomDJ home');
  $('#roomTools').hidden = screen !== 'hostScreen';
  $('#connPill').hidden = screen !== 'hostScreen';
  $('#teacherPill').hidden = screen !== 'hostScreen' || !state?.teacher;
}

/** The start screen's step: 'signinStep' (Spotify), 'keyStep' (teacher key), 'whoStep' (who's teaching?) or 'keyForm' (open a room). */
function showStep(step) {
  for (const id of ['signinStep', 'keyStep', 'whoStep', 'keyForm']) $(`#${id}`).hidden = id !== step;
}

// The old teacher key: local test servers only (teacher-key.js KEY_ALLOWED; no button, the tests set
// localStorage cq.useKey), kept on this computer until a Spotify sign-in.
const USE_KEY = 'cq.useKey';
let usingKey = KEY_ALLOWED && (() => { try { return localStorage.getItem(USE_KEY) === '1'; } catch { return false; } })();

/**
 * The start screen: signed in with Spotify → the open-room form as that teacher. Otherwise the
 * Spotify sign-in (or the teacher key, then who's teaching), then the open-room form.
 */
function showStart(message = '') {
  show('startScreen');
  for (const id of ['#openBtn', '#keyNext', '#signinBtn', '#sharedBtn']) $(id).disabled = false;
  const signed = signedInAs();
  if (signed) {
    const then = new URLSearchParams(location.search).get('then');
    if (then === 'board') return location.replace('/board/');
    if (then === 'admin') return location.replace('/admin/');
    if (chooseProfile(signed.account.profile)) return location.reload(); // that teacher's preferences
  } else if (!getKey() && !usingKey) {
    return showSignin(message);
  } else if (!getKey()) {
    showStep('keyStep');
    $('#keyStepMsg').textContent = message;
    return $('#key').focus();
  }
  const p = currentProfile();
  if (!p) return showWho(message);
  showStep('keyForm');
  $('#teachingName').textContent = p.name;
  $('#keyMsg').textContent = message;
  $('#switchTeacher').hidden = Boolean(signed);
  $('#renameMe').hidden = !signed;
  $('#signOutBtn').hidden = !signed;
  $('#adminLink').hidden = !signed?.account.admin; // the server checks again on /admin/
  $('#otherKey').hidden = Boolean(signed);
  showUsage();
  loadOpenRooms();
  if (!$('#openCode').value) suggestCode();
  classTime.prepareOpen(); // "Class ends at": the next bell, or one period from now
  prepareCredits(); // "Song suggestions": this teacher's saved choice
  $('#openBtn').focus();
  checkProfile(); // in the background: renamed, or hidden on another computer
}

/**
 * Headers for a teacher call: the Spotify sign-in's session (it names the teacher), else the key and
 * who's teaching (`profile` overrides the picked one).
 */
function teacherHeaders(profile = currentProfile()?.id, key = getKey()) {
  const signed = sessionHeaders();
  if (signed) return { ...signed, 'content-type': 'application/json' };
  return { 'x-teacher-key': key ?? '', ...(profile ? { 'x-teacher-profile': profile } : {}), 'content-type': 'application/json' };
}

/** Signed in with Spotify, or holding the teacher key. */
const canTeach = () => Boolean(signedInAs() || getKey());

// ---- Free RoomDJ: what is left today (protocol.js FREE TEACHERS; GET /api/teacher/usage) ----
/** "Free RoomDJ today: …" for the start screen and Settings ('' for teachers with no caps). */
function usageText(u, now = Date.now()) {
  if (!u?.free) return '';
  const at = new Date(u.resetsAt);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const when = at.toDateString() === new Date(now).toDateString() ? `today at ${time}` : `tomorrow at ${time}`;
  const part = (k, what) => `${u.left[k]} of ${u.caps[k]} ${what}`;
  let text = `Free RoomDJ, left today: ${part('ai', 'new-song checks')}, ${part('art', 'cover checks')}, ${part('rooms', 'rooms')}. Resets ${when}.`;
  if (u.left.ai === 0) text += ' Until then, new songs wait in Needs a look for you to decide.';
  return text;
}
async function showUsage() {
  const notes = [$('#usageNote'), $('#usageNote2')];
  const id = state?.profile ?? currentProfile()?.id;
  if (!signedInAs() || !isFreeTeacher(id)) return notes.forEach((n) => { n.hidden = true; });
  try {
    const r = await fetch('/api/teacher/usage', { headers: teacherHeaders(id) });
    const text = r.ok ? usageText(await r.json()) : '';
    for (const n of notes) {
      n.textContent = text;
      n.hidden = !text;
    }
  } catch { /* offline: leave it */ }
}

// ---- Who's teaching? (teacher profiles) ----
let profiles = []; // the list from the server (GET /api/teacher/profiles)

/** A profiles call. → { ok, status, data } (status 0: could not reach the server). */
async function profileCall(method, path = '', body = undefined, key = getKey()) {
  try {
    const r = await fetch(`/api/teacher/profiles${path}`, {
      method, headers: teacherHeaders(null, key), ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(data.profiles)) profiles = data.profiles;
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

const OFFLINE = 'Could not reach RoomDJ. Check the internet and try again.';

/** The picked teacher is still on the list (the name may have changed elsewhere). */
async function checkProfile() {
  if (signedInAs()) {
    // Signed in: renamed elsewhere, hidden, or signed out on the server.
    const account = await checkSignin();
    if (account === null && !$('#startScreen').hidden) showStart('Sign in with Spotify again.');
    else if (account) {
      chooseProfile(account.profile);
      $('#teachingName').textContent = account.profile.name;
      $('#adminLink').hidden = !account.admin;
      if (!account.disclaimerOk) showDisclaimer();
    }
    return;
  }
  const r = await profileCall('GET');
  const p = currentProfile();
  if (!r.ok || !p) return;
  const now = profiles.find((x) => x.id === p.id && !x.archived);
  if (!now) {
    forgetProfile();
    if (!$('#startScreen').hidden && !$('#keyForm').hidden) showWho('Pick who is teaching.');
  } else if (now.name !== p.name) {
    chooseProfile(now);
    $('#teachingName').textContent = now.name;
  }
}

// ---- Sign in with Spotify (protocol.js SPOTIFY SIGN-IN; account.js) ----
let sharedClientId = null; // RoomDJ's own Spotify app (GET /api/config), null: none
const configReady = fetch('/api/config').then((r) => r.json()).then((c) => {
  sharedClientId = c?.services?.spotify?.clientId ?? null;
  testAiOff = c?.testAiOff === true;
  $('#testAiSwitches').hidden = !testAiOff;
  $('#couponsSetting').hidden = c?.coupons !== true; // 🎟 built dark: only while the server takes coupons
}).catch(() => {});
let testAiOff = false; // local browser tests only (TEST_AI_OFF=on): the old AI switches show
const OWN_ID = 'cq.ownClientId'; // the Client ID typed last time on this computer (public, not a secret)
const LAST_APP = 'cq.signinApp'; // 'own' | 'shared': the Spotify app this computer signed in with last
let signinMode = 'own'; // what the big button signs in with: 'own' (the Client ID box) or 'shared' (RoomDJ's app)

/**
 * The sign-in step's view: 'setup' (first time: make your own Spotify app, most teachers; invited
 * teachers take the small "no setup" link), 'ready' (back on this computer: one button) or 'busy'
 * (back from Spotify, signing in).
 */
function signinView(view) {
  $('#signinSetup').hidden = view !== 'setup';
  $('#signinReady').hidden = view !== 'ready';
  $('#otherApp').hidden = view !== 'ready';
  $('#sharedRow').hidden = view !== 'setup' || !sharedClientId;
  $('#signinStep').querySelector('.remember-row').hidden = view === 'busy';
  $('#signinBtn').hidden = view === 'busy';
}

async function showSignin(message = '') {
  show('startScreen');
  showStep('signinStep');
  $('#signinMsg').textContent = message;
  $('#redirectUri').textContent = `${location.origin}/host/`;
  await configReady;
  let own = null, last = null;
  try { own = localStorage.getItem(OWN_ID); last = localStorage.getItem(LAST_APP); } catch { /* blocked */ }
  if (own && !$('#clientId').value) $('#clientId').value = own;
  signinMode = last === 'shared' && sharedClientId ? 'shared' : 'own';
  // A failed sign-in shows the setup steps again: they are what fixes most of them.
  const ready = !message && (signinMode === 'shared' || Boolean(own));
  signinView(ready ? 'ready' : 'setup');
  $('#signinBtn').focus({ preventScroll: true }); // keep the top (Student / Teacher) in view
}

$('#otherApp').addEventListener('click', () => {
  signinMode = 'own';
  $('#signinMsg').textContent = '';
  signinView('setup');
  $('#clientId').focus();
});
$('#sharedBtn').addEventListener('click', () => {
  signinMode = 'shared';
  $('#signinStep').requestSubmit();
});
$('#copyRedirect').addEventListener('click', async () => {
  const uri = $('#redirectUri').textContent;
  try {
    await navigator.clipboard.writeText(uri);
    toast('Redirect URI copied. Paste it in your Spotify app.', 'ok');
  } catch {
    window.prompt('Copy the Redirect URI:', uri);
  }
});
$('#signinStep').addEventListener('submit', async (e) => {
  e.preventDefault();
  let clientId = sharedClientId;
  if (signinMode === 'own') {
    clientId = cleanClientId($('#clientId').value);
    if (!clientId) {
      $('#signinMsg').textContent = 'Paste the Client ID from your Spotify app (step 4): 32 letters and numbers.';
      return $('#clientId').focus();
    }
    try { localStorage.setItem(OWN_ID, clientId); } catch { /* blocked */ }
  }
  if (!clientId) return;
  try { localStorage.setItem(LAST_APP, signinMode); } catch { /* blocked */ }
  $('#signinBtn').disabled = true;
  $('#sharedBtn').disabled = true;
  const then = ['board', 'admin'].includes(new URLSearchParams(location.search).get('then')) ? new URLSearchParams(location.search).get('then') : null;
  await login({ clientId, remember: $('#signinRemember').checked, then }); // the page goes to Spotify
});

// ---- The first-sign-in disclaimer (protocol.js DISCLAIMER) ----
// Once per teacher (the server keeps the OK): the checker cannot catch everything. OK unlocks after
// DISCLAIMER_SECONDS; Esc does not close it.
let disclaimerTimer = 0;
function showDisclaimer() {
  const dlg = $('#disclaimerDlg');
  if (dlg.open) return;
  const ok = $('#disclaimerOk');
  let left = DISCLAIMER_SECONDS;
  const draw = () => {
    ok.disabled = left > 0;
    ok.textContent = left > 0 ? `OK (${left})` : 'OK, I understand';
  };
  draw();
  dlg.showModal();
  clearInterval(disclaimerTimer);
  disclaimerTimer = setInterval(() => {
    left--;
    draw();
    if (left <= 0) {
      clearInterval(disclaimerTimer);
      ok.focus();
    }
  }, 1000);
}
$('#disclaimerDlg').addEventListener('cancel', (e) => e.preventDefault());
$('#disclaimerOk').addEventListener('click', async () => {
  const ok = $('#disclaimerOk');
  if (ok.disabled) return;
  ok.disabled = true;
  await acceptDisclaimer(); // not kept (offline): it shows again next time, nothing else changes
  $('#disclaimerDlg').close();
});

/** Signed in: on to the board (it asked), else reload as that teacher (their preferences, their Spotify). */
function afterSignin(done) {
  chooseProfile(done.account.profile);
  try { localStorage.removeItem(USE_KEY); } catch { /* blocked */ }
  // Music from: Spotify, the first time (the sign-in connected it too).
  const music = `cq.music:${done.account.profile.id}`;
  try { if (!localStorage.getItem(music)) localStorage.setItem(music, 'spotify'); } catch { /* blocked */ }
  if (done.then === 'board') location.assign('/board/');
  else if (done.then === 'admin') location.assign('/admin/');
  else location.replace('/host/');
}


$('#signOutBtn').addEventListener('click', async () => {
  await signOut();
  forgetProfile();
  toast('Signed out on this computer.', 'ok');
  showStart();
});

async function showWho(message = '') {
  show('startScreen');
  showStep('whoStep');
  $('#whoMsg').textContent = 'Loading the teachers…';
  const r = await profileCall('GET');
  if (r.status === 401) {
    forgetKey();
    return showStart(r.data.message || 'That teacher key did not work.');
  }
  if (!r.ok) return void ($('#whoMsg').textContent = r.data.message || OFFLINE);
  renderWho();
  $('#whoMsg').textContent = message;
  ($('#whoList .who-pick[aria-current="true"]') ?? $('#whoList .who-pick'))?.focus();
}

function renderWho() {
  const cur = currentProfile()?.id;
  const shown = profiles.filter((p) => !p.archived);
  const hidden = profiles.filter((p) => p.archived);
  keepFocus(() => {
    $('#whoList').innerHTML = shown.map((p) => `<li data-id="${esc(p.id)}">
      <button type="button" class="who-pick" data-act="pick" aria-current="${p.id === cur}">${esc(p.name)}${p.id === cur ? ' <small>· last time on this computer</small>' : ''}</button>
      <button type="button" data-act="rename" aria-label="${esc(`Rename ${p.name}`)}">Rename</button>
      <button type="button" data-act="hide" aria-label="${esc(`Hide ${p.name}`)}">Hide</button>
    </li>`).join('');
    $('#whoHiddenList').innerHTML = hidden.map((p) => `<li data-id="${esc(p.id)}">
      <span class="grow">${esc(p.name)}</span>
      <button type="button" data-act="show" aria-label="${esc(`Show ${p.name} again`)}">Show again</button>
    </li>`).join('');
  });
  $('#whoHidden').hidden = hidden.length === 0;
  $('#whoHiddenCount').textContent = `(${hidden.length})`;
  $('#addTeacherBtn').disabled = profiles.length >= PROFILES_MAX;
  $('#addTeacherBtn').title = profiles.length >= PROFILES_MAX ? `Up to ${PROFILES_MAX} teachers (hidden ones count)` : '';
}

/** Teaching as `p` on this computer. Another teacher's preferences need a reload (only between rooms). */
function pickTeacher(p) {
  if (chooseProfile(p)) return location.reload();
  $('#openCode').value = '';
  showStart();
}

async function whoClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const p = profiles.find((x) => x.id === btn.closest('[data-id]').dataset.id);
  if (!p) return;
  if (btn.dataset.act === 'pick') return pickTeacher(p);
  if (btn.dataset.act === 'rename') return openTeacherDlg(p);
  if (btn.dataset.act === 'hide') {
    const ok = await ask(`Hide ${p.name}?`, 'Hide',
      'Nothing is deleted: their settings, banned and allowed songs and favorites are kept. Show them again under Hidden teachers.');
    if (!ok) return;
  }
  const r = await profileCall('PATCH', `/${encodeURIComponent(p.id)}`, { archived: btn.dataset.act === 'hide' });
  if (!r.ok) return void ($('#whoMsg').textContent = r.data.message || OFFLINE);
  if (btn.dataset.act === 'hide' && currentProfile()?.id === p.id) forgetProfile();
  $('#whoMsg').textContent = '';
  renderWho();
  toast(btn.dataset.act === 'hide' ? `${p.name} is hidden. Nothing was deleted.` : `${p.name} is back on the list.`, 'ok');
}
$('#whoList').addEventListener('click', whoClick);
$('#whoHiddenList').addEventListener('click', whoClick);

let renaming = null; // the profile the teacher dialog renames (null: adding one)
function openTeacherDlg(p = null) {
  renaming = p;
  $('#teacherTitle').textContent = p ? `Rename ${p.name}` : 'Add a teacher';
  $('#teacherSave').textContent = p ? 'Rename' : 'Add';
  $('#teacherName').value = p?.name ?? '';
  $('#teacherMsg').textContent = '';
  $('#teacherSave').disabled = false;
  $('#teacherDlg').showModal();
  $('#teacherName').select();
}
$('#addTeacherBtn').addEventListener('click', () => openTeacherDlg());
$('#teacherCancel').addEventListener('click', () => $('#teacherDlg').close());
$('#teacherForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = cleanProfileName($('#teacherName').value); // the server checks again
  if (!v.ok) return void ($('#teacherMsg').textContent = v.message);
  $('#teacherSave').disabled = true;
  const r = renaming
    ? await profileCall('PATCH', `/${encodeURIComponent(renaming.id)}`, { name: v.name })
    : await profileCall('POST', '', { name: v.name });
  $('#teacherSave').disabled = false;
  if (!r.ok) return void ($('#teacherMsg').textContent = r.data.message || OFFLINE);
  $('#teacherDlg').close();
  if (renaming && currentProfile()?.id === renaming.id) {
    chooseProfile(r.data.profile);
    $('#teachingName').textContent = r.data.profile.name;
    const signed = signedInAs();
    if (signed) updateAccount({ ...signed.account, profile: { ...signed.account.profile, name: r.data.profile.name } });
  }
  renderWho();
  toast(renaming ? `Renamed to ${r.data.profile.name}.` : `Added ${r.data.profile.name}. Pick them to start.`, 'ok');
  $(`#whoList [data-id="${CSS.escape(r.data.profile.id)}"] .who-pick`)?.focus();
});

$('#switchTeacher').addEventListener('click', () => showWho());
$('#renameMe').addEventListener('click', () => {
  const p = currentProfile();
  if (p) openTeacherDlg(p);
});
$('#otherKey2').addEventListener('click', () => {
  forgetKey();
  showStart();
});

// Step 1: the teacher key, checked by loading the teachers.
$('#keyStep').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('#key').value;
  if (!key) return $('#key').focus();
  $('#keyNext').disabled = true;
  $('#keyStepMsg').textContent = '';
  const r = await profileCall('GET', '', undefined, key);
  $('#keyNext').disabled = false;
  if (r.status === 401) {
    $('#keyStepMsg').textContent = r.data.message || 'That teacher key did not work.';
    return $('#key').select();
  }
  if (!r.ok) return void ($('#keyStepMsg').textContent = r.data.message || OFFLINE);
  saveKey(key);
  $('#key').value = '';
  const p = currentProfile();
  if (p && profiles.some((x) => x.id === p.id && !x.archived)) showStart();
  else showWho();
});

/** A suggested code in the box (marked, so "Take back" can tell it is not one the teacher typed). */
function suggestCode() {
  $('#openCode').value = displayCode(generateCode());
  $('#openCode').dataset.suggested = '1';
}
$('#openCode').addEventListener('input', () => delete $('#openCode').dataset.suggested);
$('#newCode').addEventListener('click', suggestCode);

function leaveRoom() {
  conn?.stop();
  conn = null;
  joined = false;
  state = null;
  classTime.reset();
  if (room) hostStore.del(room.token);
  room = null;
  boardHost.reset();
  picks.reset();
  stopMusic();
  filler.setBlocked(true); // the room closed: background music stops
}

function showClosed(title, text) {
  leaveRoom();
  $('#closedTitle').textContent = title;
  $('#closedText').textContent = text;
  show('closedScreen');
  $('#newRoomBtn').focus();
}

// ---- Teacher key + open a room ----
$('#otherKey').addEventListener('click', () => {
  forgetKey();
  showStart();
});

/**
 * Open a room (POST /api/teacher/rooms) with the typed class code and times, then go in. A room
 * already open is opened from "Your open rooms" instead (openRoomHere).
 */
// ---- Quick start: Song suggestions (credits or unlimited) on the open-room form ----
// Prefilled from this teacher's saved settings; what they pick is sent with the new room and kept
// as their default (src/worker.js createRoom).
const creditsPick = () => $('#keyForm').querySelector('input[name="openCredits"]:checked')?.value ?? 'unlimited';
function showCreditsRow() {
  const on = creditsPick() === 'credits';
  $('#openCreditsRow').hidden = !on;
  $('#openCreditsN').disabled = !on; // a hidden bad number must never block Open (readCredits checks it)
}
// 📚 Back to work (quick start): Off or one of BACK_TO_WORK_MINUTES.
$('#openRest').innerHTML = ['<option value="off">Off: no wait</option>',
  ...BACK_TO_WORK_MINUTES.map((m) => `<option value="${m}">${m} ${m === 1 ? 'minute' : 'minutes'}</option>`)].join('');
function setRestPick(s) {
  $('#openRest').value = s.backToWork === false ? 'off' : String(s.backToWorkMinutes ?? DEFAULT_SETTINGS.backToWorkMinutes);
}
setRestPick(DEFAULT_SETTINGS);
/** The quick choice as settings: { backToWork, backToWorkMinutes } (Off keeps the minutes it had). */
function readRest(saved) {
  const v = $('#openRest').value;
  return v === 'off'
    ? { backToWork: false, backToWorkMinutes: saved?.backToWorkMinutes ?? DEFAULT_SETTINGS.backToWorkMinutes }
    : { backToWork: true, backToWorkMinutes: Number(v) };
}
let savedQuick = null; // the saved settings the quick choices were filled from
let quickTouched = false; // the teacher changed a quick choice on this form
/** The quick choices to send: only once the saved ones are shown, or the teacher picked (never the
 *  form's starting values over a saved default that has not loaded yet). */
function quickChoices(credits) {
  if (!savedQuick && !quickTouched) return {};
  return { startingCredits: credits.startingCredits, ...readRest(savedQuick) };
}

function setCreditsPick(startingCredits) {
  const on = Number.isInteger(startingCredits);
  $('#keyForm').querySelector(`input[name="openCredits"][value="${on ? 'credits' : 'unlimited'}"]`).checked = true;
  if (on) $('#openCreditsN').value = String(startingCredits);
  showCreditsRow();
}
async function prepareCredits() {
  if (!$('#keyForm').querySelector('input[name="openCredits"]:checked')) setCreditsPick(DEFAULT_SETTINGS.startingCredits);
  try {
    const r = await fetch('/api/teacher/settings', { headers: teacherHeaders() });
    if (r.ok) {
      savedQuick = await r.json();
      if (!quickTouched) { // never undo what the teacher already picked on this form
        setCreditsPick(savedQuick.startingCredits ?? null);
        setRestPick(savedQuick);
      }
    }
  } catch { /* offline: keep what is shown */ }
}
$('#keyForm').addEventListener('change', (e) => {
  if (['openCredits', 'openCreditsN', 'openRest'].includes(e.target.name || e.target.id)) quickTouched = true;
  if (e.target.name === 'openCredits') {
    showCreditsRow();
    if (creditsPick() === 'credits') $('#openCreditsN').select();
  }
});
/** → { ok: true, startingCredits: null | number } | { ok: false, message } */
function readCredits() {
  if (creditsPick() !== 'credits') return { ok: true, startingCredits: null };
  const n = Number($('#openCreditsN').value);
  const [lo, hi] = SETTINGS_LIMITS.startingCredits;
  if (!Number.isInteger(n) || n < lo || n > hi) return { ok: false, message: `Starting credits: a whole number from ${lo} to ${hi}.` };
  return { ok: true, startingCredits: n };
}

async function startRoom() {
  const key = getKey();
  if (!canTeach()) return showStart();
  const profile = currentProfile();
  if (!profile) return showWho('Pick who is teaching.');
  const v = validateCode($('#openCode').value);
  if (!v.ok) {
    showStart(v.message);
    return $('#openCode').focus();
  }
  // Class end + cleanup start in this computer's own time zone, sent as absolute times (classtime.js).
  const times = classTime.readOpen();
  if (!times.ok) {
    $('#keyMsg').textContent = times.message;
    return $(times.focus)?.focus();
  }
  const credits = readCredits();
  if (!credits.ok) {
    $('#keyMsg').textContent = credits.message;
    return $('#openCreditsN').focus();
  }
  $('#openBtn').disabled = true;
  $('#keyMsg').textContent = '';
  let r, data;
  try {
    r = await fetch('/api/teacher/rooms', {
      method: 'POST',
      headers: teacherHeaders(profile?.id, key),
      body: JSON.stringify({ code: v.code, until: times.until, cleanupAt: times.cleanupAt, profile: profile.id, period: times.period ?? null, ...quickChoices(credits) }),
    });
    data = await r.json().catch(() => ({}));
  } catch {
    return showStart('Could not reach RoomDJ. Check the internet and try again.');
  }
  if (r.status === 401) {
    if (signedInAs()) {
      forgetSignin();
      return showStart(data.message || 'Sign in with Spotify again.');
    }
    forgetKey();
    $('#key').value = '';
    return showStart(data.message || 'That teacher key did not work.');
  }
  if (data.error === 'profile') {
    // That teacher was hidden (or is gone) on another computer: pick again.
    forgetProfile();
    return showWho(data.message);
  }
  if (!r.ok || !ROOM_ID_PATTERN.test(data.room ?? '') || !data.hostToken) {
    if (data.error === 'code_taken') {
      // Most likely the teacher's own room: it is under "Your open rooms" (Open here).
      showStart('A room with that class code is already open. If it is yours, open it under "Your open rooms" above, or pick another code.');
      return $('#openCode').focus();
    }
    showStart(data.message || 'Could not open a room. Try again.');
    if (data.error === 'invalid_code') $('#openCode').focus();
    return;
  }
  $('#openCode').value = '';
  enterRoom({ room: data.room, classCode: data.code, token: data.hostToken, until: data.until });
}

$('#keyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  startRoom();
});

$('#newRoomBtn').addEventListener('click', () => showStart());

// ---- "Your open rooms" (GET /api/teacher/rooms): each of this teacher's live rooms, opened here
// with one click (POST /api/teacher/rooms/resume; a new host token, any other page running it stops).
// It replaced "Take back a room I already opened" (type the code), which confused people.
async function loadOpenRooms() {
  let rooms = [];
  try {
    const r = await fetch('/api/teacher/rooms', { headers: teacherHeaders() });
    if (r.ok) rooms = (await r.json()).rooms ?? [];
  } catch { /* offline: no list */ }
  const list = $('#openRoomsList');
  list.replaceChildren(...rooms.map((x) => {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.className = 'grow';
    const code = document.createElement('b');
    code.textContent = x.code ? displayCode(x.code) : 'Open room';
    const meta = document.createElement('small');
    const ends = new Date(x.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    meta.textContent = [x.period, `ends ${ends}`, `${x.students} student${x.students === 1 ? '' : 's'}`, x.hostOnline ? 'open on a computer now' : null].filter(Boolean).join(' · ');
    info.append(code, document.createElement('br'), meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = 'Open here';
    btn.addEventListener('click', () => openRoomHere(x, btn));
    li.append(info, btn);
    return li;
  }));
  $('#openRooms').hidden = rooms.length === 0;
}

async function openRoomHere(x, btn) {
  btn.disabled = true;
  try {
    const r = await fetch('/api/teacher/rooms/resume', { method: 'POST', headers: teacherHeaders(), body: JSON.stringify({ room: x.room }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !ROOM_ID_PATTERN.test(data.room ?? '') || !data.hostToken) {
      toast(data.message || 'That room is closed now.', 'bad');
      return loadOpenRooms();
    }
    enterRoom({ room: data.room, classCode: data.code ?? x.code ?? '', token: data.hostToken, until: data.until });
    toast('Your room is open here. Students stay in it.', 'ok');
  } catch {
    toast('Could not reach RoomDJ. Check the internet and try again.', 'bad');
  } finally {
    btn.disabled = false;
  }
}

// "Close my open rooms": every room this teacher has open (here or on another computer) closes, like
// Close room in each (POST /api/teacher/rooms/close-all; each room checks it is this teacher's).
$('#closeAllBtn').addEventListener('click', async () => {
  const ok = await ask('Close all your open rooms?', 'Close them',
    'The music stops in each one, students are sent out, and every room\'s songs, votes and nicknames are deleted.');
  if (!ok) return;
  $('#closeAllBtn').disabled = true;
  try {
    const r = await fetch('/api/teacher/rooms/close-all', { method: 'POST', headers: teacherHeaders() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return void toast(data.message || 'Could not close your rooms. Try again.', 'bad');
    const kept = hostStore.get();
    if (kept) hostStore.del(kept.token); // this computer's room entry is gone with the room
    toast(data.closed ? `Closed ${data.closed} room${data.closed === 1 ? '' : 's'}.` : 'You had no open rooms.', 'ok');
    loadOpenRooms();
  } catch {
    toast('Could not reach RoomDJ. Check the internet and try again.', 'bad');
  } finally {
    $('#closeAllBtn').disabled = false;
  }
});

// ---- The room ----
// No QR code: students may not have phones in school (Dalton). The board shows the address and
// the code; "Copy join link" gives a link for Google Classroom that fills in the code.
$('#copyLink').addEventListener('click', async () => {
  const url = $('#copyLink').dataset.url;
  try {
    await navigator.clipboard.writeText(url);
    toast('Join link copied. Paste it in Google Classroom or an email.', 'ok');
  } catch {
    window.prompt('Copy this join link:', url);
  }
});

/** Show the class code: big on the board, and in the join link (it prefills the student's code box). */
function showCode(classCode) {
  room.classCode = classCode;
  hostStore.set(room);
  const shown = displayCode(classCode);
  const url = `${location.origin}/?code=${encodeURIComponent(classCode)}`;
  $('#bigCode').innerHTML = shown.split(' ').map((w) => `<span>${esc(w)}</span>`).join('');
  $('#bigCode').setAttribute('aria-label', shown);
  $('#copyLink').dataset.url = url;
  document.title = `RoomDJ: ${shown}`;
  boardHost.sendInfo(); // the board shows the code too (the server keeps only its hash)
}

function enterRoom({ room: id, classCode, token, until, boardToken = null }) {
  room = { room: id, classCode, token, until, ...(typeof boardToken === 'string' ? { boardToken } : {}) };
  highlights.reset();
  joined = false;
  showCode(classCode);
  $('#joinHost').textContent = location.host;
  showTimes({ until });
  $('#nowPlaying').innerHTML = '<p class="note">Connecting…</p>';
  show('hostScreen');
  if (prefs.startBig) setBig(true);
  conn = connectRoom(roomSocketUrl(id, { role: 'host', token }), { onMessage, onStatus });
}

// After about 15 s of failed tries (1 + 2 + 4 + 8 s backoff), offer a reload: a stuck socket or a
// school filter (Fortinet SSL inspection breaks the WebSocket) does not always come back alone.
const STUCK_TRIES = 4;
$('#connReload').addEventListener('click', () => location.reload());

async function onStatus(status, fails) {
  const pill = $('#connPill');
  $('#connBanner').hidden = status !== 'retrying' || fails < 2; // a one-try blip stays in the pill
  $('#connStuck').hidden = status !== 'retrying' || fails < STUCK_TRIES;
  if (status === 'open') {
    pill.classList.remove('off');
    $('#connText').textContent = 'Connected';
    tellService();
    boardHost.connected();
    return;
  }
  if (status === 'ended') {
    // Normally the server's last message got here first; this is the backup.
    if (fails === 4000) return showClosed('The room is closed', 'All of the room\'s songs, votes and nicknames are deleted.');
    leaveRoom();
    return showStart('Could not connect to that room. Open a new room.');
  }
  pill.classList.add('off');
  $('#connText').textContent = 'Reconnecting…';
  if (fails < 2) return;
  const mine = conn;
  const exists = await roomExists(room.room);
  if (conn !== mine) return;
  if (exists === false) {
    showClosed('This room has ended', 'It reached its closing time, was closed, or sat unused for 12 hours. Open a new room to start again.');
  } else if (exists === true && !joined && fails >= 3) {
    leaveRoom();
    showStart('Could not connect to that room. Open a new room.');
  }
}

function onMessage(msg) {
  if (picks.onMessage(msg)) return; // the teacher's own picks: search, answers, repeats (teacher-suggest.js)
  if (highlights.onMessage(msg)) return; // recap, favorites (highlights.js)
  if (repeats.onMessage(msg)) return; // 😴 resting songs (repeats-host.js)
  if (boardHost.onMessage(msg)) return; // the new board link (board-host.js)
  switch (msg.t) {
    case 'remote':
      onRemote(msg.action);
      break;
    case 'lookup':
      // The room's iTunes call: this computer makes it (see host-lookup.js).
      answerLookup(msg, (m) => conn?.send(m));
      break;
    case 'state':
      noteServerTime(msg.state); // SERVER CLOCK (protocol.js): on arrival, not when drawn
      joined = true;
      noteRests(msg.state);
      render(msg.state);
      syncPlayback();
      // Background music: off in cleanup mode; back when nothing plays and the queue is empty.
      filler.setBlocked(msg.state.cleanup === true);
      if (!msg.state.nowPlaying && msg.state.queue.length === 0) filler.event('idle');
      break;
    case 'blocked':
      blocked = Array.isArray(msg.list) ? msg.list : [];
      renderBlocked();
      break;
    case 'error':
      if (msg.error === 'host_moved') {
        // "Take back my room" on another computer: this page's host token is dead. The server
        // closes with 4002 next, so the socket does not reconnect.
        showClosed('This room was opened on another computer',
          'The room is still open there, and students stay in it. To run it from this computer again, open the RoomDJ teacher panel here and pick it under "Your open rooms".');
      } else if (!joined) {
        // Refused before the first snapshot (no such room, or the host token is old).
        const code = room?.classCode;
        leaveRoom();
        if (msg.error === 'host') {
          // Taken back on another computer since: offer to take it back here (the code is filled in).
          showStart('This room is now run from another computer. To run it here, press "Take back a room I already opened".');
          if (code) {
            $('#openCode').value = displayCode(code);
            delete $('#openCode').dataset.suggested;
          }
        } else if (msg.error === 'no_room') {
          showStart('Your room from earlier has closed. Open a new room.');
        } else {
          showStart(msg.message || 'Could not connect to that room. Open a new room.');
        }
      } else {
        toast(msg.message || 'Something went wrong.', 'bad');
      }
      break;
    case 'times':
      classTime.onTimes(msg);
      break;
    case 'code':
      if (msg.ok) {
        showCode(msg.code);
        $('#codeDlg').close();
        toast(`The class code is now "${displayCode(msg.code)}".`, 'ok');
      } else {
        $('#codeMsg').textContent = msg.message || 'That class code did not work.';
        $('#codeSave').disabled = false;
      }
      break;
    case 'closed':
      showClosed(msg.why === 'until' ? 'The room closed for today' : 'The room is closed',
        'All of the room\'s songs, votes and nicknames are deleted.');
      break;
  }
}

// ---- Change the class code mid-day ----
$('#changeCodeBtn').addEventListener('click', () => {
  $('#codeInput').value = displayCode(generateCode());
  $('#codeMsg').textContent = '';
  $('#codeSave').disabled = false;
  $('#codeDlg').showModal();
  $('#codeInput').select();
});
$('#codeNew').addEventListener('click', () => { $('#codeInput').value = displayCode(generateCode()); });
$('#codeCancel').addEventListener('click', () => $('#codeDlg').close());
$('#codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = validateCode($('#codeInput').value);
  if (!v.ok) return void ($('#codeMsg').textContent = v.message);
  if (normalizeCode(room?.classCode) === v.code) return $('#codeDlg').close();
  if (send({ t: 'code', code: v.code })) $('#codeSave').disabled = true; // the server's 'code' answer closes it
});

// ---- Rendering ----
const signed = (n) => (n > 0 ? `+${n}` : String(n));
let lastNowId; // undefined until the first render, so the first snapshot replaces "Connecting…"
let seenReview = null; // review item ids already shown (null until the first snapshot)

function render(s) {
  state = s;
  // The room's own teacher (a room taken back from another computer keeps its teacher).
  $('#teacherPillName').textContent = s.teacher ?? '';
  $('#teacherPill').hidden = !s.teacher || $('#hostScreen').hidden;
  classTime.render(s); // class end note, cleanup banner (and the fade, onCleanup)
  highlights.render(s); // Top 5 (dialog, and the board in cleanup mode)
  boardHost.render(s); // "📺 Board connected"
  if (room && s.until !== room.until) {
    room.until = s.until; // "Change times": the saved entry lasts until the new class end
    hostStore.set(room);
  }
  const now = s.nowPlaying;
  $('#aiWarn').hidden = s.aiStatus !== 'failing';
  $('#aiWarn').textContent = 'The song checker is not working, so new songs wait in "Needs a look" for you.';
  renderReview(s.review ?? []);

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
            ${artNote(now.song)}
            <p class="now-by">Suggested by ${esc(byLabel(now))}</p>
            <p class="now-votes"><span aria-hidden="true">👍</span> <span class="n"></span><span class="sr-only"> thumbs up</span></p>
            ${spotifyMark(now.song) ? `<p class="now-sp">${spotifyMark(now.song)}</p>` : ''}
          </div>
        </div>`
      : '<p class="now-empty"></p>';
    if (now) announce(`Now playing: ${now.song.title} by ${now.song.artist}.`);
  }
  // The song playing takes 👍 too (protocol.js VOTES): its count, live.
  const nowUp = $('.now-votes .n');
  if (nowUp && now && nowUp.textContent !== String(now.up)) nowUp.textContent = now.up;
  const empty = $('.now-empty');
  if (empty) empty.textContent = s.queue.length ? 'Ready when you are.' : 'Waiting for songs. Students, suggest one!';
  $('#skipBtn').disabled = !now;
  // The teacher's own 👍 on the song playing (one vote, like a student's: TEACHER PICKS).
  $('#nowUpBtn').disabled = !now;
  $('#favsBtn').hidden = !player?.saveToFavs;
  $('#favsBtn').disabled = !now;
  $('#nowUpBtn').setAttribute('aria-pressed', String(now?.myVote === 1));
  $('#nowUpBtn').setAttribute('aria-label', now?.myVote === 1 ? 'Take back your thumbs up for the song playing' : 'Give the song playing your thumbs up');
  picks.onState(s);
  $('#banNowBtn').disabled = !now;
  $('#banNowMore').disabled = !now;
  $('#nowMenuBtn').disabled = !now;
  if (!now && openMenuIn($('#nowMenu'))) closeMenu();

  $('#lockBtn').setAttribute('aria-checked', String(s.locked));
  $('#roomMenuLock').hidden = !s.locked; // 🔒 on the Room menu too
  $('#lockBtn').textContent = s.locked ? '🔒 Suggestions locked' : '🔓 Suggestions open';
  $('#lockBtn').classList.toggle('on', s.locked);
  $('#lockedNote').hidden = !s.locked;

  const students = s.students ?? [];
  const online = students.filter((x) => x.online).length;
  $('#studentCount').textContent = `(${online})`;
  if ($('#studentsDlg').open) renderStudents();

  $('#queueCount').textContent = s.queue.length ? `(${s.queue.length})` : '';
  $('#queueEmpty').hidden = s.queue.length > 0;
  // A row's ⋯ menu that is open stays open across the re-render (votes come in all the time).
  const openRow = openMenuIn($('#queue'))?.closest('[data-id]')?.dataset.id ?? null;
  keepFocus(() => {
    $('#queue').innerHTML = s.queue.map((item, i) => `<li class="qitem${item.jumped ? ' jumped' : ''}${item.pushed ? ' pushed' : ''}" data-id="${esc(item.id)}">
      <span class="rank">${i + 1}</span>
      ${artHtml(item.song, 100)}
      <span class="song-text"><span class="song-title">${esc(item.song.title)}</span>
        <span class="song-artist">${spotifyMark(item.song)}${esc(item.song.artist)}<span class="qby"> · by ${esc(byLabel(item))}</span>${item.jumped ? ` · <span class="jtag">⚡ Jumped by ${esc(item.jumped.by)}</span>` : ''}</span>
        ${artNote(item.song)}
        ${item.pushed ? `<span class="ptag">${PUSH_TAG}</span>` : ''}</span>
      ${scoreHtml(item, s.downvoteMode).replace(/<\/span>$/, `${ghostHtml(item)}</span>`)}
      <span class="item-tools">
        ${s.upvotes === false ? '' : `<button type="button" data-act="up" class="tvote" aria-pressed="${item.myVote === 1}" aria-label="${esc(`Your thumbs up for ${item.song.title}`)}" title="Your vote (one vote, like a student's)">👍</button>`}
        ${s.downvoteMode === 'off' ? '' : `<button type="button" data-act="down" class="tvote" aria-pressed="${item.myVote === -1}" aria-label="${esc(`Your thumbs down for ${item.song.title}`)}" title="Your vote (one vote, like a student's)">👎</button>`}
        ${rowMenu(item, i)}
      </span>
    </li>`).join('');
    if (openRow) {
      closeMenu(); // the old row is gone
      const btn = $(`#queue [data-id="${CSS.escape(openRow)}"] .menu-btn`);
      if (btn) openMenu(btn, { focus: false });
    }
  });
}

/**
 * A queue row's votes (protocol.js DOWNVOTE MODE): 'off' → the 👍 count alone (👎 are ignored);
 * 'hidden' → the net and 👎 for the teacher, small and muted, but 👍 alone in big screen (the class
 * may see it); 'shown' (or a room from before the setting) → the net with 👍 and 👎.
 */
function scoreHtml(item, mode) {
  if (mode === 'off') return `<span class="score" title="👍 ${item.up}"><b>👍 ${item.up}</b></span>`;
  if (mode === 'hidden') {
    return `<span class="score down-hidden" title="👍 ${item.up}, 👎 ${item.down} (only you see 👎)"><b class="for-host">${signed(item.score)}</b><b class="for-class">👍 ${item.up}</b>`
      + `<small class="for-host">👍 ${item.up} · <span class="down-muted">👎 ${item.down}</span></small></span>`;
  }
  return `<span class="score" title="👍 ${item.up}, 👎 ${item.down}"><b>${signed(item.score)}</b><small>👍 ${item.up} · 👎 ${item.down}</small></span>`;
}

/**
 * 👻 (protocol.js GHOST VOTE): the room sends `ghost` to the host only. A small muted mark for the
 * teacher on the normal view; never on the Big screen (the class may see it).
 */
function ghostHtml(item) {
  return item.ghost === 1 ? '<span class="ghost-mark" title="Includes a ghost 👍 (students cannot tell)"><span aria-hidden="true">👻</span><span class="sr-only">, includes a ghost thumbs up</span></span>' : '';
}

/**
 * 🖼 A cover the art check hid (protocol.js ALBUM ART; the server sends artKey + artReason to the host
 * only): the reason and Show anyway, which shows it for this teacher from now on.
 */
function artNote(song) {
  if (!song?.artKey) return '';
  return `<span class="art-note">🖼 cover hidden${song.artReason ? `: ${esc(song.artReason)}` : ''}
    <button type="button" class="linkbtn" data-art-show="${esc(song.artKey)}" title="Show this cover from now on (saved for you, like an approval)"
      aria-label="${esc(`Show the cover of ${song.title} anyway`)}">Show anyway</button></span>`;
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-art-show]');
  if (!btn || !state) return;
  send({ t: 'artShow', key: btn.dataset.artShow });
  btn.disabled = true;
});

/** A queue row's ⋯ menu (menu.js): Play next / Undo, Play now, ⭐ RoomDJ Favs (Spotify), Veto, Veto or ban with a reason, Ban. */
function rowMenu(item, i) {
  const t = esc(item.song.title);
  return `<span class="menu row-menu">
    <button type="button" id="qmb${i}" class="menu-btn more-btn" data-act="menu" aria-haspopup="menu" aria-expanded="false" aria-controls="qm${i}"
      aria-label="More for ${t}" title="Play next, play now, veto or ban">⋯</button>
    <div id="qm${i}" class="menu-pop menu-end" role="menu" aria-labelledby="qmb${i}" hidden>
      ${item.pushed
    ? '<button type="button" role="menuitem" tabindex="-1" data-act="unpush" title="Back to its place">⏬ Undo play next</button>'
    : '<button type="button" role="menuitem" tabindex="-1" data-act="push" title="Free; before votes and jumps">⏫ Play next</button>'}
      <button type="button" role="menuitem" tabindex="-1" data-act="playNow" title="Skips the song playing">▶ Play now</button>
      ${player?.saveToFavs ? '<button type="button" role="menuitem" tabindex="-1" data-act="favs" title="Your own private playlist on Spotify">⭐ Save to RoomDJ Favs</button>' : ''}
      <div role="separator"></div>
      <button type="button" role="menuitem" tabindex="-1" data-act="veto" title="Take it out of the queue">🚫 Veto</button>
      <button type="button" role="menuitem" tabindex="-1" data-act="more" aria-haspopup="dialog" title="The student sees the reason and your note">💬 Veto or ban with a reason…</button>
      <button type="button" role="menuitem" tabindex="-1" data-act="ban" class="danger" title="Take it out and never allow it again">⛔ Ban…</button>
    </div>
  </span>`;
}

function renderReview(review) {
  const fresh = review.filter((item) => seenReview && !seenReview.has(item.id));
  seenReview = new Set(review.map((item) => item.id));
  $('#reviewPanel').hidden = review.length === 0;
  $('#reviewBadge').hidden = review.length === 0;
  // The count shows on the 📋 Lists button too (and keeps that button on the big screen).
  $('#listsBadge').hidden = review.length === 0;
  $('#listsBadge').textContent = review.length;
  $('#listsMenu').classList.toggle('has-review', review.length > 0);
  $('#listsMenuBtn').setAttribute('aria-label', review.length ? `Lists: ${review.length} ${review.length === 1 ? 'song needs' : 'songs need'} a look` : 'Lists');
  $('#reviewBadgeCount').textContent = review.length;
  $('#reviewBadge').setAttribute('aria-label', `Needs a look: ${review.length} ${review.length === 1 ? 'song' : 'songs'}`);
  $('#reviewCount').textContent = review.length ? `(${review.length})` : '';
  $('#reviewSpotify').hidden = !review.some((item) => catalogOf(item.song.id) === SPOTIFY);
  if (fresh.length) {
    const badge = $('#listsMenuBtn');
    badge.classList.remove('bump');
    void badge.offsetWidth; // restart the animation
    badge.classList.add('bump');
    announce(fresh.length === 1
      ? `Needs a look: ${fresh[0].song.title} by ${fresh[0].song.artist}, suggested by ${byLabel(fresh[0])}.`
      : `${fresh.length} new songs need a look.`);
  }
  const freshIds = new Set(fresh.map((item) => item.id));
  keepFocus(() => {
    $('#review').innerHTML = review.map((item) => `<li class="qitem${freshIds.has(item.id) ? ' fresh' : ''}" data-id="${esc(item.id)}">
      ${artHtml(item.song, 100)}
      <span class="song-text"><span class="song-title">${esc(item.song.title)}</span>
        <span class="song-artist">${spotifyMark(item.song)}${esc(item.song.artist)} · by ${esc(byLabel(item))}</span>
        ${artNote(item.song)}
        ${item.checked === 'lyrics' ? '<span class="review-checked">📄 Judged from lyrics: still not sure</span>' : ''}</span>
      <span class="item-tools">
        <button type="button" data-act="allow" class="primary" aria-label="${esc(`Allow ${item.song.title}`)}" title="Put it in the queue">Allow</button>
        <button type="button" data-act="veto" aria-label="${esc(`Remove ${item.song.title}`)}" title="Not this time">Remove</button>
        ${moreButton(item, 'Remove or ban')}
        <button type="button" data-act="ban" class="danger" aria-label="${esc(`Ban ${item.song.title}`)}" title="Remove it and never allow it again">Ban</button>
      </span>
    </li>`).join('');
  });
}

$('#review').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !state) return;
  const id = btn.closest('[data-id]').dataset.id;
  const item = (state.review ?? []).find((q) => q.id === id);
  if (!item) return;
  if (btn.dataset.act === 'allow') send({ t: 'allow', id });
  if (btn.dataset.act === 'veto') send({ t: 'veto', id });
  if (btn.dataset.act === 'more') pickReason({ id, title: item.song.title, actions: ['veto', 'ban'], words: { veto: 'Remove' }, from: btn });
  if (btn.dataset.act === 'ban') {
    const ok = await ask(`Ban "${item.song.title}"?`, 'Ban it',
      'Nobody can suggest it again, in this room or any of your future rooms.');
    if (ok) send({ t: 'ban', id });
  }
});

// 😴 Resting songs live in the ⭐ Favorites dialog, under the favorites (repeats-host.js).
$('#restBtn').addEventListener('click', () => {
  $('#favBtn').click();
  requestAnimationFrame(() => {
    $('#restTitle').scrollIntoView({ block: 'start' });
    $('#restTitle').focus({ preventScroll: true });
  });
});

$('#reviewBadge').addEventListener('click', () => {
  if (document.body.classList.contains('big')) setBig(false); // the Allow / Remove / Ban buttons
  $('#reviewPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('#review button[data-act="allow"]')?.focus();
});

$('#queue').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !state) return;
  const id = btn.closest('[data-id]').dataset.id;
  const item = state.queue.find((q) => q.id === id);
  if (!item) return;
  if (btn.dataset.act === 'up' || btn.dataset.act === 'down') {
    // The teacher's one vote; the same thumb again takes it back (like the student page).
    const want = btn.dataset.act === 'up' ? 1 : -1;
    if (send({ t: 'vote', id, v: item.myVote === want ? 0 : want })) announce(item.myVote === want ? 'Vote taken back.' : `Voted thumbs ${want > 0 ? 'up' : 'down'}.`);
    return;
  }
  if (btn.dataset.act === 'push' || btn.dataset.act === 'unpush') {
    // ⏫ Play next / ⏬ Undo (protocol.js TEACHER PUSH): free, the teacher decides.
    const on = btn.dataset.act === 'push';
    if (send({ t: 'push', id, on })) announce(on ? `${item.song.title} plays next.` : `${item.song.title} is back in its place.`);
    return;
  }
  if (btn.dataset.act === 'playNow') return playChosenNow(item);
  if (btn.dataset.act === 'favs') return saveFavs(item.song);
  if (btn.dataset.act === 'veto') send({ t: 'veto', id });
  if (btn.dataset.act === 'more') pickReason({ id, title: item.song.title, actions: ['veto', 'ban'], from: menuButtonOf(btn) });
  if (btn.dataset.act === 'ban') {
    const ok = await ask(`Ban "${item.song.title}"?`, 'Ban it',
      'It leaves the queue, and nobody can suggest it again, in this room or any of your future rooms.');
    if (ok) send({ t: 'ban', id });
  }
});

/**
 * ▶ Play now (protocol.js TEACHER PUSH): the song playing ends like a Skip and this one plays at
 * once. A quick confirm only while a song plays. `from` is the Skip guard: a song that ended
 * while the dialog was open means the click no longer fits, and the server ignores it.
 */
async function playChosenNow(item) {
  const now = state?.nowPlaying ?? null;
  if (now && !(await ask(`Stop "${now.song.title}" and play "${item.song.title}" now?`, 'Play now'))) return;
  const from = now?.id ?? null;
  if (!send({ t: 'playNow', id: item.id, from })) return;
  if (from) nextAsked = { from, at: Date.now() };
  if (!started) toast('Click Start music to hear it.', 'warn');
}

/** The ▾ button next to Veto / Remove / Ban: the same action with a reason and a note. */
function moreButton(item, what) {
  return `<button type="button" data-act="more" class="more" aria-haspopup="dialog"
    aria-label="${esc(`${what} ${item.song.title}, with a reason`)}" title="${esc(`${what} with a reason`)}">▾</button>`;
}

// ---- The quick-pick: an optional reason + note (shared/protocol.js REASONS) ----
let reasonFor = null; // { id, from }
const ACTION_WORDS = { veto: 'Veto', ban: 'Ban', blockedBan: 'Ban' };
$('#reasonPicks').innerHTML = TEACHER_REASONS.map((id, i) => `<label class="pick"><input type="radio" name="reason" value="${id}"${i === 0 ? ' checked' : ''}>
  <span>${esc(`${REASONS[id].emoji ? `${REASONS[id].emoji} ` : ''}${REASONS[id].teacher}`)}</span></label>`).join('');
$('#reasonNote').maxLength = NOTE_MAX;

/**
 * Open the quick-pick for one song. actions: the buttons it offers ('veto' | 'ban' | 'blockedBan');
 * words: other labels for them (Needs a look says Remove); from: the button to focus afterwards.
 */
function pickReason({ id, title, actions, words = {}, from = null }) {
  reasonFor = { id, from, row: from?.closest?.('#queue [data-id]')?.dataset.id ?? null };
  $('#reasonTitle').textContent = `Why? "${title}"`;
  const first = $('#reasonForm').querySelector('input[name="reason"]');
  first.checked = true;
  $('#reasonNote').value = '';
  $('#reasonMsg').textContent = '';
  $('#reasonBanNote').hidden = !actions.some((a) => a !== 'veto');
  $('#reasonActions').innerHTML = actions.map((a) => `<button type="button" data-do="${a}" class="${a === 'veto' ? 'primary' : 'danger'}">${esc(words[a] ?? ACTION_WORDS[a])}</button>`).join(' ');
  $('#reasonDlg').showModal();
  first.focus();
}
function closeReason() {
  const from = reasonFor?.from;
  const row = reasonFor?.row;
  reasonFor = null;
  $('#reasonDlg').close();
  if (from?.isConnected) from.focus();
  else if (row) $(`#queue [data-id="${CSS.escape(row)}"] .menu-btn`)?.focus(); // the row was drawn again
}
$('#reasonCancel').addEventListener('click', closeReason);
$('#reasonForm').addEventListener('submit', (e) => e.preventDefault()); // Enter in the note: pick a button
$('#reasonActions').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-do]');
  if (!btn || !reasonFor) return;
  const { note, refused } = screenNote($('#reasonNote').value);
  if (refused) {
    $('#reasonMsg').textContent = 'Students cannot be shown that note. Try other words, or leave it empty.';
    return $('#reasonNote').focus();
  }
  const reason = $('#reasonForm').querySelector('input[name="reason"]:checked')?.value ?? 'teacher';
  // A ban left on "Teacher's choice" goes as a plain ban (the student reads "Banned by your teacher").
  const picked = btn.dataset.do !== 'veto' && reason === 'teacher' ? null : reason;
  if (send({ t: btn.dataset.do, id: reasonFor.id, ...(picked ? { reason: picked } : {}), ...(note ? { note } : {}) })) closeReason();
});

// ---- Blocked today (shared/protocol.js BLOCKED): every "no" in this room, and why ----
let blocked = [];
const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const ACTION_TEXT = {
  suggest: 'Suggested by', veto: 'Vetoed; suggested by', remove: 'Removed from Needs a look; suggested by',
  ban: 'Banned; suggested by', blocklist: 'Taken out by a new blocked word; suggested by',
};

function renderBlocked() {
  $('#blockedCount').textContent = `(${blocked.length})`;
  $('#blockedBtn').setAttribute('aria-label', `Blocked today: ${blocked.length} ${blocked.length === 1 ? 'song' : 'songs'}`);
  if (!$('#blockedDlg').open) return;
  keepFocus(() => {
    $('#blockedList').innerHTML = blocked.length ? blocked.map((b) => `<li data-id="${esc(b.id)}">
      ${artHtml(b.song, 100)}
      <div class="blocked-text">
        <p class="song-title">${esc(b.song.title)} <span class="song-artist">· ${esc(b.song.artist)}</span></p>
        <p class="blocked-why">${esc(whyText(b.why, 'teacher'))}</p>
        ${b.detail ? `<p class="blocked-detail">${esc(b.detail)}</p>` : ''}
        <p class="note"><time>${esc(timeOf(b.at))}</time> · ${esc(ACTION_TEXT[b.action] ?? 'By')} ${esc(byLabel(b))}${b.status === 'allowed' ? ' · <b>Allowed</b>' : b.status === 'banned' ? ' · <b>Banned</b>' : ''}</p>
      </div>
      <span class="item-tools">
        ${b.canAllow ? `<button type="button" data-act="allowAnyway" class="primary" aria-label="${esc(`Allow ${b.song.title} anyway`)}" title="${esc(`Put it in the queue for ${b.by}, and allow it from now on`)}">Allow anyway</button>` : ''}
        ${b.canBan ? `<button type="button" data-act="banBlocked" class="danger" aria-label="${esc(`Ban ${b.song.title}`)}" title="Never allow it again">Ban</button>` : ''}
      </span>
    </li>`).join('') : '<li class="note">Nothing blocked yet today.</li>';
  });
}
$('#blockedBtn').addEventListener('click', () => {
  $('#blockedDlg').showModal();
  renderBlocked();
});
$('#blockedList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const entry = blocked.find((b) => b.id === id);
  if (!entry) return;
  if (btn.dataset.act === 'allowAnyway') {
    if (send({ t: 'blockedAllow', id })) toast(`"${entry.song.title}" joins the queue for ${entry.by}.`, 'ok');
  } else if (btn.dataset.act === 'banBlocked') {
    const ok = await ask(`Ban "${entry.song.title}"?`, 'Ban it', 'Nobody can suggest it again, in this room or any of your future rooms.');
    if (ok) send({ t: 'blockedBan', id });
  }
});

function send(msg) {
  if (conn?.send(msg)) return true;
  toast('Reconnecting to the room. Try again in a moment.', 'warn');
  return false;
}

// ---- Toolbar ----
$('#lockBtn').addEventListener('click', () => state && send({ t: 'lock', on: !state.locked }));

// 📚 Back to work (protocol.js BACK TO WORK): when each student's rest ends, timed from the
// snapshot's restLeft (this computer's clock may differ from the server's a little).
const restEnds = new Map(); // device → Date.now() when its rest ends
let restTick = 0;
function noteRests(s) {
  restEnds.clear();
  for (const st of s.students ?? []) if (st.restUntil && st.restLeft > 0) restEnds.set(st.device, Date.now() + st.restLeft);
}
function restHtml(s) {
  const left = (restEnds.get(s.device) ?? 0) - Date.now();
  if (left <= 0) return '';
  return `<span class="rest-tag" title="Back to work: suggesting and voting wait until then">📚 ${clockLeft(left)}</span>
    <button type="button" data-act="letBackIn" aria-label="${esc(`Let ${s.nick} back in now`)}">Let back in</button>`;
}
/** While the Students dialog is open, the 📚 countdowns tick. */
function tickRests() {
  clearTimeout(restTick);
  restTick = 0;
  for (const [device, end] of restEnds) if (end <= Date.now()) restEnds.delete(device);
  if (!$('#studentsDlg').open) {
    if (restEnds.size) restTick = setTimeout(tickRests, 1000);
    return;
  }
  for (const li of $('#students').children) {
    const who = state?.students?.find((s) => s.device === li.dataset.id);
    const box = li.querySelector('.student-rest');
    if (!who || !box) continue;
    const html = restHtml(who);
    if (!html && box.innerHTML) box.innerHTML = ''; // over: the tag and its button go
    else if (html) {
      const tag = box.querySelector('.rest-tag');
      if (tag) tag.textContent = `📚 ${clockLeft(restEnds.get(who.device) - Date.now())}`;
      else keepFocus(() => { box.innerHTML = html; });
    }
  }
  if (restEnds.size) restTick = setTimeout(tickRests, 1000);
}

function renderStudents() {
  const list = [...(state?.students ?? [])].sort((a, b) => b.online - a.online || a.nick.localeCompare(b.nick));
  keepFocus(() => {
    $('#students').innerHTML = list.length
      ? list.map((s) => `<li data-id="${esc(s.device)}">
          <span class="dot ${s.online ? 'on' : ''}" aria-hidden="true"></span>
          <span class="nick">${esc(s.nick)}</span><small>${s.online ? 'here' : 'away'}${downHtml(s)}</small>
          <span class="student-rest">${restHtml(s)}</span>
          <span class="student-credits">${creditsHtml(s)}</span>
          <button type="button" data-act="rename" aria-label="${esc(`Ask ${s.nick} for a new nickname`)}">Rename</button>
          <button type="button" class="danger" data-act="kick" aria-label="${esc(`Kick ${s.nick}`)}">Kick</button>
        </li>`).join('')
      : '<li class="note">No students yet.</li>';
  });
  const on = creditsOn();
  $('#creditsBar').hidden = !on || list.length === 0;
  $('#creditsOff').hidden = on;
  tickRests();
}
/**
 * " · 👍 2/3 · 👎 1/3": votes a student used of the room's limits (protocol.js UPVOTE LIMIT, DOWNVOTE
 * LIMIT); each only once they used one, and only while that vote is on.
 */
function downHtml(s) {
  const out = [];
  const up = state?.settings?.maxUpvotes;
  if (state?.upvotes !== false && Number.isInteger(up) && s.upvotes) {
    out.push(` · <span class="student-down" title="Thumbs up used of ${up} this class">👍 ${s.upvotes}/${up}</span>`);
  }
  const limit = state?.settings?.maxDownvotes;
  if (state?.downvoteMode !== 'off' && Number.isInteger(limit) && s.downvotes) {
    out.push(` · <span class="student-down" title="Thumbs down used of ${limit} this class">👎 ${s.downvotes}/${limit}</span>`);
  }
  return out.join('');
}
$('#studentsBtn').addEventListener('click', () => {
  $('#studentsDlg').showModal();
  renderStudents();
});
$('#students').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="letBackIn"]');
  if (!btn) return;
  const device = btn.closest('[data-id]').dataset.id;
  const who = state?.students?.find((s) => s.device === device);
  if (send({ t: 'letBackIn', device })) {
    toast(`${who?.nick ?? 'That student'} can suggest again.`, 'ok');
    btn.closest('li').querySelector('[data-act="rename"]')?.focus(); // this button goes with the next snapshot
  }
});

// ---- Credits (shared/protocol.js CREDITS): give to one student or everyone, or set a balance ----
const creditsOn = () => Number.isInteger(state?.settings?.startingCredits);
const creditWord = (n) => `${n} ${n === 1 ? 'credit' : 'credits'}`;

function creditsHtml(s) {
  if (!creditsOn() || s.credits === null || s.credits === undefined) return '';
  return `<b title="Credits">🎟 ${s.credits}</b>
    <button type="button" data-act="give1" data-n="1" aria-label="${esc(`Give ${s.nick} 1 credit`)}">+1</button>
    <button type="button" data-act="give5" data-n="5" aria-label="${esc(`Give ${s.nick} 5 credits`)}">+5</button>
    <button type="button" data-act="credits" aria-label="${esc(`More credit choices for ${s.nick}`)}">More…</button>`;
}

let creditFor = null; // the student device the credit dialog is for
$('#students').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="give1"], button[data-act="give5"], button[data-act="credits"]');
  if (!btn) return;
  const device = btn.closest('[data-id]').dataset.id;
  const who = state?.students?.find((s) => s.device === device);
  if (!who) return;
  if (btn.dataset.act !== 'credits') {
    const amount = Number(btn.dataset.n);
    if (send({ t: 'credits', device, amount })) toast(`Gave ${who.nick} ${creditWord(amount)}.`, 'ok');
    return;
  }
  creditFor = device;
  $('#creditTitle').textContent = `Credits for ${who.nick}`;
  $('#creditNow').textContent = `${who.nick} has ${creditWord(who.credits ?? 0)} now.`;
  $('#creditN').value = '5';
  $('#creditMsg').textContent = '';
  $('#studentsDlg').close();
  $('#creditDlg').showModal();
  $('#creditN').select();
});

function creditDone() {
  $('#creditDlg').close();
  renderStudents();
  $('#studentsDlg').showModal();
}
function creditSend(mode) {
  const n = Number($('#creditN').value);
  const who = state?.students?.find((s) => s.device === creditFor);
  if (!who) return creditDone();
  const [lo, hi] = mode === 'set' ? [0, CREDITS_MAX] : [1, CREDIT_GRANT_MAX];
  if (!Number.isInteger(n) || n < lo || n > hi) {
    $('#creditMsg').textContent = mode === 'set' ? `Set to a whole number from ${lo} to ${hi}.` : `Give a whole number from ${lo} to ${hi}.`;
    return $('#creditN').focus();
  }
  const msg = mode === 'set' ? { t: 'credits', device: creditFor, set: n } : { t: 'credits', device: creditFor, amount: n };
  if (!send(msg)) return;
  toast(mode === 'set' ? `${who.nick} now has ${creditWord(n)}.` : `Gave ${who.nick} ${creditWord(n)}.`, 'ok');
  creditDone();
}
$('#creditForm').addEventListener('submit', (e) => {
  e.preventDefault();
  creditSend('give');
});
$('#creditSet').addEventListener('click', () => creditSend('set'));
$('#creditCancel').addEventListener('click', creditDone);
$('#creditDlg').addEventListener('cancel', (e) => {
  e.preventDefault(); // Esc: back to the student list
  creditDone();
});

function giveAll() {
  const n = Number($('#giveAllN').value);
  if (!Number.isInteger(n) || n < 1 || n > CREDIT_GRANT_MAX) {
    toast(`Give everyone a whole number from 1 to ${CREDIT_GRANT_MAX}.`, 'warn');
    return $('#giveAllN').focus();
  }
  const count = state?.students?.length ?? 0;
  if (send({ t: 'credits', all: true, amount: n })) toast(`Gave everyone (${count}) ${creditWord(n)}.`, 'ok');
}
$('#giveAllBtn').addEventListener('click', giveAll);
$('#giveAllN').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // not the dialog's form (that would close it)
  giveAll();
});
$('#students').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="kick"], button[data-act="rename"]');
  if (!btn) return;
  const device = btn.closest('[data-id]').dataset.id;
  const who = state?.students?.find((s) => s.device === device);
  $('#studentsDlg').close();
  if (btn.dataset.act === 'rename') {
    const ok = await ask(`Ask ${who?.nick ?? 'this student'} for a new nickname?`, 'Rename',
      'They go back to the join screen to pick a different nickname, and stay in the room. Nobody can use this nickname in this room again.');
    if (ok) send({ t: 'rename', device });
  } else {
    const ok = await ask(`Kick ${who?.nick ?? 'this student'}?`, 'Kick', 'They leave the room and cannot join it again.');
    if (ok) send({ t: 'kick', device });
  }
  renderStudents();
  $('#studentsDlg').showModal();
});

// Settings
function fillSettings(s) {
  $('#setMax').min = SETTINGS_LIMITS.maxWaitingPerStudent[0];
  $('#setMax').max = SETTINGS_LIMITS.maxWaitingPerStudent[1];
  $('#setRemove').min = SETTINGS_LIMITS.removeAtScore[0];
  $('#setRemove').max = SETTINGS_LIMITS.removeAtScore[1];
  $('#setMax').value = s.maxWaitingPerStudent;
  $('#setRemove').value = s.removeAtScore;
  $('#setScoreFloor').checked = s.scoreFloor === true; // protocol.js SCORE FLOOR
  $('#setHideCounts').checked = s.hideVoteCounts === true; // protocol.js HIDDEN COUNTS
  // 👎 votes (protocol.js DOWNVOTE MODE); a room from before the setting reads 'shown'.
  $('#setDownMode').value = ['off', 'hidden', 'shown'].includes(s.downvoteMode) ? s.downvoteMode : 'shown';
  // 👻 Ghost 👍 (protocol.js GHOST VOTE); settings from before it read off, 3 minutes.
  $('#setGhost').checked = s.ghostVote === true;
  $('#setGhostMin').min = SETTINGS_LIMITS.ghostVoteMinutes[0];
  $('#setGhostMin').max = SETTINGS_LIMITS.ghostVoteMinutes[1];
  $('#setGhostMin').value = Number.isInteger(s.ghostVoteMinutes) ? s.ghostVoteMinutes : DEFAULT_SETTINGS.ghostVoteMinutes;
  // 👎 per student per class (protocol.js DOWNVOTE LIMIT): the choices, plus a saved number that is not one.
  const down = Number.isInteger(s.maxDownvotes) ? s.maxDownvotes : null;
  const downChoices = [...new Set([...DOWNVOTE_CHOICES, ...(down === null ? [] : [down])])].sort((a, b) => a - b);
  $('#setMaxDown').innerHTML = [...downChoices.map((n) => `<option value="${n}">${n}</option>`), '<option value="off">Unlimited</option>'].join('');
  $('#setMaxDown').value = down === null ? 'off' : String(down);
  // 👍 votes and 👍 per student (protocol.js UPVOTE LIMIT), the same two boxes as 👎.
  $('#setUpMode').value = s.upvotes === false ? 'off' : s.hideUpvoteCounts === true ? 'hidden' : 'shown'; // UPVOTE COUNTS
  const up = Number.isInteger(s.maxUpvotes) ? s.maxUpvotes : null;
  const upChoices = [...new Set([...UPVOTE_CHOICES, ...(up === null ? [] : [up])])].sort((a, b) => a - b);
  $('#setMaxUp').innerHTML = [...upChoices.map((n) => `<option value="${n}">${n}</option>`), '<option value="off">Unlimited</option>'].join('');
  $('#setMaxUp').value = up === null ? 'off' : String(up);
  $('#setAi').checked = s.aiCheck !== false;
  $('#setUnknown').checked = s.blockUnknownSongs !== false;
  $('#setWords').value = (s.blocklist ?? []).join('\n');
  fillSongSettings(s);
  highlights.fillSettings(s);
  repeats.fillSettings(s);
  const [creditLo, creditHi] = SETTINGS_LIMITS.startingCredits;
  $('#setCredits').min = creditLo;
  $('#setCredits').max = creditHi;
  const on = Number.isInteger(s.startingCredits);
  $('#setCreditsOn').checked = on;
  $('#setCredits').value = on ? s.startingCredits : '';
  $('#setJump').checked = s.allowJump === true;
  $('#setCoupons').checked = s.coupons !== false;
  // 📚 Back to work and 🎵 recap music (protocol.js BACK TO WORK, RECAP MUSIC)
  $('#setBackToWork').innerHTML = ['<option value="off">Off</option>',
    ...BACK_TO_WORK_MINUTES.map((m) => `<option value="${m}">${m} ${m === 1 ? 'minute' : 'minutes'}</option>`)].join('');
  $('#setBackToWork').value = s.backToWork === false ? 'off' : String(s.backToWorkMinutes ?? DEFAULT_SETTINGS.backToWorkMinutes);
  $('#setRecapMusic').checked = s.recapMusic !== false;
  $('#setArtCheck').checked = s.artCheck !== false; // 🖼 ALBUM ART
  $('#setHideAllArt').checked = s.hideAllArt === true;
  [$('#setRecapVolume').min, $('#setRecapVolume').max] = SETTINGS_LIMITS.recapVolume;
  $('#setRecapVolume').value = String(s.recapVolume ?? DEFAULT_SETTINGS.recapVolume);
  [$('#setPeriod').min, $('#setPeriod').max] = SETTINGS_LIMITS.periodMinutes;
  $('#setPeriod').value = s.periodMinutes ?? 70;
  const offset = Number.isInteger(s.bellOffsetSeconds) ? s.bellOffsetSeconds : 0;
  $('#setBellOffset').value = offset > 0 ? `+${offset}` : String(offset);
  fillPrefs();
  adaptSettings(); // every help line and hidden row for these values
  $('#settingsMsg').textContent = '';
}
// ADAPTIVE SETTINGS (Dalton, 2026-10-21: "the prompts/text change as you interact with it and stuff
// will hide", "plain explanations anyone can understand"): after every change in the form, each help
// line says what the CURRENT choice does, in plain words with the numbers picked, and a row that does
// nothing with the other choices hides (its value is kept and saved as it was).
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function say(sel, text) {
  const el = $(sel);
  if (el && el.textContent !== text) el.textContent = text;
}
function showIf(on, ...sels) {
  for (const sel of sels) {
    const el = $(sel);
    if (el) el.hidden = !on;
  }
}
const rowOf = (sel) => $(sel).closest('label');
function adaptSettings() {
  const num = (sel) => Number($(sel).value);
  // 👍 and 👎 (protocol.js UPVOTE LIMIT, DOWNVOTE MODE / LIMIT)
  const upOn = $('#setUpMode').value !== 'off';
  const downMode = $('#setDownMode').value;
  const downOn = downMode !== 'off';
  say('#upModeHelp', upOn ? `Students tap 👍 on the songs they want. The song with the most 👍 plays next. ${
    $('#setUpMode').value === 'hidden' ? 'Only you see how many 👍 a song has.' : 'Everyone sees how many 👍 a song has.'}`
    : downOn ? 'Nobody can 👍. Songs play in the order they were suggested, and 👎 moves songs down.'
      : 'Nobody can 👍. Songs play in the order they were suggested.');
  showIf(upOn, '#maxUpRow', '#maxUpHelp');
  say('#maxUpHelp', $('#setMaxUp').value === 'off' ? 'Students can 👍 as many songs as they like.'
    : `Each student gets ${plural(num('#setMaxUp'), '👍', '👍')} per class. Once they use one, it stays used.`);
  say('#downModeHelp', downMode === 'off' ? 'Nobody can 👎. Every song gets its turn.'
    : downMode === 'hidden' ? 'Students can 👎 songs they do not want. Only you see how many 👎 a song has.'
      : 'Students can 👎 songs they do not want. Everyone sees how many 👎 a song has.');
  showIf(downOn, '#maxDownRow', '#maxDownHelp');
  say('#maxDownHelp', $('#setMaxDown').value === 'off' ? 'Students can 👎 as many songs as they like.'
    : `Each student gets ${plural(num('#setMaxDown'), '👎', '👎')} per class. Once they use one, it stays used.`);
  // Scores never go below 0 and the remove score only matter while 👎 is on (SCORE FLOOR).
  const floor = $('#setScoreFloor').checked;
  rowOf('#setScoreFloor').hidden = !downOn;
  showIf(downOn, '#scoreFloorHelp');
  say('#scoreFloorHelp', floor ? 'Votes never take a song out of line, so every student\'s song gets to play. Only you can remove a song.'
    : 'Off: a song with too many 👎 leaves the line (the number below).');
  showIf(downOn && !floor, '#removeRow', '#removeHelp');
  const remove = num('#setRemove');
  say('#removeHelp', Number.isInteger(remove) && remove < 0
    ? `A song leaves the line once it has ${-remove} more 👎 than 👍.`
    : 'Pick a number below 0, like -3.');
  say('#hideCountsHelp', $('#setHideCounts').checked
    ? 'Students and the board see the order of songs, but not how many votes each has. You still see every vote.'
    : 'Students and the board see how many votes each song has.');
  // 👻 Ghost 👍 needs 👍 on; its minutes need it on (GHOST VOTE).
  const ghost = $('#setGhost').checked;
  rowOf('#setGhost').hidden = !upOn;
  showIf(upOn, '#ghostHelp');
  showIf(upOn && ghost, '#ghostMinRow');
  const gm = num('#setGhostMin');
  say('#ghostHelp', ghost ? `A song that waits ${Number.isInteger(gm) && gm > 0 ? plural(gm, 'minute') : 'a few minutes'} gets 1 free 👍, so every song gets some love. Students cannot tell.`
    : 'Off: songs only get the 👍 students give them.');
  // Songs (classtime.js shows the minutes box)
  say('#maxLenHelp', $('#setMaxLenOn').checked
    ? `Songs longer than ${Number.isInteger(num('#setMaxLen')) && num('#setMaxLen') > 0 ? plural(num('#setMaxLen'), 'minute') : 'that'} are turned down. It costs no credit.`
    : 'Off: songs of any length are fine.');
  say('#instrumentalHelp', $('#setInstrumental').checked
    ? 'Only songs with no singing or rapping. Songs the checker is not sure about wait for you in Needs a look.'
    : 'Off: songs with singing are fine.');
  const cool = $('#setCooldown').value;
  say('#cooldownHelp', cool === 'off'
    ? 'Off: a song can be picked again in your next class. It never plays twice in one class.'
    : `A song that played in any of your classes cannot be picked again for ${$('#setCooldown').selectedOptions[0]?.textContent ?? 'a while'}. Any version counts (remix, sped up, live). Wake one early in 📋 Lists → 😴 Resting songs.`);
  // Credits: Starting credits, Priority jump and coupons only matter while credits are on (CREDITS).
  const credits = $('#setCreditsOn').checked;
  showIf(credits, '#creditsStartRow');
  $('#setCredits').disabled = !credits; // a hidden bad number must never block saving
  say('#creditsHelp', credits ? 'Each song a student suggests costs 1 credit. You can give more in 🏠 Room → Students.'
    : 'Off: suggesting songs is free.');
  rowOf('#setJump').hidden = !credits;
  showIf(credits, '#jumpHelp');
  say('#jumpHelp', $('#setJump').checked
    ? 'Students can spend 2 credits on ⚡ Jump to make a song play next. If you turn this off later, songs already jumped keep their place.'
    : 'Off: no ⚡ Jump button. If you turn this off later, songs already jumped keep their place.');
  rowOf('#setCoupons').hidden = !credits;
  showIf(credits, '#couponsHelp');
  say('#couponsHelp', $('#setCoupons').checked
    ? 'Students can trade a coupon from another class app (like teachChat points) for 1 credit. Each coupon works once.'
    : 'Off: coupons from other class apps do not work here.');
  // Class time
  const rest = $('#setBackToWork').value;
  say('#backToWorkHelp', rest === 'off' ? 'Off: students can suggest another song right away.'
    : `After a student suggests a song, their screen says "📚 Back to work!" for ${plural(Number(rest), 'minute')}. Voting does not start it. Students → Let back in ends it early.`);
  // Display & sound
  const recap = $('#setRecapMusic').checked;
  showIf(recap, '#recapVolumeRow', '#recapVolumeHelp');
  $('#recapVolumeOut').textContent = `${$('#setRecapVolume').value}%`;
  say('#recapMusicHelp', recap ? 'During ▶ Play recap, the #1 song of the class plays with a ta-da for each award. Then your music comes back.'
    : 'Off: during ▶ Play recap your music just gets quieter.');
  say('#artCheckHelp', $('#setHideAllArt').checked ? 'Not needed while all album covers are hidden.'
    : $('#setArtCheck').checked ? 'A computer checks each album cover first. A cover that is not right for school shows as a plain 🎵. You can still show it.'
      : 'Off: album covers show without a check.');
  say('#hideAllArtHelp', $('#setHideAllArt').checked ? 'No album covers anywhere, just plain 🎵 tiles. Music players may still show their own pictures.'
    : 'Off: album covers show (after the check above).');
  say('#showFavHelp', $('#setShowFav').checked ? 'Students see a list of songs your classes loved most and can suggest one with a tap. No names are shown.'
    : 'Off: students do not see the class favorites list.');
}
$('#settingsForm').addEventListener('input', adaptSettings);
$('#settingsForm').addEventListener('change', adaptSettings);

const FIRST_CREDITS = 3; // what Starting credits shows when the switch first goes on
$('#setCreditsOn').addEventListener('change', () => {
  if ($('#setCreditsOn').checked && $('#setCredits').value === '') $('#setCredits').value = String(FIRST_CREDITS);
});

/** The form as settings, or null with a message (the server checks again). */
function readSettings() {
  const [maxLo, maxHi] = SETTINGS_LIMITS.maxWaitingPerStudent;
  const [remLo, remHi] = SETTINGS_LIMITS.removeAtScore;
  const max = Number($('#setMax').value), remove = Number($('#setRemove').value);
  const words = [...new Set($('#setWords').value.split(/[\n,]/).map((w) => w.trim().toLowerCase()).filter(Boolean))];
  const base = settingsBase();
  const fail = (text, field = null) => {
    $('#settingsMsg').textContent = text;
    // The box with the problem: show its tab (and All settings, if Simple hides it) and put the cursor in it.
    const el = field && $(field);
    if (el?.closest('[data-adv]')) setLevel(true, false);
    const tab = el && settingsTabs.tabFor(el);
    if (tab) settingsTabs.select(tab);
    el?.focus();
    return null;
  };
  const whole = (sel) => $(sel).value.trim() !== '' && Number.isInteger(Number($(sel).value));
  if (!whole('#setMax') || max < maxLo || max > maxHi) return fail(`Songs waiting must be a whole number from ${maxLo} to ${maxHi}.`, '#setMax');
  const floor = $('#setScoreFloor').checked;
  const ghostOn = $('#setGhost').checked;
  const [ghostLo, ghostHi] = SETTINGS_LIMITS.ghostVoteMinutes;
  const ghostMin = Number($('#setGhostMin').value);
  if (ghostOn && $('#setUpMode').value !== 'off' && (!whole('#setGhostMin') || ghostMin < ghostLo || ghostMin > ghostHi)) {
    return fail(`Ghost 👍 minutes must be a whole number from ${ghostLo} to ${ghostHi}.`, '#setGhostMin');
  }
  const removeOk = whole('#setRemove') && remove >= remLo && remove <= remHi;
  // Greyed out under the score floor: a bad value there keeps the room's own (it never removes anyway).
  const removeAtScore = removeOk ? remove : (base.removeAtScore ?? DEFAULT_SETTINGS.removeAtScore);
  // Shown only while 👎 is on and scores may go below 0 (adaptSettings); hidden, a bad box keeps the room's own.
  if (!floor && $('#setDownMode').value !== 'off' && !removeOk) return fail(`The remove score must be a whole number from ${remLo} to ${remHi}.`, '#setRemove');
  if (words.length > SETTINGS_LIMITS.blocklistWords) return fail(`Up to ${SETTINGS_LIMITS.blocklistWords} blocked words.`, '#setWords');
  const long = words.find((w) => w.length > SETTINGS_LIMITS.blocklistWordLength);
  if (long) return fail(`"${long}" is too long. Blocked words can be up to ${SETTINGS_LIMITS.blocklistWordLength} letters.`, '#setWords');
  const songs = readSongSettings(); // Max song length, Instrumentals only (classtime.js)
  if (songs.error) return fail(songs.error, '#setMaxLen');
  const [creditLo, creditHi] = SETTINGS_LIMITS.startingCredits;
  const credits = $('#setCreditsOn').checked ? Number($('#setCredits').value) : null;
  if (credits !== null && ($('#setCredits').value === '' || !Number.isInteger(credits) || credits < creditLo || credits > creditHi)) {
    return fail(`Starting credits must be a whole number from ${creditLo} to ${creditHi}, or turn Credits off.`, '#setCredits');
  }
  const period = Number($('#setPeriod').value);
  const [perLo, perHi] = SETTINGS_LIMITS.periodMinutes;
  if (!Number.isInteger(period) || period < perLo || period > perHi) return fail(`The class period must be a whole number of minutes from ${perLo} to ${perHi}.`, '#setPeriod');
  // 🔔 Bell offset: "+3", "3", "-5" or empty (0) seconds (protocol.js BELL OFFSET).
  const [offLo, offHi] = SETTINGS_LIMITS.bellOffsetSeconds;
  const offRaw = $('#setBellOffset').value.trim().replace(/\s+/g, '').replace(/^−/, '-');
  const bellOffset = offRaw === '' ? 0 : Number(offRaw);
  if (!/^[+-]?\d{0,3}$/.test(offRaw) || !Number.isInteger(bellOffset) || bellOffset < offLo || bellOffset > offHi) {
    return fail(`The bell offset must be a whole number of seconds from ${offLo} to +${offHi} (like +3 or -5).`, '#setBellOffset');
  }
  return {
    periodMinutes: period,
    bellOffsetSeconds: bellOffset,
    maxWaitingPerStudent: max,
    removeAtScore,
    scoreFloor: floor,
    hideVoteCounts: $('#setHideCounts').checked,
    downvoteMode: $('#setDownMode').value,
    // 👻 Off keeps the minutes it had (a bad box while off: the room's own).
    ghostVote: ghostOn,
    ghostVoteMinutes: whole('#setGhostMin') && ghostMin >= ghostLo && ghostMin <= ghostHi
      ? ghostMin : (base.ghostVoteMinutes ?? DEFAULT_SETTINGS.ghostVoteMinutes),
    maxDownvotes: $('#setMaxDown').value === 'off' ? null : Number($('#setMaxDown').value),
    upvotes: $('#setUpMode').value !== 'off',
    hideUpvoteCounts: $('#setUpMode').value === 'hidden', // protocol.js UPVOTE COUNTS
    maxUpvotes: $('#setMaxUp').value === 'off' ? null : Number($('#setMaxUp').value),
    blocklist: words,
    ...(testAiOff ? { aiCheck: $('#setAi').checked, blockUnknownSongs: $('#setUnknown').checked } : {}),
    maxSongMinutes: songs.maxSongMinutes,
    instrumentalsOnly: songs.instrumentalsOnly,
    ...highlights.readSettings(), // Class favorites, the artist switches
    ...repeats.readSettings(), // Repeat cooldown
    startingCredits: credits,
    // Kept as set even while credits are off (the switch is greyed out, not cleared); it only
    // counts while credits are on.
    allowJump: $('#setJump').checked,
    coupons: $('#setCoupons').checked, // 🎟 like Priority jump: kept as set while credits are off
    // 📚 Off keeps the minutes it had, for when it comes back on.
    backToWork: $('#setBackToWork').value !== 'off',
    backToWorkMinutes: $('#setBackToWork').value === 'off'
      ? (base.backToWorkMinutes ?? DEFAULT_SETTINGS.backToWorkMinutes) : Number($('#setBackToWork').value),
    recapMusic: $('#setRecapMusic').checked,
    recapVolume: Number($('#setRecapVolume').value),
    artCheck: $('#setArtCheck').checked,
    hideAllArt: $('#setHideAllArt').checked,
  };
}

// Tabs (tabs.js): Songs, Credits, Class time, Display & sound, Shortcuts, Teacher; the last one is remembered.
const settingsTabs = initTabs($('#settingsTabs'), { storageKey: 'cq.settingsTab' });

// Simple or All settings (Dalton, 2026-10-21: "a simple customization set and advanced set like you
// get in a 3D printer slicer"): Simple hides every [data-adv] row, group and tab (host.css). The
// choice is remembered on this computer; ⚙️ More options always opens on All.
const LEVEL_KEY = 'cq.settingsLevel';
const savedLevelAll = () => { try { return localStorage.getItem(LEVEL_KEY) === 'all'; } catch { return false; } };
function setLevel(all, remember = true) {
  $('#settingsDlg').classList.toggle('show-all', all);
  $('#levelSimple').setAttribute('aria-pressed', String(!all));
  $('#levelAll').setAttribute('aria-pressed', String(all));
  $('#levelNote').hidden = all;
  if (remember) try { localStorage.setItem(LEVEL_KEY, all ? 'all' : 'simple'); } catch { /* blocked: this page only */ }
  // A tab with nothing in Simple (⌨ Shortcuts): back to the first one.
  if (!all && $('#settingsTabs [aria-selected="true"]')?.hasAttribute('data-adv')) settingsTabs.select('tabSongs');
}
$('#levelSimple').addEventListener('click', () => setLevel(false));
$('#levelAll').addEventListener('click', () => setLevel(true));

// The dialog edits the room's settings (⚙️ Settings in the room), or, from ⚙️ More options on the
// open-room form, this teacher's saved defaults before any room: then only Save as my default.
let settingsForRoom = true;
/** What the form started from: the room's settings, or the saved defaults (More options). */
const settingsBase = () => (settingsForRoom ? state?.settings : savedQuick) ?? DEFAULT_SETTINGS;
function openSettings(forRoom, s, all) {
  settingsForRoom = forRoom;
  fillSettings(s);
  $('#settingsDlg').classList.toggle('defaults-mode', !forRoom);
  $('#defaultsNote').hidden = forRoom;
  $('#settingsTitle').textContent = forRoom ? 'Settings' : 'Settings for your rooms';
  settingsTabs.restore();
  setLevel(all, false);
  $('#settingsDlg').showModal();
  $('#settingsTabs [aria-selected="true"]')?.focus();
}

$('#settingsBtn').addEventListener('click', () => {
  if (!state) return;
  $('#setTeacherName').textContent = state.teacher || currentProfile()?.name || '';
  openSettings(true, state.settings, savedLevelAll());
  showUsage();
});
$('#moreOptions').addEventListener('click', async () => {
  if (!canTeach()) return showStart();
  if (!savedQuick) await prepareCredits(); // the saved defaults (and the quick choices from them)
  // What this form already says (Song suggestions, Back to work) shows in the dialog too.
  const credits = readCredits();
  const quick = quickTouched ? { ...(credits.ok ? { startingCredits: credits.startingCredits } : {}), ...readRest(savedQuick) } : {};
  $('#setTeacherName').textContent = currentProfile()?.name || '';
  openSettings(false, { ...DEFAULT_SETTINGS, ...(savedQuick ?? {}), ...quick }, true);
});
$('#cancelSettings').addEventListener('click', () => $('#settingsDlg').close());
$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!settingsForRoom) return void $('#saveDefault').click(); // Enter in a box: More options only saves
  const settings = readSettings();
  const before = state?.settings?.startingCredits ?? null;
  if (!settings || !send({ t: 'settings', settings })) return;
  $('#settingsDlg').close();
  const laterOnly = Number.isInteger(before) && Number.isInteger(settings.startingCredits)
    && settings.startingCredits !== before && (state?.students?.length ?? 0) > 0;
  toast(laterOnly
    ? 'Settings changed. The new starting credits are for students who join later. To give the others credits, use Students, Give everyone.'
    : 'Settings changed for this room.', 'ok', laterOnly ? 9000 : undefined);
});
$('#saveDefault').addEventListener('click', async () => {
  const form = readSettings();
  if (!form) return;
  // Every setting is saved, not just the ones on this form: the room's own values fill the rest.
  const settings = { ...(settingsForRoom ? state?.settings ?? {} : savedQuick ?? {}), ...form };
  const key = getKey();
  if (!canTeach()) return void ($('#settingsMsg').textContent = 'Sign in again (open a new room) to save defaults.');
  $('#saveDefault').disabled = true;
  try {
    // The room's teacher's defaults (a room from before profiles: the teacher picked here).
    const r = await fetch('/api/teacher/settings', {
      method: 'PUT',
      headers: teacherHeaders((settingsForRoom ? state?.profile : null) ?? currentProfile()?.id, key),
      body: JSON.stringify(settings),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return void ($('#settingsMsg').textContent = data.message || 'Could not save your defaults.');
    $('#settingsDlg').close();
    if (!settingsForRoom) {
      // ⚙️ More options: the open-room form now shows what was saved.
      savedQuick = data;
      quickTouched = false;
      setCreditsPick(data.startingCredits ?? null);
      setRestPick(data);
      return toast('Saved. Your rooms start with these settings.', 'ok');
    }
    send({ t: 'settings', settings });
    toast('Saved. New rooms start with these settings, and this room uses them now.', 'ok');
  } catch {
    $('#settingsMsg').textContent = 'Could not reach RoomDJ. Try again.';
  } finally {
    $('#saveDefault').disabled = false;
  }
});

$('#closeBtn').addEventListener('click', async () => {
  const ok = await ask('Close this room?', 'Close room',
    'The music stops, students are sent out, and all of the room\'s songs, votes and nicknames are deleted.');
  if (ok) send({ t: 'close' });
});

// ---- Playback ----
// Browsers block sound until someone clicks, so nothing plays before "Start music".
let player = null;
let started = false;
let paused = false;
let loadedId = null;
let nextAsked = { from: undefined, at: 0 };

/** Switch to another music service's player (music.js, the "Music from" picker). */
function usePlayer(next) {
  if (player) {
    player.stop();
    player.destroy?.();
  }
  player = next;
  loadedId = null;
  tellService();
  $('#playerNote').textContent = `Playing ${player.name}.`;
  $('#progressBar').style.width = '0%';
  player.setVolume(Number($('#volume').value));
  player.onTime((t, d) => {
    lastT = t;
    lastD = d;
    boardHost.progress(); // about every 5 s, while a board is connected
    $('#progressBar').style.width = `${Math.min(100, (t / (d || 30)) * 100)}%`;
    if (d - t < 20 && state?.queue[0]) player.prefetch?.(state.queue[0].song); // YouTube: find the next video early
    // NEXT LOCK (protocol.js): the last seconds lock in the next song. Asked again every 5 s until
    // the state says locked (a lost message, or an empty queue then); the room ignores repeats.
    if (d > 0 && d - t <= NEXT_LOCK_S && loadedId && loadedId === state?.nowPlaying?.id && !state.nextLocked && state.queue.length
      && !(lockAsked.id === loadedId && Date.now() - lockAsked.at < 5000)) {
      if (conn?.send({ t: 'lockNext', id: loadedId })) lockAsked = { id: loadedId, at: Date.now() };
    }
  });
  player.onEnded(() => requestNext(loadedId));
  player.onError((message) => {
    toast(`${message} Skipping it.`, 'warn');
    requestNext(loadedId, true);
  });
  // Spotify: another device took the music. Wait for Start music instead of sitting silent.
  player.onInterrupted?.((message) => {
    started = false;
    paused = false;
    $('#playerWarn').textContent = message;
    $('#playerWarn').hidden = false;
    updateButtons();
  });
  $('#playerWarn').hidden = true;
  filler?.playerChanged();
  syncPlayback();
}
// Background music (filler.js): when the teacher starts it, a queue song playing now pauses, and
// the room counts as started (songs students suggest then play, and pause it).
const filler = initFiller({
  getPlayer: () => player,
  onPlay() {
    if (loadedId) {
      if (started && !paused) player.pause();
      paused = true;
    }
    started = true;
    updateButtons();
    if (!loadedId) syncPlayback();
  },
});
usePlayer(createPlayer('preview'));
initMusic({
  use: usePlayer,
  notify: (text, kind) => toast(text, kind, 8000),
  // Signed in with Spotify: play through that login's app; Connect signs in again with it.
  signin: signedInAs() ? {
    clientId: signedInAs().account.clientId,
    free: isFreeTeacher(signedInAs().account.profile.id), // Spotify + previews only (protocol.js FREE TEACHERS)
    reconnect: () => login({ clientId: signedInAs().account.clientId, remember: staysSignedIn() }),
  } : null,
});

/** Tell the room what this page plays through (a Spotify room searches Spotify's catalog). */
function tellService() {
  if (player?.service && conn?.isOpen) conn.send({ t: 'service', service: player.service, lookups: true });
}

/** Ask the server to move on from `fromId` (null: nothing playing), once per song. `failed`: it would not play. */
function requestNext(fromId, failed = false) {
  if (state?.cleanup) return; // cleanup time: no next song
  if (nextAsked.from === fromId && Date.now() - nextAsked.at < NEXT_RETRY_MS) return;
  if (conn?.send({ t: 'next', from: fromId, ...(failed ? { failed: true } : {}) })) nextAsked = { from: fromId, at: Date.now() };
}

function syncPlayback() {
  if (!state || state.cleanup) return; // cleanup time: the music fades out and nothing new loads
  const now = state.nowPlaying;
  if (!now) {
    if (loadedId) { player.stop(); loadedId = null; }
    if (started && state.queue.length) requestNext(null);
    return;
  }
  if (now.id === loadedId) return;
  loadedId = now.id;
  lastT = 0;
  lastD = now.song.durationMs ? now.song.durationMs / 1000 : 0;
  if (!player.canPlay(now.song)) {
    player.stop();
    toast(catalogOf(now.song.id) === SPOTIFY && player.service !== 'spotify'
      ? `"${now.song.title}" came from Spotify, so only Spotify can play it. Skipping it.`
      : `"${now.song.title}" cannot play here. Skipping it.`, 'warn');
    return requestNext(now.id, true);
  }
  player.load(now.song).then(() => { if (started && !paused && loadedId === now.id) playNow(); });
}

function playNow() {
  filler.event('queuePlays'); // a queue song never plays over the background music
  player.play().then(() => {
    paused = false;
    $('#playerWarn').hidden = true;
    updateButtons();
  }).catch((err) => {
    if (err?.name === 'NotAllowedError') {
      started = false;
      toast('Click Start music so this computer can play sound.', 'warn');
    } else if (err?.name === 'PlayerNotReady') {
      started = false;
      toast(err.message, 'warn', 8000);
    }
    updateButtons();
  });
}

function stopMusic() {
  player.stop();
  loadedId = null;
  started = false;
  paused = false;
  lastNowId = undefined;
  seenReview = null;
  updateButtons();
}

// Cleanup time (protocol.js CLEANUP): fade the music out over about 5 s, then pause (no next
// song). "Keep the music going" brings back what the fade paused.
const FADE_STEPS = 25;
const FADE_STEP_MS = 200;
let fadeTimer = 0;
let fadedForCleanup = false;
function cleanupPlayback(on) {
  clearInterval(fadeTimer);
  fadeTimer = 0;
  const full = Number($('#volume').value);
  if (on) {
    if (!started || paused) return;
    let step = 0;
    fadeTimer = setInterval(() => {
      step++;
      player.setVolume(full * Math.max(0, 1 - step / FADE_STEPS));
      if (step < FADE_STEPS) return;
      clearInterval(fadeTimer);
      fadeTimer = 0;
      player.pause();
      paused = true;
      fadedForCleanup = true;
      player.setVolume(full); // ready for later; nothing plays now
      updateButtons();
    }, FADE_STEP_MS);
    return;
  }
  player.setVolume(full);
  if (fadedForCleanup && started && paused) {
    paused = false;
    if (loadedId) playNow();
    else syncPlayback();
    updateButtons();
  }
  fadedForCleanup = false;
  if (!started || paused) syncPlayback();
}

function updateButtons() {
  $('#startBtn').hidden = started;
  $('#playBtn').hidden = !started;
  $('#playBtn').textContent = paused ? '▶ Play' : '⏸ Pause';
  boardHost.progress(true); // the board's ⏯ shows the same
}

// The board's remote (protocol.js BOARD + REMOTE): this page owns the player, so it does exactly
// what its own buttons and keys do. Browsers block sound until someone clicks on THIS computer.
function onRemote(action) {
  if (!inRoom()) return;
  if (action === 'playPause') {
    if (!state?.nowPlaying && filler.hasLink && started) return filler.toggle();
    if (!started) {
      toast('Click Start music on this computer. The board cannot start the sound.', 'warn', 10000);
      announce('The board asked to play. Click Start music on this computer.');
      return $('#startBtn').focus();
    }
    const willPause = !paused;
    $('#playBtn').click();
    return announce(willPause ? 'Paused from the board.' : 'Playing from the board.');
  }
  if (action === 'volUp') return setVolume(Number($('#volume').value) + 0.1);
  if (action === 'volDown') return setVolume(Number($('#volume').value) - 0.1);
}

$('#startBtn').addEventListener('click', () => {
  started = true;
  paused = false;
  updateButtons();
  if (loadedId) playNow();
  else syncPlayback();
});
$('#playBtn').addEventListener('click', () => {
  if (paused) {
    paused = false;
    if (loadedId) playNow();
    else syncPlayback();
  } else {
    paused = true;
    player.pause();
  }
  updateButtons();
});
$('#skipBtn').addEventListener('click', () => {
  if (!state?.nowPlaying) return;
  if (conn?.send({ t: 'skip', from: state.nowPlaying.id })) nextAsked = { from: state.nowPlaying.id, at: Date.now() };
  else toast('Reconnecting to the room. Try again in a moment.', 'warn');
});
// ⭐ RoomDJ Favs: a song (the one playing, or one waiting in the queue: its ⋯ menu) goes in the
// teacher's own private Spotify playlist.
async function saveFavs(song) {
  if (!song || !player?.saveToFavs) return;
  const done = await player.saveToFavs(song);
  if (done.ok) toast(done.already ? `${song.title} is already in RoomDJ Favs.` : `⭐ Saved ${song.title} to RoomDJ Favs on Spotify.`, 'ok');
  else toast(done.message, 'warn');
}
$('#favsBtn').addEventListener('click', async () => {
  const now = state?.nowPlaying;
  if (!now) return;
  const btn = $('#favsBtn');
  btn.disabled = true;
  await saveFavs(now.song);
  btn.disabled = !state?.nowPlaying;
});

$('#nowUpBtn').addEventListener('click', () => {
  const now = state?.nowPlaying;
  if (!now) return;
  if (send({ t: 'vote', id: now.id, v: now.myVote === 1 ? 0 : 1 })) announce(now.myVote === 1 ? 'Vote taken back.' : 'Voted thumbs up.');
});
$('#banNowMore').addEventListener('click', () => {
  const now = state?.nowPlaying;
  if (now) pickReason({ id: now.id, title: now.song.title, actions: ['ban'], from: $('#nowMenuBtn') });
});
$('#banNowBtn').addEventListener('click', async () => {
  const now = state?.nowPlaying;
  if (!now) return;
  const ok = await ask(`Ban "${now.song.title}"?`, 'Ban it',
    'It stops now, and nobody can suggest it again, in this room or any of your future rooms.');
  if (ok) send({ t: 'ban', id: now.id });
});
$('#volume').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  player.setVolume(v);
  filler.setVolume(v);
  $('#volIcon').textContent = v === 0 ? '🔇' : '🔈';
});

// ---- Big screen: the projector view (address, code, now playing, top of the queue; no teacher tools) ----
const BIG = 'cq.big';
const isBig = () => document.body.classList.contains('big');
function setBig(on) {
  document.body.classList.toggle('big', on);
  $('#bigBtn').setAttribute('aria-checked', String(on));
  $('#bigBtn').textContent = on ? '✕ Leave big screen' : '📺 Big screen';
  try { localStorage.setItem(BIG, on ? '1' : ''); } catch { /* blocked */ }
  hostLayout?.refresh(); // the big screen has its own layout
}
$('#bigBtn').addEventListener('click', () => setBig(!isBig()));
addEventListener('keydown', (e) => {
  // An open dialog gets its own Esc (it closes the dialog). Full screen: the browser's Esc leaves it.
  if (e.key === 'Escape' && isBig() && !document.querySelector('dialog[open]') && !document.fullscreenElement) {
    setBig(false);
    $('#screenMenuBtn').focus();
  }
});

// ---- ✏️ Edit layout (layout.js): one layout for the normal view and one for big screen, kept on
// this computer for each teacher (localStorage cq.layout:<view>:<profile>, profile.js prefKey) ----
hostLayout = initLayout({
  stage: $('#hostScreen'),
  view: () => (isBig() ? 'big' : 'normal'),
  storageKey: (view) => prefKey(`cq.layout:${view}`),
  canEdit: () => Boolean(room) && !$('#hostScreen').hidden,
  returnFocus: () => $('#screenMenuBtn'),
  onToggle(on) {
    $('#layoutBtn').setAttribute('aria-checked', String(on));
    $('#layoutBtn').textContent = on ? '✓ Done editing layout' : '✏️ Edit layout';
  },
});
$('#layoutBtn').addEventListener('click', () => hostLayout.toggle());

// Full screen goes with big screen: on together, and off together when full screen turned big screen on.
let bigForFull = false;
async function toggleFull() {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  try {
    await document.documentElement.requestFullscreen();
    bigForFull = !isBig();
    if (bigForFull) setBig(true);
  } catch {
    toast('This browser would not go full screen. Try F11.', 'warn');
  }
}
document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement);
  $('#fullBtn').setAttribute('aria-checked', String(on));
  $('#fullBtn').textContent = on ? '✕ Leave full screen' : '⛶ Full screen';
  if (!on && bigForFull) setBig(false);
  if (!on) bigForFull = false;
  announce(on ? 'Full screen on.' : 'Full screen off.');
});
$('#fullBtn').addEventListener('click', toggleFull);

// ---- Display preferences (Settings, Teacher preferences): this computer only (localStorage cq.display) ----
const DISPLAY = 'cq.display';
const DISPLAY_DEFAULTS = { size: 'm', who: true, art: true, startBig: false };
let prefs = { ...DISPLAY_DEFAULTS };
try {
  const v = JSON.parse(localStorage.getItem(prefKey(DISPLAY)));
  if (v && typeof v === 'object') {
    prefs = {
      size: ['s', 'm', 'l'].includes(v.size) ? v.size : 'm',
      who: v.who !== false,
      art: v.art !== false,
      startBig: v.startBig === true,
    };
  }
} catch { /* blocked or broken: the defaults */ }
function applyPrefs() {
  const b = document.body.classList;
  b.toggle('big-size-s', prefs.size === 's');
  b.toggle('big-size-l', prefs.size === 'l');
  b.toggle('big-no-who', !prefs.who);
  b.toggle('big-no-art', !prefs.art);
}
function fillPrefs() {
  $('#prefSize').value = prefs.size;
  $('#prefWho').checked = prefs.who;
  $('#prefArt').checked = prefs.art;
  $('#prefStartBig').checked = prefs.startBig;
}
for (const id of ['#prefSize', '#prefWho', '#prefArt', '#prefStartBig']) {
  $(id).addEventListener('change', () => {
    prefs = { size: $('#prefSize').value, who: $('#prefWho').checked, art: $('#prefArt').checked, startBig: $('#prefStartBig').checked };
    try { localStorage.setItem(prefKey(DISPLAY), JSON.stringify(prefs)); } catch { /* blocked: this page only */ }
    applyPrefs();
    boardHost.sendInfo(); // the board uses the same text size, names and art
  });
}
applyPrefs();
try { setBig(prefs.startBig || localStorage.getItem(BIG) === '1'); } catch { setBig(prefs.startBig); }

// ---- Keyboard shortcuts (shortcuts.js; the keys are shared/keys.js, the teacher's own in cq.keys) ----
const inRoom = () => Boolean(room) && !$('#hostScreen').hidden;
let volBeforeMute = 1;
function setVolume(v, say = true) {
  const vol = Math.round(Math.min(1, Math.max(0, v)) * 20) / 20;
  $('#volume').value = String(vol);
  $('#volume').dispatchEvent(new Event('input'));
  if (say) announce(vol === 0 ? 'Muted.' : `Volume ${Math.round(vol * 100)} percent.`);
}
const shortcuts = initShortcuts({
  enabled: inRoom,
  actions: {
    playPause() {
      // Nothing from the queue: the key runs the background music (if there is a link).
      if (!state?.nowPlaying && filler.hasLink) return filler.toggle();
      if (!started) {
        $('#startBtn').click();
        return announce('Music started.');
      }
      const willPause = !paused;
      $('#playBtn').click();
      announce(willPause ? 'Paused.' : 'Playing.');
    },
    skip() {
      if (!state?.nowPlaying) return announce('Nothing is playing.');
      $('#skipBtn').click();
      announce('Skipped.');
    },
    big() {
      setBig(!isBig());
      announce(isBig() ? 'Big screen on.' : 'Big screen off.');
    },
    full: toggleFull,
    lock() {
      if (!state) return;
      const locking = !state.locked;
      $('#lockBtn').click();
      announce(locking ? 'Suggestions locked.' : 'Suggestions unlocked.');
    },
    mute() {
      const v = Number($('#volume').value);
      if (v > 0) {
        volBeforeMute = v;
        setVolume(0);
      } else {
        setVolume(volBeforeMute || 1);
      }
    },
    volUp: () => setVolume(Number($('#volume').value) + 0.1),
    volDown: () => setVolume(Number($('#volume').value) - 0.1),
    filler() {
      if (!filler.hasLink && isBig()) setBig(false); // the link box is not on the big screen
      filler.toggle();
    },
    add() {
      if (!state) return;
      if (isBig()) setBig(false); // the search is not on the big screen
      picks.open();
    },
    settings() {
      if (state) $('#settingsBtn').click();
    },
    layout: () => hostLayout.toggle(),
  },
});
$('#prefKeys').addEventListener('click', () => {
  $('#settingsDlg').close();
  shortcuts.openHelp();
});

// ---- Class time (classtime.js): class end, cleanup, the bell schedule ----
const classTime = initClassTime({
  // The teacher's saved bell schedule and prefill: the key and who's teaching (null: not yet).
  headers: () => (canTeach() && (state?.profile ?? currentProfile()?.id) ? teacherHeaders(state?.profile ?? currentProfile()?.id) : null),
  send,
  onCleanup: cleanupPlayback,
});

// ---- The teacher's own picks (teacher-suggest.js; protocol.js TEACHER PICKS) ----
// 🔎 Suggest a song: the room's search over this socket; the server filters picks like students'.
const picks = initTeacherSuggest({ send, getState: () => state });

// ---- 🎵 The recap show's music and sounds (recap-audio.js; protocol.js RECAP MUSIC) ----
// The show pauses the room music and the background music, and gives back exactly what was playing.
const recapAudio = initRecapAudio({
  settings: () => state?.settings,
  volume: () => Number($('#volume').value),
  box: $('#recapMusic'),
  hold() {
    const held = holdForShow({ started, paused, filler: filler.state });
    if (held.queue) {
      clearInterval(fadeTimer); // a cleanup fade in progress: the show pauses it now
      player.pause();
      paused = true;
      updateButtons();
    }
    filler.suspend(true);
    return held;
  },
  release(held) {
    filler.suspend(false);
    const go = afterShow(held, { started, paused, cleanup: state?.cleanup === true });
    if (!go.queue) return;
    paused = false;
    if (loadedId) playNow();
    else syncPlayback();
    updateButtons();
  },
});

// ---- Top 5, the recap, the favorites (highlights.js) ----
// While the recap show plays, the recap music plays (above); with it off in Settings, the room music
// goes down to 40% (back up when it closes).
const highlights = initHighlights({
  audio: recapAudio,
  send,
  picks, // ➕ Suggest on each favorite (teacher-suggest.js)
  boards: () => boardHost.boards, // ▶ Play recap shows on the board(s) when one is connected
  isBig,
  duck(on) {
    const v = Number($('#volume').value) * (on ? 0.4 : 1);
    player.setVolume(v);
    filler.setVolume(v);
  },
});
const repeats = initRepeats({ send }); // 😴 Repeat cooldown + Resting songs

// ---- Start: a refresh, or reopening /host on this computer, rejoins the same room ----
const saved = hostStore.get();
if (signinReturn) {
  // Back from Spotify's login page (account.js took the answer out of the address bar).
  show('startScreen');
  showStep('signinStep');
  signinView('busy');
  $('#signinMsg').textContent = 'Signing in…';
  finish(signinReturn).then((done) => {
    if (done.ok) return afterSignin(done);
    showSignin(done.message);
  });
} else if (ROOM_ID_PATTERN.test(saved?.room ?? '') && typeof saved.token === 'string' && saved.classCode) enterRoom(saved);
else showStart();
updateButtons();
