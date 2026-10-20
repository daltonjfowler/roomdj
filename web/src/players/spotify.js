// Full songs through the teacher's Spotify Premium account. The Spotify Web Playback SDK makes a
// "RoomDJ" speaker inside this browser tab; each song is started on it with one Web API call
// (PUT /me/player/play with a single track). RoomDJ keeps the real queue, so Spotify's own
// queue is never used.
//
// A song from Spotify's catalog ('sp:' id: the room searched Spotify) plays by its own id. A song
// from iTunes is matched to a Spotify track first (shared/spotify.js). School rule: an explicit
// Spotify track never plays (the server never lets an explicit 'sp:' song in). If Spotify only has
// the explicit version, or does not have the song, the host page is told why and skips it.
//
// Options: { auth } from spotify-auth.js, { notify(text, kind) } for messages that are not about one
// song (login ran out, not Premium).
//
// Background music (web/src/filler.js) plays a playlist or album on the same speaker with
// playContext(); a queue song then replaces it (one PUT /me/player/play with its track), and the
// end watch ignores the background music's states (createEndWatch ignoreContext).

import {
  SPOTIFY_API, combineMatches, createEndWatch, looseQuery, pickMatch, searchQuery, skipMessage, stateSummary,
} from '../../../shared/spotify.js';
import { spotifyTrackId } from '../../../shared/catalog.js';
import { mountSpotifyDetails } from '../spotify-details.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const MATCHES = 'cq.spotifyMatches';
const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 1000;
const FAVS_NAME = 'RoomDJ Favs';
const FAVS_SCOPE = 'Spotify needs your OK to save to a playlist. Sign out, sign in with Spotify again, then try ⭐ again.';
const NEED_LOGIN = 'Connect Spotify first (the button under the player), or pick Song previews.';
const NEED_PREMIUM = 'Spotify needs a Premium account to play songs here. Log in with a Premium account, or pick Song previews.';
const MOVED = 'Spotify moved to another device. Click Start music to bring it back here.';
const LOST_CHECK_MS = 1500;
const LOG_MAX = 60;
const DEBUG = new URLSearchParams(location.search).has('debug');
const NOT_LISTED = 'This Spotify account is not on the user list of RoomDJ\'s Spotify app. Add it in the Spotify developer dashboard (User Management), or pick Song previews.';

/** play() rejects with this when Spotify cannot play yet; host.js shows the message. */
function notReady(message) {
  const e = new Error(message);
  e.name = 'PlayerNotReady';
  return e;
}

let sdkLoading = null;
function loadSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  sdkLoading ??= new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => {
      sdkLoading = null;
      s.remove();
      reject(notReady('The Spotify player would not load. Check the internet and try again.'));
    };
    document.head.append(s);
  });
  return sdkLoading;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function cachedMatch(id) {
  try { return JSON.parse(sessionStorage.getItem(MATCHES))?.[id] ?? null; } catch { return null; }
}
function cacheMatch(id, match) {
  try {
    const all = JSON.parse(sessionStorage.getItem(MATCHES)) ?? {};
    all[id] = match;
    sessionStorage.setItem(MATCHES, JSON.stringify(all));
  } catch { /* blocked or full: just search again next time */ }
}

export function createSpotifyPlayer({ auth, notify = () => {} } = {}) {
  let ended = () => {}, failed = () => {}, time = () => {}, interrupted = () => {};
  let sdk = null, ready = null, volume = 1;
  let unusable = null; // a message when Spotify can never play here (not Premium, not allow-listed)
  let song = null, matching = null, match = null, seq = 0;
  let startedUri = null; // the track we asked Spotify to play for `song`
  let watch = null; // end of track for the started song (shared/spotify.js createEndWatch)
  let last = null; // the last player state while our track played
  let poll = null;
  let lostTimer = null; // checking whether a null state means another device took over
  let resumeMs = 0; // where to pick the song up after another device took it
  let filler = null; // background music: { uri (context), live (it is what the speaker holds), at: { uri, pos } }

  // Diagnostics: the last SDK states and what we made of them ("Spotify details" on the host page).
  // Song names and positions only: never a token.
  const log = [];
  let logStart = Date.now();
  function note(entry) {
    const e = { t: ((Date.now() - logStart) / 1000).toFixed(1), ...entry };
    const before = log.at(-1);
    // A poll that says nothing new (same track, same answer) just updates the last line.
    if (e.src === 'poll' && before?.src === 'poll' && before.uri === e.uri && before.paused === e.paused
      && before.decision === e.decision) {
      Object.assign(before, { t: e.t, pos: e.pos, n: (before.n ?? 1) + 1 });
    } else {
      log.push(e);
      if (log.length > LOG_MAX) log.shift();
    }
    if (DEBUG) console.debug('[spotify]', e);
  }
  function detailsText() {
    const lines = [
      `RoomDJ Spotify details, ${new Date().toISOString()}`,
      `Song: ${song ? `"${song.title}" by ${song.artist} (${Math.round((song.durationMs || 0) / 1000)} s)` : 'none'}`,
      `Started: ${startedUri?.slice(-6) ?? '-'}  Playing: ${watch?.uri?.slice(-6) ?? '-'}  Seen up to: ${Math.round((watch?.maxPos ?? 0) / 1000)} s`,
      navigator.userAgent,
      '',
      'time  source  track  "name"  paused  position/duration  [previous]  decision',
    ];
    for (const e of log) {
      if (e.msg) { lines.push(`${e.t}s  ${e.msg}`); continue; }
      const what = e.none ? '(no state)'
        : `${e.uri}  "${e.name}"  ${e.paused ? 'paused' : 'playing'}  ${(e.pos / 1000).toFixed(1)}/${(e.dur / 1000).toFixed(1)}  [${e.prev.join(',')}]`;
      lines.push(`${e.t}s  ${e.src}${e.n ? ` x${e.n}` : ''}  ${what}  ${e.decision}`);
    }
    return lines.join('\n');
  }
  const details = mountSpotifyDetails(detailsText);

  // Browsers only let the SDK make sound after a click on the page. Any click will do.
  const activate = () => { try { sdk?.activateElement?.(); } catch { /* old SDK */ } };
  document.addEventListener('click', activate, true);

  async function api(path, { method = 'GET', body, tries = 2 } = {}) {
    const token = await auth?.token();
    if (!token) throw notReady(NEED_LOGIN);
    const r = await fetch(`${SPOTIFY_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && tries > 1) {
      if (!(await auth.refreshNow())) throw notReady('The Spotify login ran out. Click Connect Spotify again.');
      return api(path, { method, body, tries: tries - 1 });
    }
    if (r.status === 429 && tries > 1) {
      await wait(Math.min(5, Number(r.headers.get('retry-after')) || 1) * 1000);
      return api(path, { method, body, tries: tries - 1 });
    }
    if (r.status === 403 && path.startsWith('/search')) {
      // Development-mode apps answer 403 for accounts that are not on the app's user list.
      unusable = NOT_LISTED;
      throw notReady(NOT_LISTED);
    }
    return r;
  }

  /** True when the playlist still exists and this account can read it (a deleted one answers 404). */
  async function stillMine(id) {
    const r = await api(`/playlists/${encodeURIComponent(id)}?fields=id`);
    return r.ok;
  }

  async function search(q) {
    const r = await api(`/search?${new URLSearchParams({ type: 'track', q, limit: '10', market: 'from_token' })}`);
    if (!r.ok) throw new Error('Spotify search did not work.');
    return (await r.json().catch(() => ({})))?.tracks?.items ?? [];
  }

  /** { status: 'ok', uri, name } | { status: 'explicit' } | { status: 'none' } */
  async function resolve(s) {
    const direct = spotifyTrackId(s.id);
    if (direct) return { status: 'ok', uri: `spotify:track:${direct}`, name: s.title };
    const hit = cachedMatch(s.id);
    if (hit) return hit;
    let result = pickMatch(s, await search(searchQuery(s)));
    if (result.status !== 'ok') result = combineMatches([result, pickMatch(s, await search(looseQuery(s)))]);
    cacheMatch(s.id, result);
    return result;
  }

  function connect() {
    if (ready) return ready;
    ready = (async () => {
      await loadSdk();
      if (!(await auth?.token())) throw notReady(NEED_LOGIN);
      const player = new window.Spotify.Player({
        name: 'RoomDJ',
        volume,
        getOAuthToken: (cb) => { auth.token().then((t) => { if (t) cb(t); }); },
      });
      sdk = player;
      // Made during a click (Start music)? Then it may make sound now.
      if (navigator.userActivation?.isActive) activate();
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(notReady('Spotify did not answer. Try Start music again.')), READY_TIMEOUT_MS);
        const giveUp = (message) => { clearTimeout(timer); fail(notReady(message)); };
        player.addListener('ready', ({ device_id: id }) => { clearTimeout(timer); done(id); });
        player.addListener('not_ready', () => { if (sdk === player) ready = null; });
        player.addListener('initialization_error', () => {
          unusable = 'This browser cannot play Spotify. Use Chrome, Edge or Firefox, or pick Song previews.';
          notify(unusable, 'bad');
          giveUp(unusable);
        });
        player.addListener('authentication_error', () => {
          const message = 'The Spotify login ran out. Click Connect Spotify again.';
          notify(message, 'bad');
          giveUp(message);
        });
        player.addListener('account_error', () => {
          unusable = NEED_PREMIUM;
          notify(NEED_PREMIUM, 'bad');
          giveUp(NEED_PREMIUM);
        });
        player.addListener('playback_error', (e) => {
          note({ msg: `playback_error ${String(e?.message ?? '').slice(0, 80)}${startedUri ? ' (skipping)' : ''}` });
          if (startedUri) failed('Spotify could not play this song.');
        });
        player.addListener('autoplay_failed', () => notify('Click Start music so this computer can play Spotify.', 'warn'));
        player.addListener('player_state_changed', (st) => onState(st, 'event'));
        player.connect().then((ok) => { if (!ok) giveUp('Could not connect to Spotify. Try again.'); });
      });
    })();
    const mine = ready;
    mine.catch(() => {
      if (ready !== mine) return;
      ready = null;
      sdk?.disconnect();
      sdk = null;
    });
    return ready;
  }

  function onState(state, src = 'poll') {
    // No state while our track was on: this tab is no longer Spotify's active device (the teacher
    // played on a phone or the desktop app). Check again before saying so; a blip is not a move.
    if (!state && startedUri && watch?.uri && !lostTimer) {
      lostTimer = setTimeout(async () => {
        lostTimer = null;
        const again = await sdk?.getCurrentState().catch(() => null);
        if (!again && startedUri && watch?.uri) moved();
      }, LOST_CHECK_MS);
    }
    // Background music on the speaker: remember where it is, to pick it up there after a queue song.
    if (filler && state && !startedUri && state.context?.uri === filler.uri) {
      const cur = state.track_window?.current_track;
      if (cur?.uri) filler.at = { uri: cur.uri, pos: Number(state.position) || 0 };
    }
    if (!startedUri || !song || !watch) return;
    // Never an end from one state: see createEndWatch (relinked uris, buffering, old previous_tracks).
    const { decision } = watch.observe(state);
    note({ src, ...stateSummary(state), decision });
    if (decision === 'ended') {
      note({ msg: 'ended: next song' });
      halt();
      ended();
      return;
    }
    if (!state || !watch.uri) return;
    last = state;
    time(state.position / 1000, state.duration / 1000);
  }

  function startPoll() {
    stopPoll();
    // Player state events come only on changes; polling keeps the progress bar and the
    // end-of-track check fresh.
    poll = setInterval(() => { sdk?.getCurrentState().then((st) => onState(st, 'poll')).catch(() => {}); }, POLL_MS);
  }
  function stopPoll() {
    clearInterval(poll);
    poll = null;
  }

  /** Another device has the music: forget our start, so the next play() starts it here again. */
  function moved() {
    resumeMs = last?.position ?? 0;
    note({ msg: `no state: another device has the music (at ${Math.round(resumeMs / 1000)} s)` });
    startedUri = null;
    watch = null;
    last = null;
    stopPoll();
    if (filler) filler.live = false;
    interrupted(MOVED);
  }

  /** Stop what plays now (if it is ours) and forget it. */
  function halt() {
    if (startedUri) sdk?.pause().catch(() => {});
    startedUri = null;
    watch = null;
    last = null;
    clearTimeout(lostTimer);
    lostTimer = null;
    stopPoll();
  }

  async function start(id, uri, at = 0, tries = 3) {
    const r = await api(`/me/player/play?device_id=${encodeURIComponent(id)}`, { method: 'PUT', body: { uris: [uri], position_ms: at } });
    if (r.ok) {
      if (filler) filler.live = false; // the queue song replaced the background music
      return;
    }
    // Just after 'ready' the new device may not be known to the Web API yet.
    if (r.status === 404 && tries > 1) {
      await wait(1000);
      return start(id, uri, at, tries - 1);
    }
    if (r.status === 403) {
      unusable = NEED_PREMIUM;
      throw notReady(NEED_PREMIUM);
    }
    throw new Error('Spotify would not start this song.');
  }

  // Make the speaker now, so it exists when the teacher clicks Start music (the click lets it play).
  if (auth?.connected()) connect().catch(() => {});

  return {
    name: 'Spotify (full songs)',
    canPlay: (s) => Boolean(s?.id),

    load(s) {
      const mine = ++seq;
      halt();
      song = s;
      logStart = Date.now();
      note({ msg: `load "${String(s.title).slice(0, 60)}" by ${String(s.artist).slice(0, 40)}` });
      match = null;
      resumeMs = 0;
      time(0, (s.durationMs || 0) / 1000);
      if (unusable || !auth?.connected()) {
        matching = null;
        return Promise.resolve();
      }
      matching = resolve(s).then((m) => {
        if (mine !== seq) return;
        if (m.status !== 'ok') {
          note({ msg: `no Spotify match (${m.status}): skipping` });
          return failed(skipMessage(s, m.status));
        }
        match = m;
        connect().catch(() => {}); // warm up the speaker while nothing plays yet
      }, (err) => {
        if (mine !== seq) return;
        if (err?.name === 'PlayerNotReady') notify(err.message, 'bad');
        else failed(err?.message || 'Spotify search did not work.');
      });
      return matching;
    },

    async play() {
      activate();
      if (unusable) throw notReady(unusable);
      if (!auth?.connected()) throw notReady(NEED_LOGIN);
      const mine = seq;
      if (!song) return;
      if (!matching) this.load(song);
      await matching;
      if (mine !== seq || !match) return;
      const id = await connect();
      if (mine !== seq) return;
      if (startedUri === match.uri) {
        note({ msg: 'resume' });
        await sdk.resume();
        startPoll();
        return;
      }
      note({ msg: `play ${match.uri.slice(-6)} at ${Math.round(resumeMs / 1000)} s` });
      try {
        await start(id, match.uri, resumeMs);
      } catch (err) {
        if (err?.name === 'PlayerNotReady') throw err;
        note({ msg: `play refused: ${String(err?.message).slice(0, 80)}` });
        if (mine === seq) failed(err.message);
        return;
      }
      if (mine !== seq) return;
      startedUri = match.uri;
      watch = createEndWatch({ song, startedUri, ignoreContext: filler?.uri ?? null });
      last = null;
      resumeMs = 0;
      startPoll();
    },

    pause() {
      stopPoll();
      if (!startedUri && filler?.live) return; // the background music is on: filler.js pauses that
      sdk?.pause().catch(() => {});
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
      sdk?.setVolume(volume).catch(() => {});
    },

    /**
     * Background music: play a playlist or album (context uri) on this speaker, where it left off
     * when it is the same one. A queue song paused on the speaker is forgotten (play() starts it
     * again where it was).
     */
    async playContext(contextUri) {
      activate();
      if (unusable) throw notReady(unusable);
      if (!auth?.connected()) throw notReady(NEED_LOGIN);
      const id = await connect();
      if (startedUri) {
        resumeMs = last?.position ?? resumeMs;
        startedUri = null;
        watch = null;
        last = null;
        stopPoll();
      }
      if (filler?.uri === contextUri && filler.live) {
        note({ msg: 'background music: resume' });
        await sdk.resume();
        return;
      }
      const at = filler?.uri === contextUri ? filler.at : null;
      filler = { uri: contextUri, live: false, at };
      note({ msg: `background music: ${contextUri.split(':')[1]}${at ? ` at ${Math.round(at.pos / 1000)} s` : ''}` });
      const path = `/me/player/play?device_id=${encodeURIComponent(id)}`;
      const put = (from) => api(path, { method: 'PUT', body: { context_uri: contextUri, ...(from ? { offset: { uri: from.uri }, position_ms: from.pos } : {}) } });
      let r = await put(at);
      if (!r.ok && r.status === 404) { await wait(1000); r = await put(at); } // a brand-new speaker
      if (!r.ok && at && r.status !== 403) r = await put(null); // that track left the playlist: from the top
      if (r.status === 403) {
        unusable = NEED_PREMIUM;
        throw notReady(NEED_PREMIUM);
      }
      if (!r.ok) throw new Error('Spotify would not play that playlist or album. Check the link.');
      if (filler?.uri === contextUri) filler.live = true;
    },
    /**
     * ⭐ RoomDJ Favs (Dalton, 2026-10-16): add the song to the teacher's own private Spotify playlist
     * "RoomDJ Favs", made on first use. Its id and the songs already added are kept in this
     * computer's localStorage per Spotify account. Spotify's February 2026 API: POST /me/playlists,
     * POST /playlists/{id}/items. Answers { ok: true, already? } | { ok: false, message }.
     */
    async saveToFavs(song) {
      try {
        const match = await resolve(song);
        if (match.status !== 'ok') return { ok: false, message: 'Spotify does not have a clean version of this song to save.' };
        const me = await api('/me');
        const user = me.ok ? (await me.json().catch(() => ({})))?.id : null;
        if (!user) return { ok: false, message: 'Spotify did not answer. Try again in a moment.' };
        const key = `cq.favsPlaylist.${user}`;
        let kept = null;
        try { kept = JSON.parse(localStorage.getItem(key)); } catch { /* blocked */ }
        if (kept?.uris?.includes(match.uri)) return { ok: true, already: true };
        const keep = (v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* blocked */ } };
        for (let round = 0; round < 2; round++) {
          if (!kept?.id) {
            const made = await api('/me/playlists', { method: 'POST', body: { name: FAVS_NAME, public: false, description: 'Songs I liked in class, saved from RoomDJ.' } });
            if (made.status === 403) return { ok: false, message: FAVS_SCOPE };
            const id = made.ok ? (await made.json().catch(() => ({})))?.id : null;
            if (!id) return { ok: false, message: 'Spotify would not make the RoomDJ Favs playlist. Try again later.' };
            kept = { id, uris: [] };
            keep(kept);
          }
          const added = await api(`/playlists/${encodeURIComponent(kept.id)}/items`, { method: 'POST', body: { uris: [match.uri] } });
          if (added.ok) {
            kept.uris = [...(kept.uris ?? []), match.uri].slice(-500);
            keep(kept);
            return { ok: true };
          }
          if (added.status === 403 && round === 0 && !(await stillMine(kept.id))) kept = null; // deleted or not ours: make a new one
          else if (added.status === 404 && round === 0) kept = null;
          else return { ok: false, message: added.status === 403 ? FAVS_SCOPE : 'Spotify would not add the song. Try again in a moment.' };
        }
        return { ok: false, message: 'Spotify would not add the song. Try again in a moment.' };
      } catch (e) {
        return { ok: false, message: e?.message || 'Spotify did not answer. Try again in a moment.' };
      }
    },

    /** Pause the background music (if the speaker holds it). */
    pauseContext() {
      if (filler?.live) sdk?.pause().catch(() => {});
    },
    /** Stop the background music and forget where it was. */
    stopContext() {
      if (filler?.live) sdk?.pause().catch(() => {});
      filler = null;
    },

    onEnded(fn) { ended = fn; },
    onError(fn) { failed = fn; },
    onTime(fn) { time = fn; },
    /** fn(message): playback left this page (another device took it); host shows Start music. */
    onInterrupted(fn) { interrupted = fn; },

    /** Leave for good (another service was picked): disconnect the speaker. */
    destroy() {
      this.stop();
      details.remove();
      document.removeEventListener('click', activate, true);
      ready = null;
      sdk?.disconnect();
      sdk = null;
    },
  };
}
