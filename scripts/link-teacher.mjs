// Link a teacher on the list to the Spotify account that may sign in as them (protocol.js SPOTIFY
// SIGN-IN, CLAUDE.md invariant 27). Only RoomDJ's own Spotify app uses links: nobody picks a
// teacher, the Spotify account's email decides. Use the email that is on the Spotify app's User
// Management list (the one that account logs in to Spotify with). KV keeps only a hash of it.
//   node scripts/link-teacher.mjs <email> <profile id>            (the live site)
//   node scripts/link-teacher.mjs <email> <profile id> --local    (wrangler dev's local KV)
//   node scripts/link-teacher.mjs --list                          (the teacher list: ids and names)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const args = process.argv.slice(2);
const where = args.includes('--local') ? '--local' : '--remote';
const [email, profileId] = args.filter((a) => !a.startsWith('--'));

function wrangler(...a) {
  const r = spawnSync(process.execPath, [WRANGLER, 'kv', 'key', ...a, '--binding', 'CLASS_KV', where], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout;
}

const list = JSON.parse(wrangler('get', 'profiles').trim() || '[]');
if (args.includes('--list') || !email) {
  for (const p of list) console.log(`${p.id.padEnd(16)} ${p.name}${p.archived ? ' (hidden)' : ''}${p.claimed ? ' (signed in already)' : ''}`);
  if (!email) console.log('\nUsage: node scripts/link-teacher.mjs <email> <profile id> [--local]');
  process.exit(0);
}
const p = list.find((x) => x.id === profileId);
if (!p) {
  console.error(`No teacher "${profileId}" on the list. node scripts/link-teacher.mjs --list`);
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
  console.error('That does not look like an email address.');
  process.exit(1);
}
const hash = createHash('sha256').update(`email:${email.trim().toLowerCase()}`).digest('hex');
wrangler('put', `link:v1:${hash}`, p.id);
console.log(`Linked: that Spotify account signs in as ${p.name} (${p.id}). ${where === '--local' ? 'Local KV.' : 'Live site.'}`);
