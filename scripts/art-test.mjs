// The album art check against the cover list (test/art-covers.json), to pick the vision model.
// Uses the SAME prompt, fetch size and parser as the Worker (shared/art.js) and calls the Workers
// AI REST API from Node, so no test route exists in the Worker. The KV art cache is not touched.
//   node scripts/art-test.mjs                          (the Worker's model, ART_MODEL)
//   node scripts/art-test.mjs --model @cf/meta/llama-3.2-11b-vision-instruct
//   node scripts/art-test.mjs --only 1-5               (some covers; also 3,7,9)
//   node scripts/art-test.mjs --save <dir>             (also write each cover JPEG there, to look at)
//   node scripts/art-test.mjs --fetch-only --save <dir>  (look covers up and save them; no AI call)
// Each cover is one AI call (about 600 input tokens with the image). Auth exactly like
// scripts/ai-test.mjs: CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID), else `wrangler auth token`;
// the token stays in memory and is never printed. Albums are looked up on iTunes (entity=album);
// the lookups are cached in test/.art-covers-cache.json (gitignored). Images are never saved
// unless --save is given.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_MODEL, artFetchUrl, artKey, buildArtPrompt, parseArtVerdict } from '../shared/art.js';
import { normalizeWords } from '../shared/filter.js';

const ROOT = new URL('../', import.meta.url);
const LIST = new URL('test/art-covers.json', ROOT);
const CACHE = new URL('test/.art-covers-cache.json', ROOT);
const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));

const args = process.argv.slice(2);
let model = ART_MODEL;
let only = null;
let save = null;
let fetchOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model') model = args[++i];
  else if (args[i] === '--save') save = args[++i];
  else if (args[i] === '--fetch-only') fetchOnly = true;
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
if (!/^@cf\/[\w.-]+\/[\w.-]+$/.test(model)) {
  console.error('A model looks like @cf/meta/llama-4-scout-17b-16e-instruct');
  process.exit(2);
}

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

// ---- Covers, found on iTunes ----
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let lastItunes = 0;
async function findAlbum(entry) {
  const k = `${entry.album} | ${entry.artist}`;
  if (cache[k]) return cache[k];
  const wait = lastItunes + 3200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastItunes = Date.now();
  // iTunes's album search is weak for older albums: with a `song` hint, search that song and take its album.
  const term = entry.song ? `${entry.artist} ${entry.song}` : `${entry.artist} ${entry.album}`;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entry.song ? 'song' : 'album'}&limit=25&country=US`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = res.ok ? JSON.parse(await res.text()) : { results: [] };
  const want = normalizeWords(entry.album);
  const artist = normalizeWords(entry.artist).split(' ').slice(0, 2).join(' ');
  const list = (data.results ?? []).filter((r) => typeof r.artworkUrl100 === 'string' && normalizeWords(r.artistName).includes(artist));
  const pick = list.find((r) => normalizeWords(r.collectionName) === want)
    ?? list.find((r) => normalizeWords(r.collectionName).startsWith(want));
  const out = pick
    ? { found: true, collectionId: pick.collectionId, collection: pick.collectionName, artist: pick.artistName, art: pick.artworkUrl100, explicit: pick.collectionExplicitness }
    : { found: false };
  cache[k] = out;
  writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);
  return out;
}

async function coverDataUri(art) {
  const url = artFetchUrl(art);
  if (!url) throw new Error('not an mzstatic cover');
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`cover HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, uri: `data:image/jpeg;base64,${bytes.toString('base64')}` };
}

// Same input shapes the Worker sends (src/art.js runArtModel).
function modelInput(m, uri) {
  const messages = buildArtPrompt(uri);
  if (m.includes('llama-3.2-11b-vision')) {
    // This model takes the image beside the messages, and text-only content.
    const text = messages.map((x) => ({ role: x.role, content: typeof x.content === 'string' ? x.content : x.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') }));
    return { messages: text, image: uri, max_tokens: 60, temperature: 0 };
  }
  return { messages, max_tokens: 60, temperature: 0 };
}

function answerText(out) {
  if (typeof out === 'string') return out;
  if (typeof out?.response === 'string') return out.response;
  if (out?.response && typeof out.response === 'object') return JSON.stringify(out.response);
  const content = out?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : null;
}

async function runModel({ token, account }, m, uri) {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${m}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(modelInput(m, uri)),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success !== false) {
      const text = answerText(data?.result);
      return { ...parseArtVerdict(text), raw: text ?? '', usage: data?.result?.usage ?? null, ms: Date.now() - started };
    }
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) {
      const why = data?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      return { verdict: 'error', reason: why.slice(0, 160), usage: null, ms: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const list = JSON.parse(readFileSync(LIST, 'utf8')).covers.map((c, i) => ({ ...c, n: i + 1 })).filter((c) => !only || only.has(c.n));
if (save) mkdirSync(save, { recursive: true });
const creds = fetchOnly ? null : auth();
const rows = [];
for (const c of list) {
  const album = await findAlbum(c);
  let r = { verdict: 'error', reason: 'not on iTunes' };
  if (album.found) {
    try {
      const { bytes, uri } = await coverDataUri(album.art);
      if (save) writeFileSync(join(save, `${String(c.n).padStart(2, '0')}.jpg`), bytes);
      r = fetchOnly ? { verdict: '-', reason: `${bytes.length} bytes` } : await runModel(creds, model, uri);
    } catch (e) {
      r = { verdict: 'error', reason: String(e.message ?? e) };
    }
  }
  const want = c.expected.toLowerCase();
  const match = r.verdict === want ? 'ok' : r.verdict === 'unsure' ? 'unsure' : r.verdict === 'error' || r.verdict === '-' ? r.verdict : 'MISS';
  rows.push({ c, album, r, match });
  console.error(`${String(c.n).padStart(2)} ${c.artist} - ${c.album}: ${r.verdict} (${match})${r.ms ? ` ${r.ms} ms` : ''}`);
}

console.log('');
console.log(`Model: ${model}`);
const cell = (t, w) => String(t ?? '').replace(/\s+/g, ' ').slice(0, w).padEnd(w);
console.log([cell('#', 3), cell('cover (as iTunes serves it)', 52), cell('expected', 13), cell('verdict', 13), cell('match', 6), cell('reason', 60), 'tokens'].join(' '));
for (const { c, album, r, match } of rows) {
  const name = album.found ? `${album.artist} - ${album.collection}` : `${c.artist} - ${c.album} (not found)`;
  const tok = r.usage ? `${r.usage.prompt_tokens ?? '?'}+${r.usage.completion_tokens ?? '?'}` : '';
  console.log([cell(c.n, 3), cell(name, 52), cell(c.expected, 13), cell(r.verdict, 13), cell(match, 6), cell(r.reason, 60), tok].join(' '));
}
if (!fetchOnly) {
  const judged = rows.filter((x) => x.r.verdict !== 'error');
  const tp = judged.filter((x) => x.c.expected === 'INAPPROPRIATE' && x.r.verdict !== 'ok').length; // hidden (flagged or unsure)
  const fn = judged.filter((x) => x.c.expected === 'INAPPROPRIATE' && x.r.verdict === 'ok').length;
  const fp = judged.filter((x) => x.c.expected === 'OK' && x.r.verdict !== 'ok').length;
  const tn = judged.filter((x) => x.c.expected === 'OK' && x.r.verdict === 'ok').length;
  const inTok = judged.reduce((n, x) => n + (x.r.usage?.prompt_tokens ?? 0), 0);
  const outTok = judged.reduce((n, x) => n + (x.r.usage?.completion_tokens ?? 0), 0);
  console.log('');
  console.log(`hidden = INAPPROPRIATE or UNSURE (both hide the cover). ${judged.length} judged, ${rows.length - judged.length} errors.`);
  console.log(`  problem covers hidden (recall): ${tp}/${tp + fn}${tp + fn ? ` = ${Math.round((100 * tp) / (tp + fn))}%` : ''}`);
  console.log(`  hidden covers that were problems (precision): ${tp}/${tp + fp}${tp + fp ? ` = ${Math.round((100 * tp) / (tp + fp))}%` : ''}`);
  console.log(`  fine covers hidden by mistake: ${fp}/${fp + tn}`);
  console.log(`  misses: ${rows.filter((x) => x.match === 'MISS').map((x) => `${x.c.n} ${x.c.album} (${x.r.verdict})`).join(', ') || 'none'}`);
  console.log(`  tokens: ${inTok} in, ${outTok} out (${judged.length ? Math.round(inTok / judged.length) : 0} in per cover)`);
}
