// 🎵 The recap show's music and sounds on the host page (protocol.js RECAP MUSIC; the rules are
// shared/recap-music.js). Only this page makes sound: it owns the speakers, and the board never plays
// audio (invariant 16). While the show plays (here, or on a board: its cues come over the room), the
// room music and the background music pause, the period's #1 song's 30-second preview fades in and
// crossfades into itself for as long as the show runs, short "ta-da" sounds (Web Audio oscillators,
// no files) mark each reveal, and at the end the music fades out and the room music comes back
// exactly as it was. Two plain <audio> elements in #recapMusic (no Web Audio on them: iTunes
// previews are cross-origin, and a media element routed through Web Audio would play silence).

import { RECAP_CUE_TIMEOUT_MS } from '../../shared/protocol.js';
import {
  CROSSFADE_MS, DUCK_LEVEL, DUCK_MS, FADE_IN_MS, FADE_OUT_MS, crossfadeAt, recapLevel, recapMusicOn, recapPreview,
} from '../../shared/recap-music.js';

const STEP_MS = 50;
const SOUND_GAP_MS = 600; // two boards (or a fast ← →) never stack the ta-das

/**
 * @param {{ settings: () => object|undefined, volume: () => number, box: HTMLElement,
 *   hold: () => object, release: (held: object) => void }} deps
 *   settings: the room's settings (recapMusic, recapVolume); volume: the room's volume slider (0..1);
 *   box: where the two <audio> elements live (hidden); hold: pause the room music and say what was
 *   playing; release: resume what hold paused (shared/recap-music.js afterShow)
 */
export function initRecapAudio({ settings, volume, box, hold, release }) {
  const els = [0, 1].map(() => {
    const a = document.createElement('audio');
    a.preload = 'auto';
    box.append(a);
    return a;
  });
  const env = new Map(els.map((a) => [a, { v: 0, target: 0, rate: 0 }]));
  let cur = 0;
  let active = false;
  let mode = null; // 'own' (this page's show) | 'board' (a board's show, timed by its cues)
  let held = null;
  let tick = 0;
  let duckUntil = 0;
  let lastSound = 0;
  let cueTimer = 0;
  let lastRecap = null;
  let cleanTimer = 0;

  // A preview that ends before the crossfade (its length was unknown): start it again.
  for (const a of els) {
    a.addEventListener('ended', () => {
      if (!active || a !== els[cur]) return;
      a.currentTime = 0;
      a.play().catch(() => {});
    });
  }

  const level = () => recapLevel(volume(), settings());

  function fadeTo(a, target, ms) {
    const e = env.get(a);
    e.target = target;
    e.rate = Math.abs(target - e.v) / Math.max(1, ms / STEP_MS);
    run();
  }
  function run() {
    if (!tick) tick = setInterval(step, STEP_MS);
  }
  function step() {
    const now = Date.now();
    const duck = now < duckUntil ? DUCK_LEVEL : 1;
    const lvl = level();
    let busy = active || now < duckUntil + STEP_MS * 4;
    for (const a of els) {
      const e = env.get(a);
      if (e.v !== e.target) {
        e.v = e.v < e.target ? Math.min(e.target, e.v + e.rate) : Math.max(e.target, e.v - e.rate);
        busy = true;
      }
      a.volume = Math.min(1, Math.max(0, e.v * lvl * duck));
      if (e.v === 0 && e.target === 0 && !a.paused) a.pause();
    }
    // The show runs longer than the clip: the other element starts it again, crossing over.
    const a = els[cur];
    if (active && a.src && !a.paused && Number.isFinite(a.duration) && a.currentTime >= crossfadeAt(a.duration)) {
      const next = els[1 - cur];
      next.src = a.src;
      next.currentTime = 0;
      env.get(next).v = 0;
      next.play().catch(() => {});
      fadeTo(next, 1, CROSSFADE_MS);
      fadeTo(a, 0, CROSSFADE_MS);
      cur = 1 - cur;
    }
    if (!busy) {
      clearInterval(tick);
      tick = 0;
    }
  }

  // ---- The sounds: Web Audio oscillators, made here (no files, nothing to load) ----
  let ctx = null;
  function audioCtx() {
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function note(ac, out, freq, at, dur, gain, type = 'triangle') {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + dur + 0.05);
  }
  /** "ta-da" (an award, a Top 5 place, the finale) or the bigger fanfare for the 👑 #1. */
  function tada(crown) {
    const ac = audioCtx();
    if (!ac) return;
    const out = ac.createGain();
    out.gain.value = Math.min(1, level() * 0.8);
    out.connect(ac.destination);
    const t = ac.currentTime + 0.03;
    if (!crown) {
      note(ac, out, 392, t, 0.14, 0.3); // ta-
      for (const f of [523.25, 659.25, 783.99]) note(ac, out, f, t + 0.16, 0.75, 0.22); // -da!
      return;
    }
    [523.25, 659.25, 783.99].forEach((f, i) => note(ac, out, f, t + i * 0.11, 0.16, 0.28));
    for (const f of [523.25, 659.25, 783.99, 1046.5]) note(ac, out, f, t + 0.36, 1.2, 0.2);
    [1567.98, 2093].forEach((f, i) => note(ac, out, f, t + 0.5 + i * 0.12, 0.25, 0.08, 'sine')); // sparkle
  }

  // ---- The show ----
  function armCueTimer() {
    clearTimeout(cueTimer);
    // A board's show: if its cues stop (the board went away), stop by ourselves.
    if (mode === 'board') cueTimer = setTimeout(stop, RECAP_CUE_TIMEOUT_MS);
  }

  /** The show starts (from = 'own' | 'board'). false: recap music is off (the caller ducks instead). */
  function start(recap, from = 'own') {
    if (recap) lastRecap = recap;
    if (!recapMusicOn(settings())) return false;
    if (active) {
      if (from === 'own') mode = 'own'; // this page plays the show now: its own slides lead
      armCueTimer();
      return true;
    }
    active = true;
    mode = from;
    clearTimeout(cleanTimer);
    held = hold();
    box.dataset.state = 'playing';
    const pick = recapPreview(lastRecap?.top5);
    box.dataset.song = pick?.title ?? '';
    if (pick) {
      const a = els[cur];
      a.src = pick.url;
      a.currentTime = 0;
      env.get(a).v = 0;
      a.volume = 0;
      a.play().catch(() => {}); // a blocked or failed preview: the show keeps its sounds
      fadeTo(a, 1, FADE_IN_MS);
    }
    armCueTimer();
    run();
    return true;
  }

  /** The show ended (or was closed): the music fades out and the room music comes back as it was. */
  function stop() {
    clearTimeout(cueTimer);
    if (!active) return false;
    active = false;
    mode = null;
    box.dataset.state = '';
    for (const a of els) fadeTo(a, 0, FADE_OUT_MS);
    clearTimeout(cleanTimer);
    cleanTimer = setTimeout(() => {
      if (active) return;
      for (const a of els) {
        a.pause();
        a.removeAttribute('src');
        a.load();
      }
    }, FADE_OUT_MS + 200);
    const h = held;
    held = null;
    release(h); // under the fade-out: the room music comes back as the recap music goes
    return true;
  }

  /**
   * A reveal on the show: 'reveal' | 'crown' (null: no sound). The ta-da plays OVER the song: no
   * duck (Dalton, 2026-10-14: the song dipping at every slide "fades in and out a bunch").
   */
  function sound(cue) {
    if (!active || (cue !== 'reveal' && cue !== 'crown')) return;
    const now = Date.now();
    if (now - lastSound < SOUND_GAP_MS) return;
    lastSound = now;
    tada(cue === 'crown');
  }

  /** A board's cue (protocol.js RECAP MUSIC): only while a board's show leads. */
  function onCue(cue) {
    if (mode === 'own') return; // this page plays its own show: its slides lead
    if (cue === 'start') {
      if (lastRecap) start(lastRecap, 'board');
      return;
    }
    if (mode !== 'board') return;
    armCueTimer();
    if (cue === 'end') stop();
    else sound(cue);
  }

  return { start, stop, sound, onCue, get active() { return active; } };
}
