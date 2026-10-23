// How many teachers use RoomDJ (Dalton, 2026-10-14: "how can I monitor the number of users/sign
// ups?"). Reads the LIVE site's KV through Cloudflare's API and prints a summary: the teachers on
// RoomDJ's own app (who signed in, who is linked), free teachers (own Spotify app) and new ones per
// day, sign-ins that are still active, today's free use, the chart pre-check and the checked songs.
// Read-only: it never writes anything. Nothing personal is printed beyond the teacher names.
//   npm run stats
// Auth: CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) if set, else Wrangler's own login.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
const NS = readFileSync(new URL('wrangler.jsonc', ROOT), 'utf8').match(/"binding":\s*"CLASS_KV",\s*"id":\s*"([0-9a-f]{32})"/)[1];

function wrangler(...cmd) {
  const r = spawnSync(process.execPath, [WRANGLER, ...cmd], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler ${cmd.join(' ')} failed (log in with: npx wrangler login)`);
  return r.stdout;
}
function auth() {
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) token = JSON.parse(wrangler('auth', 'token', '--json')).token;
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const ids = [...wrangler('whoami').matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1]);
    if (new Set(ids).size !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID');
    account = ids[0];
  }
  return { token, account };
}
const { token, account } = auth();
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${NS}`;
const headers = { authorization: `Bearer ${token}` };

async function keys(prefix) {
  const out = [];
  let cursor = '';
  do {
    const r = await fetch(`${base}/keys?limit=1000&prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${cursor}` : ''}`, { headers });
    const j = await r.json();
    if (!j.success) throw new Error(`KV list failed: ${JSON.stringify(j.errors)}`);
    out.push(...j.result.map((k) => k.name));
    cursor = j.result_info?.cursor ?? '';
  } while (cursor);
  return out;
}
async function values(names, type = 'json') {
  const out = {};
  for (let i = 0; i < names.length; i += 100) {
    const r = await fetch(`${base}/bulk/get`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ keys: names.slice(i, i + 100), type }) });
    const j = await r.json();
    if (!j.success) throw new Error(`KV bulk get failed: ${JSON.stringify(j.errors)}`);
    Object.assign(out, j.result.values);
  }
  return out;
}
async function value(name) {
  const r = await fetch(`${base}/values/${encodeURIComponent(name)}`, { headers });
  return r.ok ? r.json().catch(() => null) : null;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = day(Date.now());

const [list, linkKeys, ownKeys, sessKeys, useKeys, verdictKeys, olderVerdictKeys, prewarm] = await Promise.all([
  value('profiles'), keys('link:v1:'), keys('prof:v1:'), keys('sess:v1:'), keys(`use:v1:`), keys('verdict:v6:'), keys('verdict:v5:'), value(`prewarm:v1:state:${today}`),
]);
const links = new Set(Object.values(await values(linkKeys, 'text'))); // a link's value is a profile id
const own = Object.values(await values(ownKeys)).filter(Boolean);
const todayUse = Object.values(await values(useKeys.filter((k) => k.endsWith(`:${today}`)))).filter(Boolean);

console.log(`RoomDJ, ${new Date().toLocaleString()}\n`);
const teachers = Array.isArray(list) ? list : [];
console.log(`RoomDJ's app (your list): ${teachers.filter((p) => !p.archived).length} teachers, ${teachers.filter((p) => p.claimed).length} signed in`);
for (const p of teachers) {
  const how = p.archived ? 'hidden' : p.claimed ? 'signed in' : links.has(p.id) ? 'linked, not signed in yet' : 'not linked';
  console.log(`  ${p.name.padEnd(24)} ${how}`);
}

console.log(`\nFree teachers (their own Spotify app): ${own.length}`);
const byDay = {};
for (const p of own) byDay[day(p.createdAt || 0)] = (byDay[day(p.createdAt || 0)] ?? 0) + 1;
const days = Array.from({ length: 14 }, (_, i) => day(Date.now() - i * 86_400_000));
console.log(`  new, last 14 days: ${days.map((d) => `${d.slice(5)} ${byDay[d] ?? 0}`).join(' | ')}`);
const week = days.slice(0, 7).reduce((n, d) => n + (byDay[d] ?? 0), 0);
console.log(`  new this week: ${week}`);

console.log(`\nSign-ins still active (30 days, any app): ${sessKeys.length}`);
const sum = (k) => todayUse.reduce((n, u) => n + (u[k] ?? 0), 0);
console.log(`Free teachers active today: ${todayUse.length} (rooms ${sum('rooms')}, new-song checks ${sum('ai')}, cover checks ${sum('art')})`);
console.log(`Chart pre-check today: ${prewarm ? `${prewarm.used} AI checks, at song ${prewarm.cursor}` : 'not run yet today'}`);
// A verdict is kept per catalog id (a number, or sp:…) AND once per song (title + artist): count those.
// A song checked under v5 and again under v6 counts once.
const songs = new Set([...verdictKeys, ...olderVerdictKeys].map((k) => k.replace(/^verdict:v\d+:/, '')).filter((k) => !/^(\d+|sp:.*)$/.test(k))).size;
console.log(`Checked songs shared by everyone: ${songs} (none of these cost anything again)`);
