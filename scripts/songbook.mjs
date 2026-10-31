// npm run songbook: finds every seed song (scripts/songbook-seeds.mjs) on iTunes and writes
// src/songbook-data.js, the songs a class can browse by shelf (CLAUDE.md invariant 40). Picks the
// version a class may play: same base title and artist, never the explicit one (a clean edit or a
// song with nothing to bleep), no live / remix / karaoke / sped-up versions. Songs with no clean
// version are left out and listed. iTunes answers about 20 searches a minute, so this is slow;
// answers are kept in node_modules/.cache/songbook.json, so a second run only asks for new seeds.
//   node scripts/songbook.mjs [--fresh]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseTitle, banKey, mainArtist, normalizeWords } from '../shared/filter.js';
import { itunesSearchUrl, parseItunes, toSong } from '../shared/itunes.js';
import { ARTISTS, DEPTH, MAX, MAX_DEFAULT } from './songbook-artists.mjs';
import { SEEDS, SHELF_ORDER } from './songbook-seeds.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src', 'songbook-data.js');
const CACHE = join(root, 'node_modules', '.cache', 'songbook.json');
const GAP_MS = 3200;
const VERSION_WORDS = /\b(live|remix|sped up|slowed|nightcore|karaoke|acoustic|instrumental|cover|tribute|8 bit|lullaby|piano version|demo|reprise|medley)\b/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cache = process.argv.includes('--fresh') ? {} : JSON.parse(await readFile(CACHE, 'utf8').catch(() => '{}'));

async function search(term, url = itunesSearchUrl(term)) {
  if (cache[term]) return cache[term];
  for (let tries = 0; tries < 4; tries++) {
    await sleep(GAP_MS);
    const r = await fetch(url).catch(() => null);
    // iTunes says 400/404 for some terms (an artist name like "SNAP!"): nothing there, not a busy server.
    if (r?.status === 400 || r?.status === 404) return (cache[term] = []);
    if (r?.ok) {
      const results = parseItunes(await r.text()) ?? [];
      cache[term] = results;
      return results;
    }
    console.log(`  iTunes ${r?.status ?? 'down'} for "${term}", waiting a minute`);
    await sleep(60_000);
  }
  throw new Error(`iTunes keeps refusing "${term}"`);
}

/** Version words in the result that the seed title does not have. */
const extraVersion = (title, album, seedTitle) => {
  const seed = normalizeWords(seedTitle);
  return [normalizeWords(title), normalizeWords(album)].some((t) => {
    const m = t.match(VERSION_WORDS);
    return m && !seed.includes(m[0]);
  });
};

function pick(results, [title, artist], shelf) {
  const want = baseTitle(title) || normalizeWords(title);
  const who = normalizeWords(artist);
  const songs = results.map(toSong).filter(Boolean).filter((s) => (baseTitle(s.title) || normalizeWords(s.title)) === want);
  const byArtist = songs.filter((s) => mainArtist(s.artist) === mainArtist(artist) || ` ${normalizeWords(s.artist)} `.includes(` ${who} `));
  // Classical and film scores are filed under the performer as often as the composer.
  const pool = byArtist.length || (shelf !== 'focus' && shelf !== 'classical') ? byArtist : songs;
  const playable = pool.filter((s) => s.explicit !== 'explicit' && !/kidz bop/i.test(s.artist) && !extraVersion(s.title, s.album, title));
  return {
    song: playable.find((s) => s.explicit === 'notExplicit') ?? playable.find((s) => s.explicit === 'cleaned') ?? null,
    onlyExplicit: !playable.length && pool.some((s) => s.explicit === 'explicit'),
  };
}

const HOLIDAY = /\b(christmas|xmas|santa|jingle|navidad|holiday|hanukkah|new year)\b/;

/**
 * An artist's most popular songs on iTunes (scripts/songbook-artists.mjs): its own (not a feature),
 * never explicit (not even a clean edit), no live / remix / acoustic versions, no holiday songs, 1 to
 * 7 minutes, one per title, at most `k`.
 */
async function artistTop(artist, k) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=song&attribute=artistTerm&limit=60&country=US`;
  const who = mainArtist(artist);
  const out = [];
  const titles = new Set();
  for (const s of (await search(`artist:${artist}`, url)).map(toSong).filter(Boolean)) {
    if (mainArtist(s.artist) !== who || s.explicit !== 'notExplicit' || /kidz bop/i.test(s.artist)) continue;
    if (extraVersion(s.title, s.album, '') || HOLIDAY.test(normalizeWords(`${s.title} ${s.album}`)) || /holiday/i.test(s.genre ?? '')) continue;
    if (!(s.durationMs >= 60_000 && s.durationMs <= 7 * 60_000)) continue;
    const title = baseTitle(s.title) || normalizeWords(s.title);
    if (titles.has(title)) continue;
    titles.add(title);
    out.push(s);
    if (out.length >= k) break;
  }
  return out;
}

const songs = [];
const missing = [];
const seen = new Set();
for (const shelf of SHELF_ORDER) {
  let rank = 0;
  for (const seed of SEEDS[shelf]) {
    let found = pick(await search(`${seed[0]} ${seed[1]}`), seed, shelf);
    // Clean edits are often their own single: ask once more for one.
    if (!found.song && found.onlyExplicit) found = pick(await search(`${seed[0]} ${seed[1]} clean`), seed, shelf);
    if (!found.song) {
      missing.push(`${shelf}: ${seed[0]} - ${seed[1]}${found.onlyExplicit ? ' (explicit only)' : ''}`);
      continue;
    }
    const key = `${shelf}|${banKey(found.song)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    songs.push({ ...found.song, shelf, rank: ++rank, ...(seed[2] === 'song' ? { songOnly: true } : {}) });
  }
  // Then each list artist's most popular songs, every artist's #1 first, up to the list's MAX.
  const seeded = rank;
  if (DEPTH[shelf]) {
    const max = MAX[shelf] ?? MAX_DEFAULT;
    const names = [...SEEDS[shelf].filter((s) => s[2] !== 'song').map((s) => s[1]), ...(ARTISTS[shelf] ?? [])];
    const artists = [...new Map(names.map((a) => [mainArtist(a), a])).values()].filter((a) => mainArtist(a));
    const tops = [];
    for (const artist of artists) tops.push(await artistTop(artist, DEPTH[shelf]));
    for (let i = 0; i < DEPTH[shelf]; i++) {
      for (const top of tops) {
        const song = top[i];
        if (!song || rank >= max) continue;
        const key = `${shelf}|${banKey(song)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        songs.push({ ...song, shelf, rank: ++rank });
      }
    }
    await writeFile(CACHE, JSON.stringify(cache));
  }
  console.log(`${shelf}: ${seeded} of ${SEEDS[shelf].length} seeds${rank > seeded ? `, +${rank - seeded} artists' top songs` : ''}`);
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache));
}

// To the minute: the cron starts a new pass whenever this changes (two builds in a day are two lists).
const made = new Date().toISOString().slice(0, 16);
await writeFile(OUT, `// Made by \`npm run songbook\` (scripts/songbook.mjs) from scripts/songbook-seeds.mjs. Do not edit by hand.
export const SONGBOOK_MADE = '${made}';
export const SONGBOOK_SONGS = [
${songs.map((s) => JSON.stringify(s)).join(',\n')},
];
`);
console.log(`\n${songs.length} songs written to src/songbook-data.js`);
if (missing.length) console.log(`Not found (${missing.length}):\n  ${missing.join('\n  ')}`);
