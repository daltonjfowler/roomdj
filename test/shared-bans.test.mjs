// ⛔ Other teachers' bans (src/shared-bans.js): counts per song, other teachers only, Ban for me.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BANCOUNT_PREFIX, banForMe, recordBan, sharedBans } from '../src/shared-bans.js';

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(k, type) { const v = map.get(k)?.value; return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, value, opts = {}) { map.set(k, { value, metadata: opts.metadata }); },
    async delete(k) { map.delete(k); },
    async list({ prefix }) { return { keys: [...map].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true }; },
  };
}
const song = { id: 'it:9', title: 'Bad Song (feat. X)', artist: 'Loud Guy' };
const t = (id) => ({ id, name: id });

test('a song shows once 2 OTHER teachers banned it; a teacher counts once; never who', async () => {
  const env = { CLASS_KV: fakeKv() };
  await recordBan(env, song, t('a'));
  await recordBan(env, song, t('a')); // the same teacher again
  assert.deepEqual(await sharedBans(env, t('c')), [], 'one teacher is not enough');
  await recordBan(env, { ...song, id: 'it:10', title: 'Bad Song' }, t('b')); // another version counts for the song
  const list = await sharedBans(env, t('c'));
  assert.equal(list.length, 1);
  assert.equal(list[0].others, 2);
  assert.equal(list[0].mine, false);
  const raw = [...env.CLASS_KV.map.values()][0].value;
  assert.ok(!raw.includes('"a"') && !raw.includes('"b"'), 'teachers are hashes, never ids');
  // a real ban writes the teacher's own list too (Room.addBan): then a's own ban is not "another teacher"
  await env.CLASS_KV.put('p:a:banned', JSON.stringify([{ id: song.id, title: song.title, artist: song.artist }]));
  assert.deepEqual(await sharedBans(env, t('a')), [], 'for teacher a only 1 OTHER teacher banned it');
});

test('Ban for me copies it into my own ban list and counts me; the legacy teacher is one teacher', async () => {
  const env = { CLASS_KV: fakeKv() };
  await recordBan(env, song, t('a'));
  await recordBan(env, song, null); // a room from before profiles = the legacy teacher
  await recordBan(env, song, { id: 'john', legacy: true }); // the same legacy teacher
  const [hit] = await sharedBans(env, t('me'));
  assert.equal(hit.others, 2);
  assert.equal(await banForMe(env, t('me'), hit.key), true);
  const mine = JSON.parse(env.CLASS_KV.map.get('p:me:banned').value);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].reason, 'shared');
  const [after] = await sharedBans(env, t('me'));
  assert.equal(after.mine, true);
  assert.equal(after.others, 2, 'my own ban is not counted as another teacher');
  assert.equal(await banForMe(env, t('me'), 'song:nope|none'), false);
  assert.equal(await banForMe(env, t('me'), `${BANCOUNT_PREFIX}x`), false, 'only song keys');
});
