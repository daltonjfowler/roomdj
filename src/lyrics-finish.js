// Finish the waiting lyrics checks (Dalton, 2026-11-03: "We can finish the 978 lyric checks left in
// queue just don't pull new songs auto"). The pre-check crawl is paused (src/prewarm.js PREWARM_ON),
// but songs it already checked whose lyrics LRCLIB could not read yet (lyricsPending: AI-ok or not
// sure, no lyrics) are asked again here, slowly. NO new songs: a song without a verdict is never
// touched, and nothing is fetched from Apple (iTunes answers RoomDJ's server with 403).
// The songs come from the songbook (src/songbook.js songbookToCheck: the crawl's biggest source, with
// full details in the code). Each cron run reads their verdicts from where the last run stopped, picks
// up to FINISH_PER_RUN waiting ones and runs the same aiThemeCheck + patient lyrics lookup a suggestion
// gets (through the shared LRCLIB line and its backoff). A song LRCLIB could not answer stops the run
// there, so the next run asks it again; after FINISH_TRIES it is passed over. One pass, then it stops
// for good (KV FINISH_KEY { at, tries, asked, done }).

import { aiThemeCheck, banKey, lyricsPending, readVerdict, verdictKey } from '../shared/filter.js';
import { LYRICS_PATIENT_MS, judgeFromLyrics } from './lyrics.js';
import { songbookToCheck } from './songbook.js';

export const FINISH_KEY = 'lyricsfinish:v1';
/** Waiting songs sent to LRCLIB a run (every 15 minutes: about 770 a day at most). */
export const FINISH_PER_RUN = 8;
/** Songs whose verdicts are read a run (the cron's other work shares the KV operations). */
const READS_PER_RUN = 150;
const READ_CHUNK = 25;
/** Runs a song may stop on before it is passed over. */
const FINISH_TRIES = 3;

/** One cron run's share. → the saved state (null: nothing to do). */
export async function finishLyrics(env, { songs = songbookToCheck(), lyricsFetch } = {}) {
  if (!env.CLASS_KV || !env.AI) return null;
  const state = (await env.CLASS_KV.get(FINISH_KEY, 'json')) ?? { at: 0, tries: 0, asked: 0, done: false };
  if (state.done) return state;
  // The waiting ones from `at` on; `end` is where reading stopped.
  const waiting = [];
  let end = state.at;
  while (end < songs.length && waiting.length < FINISH_PER_RUN && end - state.at < READS_PER_RUN) {
    const slice = songs.slice(end, end + READ_CHUNK).map((song, i) => ({ song, index: end + i }));
    end += slice.length;
    const values = await Promise.all(slice.map(async ({ song }) => {
      const byId = await env.CLASS_KV.get(verdictKey(song.id), 'json').catch(() => null);
      return byId ?? (banKey(song) ? await env.CLASS_KV.get(verdictKey(banKey(song)), 'json').catch(() => null) : null);
    }));
    slice.forEach((x, i) => {
      const v = readVerdict(values[i]);
      if (v && lyricsPending(x.song, v)) waiting.push(x);
    });
    if (waiting.length > FINISH_PER_RUN) {
      end = waiting[FINISH_PER_RUN].index; // read past the run's share: the rest wait for the next run
      waiting.length = FINISH_PER_RUN;
    }
  }
  const lyrics = (song, want) => judgeFromLyrics(song, env, {
    ...want,
    timeoutMs: LYRICS_PATIENT_MS, // no student waits on the cron
    fetchImpl: lyricsFetch, // tests only (undefined: the real fetch)
    allow: async () => !env.LYRICS_RATE_ALL || (await env.LYRICS_RATE_ALL.limit({ key: 'everyone' })).success,
  });
  for (const { song, index } of waiting) {
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
      end = index; // LRCLIB busy or down: this song first next run
      break;
    }
    state.tries = 0; // settled, or passed over
  }
  state.at = end;
  if (end >= songs.length) state.done = true;
  await env.CLASS_KV.put(FINISH_KEY, JSON.stringify(state));
  if (waiting.length) console.log(JSON.stringify({ message: 'lyrics finish', waiting: waiting.length, asked: state.asked, at: state.at, done: state.done }));
  return state;
}
