// The songbook (protocol.js SONGBOOK, CLAUDE.md invariant 40): songs classes are likely to ask for,
// by shelf, found on iTunes by `npm run songbook` (src/songbook-data.js). The chart cron checks them
// (src/prewarm.js songbookPrewarm) like any song; a room's shelf shows only the ones its check settled
// as OK (Room.songbook). Server data, so a room may trust these song details like its own search's.

import { SHELF_MAX, SHELVES } from '../shared/protocol.js';
import { banKey, houseOk } from '../shared/filter.js';
import { SONGBOOK_MADE, SONGBOOK_SONGS } from './songbook-data.js';

export { SONGBOOK_MADE };

const plain = ({ shelf, rank, ...song }) => song;

/** A songbook shelf or 🔥 'popular' (src/popular.js; it has no songbook songs). */
export const isShelf = (id) => SHELVES.some((s) => s.id === id);

/** A shelf's songs, most asked first, at most SHELF_MAX. */
export function shelfSongs(id, songs = SONGBOOK_SONGS) {
  return songs.filter((s) => s.shelf === id).sort((a, b) => a.rank - b.rank).slice(0, SHELF_MAX).map(plain);
}

/** Every songbook song the cron should check: one per song (banKey), not the hand-checked ones. */
export function songbookToCheck(songs = SONGBOOK_SONGS) {
  const seen = new Set();
  const out = [];
  for (const s of songs) {
    const key = banKey(s);
    if (!key || seen.has(key) || houseOk(s)) continue;
    seen.add(key);
    out.push(plain(s));
  }
  return out;
}
