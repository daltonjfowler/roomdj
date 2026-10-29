// Checked songs pile up (Dalton, 2026-10-14: "keep building a large dataset of checked songs so it'll
// cost less as we go"). A cron (wrangler.jsonc triggers) checks the songs classes are most likely to
// suggest, Apple's most-played charts, BEFORE anyone suggests them, with the same theme check (and
// lyrics follow-up) a suggestion gets. Verdicts are shared facts (verdict:v7:*, kept a year when
// settled), so a class later pays nothing for them.
// Cheap by design: songs already known cost nothing (no AI call, not counted); at most
// PREWARM_AI_PER_DAY AI calls a day (inside Workers AI's free daily allowance), PREWARM_PER_RUN songs
// a run (a few subrequests each). KV: prewarm:v1:list:<day> (the day's chart songs, fetched once),
// prewarm:v1:state:<day> { cursor, used }.

import { aiThemeCheck, banKey } from '../shared/filter.js';
import { LYRICS_PATIENT_MS, judgeFromLyrics } from './lyrics.js';

export const PREWARM_AI_PER_DAY = 150;
export const PREWARM_PER_RUN = 6;
const STOREFRONTS = ['us', 'gb', 'ca', 'au'];
const FEED = (sf) => `https://rss.marketingtools.apple.com/api/v2/${sf}/music/most-played/100/songs.json`;
const DAY_TTL_S = 2 * 24 * 3600;

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
export async function prewarm(env, { now = Date.now(), fetchImpl = fetch, lyricsFetch } = {}) {
  if (!env.CLASS_KV || !env.AI) return { checked: 0, asked: 0, used: 0 };
  const day = new Date(now).toISOString().slice(0, 10);
  const stateKey = `prewarm:v1:state:${day}`;
  const state = (await env.CLASS_KV.get(stateKey, 'json')) ?? { cursor: 0, used: 0 };
  if (state.used >= PREWARM_AI_PER_DAY) return { checked: 0, asked: 0, used: state.used };
  const songs = await todaysSongs(env, day, fetchImpl);
  let checked = 0, asked = 0;
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
  while (state.cursor < songs.length && checked < PREWARM_PER_RUN && state.used < PREWARM_AI_PER_DAY) {
    const song = songs[state.cursor++];
    try {
      // ask: true (the check is on); no teacher scope: approvals are a teacher's, not facts.
      await aiThemeCheck(song, env, { ask: true, scope: (k) => `prewarm-none:${k}`, lyrics, budget });
    } catch (e) {
      console.error(JSON.stringify({ message: 'prewarm check failed', song: song.id, error: String(e) }));
    }
    checked++;
  }
  await env.CLASS_KV.put(stateKey, JSON.stringify(state), { expirationTtl: DAY_TTL_S });
  if (asked) console.log(JSON.stringify({ message: 'prewarm', day, checked, asked, used: state.used, of: songs.length, at: state.cursor }));
  return { checked, asked, used: state.used };
}
