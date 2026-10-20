// The AI theme check against the test list (test/ai-songs.json), to pick the model (plan doc,
// "Choosing the model"). Uses the SAME prompt and parser as the Worker (shared/filter.js) and
// calls the Workers AI REST API from Node, so no test route exists in the Worker at all. The KV
// verdict cache is not touched: every song is asked fresh.
//   node scripts/ai-test.mjs                                        (the Worker's model)
//   node scripts/ai-test.mjs --model @cf/meta/llama-3.1-8b-instruct-fast
//   node scripts/ai-test.mjs --model A --model B                    (compare, one column each)
//   node scripts/ai-test.mjs --only 1-5                             (just some songs; also 3,7,9)
//   node scripts/ai-test.mjs --group e                              (one group of the list)
//   node scripts/ai-test.mjs --group e --lyrics                     (UNKNOWN songs judged again from
//                                                                    their LRCLIB lyrics, src/lyrics.js)
//   node scripts/ai-test.mjs --only 50,52 --lyrics-only             (the lyrics call alone, no theme call:
//                                                                    for trying the lyrics prompt cheaply)
// Each run costs a little Workers AI usage (one call per song per model; --lyrics: one more for
// each UNKNOWN song that LRCLIB has lyrics for, about 1,500 tokens each). The lyrics are fetched
// from LRCLIB (spaced, our User-Agent), used for the call and dropped: never printed or saved.
// Auth: CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) if set, else Wrangler's own login
// (`wrangler auth token`). The token stays in memory and is never printed.
// Songs are looked up on iTunes the way a student's search would find them (an explicit song is
// swapped for its clean version); lookups are cached in test/.ai-songs-cache.json (gitignored).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEME_MODEL, buildLyricsPrompt, buildThemePrompt, instrumentalOf, normalizeWords, parseThemeVerdict, quickCheck, quotesLyrics } from '../shared/filter.js';
import { categoryEvidence } from '../shared/reasons.js';
import { fetchLyrics } from '../src/lyrics.js';
import { baseTitle } from '../shared/filter.js';
import { searchSongs } from '../src/itunes.js';
import { findCleanVersion } from '../src/catalog.js';

const ROOT = new URL('../', import.meta.url);
const LIST = new URL('test/ai-songs.json', ROOT);
const CACHE = new URL('test/.ai-songs-cache.json', ROOT);
const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));

// ---- Arguments ----
const args = process.argv.slice(2);
const models = [];
let only = null;
let group = null;
let withLyrics = false;
let lyricsOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model') models.push(args[++i]);
  else if (args[i] === '--group') group = args[++i];
  else if (args[i] === '--lyrics') withLyrics = true;
  else if (args[i] === '--lyrics-only') withLyrics = lyricsOnly = true;
  else if (args[i] === '--only') {
    const v = args[++i];
    if (v.includes(',')) only = new Set(v.split(',').map(Number));
    else {
      const [a, b] = v.split('-').map(Number);
      only = new Set(Array.from({ length: (b || a) - a + 1 }, (_, k) => a + k));
    }
  } else {
    console.error(`Unknown argument ${args[i]}`);
    process.exit(2);
  }
}
if (!models.length) models.push(THEME_MODEL);
if (models.some((m) => !/^@cf\/[\w.-]+\/[\w.-]+$/.test(m ?? ''))) {
  console.error('A model looks like @cf/meta/llama-3.1-8b-instruct-fast');
  process.exit(2);
}

// ---- Auth (never printed) ----
function wrangler(...cmd) {
  const r = spawnSync(process.execPath, [WRANGLER, ...cmd], { encoding: 'utf8', cwd: fileURLToPath(ROOT) });
  if (r.status !== 0) throw new Error(`wrangler ${cmd.join(' ')} failed (log in with: npx wrangler login)`);
  return r.stdout;
}
function auth() {
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const out = JSON.parse(wrangler('auth', 'token', '--json'));
    if (out.type !== 'oauth' && out.type !== 'api_token') throw new Error(`Wrangler gave a ${out.type} credential; set CLOUDFLARE_API_TOKEN instead`);
    token = out.token;
  }
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const ids = [...wrangler('whoami').matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1]);
    if (new Set(ids).size !== 1) throw new Error('Could not tell which Cloudflare account to use; set CLOUDFLARE_ACCOUNT_ID');
    account = ids[0];
  }
  return { token, account };
}

// Same answer shapes the Worker accepts (filter.js answerText).
function answerText(out) {
  if (typeof out === 'string') return out;
  if (typeof out?.response === 'string') return out.response;
  if (out?.response && typeof out.response === 'object') return JSON.stringify(out.response);
  const content = out?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : null;
}

async function runModel({ token, account }, model, song, messages = buildThemePrompt(song)) {
  // Same options as aiThemeCheck in shared/filter.js (runThemeModel).
  const body = { messages, max_tokens: 140, temperature: 0 };
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success !== false) {
      const text = answerText(data?.result);
      return text === null ? { verdict: 'unknown', reason: 'no text in answer', raw: '' } : { ...parseThemeVerdict(text), raw: text };
    }
    if (attempt >= 3 || (res.status < 500 && res.status !== 429)) {
      const why = data?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      return { verdict: 'error', reason: why.slice(0, 120), raw: '' };
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

// ---- Songs, found the way a student's search finds them ----
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let lastItunes = 0;
const kvless = {}; // no KV here: every iTunes call goes out, so they are spaced (about 20 a minute)
async function itunes(fn) {
  const wait = lastItunes + 3200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastItunes = Date.now();
  return fn();
}
async function findSong(entry) {
  const key = `${entry.title} | ${entry.artist}`;
  if (cache[key]) return cache[key];
  const results = await itunes(() => searchSongs(`${entry.title} ${entry.artist}`, kvless));
  const want = baseTitle(entry.title);
  const artist = normalizeWords(entry.artist).split(' ')[0];
  // The artist's own recording before covers ("Singles plays Pearl Jam").
  const own = (s) => normalizeWords(s.artist).startsWith(normalizeWords(entry.artist));
  // The plain studio version first: "Dynamite (Live)" or "Espresso (On Vacation Version)" only if
  // nothing better is there (the title the model sees changes what it answers).
  const plain = (s) => !/\b(live|version|remix|acoustic|instrumental|karaoke)\b/i.test(s.title);
  const pick = (list) => list.find((s) => normalizeWords(s.title) === normalizeWords(entry.title))
    ?? list.find((s) => baseTitle(s.title) === want && plain(s))
    ?? list.find((s) => baseTitle(s.title) === want);
  let song = pick(results.filter(own)) ?? pick(results.filter((s) => normalizeWords(s.artist).includes(artist))) ?? null;
  if (song?.explicit === 'explicit') {
    const clean = await itunes(() => findCleanVersion(song, kvless, { alsoIn: results }));
    song = clean ?? song;
  }
  const out = song
    ? { id: song.id, title: song.title, artist: song.artist, album: song.album, explicit: song.explicit, genre: song.genre ?? '', found: true }
    : { id: null, title: entry.title, artist: entry.artist, album: '', explicit: 'notExplicit', found: false };
  cache[key] = out;
  writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);
  return out;
}

function grade(expected, verdict) {
  if (verdict === 'error') return 'ERROR';
  if (expected === 'either') return 'ok';
  if (expected === 'ok_or_unknown') return verdict === 'inappropriate' ? 'MISS' : 'ok';
  if (verdict === expected) return 'ok';
  // Blocked by the unknown-song rule (on by default) but not actually judged.
  if (verdict === 'unknown') return 'soft';
  return 'MISS';
}

// ---- Run ----
const list = JSON.parse(readFileSync(LIST, 'utf8')).songs;
const picked = list.map((s, i) => ({ ...s, n: i + 1 }))
  .filter((s) => (!only || only.has(s.n)) && (!group || s.group === group));
if (withLyrics && models.length !== 1) {
  console.error('--lyrics works with one model');
  process.exit(2);
}
let lastLrclib = 0;
/** The lyrics step the Worker does (src/lyrics.js judgeFromLyrics), for an UNKNOWN answer. */
async function lyricsStep(creds, model, song) {
  const wait = lastLrclib + 600 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLrclib = Date.now();
  const found = await fetchLyrics(song, {});
  if (found.status !== 'lyrics') return { verdict: found.status === 'instrumental' ? 'ok' : 'unknown', lyrics: found.status, why: found.why ?? '', calls: 0 };
  const r = await runModel(creds, model, song, buildLyricsPrompt(song, found.text));
  const quoted = Boolean(r.evidence) && quotesLyrics(r.evidence, found.text);
  let evidence = quoted ? '' : r.evidence;
  if (r.verdict === 'inappropriate' && !evidence) evidence = categoryEvidence(r.category);
  return { ...r, raw: '', evidence, quoted, lyrics: 'found', calls: 1 };
}
const creds = auth();
const rows = [];
for (const entry of picked) {
  const song = await findSong(entry);
  const quick = quickCheck(song);
  const results = [];
  for (const model of models) results.push(lyricsOnly ? { verdict: 'unknown', reason: '(theme call skipped: --lyrics-only)' } : await runModel(creds, model, song));
  const lyr = withLyrics && song.found && results[0].verdict === 'unknown' ? await lyricsStep(creds, models[0], song) : null;
  rows.push({ entry, song, quick, results, lyr });
  const cells = results.map((r, i) => `${short(models[i])}: ${r.verdict} ${grade(entry.expected, r.verdict)}`).join(' | ');
  console.error(`${String(entry.n).padStart(2)} ${entry.title} - ${cells}${lyr ? ` → lyrics(${lyr.lyrics}): ${lyr.verdict} ${grade(entry.expected, lyr.verdict)}` : ''}`);
}

function short(model) {
  return model.split('/').pop();
}
const cell = (text, width) => String(text).replace(/\s+/g, ' ').slice(0, width).padEnd(width);

console.log('');
console.log(`Models: ${models.map((m, i) => `[${i + 1}] ${m}`).join('  ')}`);
console.log('match: ok = right; MISS = wrong; soft = said UNKNOWN (blocked anyway when "block unknown songs" is on); either/ok_or_unknown are graded loosely.');
console.log('');
const head = ['#', 'grp', 'song (as found on iTunes)', 'expected', ...models.flatMap((_, i) => [`[${i + 1}] verdict`, 'match', '[category] evidence (or reason)'])];
const widths = [3, 3, 46, 13, ...models.flatMap(() => [13, 5, 110])];
console.log(head.map((h, i) => cell(h, widths[i])).join(' '));
for (const { entry, song, quick, results } of rows) {
  const name = `${song.title} - ${song.artist}${song.found ? '' : ' (not on iTunes)'}${song.explicit !== 'notExplicit' ? ` [${song.explicit}]` : ''}${quick ? ` (filter: ${quick})` : ''}`;
  const parts = [entry.n, entry.group, name, entry.expected,
    ...results.flatMap((r) => [r.verdict, grade(entry.expected, r.verdict), r.category ? `[${r.category}] ${r.evidence}` : r.reason])];
  console.log(parts.map((p, i) => cell(p, widths[i])).join(' '));
}
console.log('');
models.forEach((m, i) => {
  const graded = rows.map((r) => ({ n: r.entry.n, title: r.entry.title, g: grade(r.entry.expected, r.results[i].verdict) }));
  const of = (g) => graded.filter((x) => x.g === g);
  const list = (g) => of(g).map((x) => `${x.n} ${x.title}`).join(', ') || 'none';
  console.log(`[${i + 1}] ${m}: ${of('MISS').length} misses, ${of('soft').length} soft (unknown), ${of('ERROR').length} errors of ${rows.length}`);
  console.log(`    misses: ${list('MISS')}`);
  console.log(`    soft:   ${list('soft')}`);
  if (of('ERROR').length) console.log(`    errors: ${list('ERROR')}`);
  // Instrumentals only (prompt v5): the model's answer, and what the filter decides with the title/genre hints.
  const inst = rows.filter((r) => typeof r.entry.instrumental === 'boolean');
  if (inst.length) {
    const said = inst.map((r) => ({ n: r.entry.n, title: r.entry.title, want: r.entry.instrumental, ai: r.results[i].instrumental, final: instrumentalOf(r.song, r.results[i].instrumental ?? null) }));
    const right = (k) => said.filter((x) => x[k] === x.want).length;
    const wrong = (k) => said.filter((x) => typeof x[k] === 'boolean' && x[k] !== x.want);
    console.log(`    instrumental (AI answer): ${right('ai')} right, ${wrong('ai').length} wrong, ${said.length - right('ai') - wrong('ai').length} unknown of ${said.length}`);
    console.log(`    instrumental (with hints): ${right('final')} right, ${wrong('final').length} wrong of ${said.length}`);
    for (const x of said) console.log(`      ${String(x.n).padStart(2)} ${x.title}: want ${x.want}, AI ${x.ai}, filter ${x.final}`);
  }
});
if (withLyrics) {
  const tried = rows.filter((r) => r.lyr);
  const after = (r) => (r.lyr ? r.lyr.verdict : r.results[0].verdict);
  const of = (g) => rows.filter((r) => grade(r.entry.expected, after(r)) === g);
  console.log('');
  console.log(`With lyrics (${models[0]}): ${tried.length} UNKNOWN songs looked up on LRCLIB; ${tried.filter((r) => r.lyr.lyrics === 'found').length} had lyrics, ${tried.filter((r) => r.lyr.lyrics === 'instrumental').length} instrumental, ${tried.filter((r) => r.lyr.lyrics === 'none').length} none, ${tried.filter((r) => r.lyr.lyrics === 'error').length} errors; ${tried.reduce((n, r) => n + r.lyr.calls, 0)} extra AI calls`);
  console.log(`  moved from UNKNOWN to a right verdict: ${tried.filter((r) => grade(r.entry.expected, r.lyr.verdict) === 'ok').length}`);
  console.log(`  after lyrics: ${of('MISS').length} misses, ${of('soft').length} still unknown, of ${rows.length}`);
  console.log(`    misses: ${of('MISS').map((r) => `${r.entry.n} ${r.entry.title} (${after(r)})`).join(', ') || 'none'}`);
  console.log(`    evidence that quoted 4+ lyric words (replaced): ${tried.filter((r) => r.lyr.quoted).map((r) => r.entry.title).join(', ') || 'none'}`);
  for (const r of tried) {
    console.log(`  ${String(r.entry.n).padStart(2)} ${r.entry.title}: expected ${r.entry.expected}; lyrics ${r.lyr.lyrics}${r.lyr.why ? ` (${r.lyr.why})` : ''} → ${r.lyr.verdict}${r.lyr.category ? ` [${r.lyr.category}]` : ''} ${r.lyr.evidence ?? ''}`);
  }
}
