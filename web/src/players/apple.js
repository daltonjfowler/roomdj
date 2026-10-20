// Full songs through the teacher's Apple Music subscription (phase 5), with MusicKit JS v3.
// This server signs the MusicKit developer token (src/apple.js) and hands it only to this host
// page (its host token); "Connect Apple Music" runs MusicKit's own Apple login (a popup), and
// "Disconnect" forgets it. The login stays in this browser (MusicKit keeps it in localStorage).
//
// RoomDJ keeps the real queue: Apple's queue only ever holds the one song now playing, and
// Apple's autoplay is off. Matching (shared/apple.js): the iTunes trackId is the Apple Music song
// id in most storefronts, so it is tried first; otherwise a catalog search. School rule: an
// explicit song never plays; with no clean version the host page is told why and skips it.
//
// Options: { notify(text, kind) } for messages that are not about one song, { onAuth() } called
// when the login changes (music.js redraws its button).

import { appleSkipMessage, resolveAppleSong } from '../../../shared/apple.js';
import { ITUNES, catalogOf } from '../../../shared/catalog.js';

const SDK_URL = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
const MATCHES = 'cq.appleMatches';
const NEED_LOGIN = 'Connect Apple Music first (the button under the player), or pick Song previews.';
const NEED_SUB = 'This Apple account has no Apple Music subscription. Connect one that does, or pick Song previews.';
const LOGIN_RAN_OUT = 'The Apple Music login ran out. Click Connect Apple Music again.';
const BAD_TOKEN = 'Apple Music did not accept this server\'s MusicKit key. Check the Apple setup (docs/APPLE-SETUP.md), or pick Song previews.';
const NO_ROOM = 'Open a room first: Apple Music starts once a room is open.';
const SDK_TIMEOUT_MS = 20_000;

/** play() rejects with this when Apple Music cannot play yet; host.js shows the message. */
function notReady(message) {
  const e = new Error(message);
  e.name = 'PlayerNotReady';
  return e;
}

let sdkLoading = null;
function loadSdk() {
  if (window.MusicKit?.configure) return Promise.resolve(window.MusicKit);
  sdkLoading ??= new Promise((resolve, reject) => {
    const fail = () => {
      sdkLoading = null;
      s.remove();
      reject(notReady('The Apple Music player would not load. Check the internet and try again.'));
    };
    const timer = setTimeout(fail, SDK_TIMEOUT_MS);
    document.addEventListener('musickitloaded', () => { clearTimeout(timer); resolve(window.MusicKit); }, { once: true });
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.dataset.webComponents = '';
    s.onerror = () => { clearTimeout(timer); fail(); };
    document.head.append(s);
  });
  return sdkLoading;
}

/** The developer token from this server; the room and host token come from the host session. */
async function askToken() {
  let room = null;
  try { room = JSON.parse(sessionStorage.getItem('cq.host')); } catch { /* blocked */ }
  if (!room?.room || !room?.token) throw notReady(NO_ROOM);
  let r;
  try {
    r = await fetch(`/api/apple/token?${new URLSearchParams({ room: room.room })}`, { headers: { 'x-host-token': room.token } });
  } catch {
    throw notReady('Could not reach the server for Apple Music. Check the internet and try again.');
  }
  const data = await r.json().catch(() => ({}));
  if (r.ok && data.token) return data.token;
  throw notReady(data.error === 'no_room' || data.error === 'host' ? NO_ROOM : (data.message || BAD_TOKEN));
}

// MusicKit is one instance per page: configured once, shared by every Apple player made here.
let kitReady = null;
function setup() {
  kitReady ??= (async () => {
    const MusicKit = await loadSdk();
    const developerToken = await askToken();
    let music;
    try {
      music = await MusicKit.configure({ developerToken, app: { name: 'RoomDJ', build: '1.0.0' } });
    } catch (err) {
      console.warn('MusicKit configure failed', err);
      throw notReady(BAD_TOKEN);
    }
    music ??= MusicKit.getInstance();
    try { music.autoplayEnabled = false; } catch { /* older MusicKit */ }
    return music;
  })();
  const mine = kitReady;
  mine.catch(() => { if (kitReady === mine) kitReady = null; });
  return kitReady;
}

function cachedMatch(id) {
  try { return JSON.parse(sessionStorage.getItem(MATCHES))?.[id] ?? null; } catch { return null; }
}
function cacheMatch(id, match) {
  try {
    const all = JSON.parse(sessionStorage.getItem(MATCHES)) ?? {};
    all[id] = match;
    sessionStorage.setItem(MATCHES, JSON.stringify(all));
  } catch { /* blocked or full: just look again next time */ }
}

/** MusicKit's error → what to do: { stop: message } (cannot play here at all) or { skip: message }. */
function explain(err) {
  const code = err?.errorCode ?? err?.reason ?? err?.name ?? '';
  if (code === 'SUBSCRIPTION_ERROR') return { stop: NEED_SUB };
  if (['AUTHORIZATION_ERROR', 'UNAUTHORIZED_ERROR', 'TOKEN_EXPIRED'].includes(code)) return { stop: LOGIN_RAN_OUT };
  if (code === 'NotAllowedError') return { block: err };
  return { skip: 'Apple Music could not play this song.' };
}

export function createApplePlayer({ notify = () => {}, onAuth = () => {} } = {}) {
  let ended = () => {}, failed = () => {}, time = () => {};
  let music = null, volume = 1;
  let unusable = null; // a message when Apple Music can never play here (no subscription)
  let song = null, matching = null, match = null, seq = 0;
  let startedId = null; // the catalog song we put in Apple's queue for `song`
  let playing = false; // it has started playing (so a later 'ended' or 'completed' is its end)
  let destroyed = false;

  const states = () => window.MusicKit?.PlaybackStates ?? {};
  const listeners = {
    authorizationStatusDidChange: () => onAuth(),
    playbackStateDidChange: ({ state } = {}) => {
      if (!startedId) return;
      const S = states();
      if (state === S.playing) playing = true;
      else if ((state === S.ended || state === S.completed) && playing) {
        halt();
        ended();
      }
    },
    playbackTimeDidChange: () => {
      if (!startedId || !music) return;
      time(music.currentPlaybackTime || 0, music.currentPlaybackDuration || (song?.durationMs ?? 0) / 1000);
    },
    mediaPlaybackError: (err) => {
      if (!startedId) return;
      const why = explain(err);
      halt();
      if (why.stop) {
        if (why.stop === NEED_SUB) unusable = NEED_SUB;
        notify(why.stop, 'bad');
      } else failed(why.skip);
    },
  };

  function attach(m) {
    if (music || destroyed) return m;
    music = m;
    for (const [name, fn] of Object.entries(listeners)) music.addEventListener(name, fn);
    music.volume = volume;
    onAuth();
    return m;
  }
  const kit = () => setup().then(attach);

  async function api(path, params) {
    const sf = music.storefrontId || music.storefrontCountryCode || 'us';
    return (await music.api.music(`/v1/catalog/${sf}${path}`, params))?.data;
  }

  /** { status: 'ok', id, name } | { status: 'explicit' } | { status: 'none' } */
  async function resolve(s) {
    const hit = cachedMatch(s.id);
    if (hit) return hit;
    const result = await resolveAppleSong(s, {
      byId: async (id) => (await api(`/songs/${encodeURIComponent(id)}`))?.data?.[0] ?? null,
      search: async (term) => (await api('/search', { term, types: 'songs', limit: 25 }))?.results?.songs?.data ?? [],
    });
    cacheMatch(s.id, result);
    return result;
  }

  /** Stop what plays now (if it is ours) and forget it. */
  function halt() {
    if (startedId) music?.stop()?.catch?.(() => {});
    startedId = null;
    playing = false;
  }

  const connected = () => Boolean(music?.isAuthorized);

  // Get MusicKit ready now, so the Connect click can open Apple's login straight away (a popup
  // opened long after the click is blocked).
  kit().catch(() => {});

  return {
    name: 'Apple Music (full songs)',
    // iTunes songs only: Spotify's catalog may not be used to find Apple's (its Developer Policy).
    canPlay: (s) => catalogOf(s?.id) === ITUNES,

    connected,
    /** Get MusicKit ready (the host page calls this when the pointer nears Connect). */
    prepare() { if (!music) kit().catch(() => {}); },
    /** Apple's login popup (call from a click). Resolves to { ok } or { ok: false, message }. */
    async connect() {
      try {
        const m = await kit();
        await m.authorize();
        unusable = null;
        onAuth();
        return m.isAuthorized ? { ok: true } : { ok: false, message: 'Apple Music was not connected.' };
      } catch (err) {
        onAuth();
        if (err?.name === 'PlayerNotReady') return { ok: false, message: err.message };
        console.warn('MusicKit authorize failed', err);
        return { ok: false, message: 'Apple Music was not connected. If a login window opened, finish it there; otherwise try again.' };
      }
    },
    async disconnect() {
      this.stop();
      try { await music?.unauthorize(); } catch { /* already out */ }
      onAuth();
    },

    load(s) {
      const mine = ++seq;
      halt();
      song = s;
      match = null;
      time(0, (s.durationMs || 0) / 1000);
      if (unusable || !connected()) {
        matching = null;
        return Promise.resolve();
      }
      matching = resolve(s).then((m) => {
        if (mine !== seq) return;
        if (m.status !== 'ok') return failed(appleSkipMessage(s, m.status));
        match = m;
      }, (err) => {
        if (mine !== seq) return;
        console.warn('Apple Music lookup failed', err);
        failed('Apple Music search did not work.');
      });
      return matching;
    },

    async play() {
      if (unusable) throw notReady(unusable);
      if (!music) await kit();
      if (!connected()) throw notReady(NEED_LOGIN);
      const mine = seq;
      if (!song) return;
      if (!matching) this.load(song);
      await matching;
      if (mine !== seq || !match) return;
      if (startedId === match.id) {
        await music.play();
        return;
      }
      try {
        await music.setQueue({ song: match.id, startPlaying: false });
        if (mine !== seq) return;
        startedId = match.id;
        playing = false;
        await music.play();
      } catch (err) {
        if (mine !== seq) return;
        const why = explain(err);
        if (why.block) throw why.block;
        halt();
        if (why.stop) {
          if (why.stop === NEED_SUB) unusable = NEED_SUB;
          throw notReady(why.stop);
        }
        console.warn('Apple Music play failed', err);
        failed(why.skip);
      }
    },

    pause() {
      try { music?.pause(); } catch { /* nothing loaded */ }
    },

    stop() {
      seq++;
      halt();
      song = null;
      match = null;
      matching = null;
      time(0, 1);
    },

    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      if (music) music.volume = volume;
    },

    onEnded(fn) { ended = fn; },
    onError(fn) { failed = fn; },
    onTime(fn) { time = fn; },

    /** Leave for good (another service was picked). The login stays for next time. */
    destroy() {
      this.stop();
      destroyed = true;
      if (music) for (const [name, fn] of Object.entries(listeners)) music.removeEventListener(name, fn);
      music = null;
    },
  };
}
