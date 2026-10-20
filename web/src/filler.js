// Background music on the host page: a YouTube video, live stream or playlist (its own visible
// YouTube player, #fillerBox, like players/youtube.js: youtube-nocookie, at least 200 x 200 px while
// it plays, ads untouched), or a Spotify playlist or album on the RoomDJ speaker (Music from:
// Spotify, connected; players/spotify.js playContext). The link and the "resume" choice are kept on
// this computer, per teacher (localStorage cq.filler:<profile>, profile.js). The rules are shared/filler.js fillerStep: a queue song
// pauses it, an empty queue brings it back (if resume is on), cleanup mode and closing stop it.
//
// host.js tells it: event('queuePlays') just before a queue song plays, event('idle') when nothing
// plays and the queue is empty, event('stop'), setBlocked(bool) (cleanup mode, or no room).
// It asks host.js: onPlay() when the teacher starts it (the host pauses a queue song then).
// suspend(true/false): the recap show (recap-audio.js) pauses it without changing its state, and
// it plays again afterwards only if it was playing.

import { $, announce, toast } from './dom.js';
import { prefKey } from './profile.js';
import { loadApi } from './players/youtube.js';
import { FILLER_HELP, fillerStep, loadFiller, parseFillerLink } from '../../shared/filler.js';

const SAVED = 'cq.filler';
const YT_HOST = 'https://www.youtube-nocookie.com';
const YT_ENDED = 0;
const YT_PLAYING = 1;

function readSaved() { try { return loadFiller(localStorage.getItem(prefKey(SAVED))); } catch { return null; } }
function writeSaved(v) {
  try {
    if (v) localStorage.setItem(prefKey(SAVED), JSON.stringify(v));
    else localStorage.removeItem(prefKey(SAVED));
  } catch { /* blocked: works until the page closes */ }
}

/**
 * @param {{ getPlayer: () => object, onPlay: () => void }} host
 */
export function initFiller({ getPlayer, onPlay }) {
  let saved = readSaved(); // { link, resume } | null
  let state = 'off';
  let blocked = true; // until a room is open
  let volume = 1;
  let yt = null, ytReady = null, ytLoaded = null; // YT.Player, its ready promise, the video/list it has
  let spotifyOn = null; // the Spotify player holding our context
  let seq = 0;
  let suspended = false; // the recap show is playing (protocol.js RECAP MUSIC)

  const box = $('#fillerBox');
  const link = () => (saved ? parseFillerLink(saved.link) : null);

  function render() {
    const btn = $('#fillerBtn');
    const on = state === 'playing';
    btn.textContent = on ? '⏸ Background music' : '▶ Background music';
    btn.setAttribute('aria-pressed', String(on));
    btn.disabled = blocked;
    const p = link();
    $('#fillerNow').textContent = !p ? 'No background music link yet.'
      : `${p.kind === 'spotify' ? `Spotify ${p.type}` : p.kind === 'youtubeList' ? 'YouTube playlist' : 'YouTube'}${state === 'held' ? ' · paused for a song, back when the queue is empty' : ''}`;
    // YouTube's rule: the player is on screen while it plays.
    box.hidden = !(on && p && p.kind !== 'spotify');
  }

  // ---- YouTube ----
  function ensureYt() {
    if (ytReady) return ytReady;
    ytReady = loadApi().then((YT) => new Promise((resolve) => {
      const el = document.createElement('div');
      box.replaceChildren(el);
      yt = new YT.Player(el, {
        host: YT_HOST,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, origin: location.origin, iv_load_policy: 3 },
        events: {
          onReady: () => resolve(yt),
          onStateChange: (e) => {
            box.dataset.state = String(e.data); // the player's state, for the browser test
            // A video (not a stream) that ends starts again: background music loops.
            if (e.data === YT_ENDED && state === 'playing' && link()?.kind === 'youtube') {
              yt.seekTo(0, true);
              yt.playVideo();
            }
            if (e.data === YT_PLAYING && state !== 'playing') yt.pauseVideo(); // a late start after a pause
          },
          onError: (e) => {
            console.warn(`Background music: YouTube error ${e.data}`);
            if (state !== 'playing') return;
            ytLoaded = null;
            apply(fillerStep(state, 'stop'));
            toast([101, 150, 153].includes(e.data)
              ? 'That YouTube video cannot play on other sites (its owner turned that off). Try another link.'
              : 'That YouTube background music would not play. Try another link.', 'warn', 8000);
          },
        },
      });
    }));
    ytReady.catch(() => { ytReady = null; });
    return ytReady;
  }

  async function playYoutube(p, my) {
    box.hidden = false; // visible before it starts
    const player = await ensureYt();
    if (my !== seq || state !== 'playing') return;
    player.setVolume(Math.round(volume * 100));
    const want = p.kind === 'youtube' ? `v:${p.videoId}` : `l:${p.list}`;
    if (ytLoaded === want) return player.playVideo(); // where it was (a live stream: back to live)
    ytLoaded = want;
    if (p.kind === 'youtube') player.loadVideoById(p.videoId);
    else {
      player.loadPlaylist({ listType: 'playlist', list: p.list });
      player.setLoop?.(true);
    }
  }

  // ---- Actions ----
  async function play() {
    const p = link();
    const my = ++seq;
    if (!p) return;
    try {
      if (p.kind === 'spotify') {
        const player = getPlayer();
        if (!player?.playContext) {
          throw new Error('Spotify background music needs Music from: Spotify, connected. Or paste a YouTube link.');
        }
        spotifyOn = player;
        await player.playContext(p.contextUri);
      } else {
        await playYoutube(p, my);
      }
    } catch (err) {
      if (my !== seq) return;
      state = 'off';
      render();
      toast(err?.message || 'The background music would not play.', 'warn', 8000);
    }
  }

  function pause(reason) {
    seq++;
    yt?.pauseVideo?.();
    // A queue song on the same Spotify speaker replaces the background music by itself; pausing it
    // too could land after the song started and pause the song.
    if (!(reason === 'queuePlays' && spotifyOn && spotifyOn === getPlayer())) spotifyOn?.pauseContext?.();
  }

  function stop() {
    seq++;
    yt?.stopVideo?.();
    ytLoaded = null;
    spotifyOn?.stopContext?.();
    spotifyOn = null;
  }

  function apply({ state: next, action }, reason) {
    const before = state;
    state = next;
    if (action === 'play') { if (!suspended) play(); }
    else if (action === 'pause') pause(reason);
    else if (action === 'stop') stop();
    render();
    if (before !== state && reason !== 'queuePlays') {
      if (state === 'playing') announce('Background music on.');
      else if (state === 'off') announce(action === 'stop' ? 'Background music stopped.' : 'Background music paused.');
    }
  }

  const opts = () => ({ resume: saved?.resume !== false, blocked: blocked || !link() });

  function toggle() {
    if (!link()) return openForm();
    const r = fillerStep(state, 'toggle', opts());
    if (r.action === 'refuse') return toast('Background music is off while the room is cleaning up or closed.', 'warn');
    if (r.action === 'play') onPlay();
    apply(r, 'toggle');
  }

  // ---- The form (link + resume) ----
  function openForm() {
    $('#fillerForm').hidden = false;
    $('#fillerEdit').setAttribute('aria-expanded', 'true');
    $('#fillerLink').value = saved?.link ?? '';
    $('#fillerResume').checked = saved?.resume !== false;
    $('#fillerMsg').textContent = '';
    $('#fillerLink').focus();
  }
  function closeForm() {
    $('#fillerForm').hidden = true;
    $('#fillerEdit').setAttribute('aria-expanded', 'false');
  }
  $('#fillerBtn').addEventListener('click', toggle);
  $('#fillerEdit').addEventListener('click', () => ($('#fillerForm').hidden ? openForm() : closeForm()));
  $('#fillerCancel').addEventListener('click', () => {
    closeForm();
    $('#fillerEdit').focus();
  });
  $('#fillerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#fillerLink').value.trim();
    const p = parseFillerLink(text);
    if (!p.ok) {
      $('#fillerMsg').textContent = p.message || FILLER_HELP;
      return $('#fillerLink').focus();
    }
    const changed = text !== saved?.link;
    const wasOn = state === 'playing';
    if (changed && state !== 'off') apply(fillerStep(state, 'stop'));
    saved = { link: text, resume: $('#fillerResume').checked };
    writeSaved(saved);
    closeForm();
    render();
    toast(p.kind === 'spotify' && !getPlayer()?.playContext
      ? 'Saved. Spotify background music plays when Music from is Spotify, connected.'
      : 'Background music saved on this computer.', 'ok');
    if (changed && wasOn) toggle();
    else $('#fillerBtn').focus();
  });
  $('#fillerClear').addEventListener('click', () => {
    apply(fillerStep(state, 'stop'));
    saved = null;
    writeSaved(null);
    $('#fillerLink').value = '';
    closeForm();
    render();
    toast('Background music link removed.', 'ok');
  });

  render();

  return {
    get state() { return state; },
    get hasLink() { return Boolean(link()); },
    toggle,
    /** 'queuePlays' | 'idle' | 'stop' */
    event(name) {
      const r = fillerStep(state, name, opts());
      if (r.state !== state || r.action) apply(r, name);
    },
    setBlocked(on) {
      blocked = Boolean(on);
      if (blocked && state !== 'off') apply(fillerStep(state, 'stop'));
      else render();
    },
    /** The recap show: pause now (state kept); play again after it only if it was playing. */
    suspend(on) {
      if (Boolean(on) === suspended) return;
      suspended = Boolean(on);
      if (suspended && state === 'playing') pause('show');
      else if (!suspended && state === 'playing' && !blocked) play();
    },
    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      yt?.setVolume?.(Math.round(volume * 100));
    },
    /** The "Music from" player changed: Spotify background music cannot outlive its speaker. */
    playerChanged() {
      if (spotifyOn && spotifyOn !== getPlayer()) {
        spotifyOn = null; // that speaker is gone (destroyed)
        if (state !== 'off') {
          state = 'off';
          render();
          toast('The Spotify background music stopped (Music from changed).', 'warn');
        }
      }
    },
  };
}
