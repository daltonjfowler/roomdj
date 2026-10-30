// The songbook (protocol.js SONGBOOK, CLAUDE.md invariant 40): the shelves' data, the cron's list and
// the search filters (shared/songbook.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { SHELF_MAX, SHELVES } from '../shared/protocol.js';
import { banKey, houseOk } from '../shared/filter.js';
import { cleanView, resultGenres, viewResults } from '../shared/songbook.js';
import { SONGBOOK_MADE, SONGBOOK_SONGS } from '../src/songbook-data.js';
import { isShelf, shelfSongs, songbookToCheck } from '../src/songbook.js';

const r = (id, over = {}) => ({ id: `it:${id}`, title: `Song ${id}`, artist: `Artist ${id}`, genre: 'Pop', year: 2020, check: 'unchecked', ...over });

test('songbook data: playable iTunes songs on known shelves, never explicit, ranked from 1', () => {
  assert.match(SONGBOOK_MADE, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(SONGBOOK_SONGS.length > 300, `a real list (${SONGBOOK_SONGS.length})`);
  const ranks = new Map();
  for (const s of SONGBOOK_SONGS) {
    assert.ok(isShelf(s.shelf), s.shelf);
    assert.match(s.id, /^it:\d+$/);
    assert.notEqual(s.explicit, 'explicit', `${s.title}: only a clean edit or a song with nothing to bleep`);
    assert.ok(s.title && s.artist && banKey(s), s.id);
    assert.match(s.previewUrl, /^https:\/\//);
    assert.equal(s.rank, (ranks.get(s.shelf) ?? 0) + 1, `${s.shelf} ranks in order`);
    ranks.set(s.shelf, s.rank);
  }
  for (const { id } of SHELVES) if (id !== 'popular') assert.ok(ranks.get(id) > 0, `${id} has songs`);
  const bling = SONGBOOK_SONGS.find((s) => houseOk(s) && /hotline/i.test(s.title));
  assert.ok(bling, 'Hotline Bling is on the hip-hop shelf');
});

test('shelfSongs: one shelf, rank order, at most SHELF_MAX, plain songs', () => {
  const songs = [
    { ...r(1), shelf: 'pop', rank: 2 }, { ...r(2), shelf: 'pop', rank: 1 }, { ...r(3), shelf: 'rock', rank: 1 },
    ...Array.from({ length: SHELF_MAX + 5 }, (_, i) => ({ ...r(100 + i), shelf: 'dance', rank: i + 1 })),
  ];
  assert.deepEqual(shelfSongs('pop', songs).map((s) => s.id), ['it:2', 'it:1']);
  assert.equal(shelfSongs('pop', songs)[0].shelf, undefined);
  assert.equal(shelfSongs('pop', songs)[0].rank, undefined);
  assert.equal(shelfSongs('dance', songs).length, SHELF_MAX);
  assert.deepEqual(shelfSongs('nope', songs), []);
  assert.equal(isShelf('pop'), true);
  assert.equal(isShelf('__proto__'), false);
});

test('songbookToCheck: one per song (any shelf, any version), hand-checked songs skipped', () => {
  const songs = [
    { ...r(1, { title: 'Sunflower', artist: 'Post Malone' }), shelf: 'pop', rank: 1 },
    { ...r(2, { title: 'Sunflower (Spider-Man: Into the Spider-Verse)', artist: 'Post Malone' }), shelf: 'movies', rank: 1 },
    { ...r(3, { title: 'Hotline Bling', artist: 'Drake' }), shelf: 'hiphop', rank: 1 },
    { ...r(4), shelf: 'rock', rank: 1 },
  ];
  assert.deepEqual(songbookToCheck(songs).map((s) => s.id), ['it:1', 'it:4']);
});

test('viewResults: ✓ Checked only, genre, sorts; popular keeps the server order', () => {
  const list = [
    r(1, { check: 'ready', year: 2015, title: 'beta' }),
    r(2, { genre: 'Rock', year: 0, title: 'Alpha' }),
    r(3, { check: 'ready', genre: 'Rock', year: 2024, title: 'charlie' }),
    r(4, { year: 1984, title: 'delta' }),
  ];
  const ids = (v) => viewResults(list, v).map((s) => s.id.slice(3)).join('');
  assert.equal(ids(), '1234');
  assert.equal(ids({ checked: true }), '13');
  assert.equal(ids({ genre: 'Rock' }), '23');
  assert.equal(ids({ genre: 'Jazz' }), '1234', 'a genre these results do not have is ignored');
  assert.equal(ids({ sort: 'newest' }), '3142', 'year not known: last');
  assert.equal(ids({ sort: 'oldest' }), '4132', 'year not known: last');
  assert.equal(ids({ sort: 'title' }), '2134', 'A to Z, any case');
  assert.equal(ids({ checked: true, genre: 'Rock', sort: 'newest' }), '3');
  assert.equal(list.map((s) => s.id).join(), 'it:1,it:2,it:3,it:4', 'the results themselves are not reordered');
});

test('resultGenres and cleanView', () => {
  assert.deepEqual(resultGenres([r(1, { genre: 'Rock' }), r(2), r(3, { genre: 'Rock' }), r(4, { genre: '' })]), ['Rock', 'Pop']);
  assert.deepEqual(cleanView({ checked: 'yes', sort: 'loudest', genre: 7 }), { checked: false, genre: '', sort: 'popular' });
  assert.deepEqual(cleanView(null), { checked: false, genre: '', sort: 'popular' });
  assert.deepEqual(cleanView({ checked: true, sort: 'newest', genre: 'Pop' }), { checked: true, genre: 'Pop', sort: 'newest' });
});
