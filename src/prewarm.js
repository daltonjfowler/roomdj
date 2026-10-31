// Checked songs pile up (Dalton, 2026-10-14: "keep building a large dataset of checked songs so it'll
// cost less as we go"). A cron (wrangler.jsonc triggers) checks the songs classes are most likely to
// suggest, Apple's most-played charts, BEFORE anyone suggests them, with the same theme check (and
// lyrics follow-up) a suggestion gets. Verdicts are shared facts (verdict:v7:*, kept for good when
// settled), so a class later pays nothing for them.
// Cheap by design: songs already known cost nothing (no AI call, not counted); at most
// PREWARM_AI_PER_DAY AI calls a day, PREWARM_PER_RUN songs a run in the day (PREWARM_NIGHT_PER_RUN at
// night; a few subrequests each). KV: prewarm:v1:list:<day> (the day's chart songs, fetched once),
// prewarm:v1:state:<day> { cursor, used }.
// Once the day's chart songs are done, the same runs and budget go on with the songbook (Dalton,
// 2026-10-29: "capture likely asks"; src/songbook.js): one pass over its songs, KV prewarm:v1:songbook
// { made, at } (no expiry), started again only when `npm run songbook` makes a new list.
// Then Apple's top songs per genre (GENRE_IDS, KV prewarm:v1:genres:<day>, state.genre), and every
// song a run finds ✓ Checked goes on the shelves by genre (growShelves, KV songbook:v1:grown; Dalton,
// 2026-10-30: "expand the pre-checked songs we have by a lot"). Known songs cost no AI call and do not
// count against PREWARM_PER_RUN, only against PREWARM_SCAN_PER_RUN (KV reads).

import { aiThemeCheck, banKey, checkFromKv } from '../shared/filter.js';
import { parseItunes, toSong } from '../shared/itunes.js';
import { LYRICS_PATIENT_MS, judgeFromLyrics } from './lyrics.js';
import { nightHours } from './night.js';
import { GROWN_KEY, SONGBOOK_MADE, addGrown, archiveShelves, bakedKeys, readGrown, shelfWorthy, songbookToCheck } from './songbook.js';

// Dalton, 2026-10-31: "get more now of common songs in prep for broader release". About 33 neurons
// a call (llama 3.3), so the cap is about 40k neurons a day at most (~$0.30 a day over the free 10k);
// it tapers off by itself as the lists become known songs (no AI).
export const PREWARM_AI_PER_DAY = 1200;
/** Songs a run may send to the AI: few in the day (classes share the LRCLIB line), more at night. */
export const PREWARM_PER_RUN = 6;
export const PREWARM_NIGHT_PER_RUN = 30;
/** Songs a run looks at in all (known ones are a KV read or two each, no AI). */
export const PREWARM_SCAN_PER_RUN = 40;
export const PREWARM_NIGHT_SCAN_PER_RUN = 150;
// iTunes top songs per genre, US: Pop, Hip-Hop/Rap, R&B/Soul, Rock, Alternative, Country, Latin,
// Dance, Electronic, Soundtrack, K-Pop, Classical, Singer/Songwriter.
const GENRE_IDS = [14, 18, 15, 21, 20, 6, 12, 17, 7, 16, 51, 5, 10];
const GENRE_FEED = (id) => `https://itunes.apple.com/us/rss/topsongs/limit=100/genre=${id}/json`;
const LOOKUP_MAX = 150;
const STOREFRONTS = ['us', 'gb', 'ca', 'au'];
const FEED = (sf) => `https://rss.marketingtools.apple.com/api/v2/${sf}/music/most-played/100/songs.json`;
const DAY_TTL_S = 2 * 24 * 3600;
const SONGBOOK_STATE = 'prewarm:v1:songbook';

/** A chart entry as a song for the theme check (null: not a usable one). */
export function chartSong(r) {
  const id = Number(r?.id);
  const title = typeof r?.name === 'string' ? r.name.trim().slice(0, 200) : '';
  if (!Number.isSafeInteger(id) || id <= 0 || !title || r.kind !== 'songs') return null;
  const genre = (r.genres ?? []).map((g) => g?.name).find((n) => typeof n === 'string' && n !== 'Music') ?? '';
  return {
    id: `it:${id}`,
    title,
    artist: typeof r.artistName === 'string' ? r.artistName.slice(0, 200) : '',
    album: '',
    genre: genre.slice(0, 40),
    year: Number(String(r.releaseDate ?? '').slice(0, 4)) || 0,
    // Apple spells it "Explict" in this feed.
    explicit: /^explic?i?t$/i.test(r.contentAdvisoryRating ?? '') ? 'explicit' : 'notExplicit',
  };
}

/** A genre feed entry (the older iTunes RSS) as a song for the theme check (null: not a usable one). */
export function genreChartSong(e) {
  const id = Number(e?.id?.attributes?.['im:id']);
  const title = typeof e?.['im:name']?.label === 'string' ? e['im:name'].label.trim().slice(0, 200) : '';
  if (!Number.isSafeInteger(id) || id <= 0 || !title) return null;
  const artist = e['im:artist']?.label;
  const album = e['im:collection']?.['im:name']?.label;
  const genre = e.category?.attributes?.label;
  return {
    id: `it:${id}`,
    title,
    artist: typeof artist === 'string' ? artist.slice(0, 200) : '',
    album: typeof album === 'string' ? album.slice(0, 200) : '',
    genre: typeof genre === 'string' ? genre.slice(0, 40) : '',
    year: Number(String(e['im:releaseDate']?.label ?? '').slice(0, 4)) || 0,
    explicit: 'notExplicit', // this feed does not say; growShelves' iTunes lookup does
  };
}

/** The day's genre chart songs: one per song, the genres taken in turn (each one's #1, then each #2...). */
async function genreSongs(env, day, fetchImpl) {
  const key = `prewarm:v1:genres:${day}`;
  const kept = await env.CLASS_KV.get(key, 'json');
  if (Array.isArray(kept)) return kept;
  const lists = [];
  for (const id of GENRE_IDS) {
    try {
      const r = await fetchImpl(GENRE_FEED(id), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const entries = (await r.json())?.feed?.entry;
      lists.push((Array.isArray(entries) ? entries : []).map(genreChartSong).filter(Boolean));
    } catch (e) {
      console.error(JSON.stringify({ message: 'prewarm genre feed failed', genre: id, error: String(e) }));
    }
  }
  const seen = new Set();
  const songs = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const s = l[i];
      const k = s && (banKey(s) ?? s.id);
      if (!s || seen.has(k)) continue;
      seen.add(k);
      songs.push(s);
    }
  }
  if (songs.length) await env.CLASS_KV.put(key, JSON.stringify(songs), { expirationTtl: DAY_TTL_S });
  return songs;
}

/**
 * Songs a run found ✓ Checked join the shelves (KV GROWN_KEY): the ones not there yet (nor in the
 * seeds or archive) are looked up on iTunes in one call for their cover, preview and real
 * explicitness, then kept when shelfWorthy and a shelf takes their genre. A failed lookup only waits:
 * the chart songs come round again. → how many joined
 */
export async function growShelves(env, found, fetchImpl, baked = bakedKeys()) {
  if (!found.length) return 0;
  const grown = readGrown(await env.CLASS_KV.get(GROWN_KEY, 'json'));
  const have = new Set([...grown.map(banKey), ...baked]);
  const todo = found.filter((s) => /^it:\d+$/.test(s.id) && !have.has(banKey(s))).slice(0, LOOKUP_MAX);
  if (!todo.length) return 0;
  let results;
  try {
    const r = await fetchImpl(`https://itunes.apple.com/lookup?id=${todo.map((s) => s.id.slice(3)).join(',')}&entity=song&country=US`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`iTunes ${r.status}`);
    results = parseItunes(await r.text()) ?? [];
  } catch (e) {
    console.error(JSON.stringify({ message: 'prewarm shelf lookup failed', error: String(e) }));
    return 0;
  }
  const add = [];
  for (const raw of results) {
    const song = toSong(raw);
    if (!song || !shelfWorthy(song) || have.has(banKey(song))) continue;
    const shelves = archiveShelves(song);
    if (shelves.length) add.push({ ...song, shelves });
  }
  if (!add.length) return 0;
  await env.CLASS_KV.put(GROWN_KEY, JSON.stringify(addGrown(grown, add)));
  return add.length;
}

/** The day's chart songs, one per song (banKey), US first. */
async function todaysSongs(env, day, fetchImpl) {
  const key = `prewarm:v1:list:${day}`;
  const kept = await env.CLASS_KV.get(key, 'json');
  if (Array.isArray(kept)) return kept;
  const seen = new Set();
  const songs = [];
  for (const sf of STOREFRONTS) {
    try {
      const r = await fetchImpl(FEED(sf), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      for (const raw of (await r.json())?.feed?.results ?? []) {
        const s = chartSong(raw);
        const k = s && (banKey(s) ?? s.id);
        if (!s || seen.has(k)) continue;
        seen.add(k);
        songs.push(s);
      }
    } catch (e) {
      console.error(JSON.stringify({ message: 'prewarm feed failed', storefront: sf, error: String(e) }));
    }
  }
  if (songs.length) await env.CLASS_KV.put(key, JSON.stringify(songs), { expirationTtl: DAY_TTL_S });
  return songs;
}

/** One cron run. → { checked, asked, used } (for the log and tests). */
export async function prewarm(env, { now = Date.now(), fetchImpl = fetch, lyricsFetch, songbook = songbookToCheck(), songbookMade = SONGBOOK_MADE, baked } = {}) {
  if (!env.CLASS_KV || !env.AI) return { checked: 0, asked: 0, used: 0 };
  const day = new Date(now).toISOString().slice(0, 10);
  const stateKey = `prewarm:v1:state:${day}`;
  const state = (await env.CLASS_KV.get(stateKey, 'json')) ?? { cursor: 0, used: 0 };
  state.genre ??= 0;
  if (state.used >= PREWARM_AI_PER_DAY) return { checked: 0, asked: 0, used: state.used };
  const songs = await todaysSongs(env, day, fetchImpl);
  let checked = 0, asked = 0, scanned = 0;
  const ready = []; // songs this run found ✓ Checked (growShelves)
  const budget = async () => {
    if (state.used >= PREWARM_AI_PER_DAY) return false;
    state.used++;
    asked++;
    return true;
  };
  const lyrics = (song, want) => judgeFromLyrics(song, env, {
    ...want,
    timeoutMs: LYRICS_PATIENT_MS, // no student waits on the cron
    fetchImpl: lyricsFetch, // tests only (undefined: the real fetch)
    allow: async () => (!env.LYRICS_RATE_ALL || (await env.LYRICS_RATE_ALL.limit({ key: 'everyone' })).success) && budget(),
  });
  const check = async (song) => {
    const before = asked;
    try {
      // ask: true (the check is on); no teacher scope: approvals are a teacher's, not facts.
      await aiThemeCheck(song, env, { ask: true, scope: (k) => `prewarm-none:${k}`, lyrics, budget });
      if (song.explicit !== 'explicit' && (await checkFromKv(song, env, { scope: (k) => `prewarm-none:${k}` })) === 'ready') ready.push(song);
    } catch (e) {
      console.error(JSON.stringify({ message: 'prewarm check failed', song: song.id, error: String(e) }));
    }
    scanned++;
    if (asked > before) checked++; // a known song cost no AI call: only the scan counts
  };
  const night = nightHours(now);
  const perRun = night ? PREWARM_NIGHT_PER_RUN : PREWARM_PER_RUN;
  const scanMax = night ? PREWARM_NIGHT_SCAN_PER_RUN : PREWARM_SCAN_PER_RUN;
  const more = () => checked < perRun && scanned < scanMax && state.used < PREWARM_AI_PER_DAY;
  while (state.cursor < songs.length && more()) await check(songs[state.cursor++]);
  // The songbook, after the charts (one pass per list).
  let book = null;
  if (state.cursor >= songs.length && more() && songbook.length) {
    const kept = (await env.CLASS_KV.get(SONGBOOK_STATE, 'json')) ?? {};
    book = { made: songbookMade, at: kept.made === songbookMade ? Number(kept.at) || 0 : 0 };
    const start = book.at;
    while (book.at < songbook.length && more()) await check(songbook[book.at++]);
    if (book.at !== start || kept.made !== songbookMade) await env.CLASS_KV.put(SONGBOOK_STATE, JSON.stringify(book));
  }
  // Then the genre charts.
  let genres = null;
  if (state.cursor >= songs.length && (!book || book.at >= songbook.length) && more()) {
    genres = await genreSongs(env, day, fetchImpl);
    while (state.genre < genres.length && more()) await check(genres[state.genre++]);
  }
  const grew = await growShelves(env, ready, fetchImpl, baked).catch((e) => {
    console.error(JSON.stringify({ message: 'prewarm shelves failed', error: String(e) }));
    return 0;
  });
  await env.CLASS_KV.put(stateKey, JSON.stringify(state), { expirationTtl: DAY_TTL_S });
  if (asked || grew) console.log(JSON.stringify({ message: 'prewarm', day, checked, scanned, asked, grew, used: state.used, of: songs.length, at: state.cursor, ...(book ? { songbook: book.at, songbookOf: songbook.length } : {}), ...(genres ? { genre: state.genre, genreOf: genres.length } : {}) }));
  return { checked, scanned, asked, grew, used: state.used, ...(book ? { songbook: book.at } : {}), ...(genres ? { genre: state.genre } : {}) };
}
