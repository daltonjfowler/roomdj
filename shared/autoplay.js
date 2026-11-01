// 🎲 Autoplay (protocol.js DEFAULT_SETTINGS autoplay; Dalton, 2026-11-01: "if no songs are queued and
// you don't pick a fallback playlist it'll play a random song from the genres you check off"). The
// host page asks ({ t: 'autoplay' }) when nothing plays, the queue is empty, the music is started and
// no background music link is set; the room picks a random ✓ Checked song from the teacher's chosen
// song lists (the same list a student browses, this room's rules applied) and adds it as a teacher
// pick, so it takes the teacher's path through suggest(): the same filter, repeats and artist rules.
// Pure helpers here (tested in Node); the Room does the picking (src/room.js autoplay).

import { SHELVES, shelfShown } from './protocol.js';
import { hasPlayed, isWaiting } from './queue.js';

export const AUTOPLAY_GAP_MS = 15_000; // at most one pick this often (a refused pick waits too)
export const AUTOPLAY_TRIES = 6; // songs tried per ask before giving up

/** Should the room add a song now? (the host asks; the room checks for itself). */
export function autoplayDue(state, lastAt = 0, now = Date.now()) {
  return state?.settings?.autoplay === true && state.open && !state.cleanup && !state.nowPlaying
    && (state.queue?.length ?? 0) === 0 && now - lastAt >= AUTOPLAY_GAP_MS;
}

/** The chosen lists this room may show (Gospel only while its switch is on). */
export function autoplayShelves(settings) {
  const ids = Array.isArray(settings?.autoplayShelves) ? settings.autoplayShelves : [];
  return SHELVES.filter((s) => ids.includes(s.id) && shelfShown(s, settings)).map((s) => s.id);
}

/** Songs worth trying: not waiting, not played this class. Shuffled. */
export function autoplayPicks(state, songs, rand = Math.random) {
  return shuffle(songs.filter((s) => s?.id && !isWaiting(state, s.id, s) && !hasPlayed(state, s.id, s)), rand);
}

export function shuffle(list, rand = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
