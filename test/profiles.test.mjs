// Teacher profiles (Dalton, 2026-10-07; protocol.js TEACHER PROFILES): KV keys per profile (the
// legacy profile keeps the plain keys), the profile list (names, add, rename, hide), the first-use
// migration (twice = nothing extra), and what each profile's room reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILES_MAX, PROFILE_NAME_MAX, SEED_PROFILES } from '../shared/protocol.js';
import {
  addProfile, changeProfile, cleanProfileName, findProfile, migrateProfiles, newProfileId, readProfiles, roomProfile,
} from '../shared/profiles.js';
import { teacherKvKey, teacherScope } from '../src/teacher-kv.js';
import { ensureProfiles, handleProfiles, readProfileList, requestProfile } from '../src/profiles.js';
import { readBanned } from '../src/search.js';
import { aiThemeCheck, approveSong, approvedKey, filterSong } from '../shared/filter.js';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import { newRoomState, snapshotFor } from '../shared/queue.js';

function fakeKv(init = {}) {
  const map = new Map(Object.entries(init));
  const puts = [];
  return {
    map,
    puts,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { puts.push(k); map.set(k, v); },
  };
}

const T1 = { id: 'teacher-1', name: 'Teacher 1', legacy: true };
const T2 = { id: 'teacher-2', name: 'Teacher 2', legacy: false };

test('teacherKvKey: null and the legacy profile use the plain key; others p:<id>:<name>', () => {
  assert.equal(teacherKvKey('settings'), 'settings');
  assert.equal(teacherKvKey('settings', null), 'settings', 'a room from before profiles');
  assert.equal(teacherKvKey('banned', T1), 'banned', 'legacy: nothing copied or rewritten');
  assert.equal(teacherKvKey('favorites', T2), 'p:teacher-2:favorites');
  assert.equal(teacherKvKey('favorites', 'teacher-2'), 'p:teacher-2:favorites');
  assert.equal(teacherScope(T1)(approvedKey('it:42')), 'approved:42');
  assert.equal(teacherScope(T2)(approvedKey('song:happy|pharrell')), 'p:teacher-2:approved:song:happy|pharrell');
  assert.throws(() => teacherKvKey('x', { id: 'Bad Id' }));
  assert.throws(() => teacherKvKey('x', 'a:b'));
});

test('profile names: one line, up to 32 letters, a letter needed, word-screened like notes', () => {
  assert.deepEqual(cleanProfileName('  Teacher   1 '), { ok: true, name: 'Teacher 1' });
  assert.equal(cleanProfileName('Ms Example').ok, true, 'titles are fine for teachers');
  assert.equal(cleanProfileName('Ms O\'Neil-Smith').ok, true);
  assert.equal(cleanProfileName('José Núñez').ok, true);
  assert.equal(cleanProfileName('').ok, false);
  assert.equal(cleanProfileName('   ').ok, false);
  assert.equal(cleanProfileName('1234').ok, false);
  assert.equal(cleanProfileName('x'.repeat(PROFILE_NAME_MAX)).ok, true);
  assert.equal(cleanProfileName('x'.repeat(PROFILE_NAME_MAX + 1)).ok, false);
  assert.equal(cleanProfileName('line\none').name, 'line one');
  assert.equal(cleanProfileName('Big Shit').ok, false, 'students may see the name');
  assert.equal(cleanProfileName(null).ok, false);
});

test('migration: Teacher 1 (legacy) + Teacher 2; running it again creates nothing', async () => {
  const first = migrateProfiles(null, 5);
  assert.equal(first.created, true);
  assert.deepEqual(first.list.map((p) => [p.id, p.name, p.legacy === true]), [['teacher-1', 'Teacher 1', true], ['teacher-2', 'Teacher 2', false]]);
  const again = migrateProfiles(first.list, 9);
  assert.equal(again.created, false);
  assert.deepEqual(again.list, first.list);

  const kv = fakeKv();
  const env = { CLASS_KV: kv };
  assert.deepEqual(await readProfileList(env), [], 'browsing never writes the list');
  const a = await ensureProfiles(env);
  const b = await ensureProfiles(env);
  assert.deepEqual(a, b);
  assert.equal(kv.puts.filter((k) => k === 'profiles').length, 1, 'written once');
  assert.equal(a.length, 2);
  // Two first runs at once write the same list (fixed seed ids).
  const kv2 = fakeKv();
  const [x, y] = await Promise.all([ensureProfiles({ CLASS_KV: kv2 }), ensureProfiles({ CLASS_KV: kv2 })]);
  assert.deepEqual(x.map((p) => p.id), y.map((p) => p.id));
  assert.deepEqual(x.map((p) => p.id), SEED_PROFILES.map((p) => p.id));
  // Nothing else in KV was touched: the old plain keys stay Teacher 1's.
  assert.deepEqual([...kv.map.keys()], ['profiles']);
});

test('the stored list is checked: bad entries, repeated ids and a second legacy dropped', () => {
  const list = readProfiles([
    { id: 'teacher-1', name: 'Teacher 1', legacy: true, createdAt: 1 },
    { id: 'teacher-1', name: 'Again' },
    { id: 'BAD', name: 'x' },
    { id: 'abc', name: '' },
    { id: 'other', name: 'Other', legacy: true, archived: true, createdAt: 2 },
    'nope',
  ]);
  assert.deepEqual(list, [
    { id: 'teacher-1', name: 'Teacher 1', createdAt: 1, legacy: true },
    { id: 'other', name: 'Other', createdAt: 2, archived: true },
  ]);
  assert.deepEqual(readProfiles('x'), []);
});

test('add, rename, hide and show: duplicates refused, at most 20, the last visible teacher stays', () => {
  let list = migrateProfiles(null, 1).list;
  const add = addProfile(list, 'Pat Lee', { now: 2, id: 'abcd1234' });
  assert.equal(add.ok, true);
  list = add.list;
  assert.deepEqual(add.profile, { id: 'abcd1234', name: 'Pat Lee', createdAt: 2 });
  assert.equal(addProfile(list, 'pat   LEE').error, 'name_taken');
  assert.equal(addProfile(list, '').error, 'name');
  const ren = changeProfile(list, 'abcd1234', { name: 'Pat Lee-Smith' });
  assert.equal(ren.ok, true);
  assert.equal(ren.profile.id, 'abcd1234', 'renaming keeps the id (and all the data)');
  assert.equal(changeProfile(list, 'abcd1234', { name: 'teacher 1' }).error, 'name_taken');
  assert.equal(changeProfile(list, 'nope', { name: 'X' }).error, 'no_profile');
  const hid = changeProfile(ren.list, 'abcd1234', { archived: true });
  assert.equal(hid.profile.archived, true);
  assert.equal(findProfile(hid.list, 'abcd1234').name, 'Pat Lee-Smith', 'hidden, never deleted');
  assert.equal(findProfile(hid.list, 'abcd1234', { active: true }), null);
  const shown = changeProfile(hid.list, 'abcd1234', { archived: false });
  assert.equal(shown.profile.archived, undefined);
  let two = changeProfile(list, 'teacher-1', { archived: true }).list;
  two = changeProfile(two, 'abcd1234', { archived: true }).list;
  assert.equal(changeProfile(two, 'teacher-2', { archived: true }).error, 'last');
  let full = list;
  for (let i = 0; full.length < PROFILES_MAX; i++) full = addProfile(full, `Teacher ${'abcdefghijklmnopqrstuvwxyz'[i]}`).list;
  assert.equal(addProfile(full, 'One More').error, 'full');
  assert.match(newProfileId(list), /^[a-z0-9]{8}$/);
  assert.deepEqual(roomProfile(list[0]), { id: 'teacher-1', name: 'Teacher 1', legacy: true });
});

test('endpoints: list (migrates), add, rename, hide; a request names an active profile', async () => {
  const kv = fakeKv();
  const env = { CLASS_KV: kv };
  const call = async (method, path, body, headers = {}) => {
    const url = new URL(`https://roomdj.com${path}`);
    const r = await handleProfiles(new Request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), env, url);
    return { status: r.status, body: await r.json() };
  };
  const list = await call('GET', '/api/teacher/profiles');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.profiles.map((p) => p.name), ['Teacher 1', 'Teacher 2']);
  const add = await call('POST', '/api/teacher/profiles', { name: 'Sam Ortiz' });
  assert.equal(add.status, 201);
  const id = add.body.profile.id;
  assert.equal((await call('POST', '/api/teacher/profiles', { name: 'sam ortiz' })).status, 409);
  assert.equal((await call('POST', '/api/teacher/profiles', { name: '' })).body.error, 'name');
  assert.equal((await call('PATCH', `/api/teacher/profiles/${id}`, { name: 'Sam Ortiz-Lee' })).body.profile.name, 'Sam Ortiz-Lee');
  assert.equal((await call('PATCH', `/api/teacher/profiles/${id}`, { archived: true })).body.profile.archived, true);
  assert.equal((await call('PATCH', '/api/teacher/profiles/nope', { name: 'X' })).status, 404);
  assert.equal((await call('DELETE', `/api/teacher/profiles/${id}`)).status, 405, 'never deleted');
  const req = (h) => new Request('https://roomdj.com/api/teacher/settings', { headers: h });
  assert.equal((await requestProfile(req({ 'x-teacher-profile': 'teacher-2' }), env)).name, 'Teacher 2');
  assert.equal((await requestProfile(req({}), env, 'teacher-1')).legacy, true, 'or in the body');
  assert.equal((await requestProfile(req({}), env)).status, 400, 'missing');
  assert.equal((await requestProfile(req({ 'x-teacher-profile': 'nobody' }), env)).status, 400, 'unknown');
  assert.equal((await requestProfile(req({ 'x-teacher-profile': id }), env)).status, 400, 'hidden');
});

test('bans, approvals and favorites keys are per profile; legacy reads the old plain data', async () => {
  const song = { id: 'it:42', title: 'Happy', artist: 'Pharrell Williams', album: 'G I R L', explicit: 'notExplicit' };
  const kv = fakeKv({ banned: JSON.stringify([{ id: 'it:7', title: 'Old Ban', artist: 'A' }]) });
  const env = { CLASS_KV: kv, AI: { run: async () => ({ response: '{"verdict":"UNKNOWN"}' }) } };
  assert.equal((await readBanned(env, T1)).has('it:7'), true, 'Teacher 1 sees the bans from before');
  assert.equal((await readBanned(env, null)).has('it:7'), true);
  assert.equal((await readBanned(env, T2)).has('it:7'), false, 'Teacher 2 starts fresh');
  await approveSong(song, env, teacherScope(T2));
  assert.ok(kv.map.has('p:teacher-2:approved:42'));
  assert.ok(kv.map.has('p:teacher-2:approved:song:happy|pharrell williams'));
  assert.equal(kv.map.has('approved:42'), false);
  assert.equal((await aiThemeCheck(song, env, { scope: teacherScope(T2) })).source, 'teacher');
  assert.notEqual((await aiThemeCheck(song, env, { scope: teacherScope(T1) })).source, 'teacher', 'Teacher 1 did not approve it');
  const t1 = await filterSong(song, { settings: DEFAULT_SETTINGS, env, scope: teacherScope(T1) });
  assert.equal(t1.reason, 'review');
  assert.equal((await filterSong(song, { settings: DEFAULT_SETTINGS, env, scope: teacherScope(T2) })).ok, true);
});

// Dalton 2026-10-10 "do my approves last?": live KV held p:dalton-fowler:approved:1406109863 and
// :song:god s plan|drake beside a shared cached verdict "inappropriate / sexual". A later room of the
// same profile (the room keeps { id, name, legacy }) must pass it for that version and any other
// version (another trackId, a "(feat. ...)" title), with no AI and no lyrics call.
test('a teacher approval lasts across rooms and versions over a cached AI "no"', async () => {
  const dalton = { id: 'dalton-fowler', name: 'Dalton Fowler', legacy: false };
  const godsPlan = { id: 'it:1406109863', title: "God's Plan", artist: 'Drake', album: 'Scorpion', explicit: 'cleaned' };
  const no = JSON.stringify({ verdict: 'inappropriate', category: 'sexual', evidence: 'Mature themes and language', instrumental: false });
  const kv = fakeKv({ 'verdict:v5:1406109863': no, 'verdict:v5:song:god s plan|drake': no });
  const env = { CLASS_KV: kv, AI: { run: async () => { throw new Error('no AI call for an approved song'); } } };
  const lyrics = async () => { throw new Error('no lyrics call for an approved song'); };
  const settings = { ...DEFAULT_SETTINGS, aiCheck: true, blockUnknownSongs: true };
  const before = await filterSong(godsPlan, { settings, env, scope: teacherScope(dalton), lyrics });
  assert.equal(before.reason, 'theme', 'blocked before the teacher says yes');
  await approveSong(godsPlan, env, teacherScope(roomProfile(dalton)));
  assert.equal(kv.map.get('p:dalton-fowler:approved:1406109863'), kv.map.get('p:dalton-fowler:approved:song:god s plan|drake'));
  const other = { ...godsPlan, id: 'it:999', title: "God's Plan (feat. Someone) - Radio Edit", artist: 'Drake & Someone' };
  for (const s of [godsPlan, other]) {
    const r = await filterSong(s, { settings, env, scope: teacherScope(roomProfile(dalton)), lyrics });
    assert.deepEqual([r.ok, r.ai.source], [true, 'teacher'], s.id);
  }
  assert.equal((await filterSong(godsPlan, { settings, banned: ['song:god s plan|drake'], env, scope: teacherScope(dalton) })).reason, 'banned', 'a ban still wins');
  assert.equal((await filterSong(godsPlan, { settings, env, scope: teacherScope(null) })).reason, 'theme', 'the legacy profile did not approve it');
});

test('the room snapshot names its teacher (everyone) and its profile id (host only)', () => {
  const room = newRoomState('0123456789abcdef0123456789abcdef');
  assert.equal(snapshotFor(room, null).teacher, null, 'a room from before profiles');
  room.profile = { id: 'teacher-2', name: 'Teacher 2', legacy: false };
  const student = snapshotFor(room, 'd'.repeat(16));
  assert.equal(student.teacher, 'Teacher 2');
  assert.equal(student.profile, undefined);
  assert.equal(snapshotFor(room, null).profile, 'teacher-2');
});

test('an existing list (a live install with its own ids) is never reseeded; legacy is the flag, not the id', async () => {
  // Like the live site: the list was seeded long ago with other ids and names. A teacher whose id
  // happens to be a seed id but is NOT legacy must get prefixed keys: nothing depends on seed ids.
  const live = [
    { id: 'old-legacy-id', name: 'Ms Rivera', legacy: true, createdAt: 1 },
    { id: 'teacher-1', name: 'Mr Okafor', createdAt: 1 },
  ];
  const kv = fakeKv({ profiles: JSON.stringify(live), settings: JSON.stringify({ ...DEFAULT_SETTINGS, maxWaitingPerStudent: 4 }), banned: '[]' });
  const env = { CLASS_KV: kv };
  const list = await ensureProfiles(env);
  assert.deepEqual(list.map((p) => [p.id, p.name, p.legacy === true]), [['old-legacy-id', 'Ms Rivera', true], ['teacher-1', 'Mr Okafor', false]]);
  assert.deepEqual(kv.puts, [], 'nothing written: no reseed, no rewrite');
  assert.equal(JSON.parse(kv.map.get('profiles')).length, 2);
  assert.ok(!list.some((p) => SEED_PROFILES.some((s) => s.name === p.name)), 'the seed names never appear');
  const req = (h) => new Request('https://roomdj.com/api/teacher/settings', { headers: h });
  const legacy = await requestProfile(req({ 'x-teacher-profile': 'old-legacy-id' }), env);
  assert.equal(legacy.legacy, true);
  assert.equal(teacherKvKey('settings', legacy), 'settings', 'legacy keeps the plain keys');
  assert.equal(teacherKvKey('favorites', legacy), 'favorites');
  assert.equal(teacherScope(legacy)(approvedKey('it:42')), 'approved:42');
  const other = await requestProfile(req({ 'x-teacher-profile': 'teacher-1' }), env);
  assert.equal(teacherKvKey('settings', other), 'p:teacher-1:settings', 'a seed id without the flag is an ordinary profile');
  assert.equal((await requestProfile(req({ 'x-teacher-profile': 'teacher-2' }), env)).status, 400, 'no seed profile was added');
  assert.deepEqual(roomProfile(list[0]), { id: 'old-legacy-id', name: 'Ms Rivera', legacy: true });
  assert.deepEqual(kv.puts, [], 'still nothing written');
});
