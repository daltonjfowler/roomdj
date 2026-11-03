// Finish the waiting lyrics checks (Dalton, 2026-11-03: "We can finish the 978 lyric checks left in
// queue just don't pull new songs auto"). The pre-check crawl is paused (src/prewarm.js PREWARM_ON),
// but songs it already checked whose lyrics LRCLIB could not read yet (lyricsPending: AI-ok or not
// sure, no lyrics) are asked again here, slowly. NO new songs: a song without a verdict is never
// touched, and nothing is fetched from the charts.
// Each cron run walks the per-iTunes-id verdicts (verdict:v<PROMPT_VERSION>:<track id>; the per-song
// keys hold no real title) from where the last run stopped, picks up to FINISH_PER_RUN waiting ones,
// looks them up on iTunes (one call) for their real title, artist and length, and runs the same
// aiThemeCheck + patient lyrics lookup a suggestion gets (through the shared LRCLIB line and its
// backoff). A song LRCLIB could not answer stops the run there, so the next run asks it again; after
// FINISH_TRIES it is passed over. One pass over the verdicts, then it stops for good
// (KV FINISH_KEY { cursor, skip, tries, asked, done }).

import { PROMPT_VERSION, aiThemeCheck, lyricsPending, readVerdict } from '../shared/filter.js';
import { parseItunes, toSong } from '../shared/itunes.js';
import { LYRICS_PATIENT_MS, judgeFromLyrics } from './lyrics.js';

export const FINISH_KEY = 'lyricsfinish:v1';
/** Waiting songs sent to LRCLIB a run (every 15 minutes: about 770 a day at most). */
export const FINISH_PER_RUN = 8;
/** Verdicts read a run while looking for waiting ones (the cron's other work shares the KV operations). */
const READS_PER_RUN = 150;
const READ_CHUNK = 25;
/** Runs a song may stop on before it is passed over. */
const FINISH_TRIES = 3;
const PAGE = 1000;

/** One cron run's share. → the saved state (null: nothing to do). */
export async function finishLyrics(env, { fetchImpl = fetch, lyricsFetch } = {}) {
  if (!env.CLASS_KV || !env.AI) return null;
  const state = (await env.CLASS_KV.get(FINISH_KEY, 'json')) ?? { cursor: null, skip: 0, tries: 0, asked: 0, done: false };
  if (state.done) return state;
  const prefix = `verdict:v${PROMPT_VERSION}:`;
  const page = await env.CLASS_KV.list({ prefix, limit: PAGE, ...(state.cursor ? { cursor: state.cursor } : {}) });
  const names = page.keys.map((k) => k.name);
  // The waiting ones from `skip` on: [{ index, id }]; `end` is where reading stopped.
  const waiting = [];
  let end = state.skip, read = 0;
  while (end < names.length && waiting.length < FINISH_PER_RUN && read < READS_PER_RUN) {
    const slice = [];
    for (; end < names.length && slice.length < READ_CHUNK; end++) {
      const id = names[end].slice(prefix.length);
      if (/^\d+$/.test(id)) slice.push({ index: end, id });
    }
    read += slice.length;
    const values = await Promise.all(slice.map((x) => env.CLASS_KV.get(prefix + x.id, 'json').catch(() => null)));
    slice.forEach((x, i) => {
      const v = readVerdict(values[i]);
      if (v && lyricsPending({}, v)) waiting.push(x);
    });
    if (waiting.length > FINISH_PER_RUN) {
      end = waiting[FINISH_PER_RUN].index; // read past the run's share: the rest wait for the next run
      waiting.length = FINISH_PER_RUN;
    }
  }
  if (waiting.length) {
    let songs;
    try {
      const r = await fetchImpl(`https://itunes.apple.com/lookup?id=${waiting.map((x) => x.id).join(',')}&entity=song&country=US`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`iTunes ${r.status}`);
      songs = new Map((parseItunes(await r.text()) ?? []).map(toSong).filter(Boolean).map((s) => [s.id, s]));
    } catch (e) {
      console.error(JSON.stringify({ message: 'lyrics finish lookup failed', error: String(e) }));
      return state; // the same songs next run
    }
    const lyrics = (song, want) => judgeFromLyrics(song, env, {
      ...want,
      timeoutMs: LYRICS_PATIENT_MS, // no student waits on the cron
      fetchImpl: lyricsFetch, // tests only (undefined: the real fetch)
      allow: async () => !env.LYRICS_RATE_ALL || (await env.LYRICS_RATE_ALL.limit({ key: 'everyone' })).success,
    });
    for (const x of waiting) {
      const song = songs.get(`it:${x.id}`);
      if (song) {
        let done = false;
        try {
          // No teacher scope: approvals are a teacher's, not facts (as the chart pre-check).
          const ai = await aiThemeCheck(song, env, { ask: true, scope: (k) => `prewarm-none:${k}`, lyrics });
          done = !ai.failed && !lyricsPending(song, ai);
        } catch (e) {
          console.error(JSON.stringify({ message: 'lyrics finish check failed', song: song.id, error: String(e) }));
        }
        state.asked++;
        if (!done && ++state.tries < FINISH_TRIES) {
          end = x.index; // LRCLIB busy or down: this song first next run
          break;
        }
      }
      state.tries = 0; // settled, passed over, or no longer on iTunes
    }
  }
  state.skip = end;
  if (end >= names.length) {
    if (page.list_complete) state.done = true;
    else {
      state.cursor = page.cursor;
      state.skip = 0;
    }
  }
  await env.CLASS_KV.put(FINISH_KEY, JSON.stringify(state));
  if (waiting.length) console.log(JSON.stringify({ message: 'lyrics finish', waiting: waiting.length, asked: state.asked, done: state.done }));
  return state;
}
