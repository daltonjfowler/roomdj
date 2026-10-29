// The night shift (Dalton, 2026-10-28): LRCLIB is busiest while classes run, so a song whose lyrics
// could not be read in class is checked again at night, when nobody waits. Two kinds of songs go on
// the night list (KV lyricsq:v1:*, each key a small list of songs, NIGHT_TTL_S):
//   - a suggestion the checker could not settle because LRCLIB was busy, slow or rate-limited, or a
//     free teacher's AI checks were used up (nightWorthy; key lyricsq:v1:look:<banKey>);
//   - songs a class searched that were not ✓ Checked yet (the room keeps up to NIGHT_SEARCH_MAX in
//     memory and writes them as one key when it closes; key lyricsq:v1:s:<time>-<random>);
//   - songs a teacher turned down (Remove in Needs a look, Ban; key lyricsq:v1:t:<banKey>), and ONCE
//     the bans from before that (sweepBans; lyricsq:v1:bans:<day>-<n>): Dalton, 2026-10-28, "songs
//     that were rejected by other teachers that weren't checked yet ... make final decision for
//     everyone. Still leave blocked for that teacher". The night's verdict is a shared fact; the
//     teacher's own ban list is never touched.
// The cron (src/prewarm.js) runs nightShift during NIGHT_HOURS_UTC before the chart songs: the same
// aiThemeCheck and patient lyrics lookup a suggestion gets, at most NIGHT_AI_PER_DAY AI calls a day.
// A song already settled costs nothing. Only song details (title, artist, album, length...) are kept:
// no student, nickname or room.

import { ITUNES, catalogOf, songId } from '../shared/catalog.js';
import { aiThemeCheck, banKey } from '../shared/filter.js';
import { LYRICS_PATIENT_MS, judgeFromLyrics } from './lyrics.js';

export const NIGHT_PREFIX = 'lyricsq:v1:';
export const NIGHT_TTL_S = 7 * 24 * 3600;
export const NIGHT_AI_PER_DAY = 150;
/** Songs a run that needed the AI or LRCLIB, and songs a run in all (settled ones cost only KV reads). */
export const NIGHT_PER_RUN = 8;
export const NIGHT_SONGS_PER_RUN = 40;
/** Set (never expires) once sweepBans has run: every ban since is listed when it is made. */
const BANS_SWEPT = 'night:v1:bans-swept';
const BANS_PER_KEY = 50;
export const NIGHT_KEYS_PER_RUN = 10;
/** Searched songs a room keeps for the night list. */
export const NIGHT_SEARCH_MAX = 40;
/** 04:00-10:00 UTC: midnight to 6 am Eastern, 9 pm to 3 am Pacific. */
export const NIGHT_HOURS_UTC = [4, 10];
const DAY_TTL_S = 2 * 24 * 3600;

export function nightHours(now) {
  const h = new Date(now).getUTCHours();
  return h >= NIGHT_HOURS_UTC[0] && h < NIGHT_HOURS_UTC[1];
}

/** The song's details for the night list, or null (iTunes songs only: Spotify songs never go to the AI, filter.js). */
export function nightSong(song) {
  if (catalogOf(song?.id) !== ITUNES || !banKey(song)) return null;
  const { id, title, artist, album = '', durationMs = 0, explicit = 'notExplicit', genre = '', year = 0 } = song;
  return { id, title, artist, album, durationMs, explicit, genre, year };
}

/**
 * True when the night can settle what the checker could not: an OK or UNKNOWN whose lyrics were
 * never read (LRCLIB trouble, a rate limit, a free teacher's used-up AI checks). Not a teacher's
 * allow, not a song LRCLIB has no lyrics for.
 */
export function nightWorthy(song, ai) {
  if (!nightSong(song) || !ai || ai.lyrics || ai.source === 'teacher' || ai.source === 'policy') return false;
  return ai.verdict === 'ok' || ai.verdict === 'unknown';
}

/** Put songs on the night list under `name` (lyricsq:v1:<name>). Never throws. */
export async function addToNight(env, name, songs) {
  const list = songs.map(nightSong).filter(Boolean);
  if (!list.length || !env.CLASS_KV) return;
  try {
    await env.CLASS_KV.put(`${NIGHT_PREFIX}${name}`, JSON.stringify(list), { expirationTtl: NIGHT_TTL_S });
  } catch (e) {
    console.error(JSON.stringify({ message: 'night list write failed', error: String(e) }));
  }
}

/**
 * ONCE ever: the bans made before Room.rejectedByTeacher (every teacher's `banned` and
 * `p:<profile>:banned`) go on the night list, one entry per song (banKey), BANS_PER_KEY songs a key.
 * Never again (Dalton, 2026-10-28: "lyrics don't change"): a ban made since is listed when it is
 * made, and a settled verdict is kept. Read only: the ban lists stay as they are. → songs listed.
 */
export async function sweepBans(env, day) {
  if (await env.CLASS_KV.get(BANS_SWEPT)) return 0;
  await env.CLASS_KV.put(BANS_SWEPT, day);
  const names = ['banned'];
  let cursor;
  do {
    const page = await env.CLASS_KV.list({ prefix: 'p:', limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const k of page.keys ?? []) if (/^p:[^:]+:banned$/.test(k.name)) names.push(k.name);
    cursor = page.list_complete === false ? page.cursor : undefined;
  } while (cursor);
  const seen = new Set();
  const songs = [];
  for (const name of names) {
    const list = await env.CLASS_KV.get(name, 'json');
    for (const b of Array.isArray(list) ? list : []) {
      const s = nightSong({ ...b, id: songId(b?.id ?? b?.trackId) });
      const key = s && banKey(s);
      if (key && !seen.has(key)) {
        seen.add(key);
        songs.push(s);
      }
    }
  }
  for (let i = 0; i < songs.length; i += BANS_PER_KEY) {
    await addToNight(env, `bans:${day}-${i / BANS_PER_KEY}`, songs.slice(i, i + BANS_PER_KEY));
  }
  return songs.length;
}

/** One cron run's share of the night list. → { checked, asked, used } (for the log and tests). */
export async function nightShift(env, { now = Date.now(), lyricsFetch } = {}) {
  if (!env.CLASS_KV || !env.AI) return { checked: 0, asked: 0, used: 0 };
  const day = new Date(now).toISOString().slice(0, 10);
  const stateKey = `night:v1:state:${day}`;
  const state = (await env.CLASS_KV.get(stateKey, 'json')) ?? { used: 0 };
  if (state.used >= NIGHT_AI_PER_DAY) return { checked: 0, asked: 0, used: state.used };
  let checked = 0, asked = 0;
  const budget = async () => {
    if (state.used >= NIGHT_AI_PER_DAY) return false;
    state.used++;
    asked++;
    return true;
  };
  const lyrics = (song, want) => judgeFromLyrics(song, env, {
    ...want,
    timeoutMs: LYRICS_PATIENT_MS,
    fetchImpl: lyricsFetch, // tests only (undefined: the real fetch)
    allow: async () => (!env.LYRICS_RATE_ALL || (await env.LYRICS_RATE_ALL.limit({ key: 'everyone' })).success) && budget(),
  });
  try {
    await sweepBans(env, day);
  } catch (e) {
    console.error(JSON.stringify({ message: 'night ban sweep failed', error: String(e) }));
  }
  let worked = 0; // songs that needed the AI or LRCLIB this run
  const more = () => worked < NIGHT_PER_RUN && checked < NIGHT_SONGS_PER_RUN && state.used < NIGHT_AI_PER_DAY;
  const { keys = [] } = await env.CLASS_KV.list({ prefix: NIGHT_PREFIX, limit: NIGHT_KEYS_PER_RUN });
  for (const { name } of keys) {
    if (!more()) break;
    const songs = (await env.CLASS_KV.get(name, 'json')) ?? [];
    const left = Array.isArray(songs) ? [...songs] : [];
    while (left.length && more()) {
      const song = left.shift();
      const before = asked;
      try {
        // No teacher scope: approvals are a teacher's, not facts (as the chart pre-check).
        await aiThemeCheck(song, env, { ask: true, scope: (k) => `prewarm-none:${k}`, lyrics, budget });
      } catch (e) {
        console.error(JSON.stringify({ message: 'night check failed', song: song?.id, error: String(e) }));
      }
      checked++;
      if (asked > before) worked++;
    }
    if (left.length) await env.CLASS_KV.put(name, JSON.stringify(left), { expirationTtl: NIGHT_TTL_S });
    else await env.CLASS_KV.delete(name);
  }
  await env.CLASS_KV.put(stateKey, JSON.stringify(state), { expirationTtl: DAY_TTL_S });
  if (checked) console.log(JSON.stringify({ message: 'night shift', day, checked, asked, used: state.used }));
  return { checked, asked, used: state.used };
}
