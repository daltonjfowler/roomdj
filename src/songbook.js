// The songbook (protocol.js SONGBOOK, CLAUDE.md invariant 40): songs classes are likely to ask for,
// by shelf. Three sources: the seeds (`npm run songbook`, src/songbook-data.js, most asked first; the
// chart cron checks them like any song, src/prewarm.js), the songs the chart cron found ✓ Checked
// (KV GROWN_KEY, chart order, grows by itself every day) and the archive (`npm run songbook:archive`,
// src/songbook-archive-data.js: every song the live checker had passed when it ran, by genre). A
// room's shelf shows only ✓ Checked songs (Room.songbook). Server data, so a room may trust these
// song details like its own search's.

import { PROMPT_VERSION, banKey, houseOk, kidSafeArtist, mainArtist, normalizeWords, notMusicHit } from '../shared/filter.js';
import { SHELF_MAX, SHELVES } from '../shared/protocol.js';
import { ARCHIVE_SONGS, ARCHIVE_VERSION } from './songbook-archive-data.js';
import { SONGBOOK_MADE, SONGBOOK_SONGS } from './songbook-data.js';

export { SONGBOOK_MADE };

/** Seeds a shelf may ask KV about (not in the archive yet), at most, each time it opens. */
export const SHELF_READS = 40;
/** Songs a shelf looks at for its SHELF_MAX: the checked ones first, then seeds to ask KV about. */
export const SHELF_SCAN = SHELF_MAX + SHELF_READS;

const plain = ({ shelf, rank, shelves, instrumental, songOnly, ...song }) => song;

/** A songbook shelf or 🔥 'popular' (src/popular.js; it has no songbook songs). */
export const isShelf = (id) => SHELVES.some((s) => s.id === id);

// iTunes genres (primaryGenreName, lower case) → shelf. Anything else only goes on 📻 Throwbacks.
const GENRE_SHELF = [
  [/^k-pop$/, 'kpop'],
  [/^(pop|singer\/songwriter|teen pop|adult contemporary)$/, 'pop'],
  [/^(hip-hop\/rap|hip-hop|rap|r&b\/soul|contemporary r&b|soul|afrobeats|afro-beat|afropop)$/, 'hiphop'],
  [/^(soundtrack|musicals|original score|disney|tv soundtrack|foreign cinema|anime)$/, 'movies'],
  [/^(rock|alternative|hard rock|metal|indie rock|indie pop|punk|classic rock|pop\/rock|soft rock|adult alternative|american trad rock|britpop|new wave|rock & roll|emo|pop punk|grunge|arena rock|british invasion|southern rock|glam rock|prog-rock\/art rock|psychedelic|blues-rock|hair metal|college rock|goth rock)$/, 'rock'],
  [/^(country|americana|contemporary country|honky tonk|bluegrass|country rock)$/, 'country'],
  [/^(latin|pop latino|urbano latino|música mexicana|musica mexicana|regional mexicano|reggaeton|salsa y tropical|latin urban|música tropical|latin pop)$/, 'latin'],
  [/^(dance|electronic|house|techno|electronica|edm|trance|dubstep|disco|drum & bass|hardstyle|breakbeat|uk garage|garage|bass|progressive house|deep house|tech house|big room|future bass|electro house)$/, 'dance'],
];
const FOCUS_GENRES = /^(classical|instrumental|new age|ambient|soundtrack|original score|piano|jazz|lo-fi|easy listening|video game)$/;
const THROWBACK_YEAR = 2009;

// The style shelves (Dalton, 2026-10-31: "ska too and punk rock and pop punk and classic rock and
// grunge and metal... I want more categories and diversity"), on top of the broad shelf above: by
// iTunes genre (and year), or because the seeds put the song's artist on that shelf. Apple files most
// punk, grunge and ska under plain Rock or Alternative, so the artist is the better sign.
const ROCKISH = /^(rock|hard rock|alternative|pop\/rock|american trad rock|roots rock)$/;
const STYLE_SHELF = [
  ['classicrock', (g, y) => /^(classic rock|arena rock|british invasion|rock & roll|southern rock|glam rock|prog-rock\/art rock|psychedelic|blues-rock|rockabilly|surf|jam bands)$/.test(g) || (ROCKISH.test(g) && y > 0 && y <= 1989)],
  ['metal', (g) => /^(metal|heavy metal|hair metal|death metal\/black metal|metalcore|nu metal)$/.test(g)],
  ['punk', (g) => /^(punk|punk rock|hardcore punk|pop punk|emo|ska punk)$/.test(g)],
  // Alternative & indie: indie, and grunge / '90s alternative.
  ['indie', (g, y) => /^(indie rock|indie pop|indie|college rock|indie folk|grunge)$/.test(g) || (/^(alternative|college rock)$/.test(g) && y >= 1989 && y <= 1999)],
  ['reggae', (g) => /^(reggae|roots reggae|modern dancehall|dancehall|dub|lovers rock|ska|two tone|rocksteady)$/.test(g)],
  ['afrobeats', (g) => /^(afrobeats|afro-beat|afro-pop|afropop|afro house|amapiano|african|afro-fusion)$/.test(g)],
  ['soul', (g, y) => /^(soul|motown|funk|disco|doo wop|neo-soul|quiet storm)$/.test(g) || (g === 'r&b/soul' && y > 0 && y <= 1989)],
  ['classical', (g) => /^(classical|orchestral|opera|baroque era|classical era|romantic era|chamber music|choral|art song|modern era|medieval era|renaissance)$/.test(g)],
  ['jazz', (g) => /^(jazz|vocal jazz|big band|bop|hard bop|cool jazz|contemporary jazz|crossover jazz|mainstream jazz|smooth jazz|latin jazz|fusion|dixieland|ragtime|trad jazz|swing|vocal|blues|chicago blues|classic blues|contemporary blues|country blues|delta blues|electric blues|acoustic blues)$/.test(g)],
  // The lists added after (Dalton, 2026-10-31: "Add all of those"); 🙏 Gospel shows only while the
  // teacher's gospelShelf setting is on (protocol.js shelfShown).
  ['musicals', (g) => /^(musicals|musical|broadway|cast recordings|show tunes)$/.test(g)],
  ['games', (g) => /^(video game|video games|soundtrack:video game|anime)$/.test(g)],
  ['world', (g) => /^(world|worldwide|j-pop|j-rock|bollywood|indian pop|indian|indian classical|arabic|arabic pop|khaleeji|raï|brazilian|mpb|bossa nova|samba|axé|c-pop|mandopop|cantopop|french pop|chanson|celtic|turkish|greek|african|middle eastern|hawaii|polynesian)$/.test(g)],
  ['folk', (g) => /^(folk|bluegrass|americana|contemporary folk|traditional folk|indie folk|folk-rock|celtic folk|old time|newgrass|contemporary bluegrass)$/.test(g)],
  ['gospel', (g) => /^(christian|christian & gospel|gospel|christian pop|christian rock|contemporary christian|praise & worship|inspirational|southern gospel|traditional gospel|contemporary gospel|christian hip-hop|christian rap|christian metal|ccm)$/.test(g)],
];
const STYLE_IDS = new Set(STYLE_SHELF.map(([id]) => id));

/** mainArtist → the style shelves the seeds put that artist on. */
function seedArtists(songs = SONGBOOK_SONGS) {
  const map = new Map();
  for (const s of songs) {
    if (!STYLE_IDS.has(s.shelf) || s.songOnly) continue;
    const who = mainArtist(s.artist);
    if (!who) continue;
    if (!map.has(who)) map.set(who, new Set());
    map.get(who).add(s.shelf);
  }
  return map;
}
const SEED_ARTISTS = seedArtists();

/**
 * The shelves an archive (or cron) song goes on: its genre's, the style shelves its genre or artist
 * fits, 📻 Throwbacks for 2009 and older, 📚 Focus when the checker found it has no words
 * (instrumental) and its genre fits.
 */
export function archiveShelves(song, { instrumental = false } = {}, artists = SEED_ARTISTS) {
  const genre = String(song.genre ?? '').toLowerCase().trim();
  const year = Number(song.year) || 0;
  const out = [];
  const hit = GENRE_SHELF.find(([re]) => re.test(genre));
  if (hit && !(instrumental && FOCUS_GENRES.test(genre))) out.push(hit[1]);
  if (instrumental && FOCUS_GENRES.test(genre)) out.push('focus');
  const byArtist = artists.get(mainArtist(song.artist ?? '')) ?? new Set();
  for (const [id, fits] of STYLE_SHELF) if (fits(genre, year) || byArtist.has(id)) out.push(id);
  if (year > 0 && year <= THROWBACK_YEAR) out.push('throwbacks');
  return out;
}

const VERSION_WORDS = /\b(live|remix|sped up|slowed|nightcore|karaoke|acoustic version|cover|tribute|8 bit|lullaby|reprise|medley)\b/;

/**
 * A ✓ Checked song a shelf may list: never explicit, no Kidz Bop (a teacher setting), nothing the
 * "not music for class" list catches, no live / remix / karaoke / sped-up versions.
 */
export function shelfWorthy(song) {
  if (!song?.title || song.explicit === 'explicit' || kidSafeArtist(song) || notMusicHit(song)) return false;
  return !VERSION_WORDS.test(normalizeWords(`${song.title} ${song.album ?? ''}`));
}

// ---- Grown: what the chart cron found ✓ Checked (src/prewarm.js growShelves) -----------------------

export const GROWN_KEY = 'songbook:v1:grown';
/** Songs kept, newest finds first (about 500 bytes each: well under KV's 25 MB). */
export const GROWN_MAX = 7000;

/**
 * KV GROWN_KEY → its songs, or [] when missing or from an older prompt. Each one's `shelves` are
 * worked out again (archiveShelves), so a new shelf picks up songs found before it existed.
 */
export function readGrown(raw, version = PROMPT_VERSION) {
  if (!raw || raw.v !== version || !Array.isArray(raw.list)) return [];
  return raw.list.filter((s) => s?.id && Array.isArray(s.shelves))
    .map((s) => ({ ...s, shelves: [...new Set([...s.shelves, ...archiveShelves(s, { instrumental: s.instrumental === true })])] }));
}

/** New finds go first, one per song (banKey), at most GROWN_MAX. → the KV value */
export function addGrown(list, found, version = PROMPT_VERSION) {
  const seen = new Set();
  const out = [];
  for (const s of [...found, ...list]) {
    const k = banKey(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return { v: version, list: out.slice(0, GROWN_MAX) };
}

/** Songs ✓ Checked on the shelves without the cron (the archive): the cron does not add them again. */
export function bakedKeys(archive = ARCHIVE_SONGS) {
  return new Set(archive.map(banKey).filter(Boolean));
}

/**
 * The seeds, banKey → song. A seed the cron finds ✓ Checked joins the grown list even when no shelf
 * takes its genre: then the room trusts it with no KV read, so a list fills as the cron checks its
 * seeds (Dalton, 2026-10-31: "fill the list ... so we have a full list"), no archive rebuild needed.
 * A seed already has its iTunes details, so it joins with no lookup (iTunes refuses most calls from
 * the Worker: src/itunes.js).
 */
export function seedKeys(songs = SONGBOOK_SONGS) {
  const map = new Map();
  for (const s of songs) {
    const k = banKey(s);
    if (k && !map.has(k)) map.set(k, plain(s));
  }
  return map;
}

/** The archive is from the checker's current prompt: its songs are ✓ Checked with no KV read. */
const archiveCurrent = (version = ARCHIVE_VERSION) => version === PROMPT_VERSION;

/**
 * A shelf's songs to look at (at most SHELF_SCAN): the seeds known to be checked (archive or grown)
 * and the hand-checked ones (most asked first), then the cron's finds (chart order), then the
 * archive's (newest first), then the seeds not checked yet (the room asks KV about those). Each once.
 */
export function shelfSongs(id, songs = SONGBOOK_SONGS, archive = ARCHIVE_SONGS, grown = []) {
  const known = new Set([...archive, ...grown].map(banKey));
  const seeds = songs.filter((s) => s.shelf === id).sort((a, b) => a.rank - b.rank);
  const seen = new Set();
  const out = [];
  const add = (s) => {
    const k = banKey(s);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(plain(s));
  };
  for (const s of seeds) if (known.has(banKey(s)) || houseOk(s)) add(s);
  for (const s of grown) if (s.shelves?.includes(id)) add(s);
  for (const s of archive) if (s.shelves?.includes(id)) add(s);
  for (const s of seeds) add(s);
  return out.slice(0, SHELF_SCAN);
}

/**
 * A list with its artists mixed (Dalton, 2026-11-01: "vary the list it's all Taylor Swift"): every
 * artist's first song in list order, then every artist's second song, and so on. The seeds come in
 * artist blocks, so without this one artist could fill the top of a list.
 */
export function spreadArtists(songs) {
  const n = new Map();
  return songs
    .map((song, i) => {
      const a = mainArtist(song.artist) || `#${i}`;
      const round = n.get(a) ?? 0;
      n.set(a, round + 1);
      return { song, round, i };
    })
    .sort((x, y) => x.round - y.round || x.i - y.i)
    .map((x) => x.song);
}

/**
 * Songs this room may tag ✓ Checked without reading KV (banKeys): the archive's while it is from the
 * current prompt, and the cron's finds (readGrown keeps only the current prompt's). Under
 * Instrumentals only, only the ones known to have no words.
 */
export function archiveReady({ instrumentalsOnly = false } = {}, archive = ARCHIVE_SONGS, grown = [], version = ARCHIVE_VERSION) {
  const all = [...(archiveCurrent(version) ? archive : []), ...grown];
  return new Set(all.filter((s) => !instrumentalsOnly || s.instrumental === true).map(banKey));
}

/**
 * Every songbook song the cron should check: one per song (banKey), not the hand-checked ones, every
 * list's #1, then every list's #2... (so the lists fill evenly as the cron goes).
 */
export function songbookToCheck(songs = SONGBOOK_SONGS) {
  const seen = new Set();
  const out = [];
  for (const s of songs.map((s, i) => [s, i]).sort((a, b) => (a[0].rank || 0) - (b[0].rank || 0) || a[1] - b[1]).map(([s]) => s)) {
    const key = banKey(s);
    if (!key || seen.has(key) || houseOk(s)) continue;
    seen.add(key);
    out.push(plain(s));
  }
  return out;
}
