// Socket-level checks from the 2026-10-09 review (no Chrome): raw host sockets against a LOCAL
// wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:hardening            (or: node test/browser/hardening.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. No Workers AI call (aiCheck off, art check
// off). Searches hit the real iTunes API (the Worker's own fetch: no host page answers lookups).
// Covers: ▶ Play now WITHOUT `from` is ignored (the Skip guard is not optional for it), and with
// the right `from` it plays.

import { readFileSync } from 'node:fs';
import { T1, closeOpenRooms } from './teacher-pick.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const ROOT = new URL('../../', import.meta.url);

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}

function teacherKey() {
  const vars = readFileSync(new URL('.dev.vars', ROOT), 'utf8');
  const line = vars.split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='));
  if (!line) throw new Error('TEACHER_KEY is not in .dev.vars');
  return line.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
}
const KEY = teacherKey();

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeout = 15_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

/** A raw socket that keeps every message it got. */
function socket(path) {
  const url = new URL(path, BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  const got = [];
  ws.addEventListener('message', (e) => { try { got.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return {
    ws, got, opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    state: () => got.findLast((m) => m.t === 'state')?.state ?? null,
    take: (pred) => until(() => got.find(pred)),
  };
}

const code = `hardening ${Math.floor(Math.random() * 1e6)}`;
await closeOpenRooms(BASE, KEY); // one room per teacher
const res = await api('/api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code, until: Date.now() + 60 * 60_000 }) });
if (!check('room opens', res.ok, `HTTP ${res.status}`)) process.exit(1);
const { room, hostToken } = await res.json();
const host = socket(`/api/rooms/${room}/ws?role=host&token=${encodeURIComponent(hostToken)}`);
await host.opened;
try {
  host.send({ t: 'settings', settings: { aiCheck: false, artCheck: false, cooldownDays: null, backToWork: false, oneSongPerArtist: false, noBackToBackArtist: false, maxSongMinutes: null } });
  await until(() => host.state()?.settings?.aiCheck === false);

  host.send({ t: 'search', q: 'beatles' });
  const found = await host.take((m) => m.t === 'searchResults');
  const songs = (found?.results ?? []).slice(0, 6);
  check('search has songs', songs.length >= 2, JSON.stringify(found)?.slice(0, 200));
  for (const s of songs) {
    host.send({ t: 'suggest', song: s.id });
    await host.take((m) => m.t === 'suggested' && m.song === s.id);
  }
  check('two songs waiting', (host.state()?.queue?.length ?? 0) >= 2, String(host.state()?.queue?.length));

  host.send({ t: 'next', from: null });
  const playing = (await until(() => host.state()?.nowPlaying))?.id;
  check('a song plays', Boolean(playing));

  const other = host.state().queue[0].id;
  host.send({ t: 'playNow', id: other }); // no `from`: a doubled or stale click must not skip
  await sleep(1500);
  check('Play now without from is ignored', host.state()?.nowPlaying?.id === playing, `now ${host.state()?.nowPlaying?.id}`);

  host.send({ t: 'playNow', id: other, from: playing });
  const after = await until(() => (host.state()?.nowPlaying?.id === other ? other : null));
  check('Play now with the right from plays it', after === other);
} finally {
  host.send({ t: 'close' });
  await sleep(500);
  host.ws.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
