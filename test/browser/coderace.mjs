// Class code race (src/codelock.js CodeLock): two teachers open rooms with the SAME class code at
// the same moment. Exactly one may get it; the other gets 409 code_taken. Then the code changes and
// closing hand the lock on correctly. LOCAL wrangler dev only:
//   npm run dev, then:  npm run test:coderace   (or: node test/browser/coderace.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Uses the seed teachers T1 and T2 (one room each).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codeHash } from '../../src/codes.js';
import { T1, T2, closeOpenRooms } from './teacher-pick.mjs';

const ROOT = new URL('../../', import.meta.url);
const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}
function teacherKey() {
  const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='));
  if (!line) throw new Error('TEACHER_KEY is not in .dev.vars');
  return line.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
}
const KEY = teacherKey();
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`);
};
const api = (path, profile, body) => fetch(new URL(path, BASE), {
  method: 'POST',
  headers: { 'x-teacher-key': KEY, 'x-teacher-profile': profile, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const open = (profile, code) => api('/api/teacher/rooms', profile, { code, until: Date.now() + 30 * 60_000 })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const closeAll = () => Promise.all([closeOpenRooms(BASE, KEY, T1), closeOpenRooms(BASE, KEY, T2)]);

try {
  for (let round = 1; round <= 5; round++) {
    await closeAll();
    const code = `race test ${Date.now()} ${round}`;
    const [a, b] = await Promise.all([open(T1, code), open(T2, code)]);
    const won = [a, b].filter((r) => r.status === 200);
    const lost = [a, b].filter((r) => r.status === 409 && r.error === 'code_taken');
    check(`round ${round}: exactly one room gets the code at once`, won.length === 1 && lost.length === 1, `${a.status} ${a.error ?? ''} / ${b.status} ${b.error ?? ''}`);
  }
  // KV lag (the real-world race): KV can be up to a minute behind in another data centre, so the
  // second teacher's check may not see the first room's code route. Simulate it by deleting the
  // route from local KV: only the CodeLock can still say no.
  await closeAll();
  const lagCode = `race lag ${Date.now()}`;
  check('T1 opens a room (lag test)', (await open(T1, lagCode)).status === 200);
  const del = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT)), 'kv', 'key', 'delete', '--local', '--binding', 'CLASS_KV', `room:${await codeHash(lagCode)}`],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  check('the KV code route is gone (as if not seen yet)', del.status === 0, del.stderr.slice(0, 200));
  const lagged = await open(T2, lagCode);
  check('T2 still cannot take the code: the lock says no', lagged.status === 409 && lagged.error === 'code_taken', `${lagged.status} ${lagged.error ?? ''}`);

  // Closing hands the code on: the other teacher can take it right after.
  await closeAll();
  const code = `race handoff ${Date.now()}`;
  const first = await open(T1, code);
  check('T1 opens a room with the code', first.status === 200, String(first.status));
  check('T2 cannot take it while T1 is open', (await open(T2, code)).status === 409);
  await closeOpenRooms(BASE, KEY, T1);
  const second = await open(T2, code);
  check('after T1 closes, T2 gets it', second.status === 200, `${second.status} ${second.error ?? ''}`);
} catch (e) {
  failures++;
  console.log(`FAIL the flow stopped: ${e.stack ?? e}`);
} finally {
  await closeAll();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
