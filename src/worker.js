// RoomDJ (roomdj.com). The API and the pages come through here first (wrangler.jsonc `run_worker_first`;
// the built JS/CSS, images and unknown paths are served without the Worker, web/public/_headers):
//   1. http → https (301), and www.roomdj.com → roomdj.com.
//   2. /api/* is answered here (routes in shared/protocol.js). Room routes go to that room's
//      Durable Object (src/room.js). Everything else is the built pages in public/.
//   3. Every response gets the security headers below; HTML also gets the CSP.
//
// Teacher settings and the ban list live in this app's own KV namespace under "settings" and
// "banned", per teacher profile (src/teacher-kv.js; the profile list: src/profiles.js); class codes
// under "room:<hash>" (src/codes.js). /api/teacher/* needs the TEACHER_KEY secret. No secret set =
// no teacher access.
//
// Per-address fuses (Cloudflare rate-limit bindings, wrangler.jsonc; like uploadmymodel). A whole
// school reaches us from ONE public address, so they are only ever as tight as a whole class
// needs. JOIN_RATE_IP (60 a minute) counts every class code try BEFORE the compare: a student
// types the code once a day (a refresh rejoins with the room id), so a class of 35 plus typos
// fits. The per-device lockout (src/lockout.js) slows one guesser further and never locks out the
// class or the teacher. SEARCH_RATE (per device), SEARCH_RATE_IP and SEARCH_RATE_ALL (everyone)
// guard browsing before joining, which needs no code, so the internet cannot hammer the catalogs.
// BOARD_RATE_IP: the board's sign-in (POST /api/teacher/board), which a waiting board asks every
// 10 s; a school's boards all share the address, so it is generous.

import { DEFAULT_SETTINGS, DEVICE_ID_PATTERN, ROOM_ID_PATTERN } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';
import { normalizeCode, validateCode, validateUntil } from '../shared/code.js';
import { shiftTimes, validateTimes } from '../shared/classtime.js';
import { sha256Hex } from './room.js';
import { BOARD_CSP, BOARD_PERMISSIONS, COMMON_HEADERS, CONTENT_SECURITY_POLICY, PAGE_CSP } from './headers.js';
import { claimCode, codeHash, codeInUse, legacyCodeHash, putCodeRoute, readCodeRoute, releaseCode } from './codes.js';
import { addressOf, lockout } from './lockout.js';
import { readBanned } from './search.js';
import { quickCheck } from '../shared/filter.js';
import { songId } from '../shared/catalog.js';
import { artKey, artState } from '../shared/art.js';
import { cachedArtVerdict } from './art.js';
import { spotifyCatalogConfigured } from './spotify-catalog.js';
import { appleConfigured } from '../shared/apple.js';
import { appleDeveloperToken } from './apple.js';
import { teacherKvKey } from './teacher-kv.js';
import { handleProfiles, readProfileList, requestProfile, signedIn } from './profiles.js';
import { handleAuth, teacherSession } from './auth.js';
import { FREE_CAPS, freeUsage, spendFree } from './free.js';
import { prewarm } from './prewarm.js';
import { nightHours, nightShift } from './night.js';
import { refreshPopular } from './popular.js';
import { handleAdmin } from './admin.js';
import { cleanPath, robotsTag } from './seo.js';
import { readOpenRooms, removeOpenRoom, updateOpenRooms } from './open-rooms.js';
import { roomProfile } from '../shared/profiles.js';

export { Room } from './room.js';
export { CouponLedger } from './coupons.js';
export { CodeLock } from './codelock.js';
export { LyricsGate } from './lyrics-gate.js';
import { couponsOn } from './coupons.js';

const KV_SETTINGS = 'settings';
const MAX_TEACHER_BYTES = 32 * 1024;
const MAX_JOIN_BYTES = 1024;
const TEACHER_REJECT_DELAY_MS = 300;
const WRONG_CODE = { error: 'code', message: 'That class code is not right. Check the board and type it again.' };

function isLocal(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

// Asset responses have immutable headers, so copy into a new Response first. A WebSocket
// upgrade (101) is passed through untouched.
function withSecurityHeaders(response, path = '') {
  if (response.status === 101 || response.webSocket) return response;
  const copy = new Response(response.body, response);
  for (const [name, value] of COMMON_HEADERS) copy.headers.set(name, value);
  // The host page opens Apple's login window (MusicKit), which reports back to its opener: keep
  // the opener for popups the host page opens. Every other page keeps plain same-origin.
  if (path.startsWith('/host')) copy.headers.set('cross-origin-opener-policy', 'same-origin-allow-popups');
  const board = path === '/board' || path.startsWith('/board/');
  // The admin page (/admin/, src/admin.js): this site's scripts only, talks only to this server.
  const admin = path === '/admin' || path.startsWith('/admin/');
  if (admin) copy.headers.set('referrer-policy', 'no-referrer');
  if (board) {
    copy.headers.set('permissions-policy', BOARD_PERMISSIONS);
    copy.headers.set('referrer-policy', 'no-referrer');
  }
  const type = (copy.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html') copy.headers.set('content-security-policy', path.startsWith('/host') ? CONTENT_SECURITY_POLICY : board || admin ? BOARD_CSP : PAGE_CSP);
  return copy;
}

const CANONICAL_HOST = 'roomdj.com';

// Where to send this request instead, or null to answer it: http → https, and
// www.roomdj.com → roomdj.com. The port is dropped: Cloudflare's alternate http ports do not
// speak https. The workers.dev address stays on as a fallback, not redirected.
export function redirectTarget(requestUrl) {
  const url = new URL(requestUrl);
  const host = url.hostname.toLowerCase();
  const isWww = host === 'www.' + CANONICAL_HOST;
  const clean = cleanPath(url.pathname); // /about.html -> /about, a 301 (seo.js)
  const toHttps = isWww || (url.protocol === 'http:' && !isLocal(host));
  if (!toHttps && !clean) return null;
  if (clean) url.pathname = clean;
  if (toHttps) {
    url.protocol = 'https:';
    if (isWww) url.hostname = CANONICAL_HOST;
    url.port = '';
  }
  return url.toString();
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const encoder = new TextEncoder();

// Secret comparison that leaks nothing through timing: both sides hashed to 32 bytes, then
// Cloudflare's timingSafeEqual (same as uploadmycut).
/** True when `given` equals any of `keys`. Every key is compared, so the time does not say which one. */
async function anyKeyEquals(given, keys) {
  const hits = await Promise.all(keys.map((k) => constantTimeEquals(given, k)));
  return hits.some(Boolean);
}

async function constantTimeEquals(a, b) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

// A wrong key waits a moment (slows guessing). No secret uploaded means no teacher endpoint at
// all: never fall open. No lockout: a school shares one IP, and a lockout would let one student
// lock out the teacher.
// FULLY OFF on the real site (Dalton, 2026-10-20): the key works only on a local test server
// (127.0.0.1 / localhost), even if a TEACHER_KEY secret is ever uploaded again.
function keyAllowed(request) {
  return ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname);
}

async function teacherOk(request, env) {
  // TEACHER_KEY_2: an optional second teacher (a student teacher); delete that secret to remove them.
  const keys = keyAllowed(request) ? [env.TEACHER_KEY, env.TEACHER_KEY_2].filter(Boolean) : [];
  if (!keys.length) {
    console.error(JSON.stringify({ message: 'TEACHER_KEY is not set; teacher endpoint refused' }));
  } else if (await anyKeyEquals(request.headers.get('x-teacher-key') ?? '', keys)) {
    return true;
  }
  await new Promise((r) => setTimeout(r, TEACHER_REJECT_DELAY_MS));
  return false;
}

// A teacher profile's saved settings, or the defaults if none are saved (or they no longer pass the
// checks). profile null / legacy: the plain "settings" key (the data from before profiles).
export async function readSettings(env, profile = null) {
  try {
    const saved = await env.CLASS_KV?.get(teacherKvKey(KV_SETTINGS, profile), 'json');
    if (saved) {
      const v = validateSettings(saved, { testAiOff: env.TEST_AI_OFF === 'on' });
      if (v.ok) return v.settings;
      console.error(JSON.stringify({ message: 'saved settings no longer valid; using defaults', errors: v.errors }));
    }
  } catch (e) {
    console.error(JSON.stringify({ message: 'settings read failed', error: String(e) }));
  }
  return { ...DEFAULT_SETTINGS, blocklist: [] };
}

/** 32 random bytes, base64url. */
function makeHostToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function roomStub(env, id) {
  return env.ROOMS.get(env.ROOMS.idFromName(id));
}

/** A small JSON body, or a Response saying why not. */
async function readJson(request, max) {
  if (Number(request.headers.get('content-length') ?? 0) > max) return json(413, { error: 'size', message: 'That is too much to send.' });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > max) return json(413, { error: 'size', message: 'That is too much to send.' });
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return json(400, { error: 'json', message: 'The page sent something the server could not read.' });
  }
}

/** 16 random bytes, hex: the room's id (its Durable Object name and URL). */
function makeRoomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Open a room for the day with the teacher's class code. A code another open room has (the other
// teacher's) is refused; the room is named by a random id, and KV maps the code's hash to it.
// The open-room form's quick choices (createRoom): settings a new room may set and keep as the default.
const QUICK_KEYS = ['startingCredits', 'backToWork', 'backToWorkMinutes'];

async function createRoom(request, env) {
  const read = await readJson(request, MAX_JOIN_BYTES);
  if (read instanceof Response) return read;
  const v = validateCode(read.body?.code);
  if (!v.ok) return json(400, { error: 'invalid_code', message: v.message });
  if (!validateUntil(read.body?.until)) return json(400, { error: 'until', message: 'Pick how long the room stays open (up to a day).' });
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  // Who's teaching (protocol.js TEACHER PROFILES): an active profile on the list, kept by the room.
  const profile = await requestProfile(request, env, typeof read.body?.profile === 'string' ? read.body.profile : null);
  if (profile instanceof Response) return profile;
  let settings = await readSettings(env, profile);
  // Quick start (the open-room form): Song suggestions (credits or unlimited) and 📚 Back to work
  // (the wait between suggestions) for this room, kept as the teacher's default once the room opens.
  // A key left out keeps the saved setting, as before.
  const quick = Object.fromEntries(QUICK_KEYS.filter((k) => read.body && Object.hasOwn(read.body, k) && read.body[k] !== settings[k]).map((k) => [k, read.body[k]]));
  const newDefault = Object.keys(quick).length > 0;
  if (newDefault) {
    const changed = validateSettings({ ...settings, ...quick }, { testAiOff: env.TEST_AI_OFF === 'on' });
    if (!changed.ok) return json(400, { error: 'quick', message: changed.errors[0] });
    settings = changed.settings;
  }
  // Class time: the page sends BELL times; the room keeps the real moments (+ the teacher's
  // bellOffsetSeconds, protocol.js BELL OFFSET), checked as such: cleanupAt (optional) after now
  // and before class ends (shared/classtime.js).
  const times = validateTimes(shiftTimes({ until: read.body.until, cleanupAt: read.body?.cleanupAt ?? null }, settings.bellOffsetSeconds));
  if (!times.ok) return json(400, { error: times.error === 'cleanup' ? 'cleanup' : 'until', message: times.message });
  const { until, cleanupAt } = times;
  // The bell period picked (a name on this teacher's bell schedule, else none): the room keeps it for
  // the period's own running favorite (src/room.js periodFavorite).
  const period = typeof read.body?.period === 'string' && (settings.bellSchedule ?? []).some((b) => b.name === read.body.period) ? read.body.period : null;
  const hash = await codeHash(v.code);
  if ((await codeInUse(env, hash)) || (await codeInUse(env, await legacyCodeHash(v.code)))) {
    return json(409, { error: 'code_taken', message: 'Another open room is using that class code. Pick a different one.' });
  }
  // Every teacher runs one room at a time (Dalton, 2026-10-16: "It doesn't make any sense to ever have
  // two at once"; free teachers since 2026-10-14). One Spotify account plays one stream anyway.
  if ((await teacherRooms(env, profile)).length) {
    return json(409, { error: 'one_room', message: 'RoomDJ runs one room at a time. Open or close your room under "Your open rooms" first.' });
  }
  // A free teacher's rooms today (per Spotify account; protocol.js FREE TEACHERS).
  if (!(await spendFree(env, profile, 'rooms'))) {
    return json(429, { error: 'rooms_today', message: `Free RoomDJ opens up to ${FREE_CAPS.rooms} rooms a day. Take back a room you already opened, or try again tomorrow.` });
  }
  const hostToken = makeHostToken();
  const hostHash = await sha256Hex(hostToken);
  const id = makeRoomId();
  // The final say on the code (src/codelock.js): KV above can lag, the lock cannot.
  if (!(await claimCode(env, hash, id, until))) {
    return json(409, { error: 'code_taken', message: 'Another open room is using that class code. Pick a different one.' });
  }
  const res = await roomStub(env, id).fetch('https://room/init', {
    method: 'POST',
    body: JSON.stringify({ id, codeHash: hash, until, cleanupAt, settings, hostHash, profile: roomProfile(profile), period, code: v.code }),
  });
  if (res.status !== 201) {
    await releaseCode(env, hash, id);
    console.error(JSON.stringify({ message: 'room init failed', status: res.status }));
    return json(500, { error: 'server', message: 'Could not open a room. Try again.' });
  }
  await putCodeRoute(env, hash, id, until);
  if (newDefault) await env.CLASS_KV.put(teacherKvKey(KV_SETTINGS, profile), JSON.stringify(settings));
  return json(200, { room: id, code: v.code, until, cleanupAt, hostToken });
}

/** What a room compares to its own teacher (src/room.js teachersRoom). */
const ownerOf = (p) => ({ id: p.id, legacy: p.legacy === true });

/**
 * This teacher's live rooms (their open-room list, each room asked; gone ones are taken off the list):
 * [{ room, code, until, period, songs, students, hostOnline }].
 */
async function teacherRooms(env, profile) {
  const live = [];
  const gone = [];
  for (const { room } of await readOpenRooms(env, profile)) {
    if (!ROOM_ID_PATTERN.test(room)) continue;
    const res = await roomStub(env, room).fetch('https://room/teacherInfo', { method: 'POST', body: JSON.stringify({ profile: ownerOf(profile) }) });
    if (res.ok) live.push(await res.json());
    else gone.push(room);
  }
  if (gone.length) await updateOpenRooms(env, profile, (list) => gone.reduce((l, id) => removeOpenRoom(l, id), list));
  return live;
}

// "Your open rooms" on the start screen (it replaced "Take back a room I already opened"): GET lists
// them; POST .../resume { room } opens one on this computer (a new host token; the room checks it is
// this teacher's). No class code to type.
async function listRooms(request, env) {
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  const profile = await requestProfile(request, env);
  if (profile instanceof Response) return profile;
  return json(200, { rooms: await teacherRooms(env, profile) });
}
async function resumeRoom(request, env) {
  const profile = await requestProfile(request, env);
  if (profile instanceof Response) return profile;
  const read = await readJson(request, MAX_JOIN_BYTES);
  if (read instanceof Response) return read;
  const room = read.body?.room;
  if (typeof room !== 'string' || !ROOM_ID_PATTERN.test(room)) return json(404, NO_ROOM);
  const hostToken = makeHostToken();
  const res = await roomStub(env, room).fetch('https://room/teacherResume', {
    method: 'POST', body: JSON.stringify({ profile: ownerOf(profile), hostHash: await sha256Hex(hostToken) }),
  });
  if (!res.ok) return json(404, NO_ROOM);
  return json(200, { ...(await res.json()), hostToken });
}

// "Close my open rooms" (the start screen): every room on this teacher's open-room list closes, like
// pressing Close room in each (each room checks it is this teacher's). → { closed: n }
async function closeAllRooms(request, env) {
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  const profile = await requestProfile(request, env);
  if (profile instanceof Response) return profile;
  let closed = 0;
  const done = [];
  for (const { room } of await readOpenRooms(env, profile)) {
    if (!ROOM_ID_PATTERN.test(room)) continue;
    const res = await roomStub(env, room).fetch('https://room/teacherClose', { method: 'POST', body: JSON.stringify({ profile: ownerOf(profile) }) });
    if (res.ok) closed++;
    done.push(room); // closed now, or gone / not this teacher's: off the list either way
  }
  if (done.length) await updateOpenRooms(env, profile, (list) => done.reduce((l, id) => removeOpenRoom(l, id), list));
  console.log(JSON.stringify({ message: 'teacher closed open rooms', profile: profile.id, closed }));
  return json(200, { closed });
}

// A student types the class code. Order matters (like uploadmymodel's /api/slice): the address
// fuse first, then the device's lockout (a locked device is refused WITHOUT comparing), then the
// compare. A wrong code and "no room has that code" are the same answer.
async function joinRoom(request, env) {
  if (env.JOIN_RATE_IP && !(await env.JOIN_RATE_IP.limit({ key: addressKey(request) })).success) {
    return json(429, { error: 'busy', message: 'A lot of joining is coming from your school right now. Wait a minute and try again.' });
  }
  const device = request.headers.get('x-device') ?? '';
  if (!DEVICE_ID_PATTERN.test(device)) return json(400, { error: 'device', message: 'Reload the page and try again.' });
  const lock = await lockout(env, 'code', request);
  if (lock.locked) return lock.response(json);
  const read = await readJson(request, MAX_JOIN_BYTES);
  if (read instanceof Response) return read;
  const code = normalizeCode(read.body?.code);
  let admitted = null;
  if (code) {
    // The code with any spacing; a room opened before spacing stopped mattering has the legacy hash.
    let hash = await codeHash(code);
    let route = await readCodeRoute(env, hash);
    if (!route) {
      hash = await legacyCodeHash(code);
      route = await readCodeRoute(env, hash);
    }
    if (route && ROOM_ID_PATTERN.test(route.id)) {
      const res = await roomStub(env, route.id).fetch('https://room/admit', {
        method: 'POST',
        body: JSON.stringify({ codeHash: hash, device }),
      });
      // Right code, but this device was kicked or the room is full: say so (not a wrong guess).
      if (res.status !== 403 || (await res.clone().json().catch(() => ({}))).error !== 'code') {
        if (!res.ok) return res;
        admitted = await res.json();
      }
    }
  }
  if (!admitted) {
    await lock.wrong();
    return json(403, WRONG_CODE);
  }
  await lock.right();
  return json(200, admitted);
}

function addressKey(request) {
  return `ip ${addressOf(request)}`; // an IPv6 address counts as its /64
}

// Browsing before joining: the student's browser searches iTunes itself (from the school's own
// address) and asks here which of the songs it found may show. The teacher's saved default
// blocklist and the ban list apply here, so the blocked words never reach a page; the explicit
// flag is checked too. Display only: a suggestion needs a room, which takes every song from its
// own iTunes data. No AI call. Limits per device, per address and for everyone together.
const MAX_BROWSE_BYTES = 16 * 1024;
const BROWSE_SONGS_MAX = 30;
async function browseCheck(request, env) {
  const device = request.headers.get('x-device') ?? '';
  if (!DEVICE_ID_PATTERN.test(device)) return json(400, { error: 'device', message: 'Reload the page and try again.' });
  const busy = (message) => json(429, { error: 'rate', message });
  if (env.SEARCH_RATE && !(await env.SEARCH_RATE.limit({ key: `device ${device}` })).success) {
    return busy('That is a lot of searching. Wait a minute and try again.');
  }
  if (env.SEARCH_RATE_IP && !(await env.SEARCH_RATE_IP.limit({ key: addressKey(request) })).success) {
    return busy('A lot of searching is coming from your school right now. Wait a minute and try again.');
  }
  if (env.SEARCH_RATE_ALL && !(await env.SEARCH_RATE_ALL.limit({ key: 'everyone' })).success) {
    return busy('The song search is very busy right now. Wait a minute and try again.');
  }
  const read = await readJson(request, MAX_BROWSE_BYTES);
  if (read instanceof Response) return read;
  const list = read.body?.songs;
  if (!Array.isArray(list) || list.length > BROWSE_SONGS_MAX) return json(400, { error: 'songs', message: 'The page sent something the server could not read.' });
  const { blocklist, banned, art: artSettings } = await browseFilter(env);
  const str = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
  const allowed = list.map((x) => {
    const id = songId(x?.id);
    if (!id) return false;
    const song = { id, title: str(x.title), artist: str(x.artist), album: str(x.album), explicit: x?.explicit === 'cleaned' || x?.explicit === 'notExplicit' ? x.explicit : 'explicit' };
    return quickCheck(song, { blocklist, banned }) === null;
  });
  // 🖼 Covers (protocol.js ALBUM ART): the KV art cache only, never an AI call. No room, so no
  // teacher's Show anyway; any teacher's "Hide all album art" hides them all here.
  const art = await Promise.all(list.map(async (x, i) => {
    const key = allowed[i] ? artKey(x?.artwork) : null;
    const verdict = key && artSettings.artCheck && !artSettings.hideAllArt ? (await cachedArtVerdict(env, key))?.verdict ?? null : null;
    return artState(artSettings, { key, verdict });
  }));
  return json(200, { allowed, art });
}

// Browsing has no room, so no teacher profile: every profile's saved blocked words and bans count
// (the strictest; display only). The plain keys (the legacy profile, and everything before
// profiles) always count. Kept in this isolate's memory for a minute (2 KV reads a profile).
const BROWSE_FILTER_MS = 60_000;
let browseCache = null; // { at, value }
async function browseFilter(env) {
  if (browseCache && Date.now() - browseCache.at < BROWSE_FILTER_MS) return browseCache.value;
  const scopes = [null, ...(await readProfileList(env)).filter((p) => !p.legacy)];
  const parts = await Promise.all(scopes.map((p) => Promise.all([readSettings(env, p), readBanned(env, p)])));
  const value = {
    blocklist: [...new Set(parts.flatMap(([s]) => s.blocklist))],
    banned: new Set(parts.flatMap(([, b]) => [...b])),
    // The strictest: the check is off only when every teacher turned it off.
    art: { artCheck: parts.some(([s]) => s.artCheck !== false), hideAllArt: parts.some(([s]) => s.hideAllArt === true) },
  };
  browseCache = { at: Date.now(), value };
  return value;
}

// The board's sign-in (protocol.js BOARD SIGN-IN): the teacher's most recently opened room that is
// live, and a new sign-in board token for it. Only rooms on THIS profile's signpost, and each room
// checks again that it is this teacher's, so a board never gets another teacher's room. Entries
// whose room is closed (or not this teacher's) are taken off the signpost.
async function signinBoard(request, env) {
  if (env.BOARD_RATE_IP && !(await env.BOARD_RATE_IP.limit({ key: addressKey(request) })).success) {
    return json(429, { error: 'busy', message: 'A lot of boards are asking at once. This board tries again in a moment.' });
  }
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  const profile = await requestProfile(request, env);
  if (profile instanceof Response) return profile;
  const gone = [];
  let found = null;
  for (const { room } of await readOpenRooms(env, profile)) {
    const res = await roomStub(env, room).fetch('https://room/boardToken', {
      method: 'POST',
      body: JSON.stringify({ profile: { id: profile.id, legacy: profile.legacy === true } }),
    });
    if (res.ok) {
      found = await res.json();
      break;
    }
    if (res.status === 404) gone.push(room);
  }
  if (gone.length) await updateOpenRooms(env, profile, (list) => gone.reduce((l, id) => removeOpenRoom(l, id), list));
  if (!found) return json(404, { error: 'no_room', message: `${profile.name} has no room open right now.` });
  return json(200, { room: found.room, boardToken: found.boardToken, until: found.until });
}

async function handleTeacher(request, env, url) {
  // Spotify sign-in (protocol.js SPOTIFY SIGN-IN): the session names the profile. Without one, the
  // old teacher key (only while a TEACHER_KEY secret is set: local tests).
  const session = await teacherSession(request, env);
  if (session instanceof Response) return session;
  if (session) signedIn.set(request, session);
  else if (!(await teacherOk(request, env))) return json(401, { error: 'key', message: 'Wrong teacher key.' });
  if (url.pathname === '/api/teacher/board') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    return signinBoard(request, env);
  }
  if (url.pathname === '/api/teacher/rooms') {
    if (request.method === 'GET') return listRooms(request, env);
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use GET or POST.' });
    return createRoom(request, env);
  }
  if (url.pathname === '/api/teacher/rooms/resume') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    return resumeRoom(request, env);
  }
  if (url.pathname === '/api/teacher/rooms/close-all') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    return closeAllRooms(request, env);
  }
  if (url.pathname === '/api/teacher/profiles' || url.pathname.startsWith('/api/teacher/profiles/')) return handleProfiles(request, env, url);
  if (url.pathname === '/api/teacher/usage') {
    // A free teacher's caps today, per Spotify account (protocol.js FREE TEACHERS).
    if (request.method !== 'GET') return json(405, { error: 'method', message: 'Use GET.' });
    const profile = await requestProfile(request, env);
    if (profile instanceof Response) return profile;
    return json(200, await freeUsage(env, profile));
  }
  if (url.pathname !== '/api/teacher/settings') return json(404, { error: 'not_found', message: 'No such API.' });
  if (request.method !== 'GET' && request.method !== 'PUT') return json(405, { error: 'method', message: 'Use GET or PUT.' });
  // Each teacher profile has its own settings (protocol.js TEACHER PROFILES).
  const profile = await requestProfile(request, env);
  if (profile instanceof Response) return profile;
  if (request.method === 'GET') return json(200, await readSettings(env, profile));
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_TEACHER_BYTES) return json(413, { error: 'size', message: 'That is too much to save.' });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_TEACHER_BYTES) return json(413, { error: 'size', message: 'That is too much to save.' });
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(400, { error: 'json', message: 'The page sent something the server could not read.' });
  }
  // A page may send only the fields it changes (the bell schedule editor): the rest keep their saved values.
  const v = validateSettings(body && typeof body === 'object' && !Array.isArray(body) ? { ...(await readSettings(env, profile)), ...body } : body, { testAiOff: env.TEST_AI_OFF === 'on' });
  if (!v.ok) return json(400, { error: 'invalid', message: 'Some of those values are not allowed.', details: v.errors });
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  await env.CLASS_KV.put(teacherKvKey(KV_SETTINGS, profile), JSON.stringify(v.settings));
  browseCache = null; // browsing in this isolate sees new blocked words at once
  return json(200, v.settings);
}

const NO_ROOM = { error: 'no_room', message: 'This room is closed. Ask your teacher for today\'s class code.' };

async function handleRoom(request, env, url, match) {
  const id = match[1];
  const action = match[2] ?? '';
  if (!ROOM_ID_PATTERN.test(id)) return json(404, NO_ROOM);
  if (request.method !== 'GET') return json(405, { error: 'method', message: 'Use GET.' });
  const stub = roomStub(env, id);
  if (action === '') return stub.fetch('https://room/info');
  if (action === '/search' || action === '/songbook') {
    return stub.fetch(`https://room${action}${url.search}`, { headers: { 'x-device': request.headers.get('x-device') ?? '' } });
  }
  if (action === '/ws') return stub.fetch(new Request(`https://room/ws${url.search}`, request));
  if (action === '/youtube') {
    return stub.fetch(`https://room/youtube${url.search}`, { headers: { 'x-host-token': request.headers.get('x-host-token') ?? '' } });
  }
  return json(404, { error: 'not_found', message: 'No such API.' });
}

// Which music services this server has set up (public: no secrets in it). The host page shows
// only these in its "Music from" picker. A Spotify Client ID is public by design; its secret
// (SPOTIFY_CLIENT_SECRET, for the server's own catalog search) never leaves the Worker.
export function serviceConfig(env, request) {
  const spotifyId = String(env.SPOTIFY_CLIENT_ID ?? '').trim();
  return {
    services: {
      preview: true,
      // catalog: the secret is set too, so Spotify rooms search Spotify's catalog (never sent here).
      spotify: /^[0-9a-f]{32}$/i.test(spotifyId) ? { clientId: spotifyId, catalog: spotifyCatalogConfigured(env) } : false,
      youtube: Boolean(env.YOUTUBE_API_KEY),
      // Apple Music: all three secrets set (docs/APPLE-SETUP.md). The token itself is host-only.
      apple: appleConfigured(env),
    },
    // The old shared teacher key: local test servers with its secret only (keyAllowed).
    teacherKey: keyAllowed(request) && Boolean(env.TEACHER_KEY || env.TEACHER_KEY_2),
    // 🎟 Coupons (src/coupons.js; built dark): the student page and Settings show them only then.
    coupons: couponsOn(env),
    // Student nicknames are made ("Brave Otter", shared/nickgen.js); typed ones only for local tests.
    typedNicknames: env.TYPED_NICKNAMES === 'on',
    testAiOff: env.TEST_AI_OFF === 'on', // local browser tests only: the host shows the old AI switches
  };
}

// The MusicKit developer token, for a host page only: its host token must fit an open room (the
// Room checks, in constant time). Limited to this site by the token's origin claim.
async function appleToken(request, env, url) {
  if (!appleConfigured(env)) return json(404, { error: 'apple_off', message: 'Apple Music is not set up on this server.' });
  const id = url.searchParams.get('room') ?? '';
  const token = request.headers.get('x-host-token') ?? '';
  const denied = json(403, { error: 'host', message: "Only the teacher's host page can use Apple Music." });
  if (!ROOM_ID_PATTERN.test(id) || !token) return denied;
  const res = await roomStub(env, id).fetch('https://room/host', { headers: { 'x-host-token': token } });
  if (res.status === 404) return json(404, NO_ROOM);
  if (!res.ok) return denied;
  // Free teachers: no Apple Music (it runs on RoomDJ's own Apple developer key; protocol.js FREE TEACHERS).
  if ((await res.json().catch(() => ({}))).free) return json(403, { error: 'apple_off', message: 'Apple Music is not available on free RoomDJ. Use Spotify.' });
  try {
    const { token: developerToken, exp } = await appleDeveloperToken(env, url.origin);
    return json(200, { token: developerToken, exp });
  } catch (e) {
    console.error(JSON.stringify({ message: 'apple token failed', error: String(e) }));
    return json(503, { error: 'apple_key', message: 'The Apple Music key on this server does not work. Check docs/APPLE-SETUP.md.' });
  }
}

async function handleApi(request, env, url) {
  if (url.pathname === '/api/health') return json(200, { ok: true });
  if (url.pathname === '/api/config') {
    if (request.method !== 'GET') return json(405, { error: 'method', message: 'Use GET.' });
    return json(200, serviceConfig(env, request));
  }
  if (url.pathname.startsWith('/api/auth/')) return handleAuth(request, env, url);
  if (url.pathname.startsWith('/api/admin/')) return handleAdmin(request, env, url);
  // Everything under /api/teacher/ needs a session or the key, even paths that do not exist.
  if (url.pathname.startsWith('/api/teacher/')) return handleTeacher(request, env, url);
  if (url.pathname === '/api/join') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    return joinRoom(request, env);
  }
  if (url.pathname === '/api/browse') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    return browseCheck(request, env);
  }
  if (url.pathname === '/api/apple/token') {
    if (request.method !== 'GET') return json(405, { error: 'method', message: 'Use GET.' });
    return appleToken(request, env, url);
  }
  const room =url.pathname.match(/^\/api\/rooms\/([^/]+)(\/search|\/songbook|\/ws|\/youtube)?$/);
  if (room) return handleRoom(request, env, url, room);
  return json(404, { error: 'not_found', message: 'No such API.' });
}

export default {
  async fetch(request, env) {
    const target = redirectTarget(request.url);
    if (target !== null) {
      return withSecurityHeaders(new Response(null, { status: 301, headers: { location: target } }));
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return withSecurityHeaders(await handleApi(request, env, url));
      } catch (e) {
        console.error(JSON.stringify({ message: 'api request failed', path: url.pathname, error: String(e) }));
        return withSecurityHeaders(json(500, { error: 'server', message: 'Something went wrong on the server. Try again.' }));
      }
    }
    const page = withSecurityHeaders(await env.ASSETS.fetch(request), url.pathname);
    const robots = robotsTag(request.url, url.pathname);
    if (robots) page.headers.set('x-robots-tag', robots);
    return page;
  },
  // The cron (wrangler.jsonc triggers): at night, the songs classes could not settle (src/night.js);
  // then chart songs before classes suggest them (src/prewarm.js); once a day 🔥 Popular (src/popular.js).
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (nightHours(Date.now())) await nightShift(env).catch((e) => console.error(JSON.stringify({ message: 'night shift failed', error: String(e) })));
      await prewarm(env).catch((e) => console.error(JSON.stringify({ message: 'prewarm failed', error: String(e) })));
      await refreshPopular(env).catch((e) => console.error(JSON.stringify({ message: 'popular failed', error: String(e) })));
    })());
  },
};
