// 🎵 Recap music (protocol.js RECAP MUSIC): the pure parts, shared by the host page
// (web/src/recap-audio.js), the board (its cues) and the Node tests. Which preview plays, how loud,
// when the loop crossfades, which slide gets which sound, and what the room music does around it.

import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from './protocol.js';

export const FADE_IN_MS = 1500;
export const FADE_OUT_MS = 1200;
/**
 * The clip starts again this long before its end, fading across (the show runs over 30 s). Short, so
 * the loop sounds like one song playing on, not a fade out and in (Dalton, 2026-10-14).
 */
export const CROSSFADE_MS = 600;
/** A "ta-da" turns the song down to this share of its level for DUCK_MS. */
export const DUCK_LEVEL = 0.3;
export const DUCK_MS = 1100;

/** Only previews the host page's CSP lets play (media-src *.itunes.apple.com, *.mzstatic.com). */
export function previewOk(url) {
  if (typeof url !== 'string' || url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(itunes\.apple\.com|mzstatic\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The song the recap music plays: the #1 of the period's Top 5 (recap.top5, best first), or the next
 * one with a preview when #1 has none. null: no Top 5 song has one (the show gets its sounds only).
 * @returns {{ url: string, title: string, artist: string, rank: number } | null}
 */
export function recapPreview(top5) {
  const list = Array.isArray(top5) ? top5 : [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (previewOk(t?.previewUrl)) return { url: t.previewUrl, title: t.song?.title ?? '', artist: t.song?.artist ?? '', rank: i + 1 };
  }
  return null;
}

/** Music level 0..1: the room's volume slider (0..1) times the teacher's recapVolume (percent). */
export function recapLevel(roomVolume, settings) {
  const [lo, hi] = SETTINGS_LIMITS.recapVolume;
  const pct = Number.isInteger(settings?.recapVolume) && settings.recapVolume >= lo && settings.recapVolume <= hi
    ? settings.recapVolume : DEFAULT_SETTINGS.recapVolume;
  const v = Number.isFinite(roomVolume) ? Math.min(1, Math.max(0, roomVolume)) : 1;
  return Math.round(v * (pct / 100) * 1000) / 1000;
}

/** Is recap music on in these settings (saved settings without it: on)? */
export const recapMusicOn = (settings) => settings?.recapMusic !== false;

/** When (seconds into the clip) the next copy starts and the two cross. */
export function crossfadeAt(durationSec) {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 30;
  return Math.max(d / 2, d - CROSSFADE_MS / 1000);
}

/** The sound for a show slide's reveal: 'crown' (👑 #1), 'reveal' (an award, a Top 5 place, the finale), or null (the title card). */
export function cueFor(slide) {
  if (!slide || slide.kind === 'title') return null;
  if (slide.kind === 'top5' && slide.rank === 1) return 'crown';
  return 'reveal';
}

/**
 * The room music as the show starts: what to pause now, and remember. `queue`: a queue song is
 * playing (started, not paused); `filler`: the background music is playing.
 */
export function holdForShow({ started = false, paused = false, filler = 'off' } = {}) {
  return { queue: started === true && paused !== true, filler: filler === 'playing' };
}

/**
 * The room music after the show: resume exactly what the show paused, nothing else (paused stays
 * paused), and never in cleanup mode or when the teacher already pressed play during the show.
 */
export function afterShow(held, { started = false, paused = false, cleanup = false } = {}) {
  if (!held || cleanup) return { queue: false, filler: false };
  return { queue: held.queue === true && started === true && paused === true, filler: held.filler === true };
}
