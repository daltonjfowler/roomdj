// 🎲 Autoplay (protocol.js DEFAULT_SETTINGS autoplay; Dalton, 2026-11-01: "if no songs are queued and
// you don't pick a fallback playlist it'll play a random song from the genres you check off"). The
// host page asks ({ t: 'autoplay' }) when nothing plays, the queue is empty, the music is started and
// no background music link is set; the room picks a ✓ Checked song from the teacher's chosen
// song lists (the same list a student browses, this room's rules applied) and adds it as a teacher
// pick, so it takes the teacher's path through suggest(): the same filter, repeats and artist rules.
// Popular first (Dalton, 2026-11-01: "based on popular songs in the genres highlighted"): a weighted
// draw, not a flat one. A song's weight falls with its place in its list (the lists are most asked
// first) and is POPULAR_BOOST times more for a song on 🔥 Popular on RoomDJ (what classes really
// played). Deeper songs still come up now and then, so a class does not hear the same five hits.
// Pure helpers here (tested in Node); the Room does the picking (src/room.js autoplay).

import { SHELVES, shelfShown } from './protocol.js';
import { hasPlayed, isWaiting } from './queue.js';

export const AUTOPLAY_GAP_MS = 15_000; // at most one pick this often (a refused pick waits too)
export const AUTOPLAY_RETRY_MS = AUTOPLAY_GAP_MS + 1000; // the host page asks again after this, past the room's gap
export const AUTOPLAY_NONE_WAIT_MS = 60_000; // the lists had no song: the next ask waits this long
export const AUTOPLAY_TICK_MS = 3000; // how often the host page checks a quiet room (no state arrives then)
export const AUTOPLAY_TRIES = 6; // songs tried per ask before giving up
export const POPULAR_BOOST = 4; // 🔥 Popular on RoomDJ counts this many times more
const PLACE_FALLOFF = 10; // the 11th song in a list is half as likely as the 1st, the 31st a quarter

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

/** How likely a song is: its place in its list (0 = the top) and whether it is on 🔥 Popular. */
export function autoplayWeight(place, popular = false) {
  return (popular ? POPULAR_BOOST : 1) / (1 + place / PLACE_FALLOFF);
}

/**
 * Songs worth trying, in the order to try them: not waiting, not played this class, drawn by weight
 * (autoplayWeight; each list in its own order). `lists`: arrays of songs, one per ticked list.
 * `isPopular(song)`: on 🔥 Popular on RoomDJ. A song in two lists counts once, at its best weight.
 */
export function autoplayPicks(state, lists, { isPopular = () => false, rand = Math.random } = {}) {
  const best = new Map();
  for (const list of lists) {
    list.forEach((song, place) => {
      if (!song?.id || isWaiting(state, song.id, song) || hasPlayed(state, song.id, song)) return;
      const w = autoplayWeight(place, isPopular(song));
      if (!best.has(song.id) || best.get(song.id).w < w) best.set(song.id, { song, w });
    });
  }
  // A weighted draw without repeats (Efraimidis-Spirakis): sort by rand^(1/w), biggest first.
  return [...best.values()].map(({ song, w }) => ({ song, key: Math.pow(rand(), 1 / w) }))
    .sort((a, b) => b.key - a.key).map((x) => x.song);
}
