// YouTube videos in the YouTube IFrame Player (phase 4). There is no YouTube Music API, so this
// plays the regular YouTube video the server matched to the iTunes song (src/youtube.js, which
// alone holds the API key). YouTube's rules, followed here: the player stays visible while it
// plays (at least 200 x 200 px, in the now-playing card), nothing hides or skips its ads, and
// nothing plays in the background.
//
// Any song YouTube cannot play here (no match, the day's search quota used up, the video will not
// embed) plays as its 30-second preview instead, with a notice. Error codes 2/5/100/101/150/153
// (bad id, HTML5 error, removed, owner blocks embedding, no Referer) ask the server for the next
// candidate; the server remembers the bad id so it is never chosen again.
//
// Options: { notify(text, kind) } from music.js; `mount` and `lookup` are for tests.

import { createPreviewPlayer } from './preview.js';
import { ITUNES, catalogOf } from '../../../shared/catalog.js';

const API_SRC = 'https://www.youtube.com/iframe_api';
const HOST = 'https://www.youtube-nocookie.com';
const UNPLAYABLE = new Set([2, 5, 100, 101, 150, 153]);
const STATE = { ENDED: 0, PLAYING: 1, CUED: 5 };
const DOWN = 'YouTube is not answering right now.';

let apiPromise = null;
/** The IFrame Player API (YT), loaded once per page (also used by the background music, filler.js). */
export function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const before = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      before?.();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = API_SRC;
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      s.remove();
      reject(new Error('The YouTube player would not load.'));
    };
    document.head.append(s);
  });
  return apiPromise;
}

/**
 * Ask this server which video plays a song. The room and host token come from the host page's
 * session ('cq.host': { room, token }, or { code, token } from before class codes).
 */
async function askServer(songId, skip) {
  let room = null;
  try { room = JSON.parse(sessionStorage.getItem('cq.host')); } catch { /* blocked */ }
  const id = room?.room ?? room?.code;
  if (!id || !room?.token) return { error: 'host', message: DOWN };
  const q = new URLSearchParams({ song: songId });
  if (skip) q.set('skip', skip);
  try {
    const r = await fetch(`/api/rooms/${encodeURIComponent(id)}/youtube?${q}`, { headers: { 'x-host-token': room.token } });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.videoId) return { videoId: data.videoId };
    return { error: data.error ?? 'youtube_down', message: data.message ?? DOWN };
  } catch {
    return { error: 'youtube_down', message: DOWN };
  }
}

export function createYoutubePlayer({ notify = () => {}, mount = document.querySelector('#ytBox'), lookup = askServer } = {}) {
  const preview = createPreviewPlayer(); // the fallback for songs YouTube cannot play
  let ended = () => {}, failed = () => {}, time = () => {};
  let yt = null; // YT.Player
  let ready = null; // Promise of yt, once the player is ready
  let mode = null; // 'youtube' | 'preview' | null (loading or stopped)
  let song = null, videoId = null, seq = 0, wantPlay = false, volume = 1, timer = 0;
  let quotaTold = false;
  // The player can report one bad video's error more than once, the late ones after the next video
  // is already loading. Only an error after the current video changed state counts, and only one
  // lookup at a time, so a good video is never reported as bad.
  let armed = false, asking = false;
  // The player obeys commands asynchronously: a playVideo() sent before a cueVideoById() has
  // finished reaches the old video, and then the cue stops it. So load() waits until the cue is
  // done (or the video fails) before it resolves.
  let begun = false, lastState = null, cueDone = null;
  const CUE_WAIT_MS = 6000;
  const found = new Map(); // song id → Promise of a lookup answer (load and prefetch share it)
  const note = document.querySelector('#ytNote');
  if (note) note.hidden = false;

  preview.onEnded(() => { if (mode === 'preview') ended(); });
  preview.onError((m) => { if (mode === 'preview') failed(m); });
  preview.onTime((t, d) => { if (mode === 'preview') time(t, d); });

  const show = (on) => { if (mount) mount.hidden = !on; };
  const stopTimer = () => { clearInterval(timer); timer = 0; };
  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (mode !== 'youtube' || !yt?.getCurrentTime) return;
      time(yt.getCurrentTime() || 0, yt.getDuration() || (song?.durationMs ?? 0) / 1000 || 30);
    }, 500);
  }

  function lookupOnce(id) {
    if (!found.has(id)) {
      if (found.size > 50) found.clear();
      const p = lookup(id);
      found.set(id, p);
      p.then((r) => { if (!r.videoId && found.get(id) === p) found.delete(id); });
    }
    return found.get(id);
  }

  function ensurePlayer() {
    if (ready) return ready;
    if (!mount) return Promise.reject(new Error('No place for the YouTube player.'));
    ready = loadApi().then((YT) => new Promise((resolve) => {
      const el = document.createElement('div');
      mount.replaceChildren(el);
      yt = new YT.Player(el, {
        host: HOST,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, origin: location.origin, iv_load_policy: 3 },
        events: { onReady: () => resolve(yt), onStateChange, onError },
      });
    }));
    ready.catch(() => { ready = null; });
    return ready;
  }

  function onStateChange(e) {
    if (mode !== 'youtube') return;
    armed = true;
    lastState = e.data;
    if (e.data === STATE.PLAYING) begun = true;
    if (e.data === STATE.CUED || e.data === STATE.PLAYING) cueDone?.();
    if (e.data === STATE.PLAYING) startTimer();
    else stopTimer();
    if (e.data === STATE.ENDED) ended();
  }

  async function onError(e) {
    cueDone?.();
    console.warn(`YouTube player error ${e.data} on ${videoId}${armed && !asking ? '' : ' (ignored: repeat)'}`);
    if (mode !== 'youtube' || !song || !armed || asking) return;
    const my = seq;
    armed = false;
    const bad = videoId;
    stopTimer();
    if (!UNPLAYABLE.has(e.data)) return fallBack({ error: 'youtube_player', message: 'This YouTube video would not play.' }, my);
    asking = true;
    const r = await lookup(song.id, bad).finally(() => { asking = false; });
    if (my !== seq) return;
    if (!r.videoId) return fallBack(r, my);
    found.set(song.id, Promise.resolve(r));
    videoId = r.videoId;
    begun = false;
    if (wantPlay) yt.loadVideoById(videoId);
    else yt.cueVideoById(videoId);
  }

  /** Play this song's 30-second preview instead, and say why. */
  async function fallBack(r, my) {
    mode = null;
    yt?.stopVideo?.();
    show(false);
    if (!preview.canPlay(song)) return failed(r.message || DOWN);
    if (r.error === 'youtube_quota') {
      if (!quotaTold) notify(r.message, 'warn');
      quotaTold = true;
    } else {
      notify(`"${song.title}": ${r.message || DOWN} Playing its 30-second preview instead.`, 'warn');
    }
    await preview.load(song);
    if (my !== seq) return;
    mode = 'preview';
    if (wantPlay) preview.play().catch(() => {});
  }

  return {
    name: 'YouTube videos',
    // iTunes songs only: Spotify's catalog may not be used to find YouTube videos (its Developer Policy).
    canPlay: (s) => catalogOf(s?.id) === ITUNES,
    async load(s) {
      const my = ++seq;
      song = s;
      videoId = null;
      mode = null;
      wantPlay = false;
      stopTimer();
      preview.stop();
      yt?.pauseVideo?.();
      time(0, (s.durationMs || 30_000) / 1000);
      const r = await lookupOnce(s.id);
      if (my !== seq) return;
      if (!r.videoId) return fallBack(r, my);
      try {
        await ensurePlayer();
      } catch (err) {
        if (my === seq) await fallBack({ error: 'youtube_player', message: err.message }, my);
        return;
      }
      if (my !== seq) return;
      mode = 'youtube';
      armed = false;
      begun = false;
      lastState = null;
      videoId = r.videoId;
      show(true);
      yt.setVolume(Math.round(volume * 100));
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, CUE_WAIT_MS);
        cueDone = () => {
          clearTimeout(timeout);
          cueDone = null;
          resolve();
        };
        yt.cueVideoById(videoId);
      });
    },
    play() {
      wantPlay = true;
      if (mode === 'preview') return preview.play();
      if (mode === 'youtube' && !asking) {
        // Cued (or paused): playVideo. The cue never finished: start it with loadVideoById.
        if (begun || lastState === STATE.CUED) yt.playVideo();
        else yt.loadVideoById(videoId);
        // A blocked autoplay leaves the video cued; ads and buffering move it on.
        const my = seq;
        setTimeout(() => {
          if (my === seq && wantPlay && mode === 'youtube' && !begun && lastState === STATE.CUED) {
            notify('Click Start music, or the play button on the video, so this computer can play YouTube.', 'warn');
          }
        }, 4000);
      }
      return Promise.resolve();
    },
    pause() {
      wantPlay = false;
      if (mode === 'preview') preview.pause();
      if (mode === 'youtube') yt.pauseVideo();
    },
    stop() {
      seq++;
      mode = null;
      song = null;
      wantPlay = false;
      stopTimer();
      preview.stop();
      yt?.stopVideo?.();
      show(false);
      time(0, 30);
    },
    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      preview.setVolume(volume);
      yt?.setVolume?.(Math.round(volume * 100));
    },
    onEnded(fn) { ended = fn; },
    onError(fn) { failed = fn; },
    onTime(fn) { time = fn; },
    /** Find the next song's video early (host page, near the end of a song). */
    prefetch(s) {
      if (catalogOf(s?.id) === ITUNES) lookupOnce(s.id);
    },
    destroy() {
      this.stop();
      yt?.destroy?.();
      yt = null;
      ready = null;
      mount?.replaceChildren();
      if (note) note.hidden = true;
    },
  };
}
