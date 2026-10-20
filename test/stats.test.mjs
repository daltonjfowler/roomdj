// The recap's fun stats (shared/stats.js) on made-up periods, and the release year (shared/itunes.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decadeCounts, genreCounts, minutesSeconds, pickStats, statPool, versusStat, vibeChanger,
} from '../shared/stats.js';
import { recapOf, recapText } from '../shared/highlights.js';
import { releaseYear, toSong, trimResult } from '../shared/itunes.js';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import { addSuggestion, kickDevice, newRoomState, nextSong, vote } from '../shared/queue.js';

const S = { dA: { nick: 'Ana' }, dB: { nick: 'Ben' }, dC: { nick: 'Cy' } };
let n = 0;
/** A history entry (shared/highlights.js shape). */
function played({ genre = '', year = 0, ms = 0, up = 0, down = 0, device = 'dA', status = 'finished', at } = {}) {
  n += 1;
  return {
    id: `s${n}`, device, by: S[device]?.nick ?? 'a classmate', up, down, score: up - down, at: at ?? n * 1000, status,
    song: { id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, artwork: '', durationMs: ms, genre, year },
  };
}
const ids = (pool) => pool.map((s) => s.id);

test('versus: Top contributor (songs suggested) vs Top voter (votes cast); kicked devices are never named', () => {
  const v = versusStat({ songs: { dA: 3, dB: 1 }, votes: { dB: 9, dC: 4 } }, S);
  assert.deepEqual(v.contributor, { nick: 'Ana', n: 3 });
  assert.deepEqual(v.voter, { nick: 'Ben', n: 9 });
  assert.equal(v.text, '🎤 Top contributor: Ana (3 songs suggested) vs 🗳 Top voter: Ben (9 votes cast)');
  assert.deepEqual(versusStat({ songs: { gone: 7, dA: 1 }, votes: {} }, S).contributor, { nick: 'Ana', n: 1 });
  assert.match(versusStat({ songs: { dA: 1 }, votes: {} }, S).text, /Top voter: nobody yet/);
  assert.equal(versusStat({ songs: {}, votes: {} }, S), null);
  assert.equal(versusStat(null, S), null);
});

test('genres and decades: counts of songs that played; failed songs and unknowns left out', () => {
  const h = [played({ genre: 'Pop', year: 2014 }), played({ genre: 'Pop', year: 2019 }), played({ genre: 'Rock', year: 1975 }),
    played({ genre: 'Jazz', status: 'failed', year: 1960 }), played({ genre: '' })];
  assert.deepEqual(genreCounts(h), [{ label: 'Pop', n: 2 }, { label: 'Rock', n: 1 }]);
  assert.deepEqual(decadeCounts(h), [{ label: '1970s', n: 1 }, { label: '2010s', n: 2 }]);
  const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((g, i) => played({ genre: g, up: i }));
  const rows = genreCounts(many, 4);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.at(-1), { label: 'Other', n: 4 });
});

test('vibe changer: a new genre after which suggestions shifted toward it', () => {
  const h = [played({ genre: 'Pop', at: 1000 }), played({ genre: 'Pop', at: 2000 }), played({ genre: 'Country', at: 3000 }), played({ genre: 'Country', at: 4000 })];
  const log = [
    { genre: 'Pop', at: 100 }, { genre: 'Pop', at: 200 }, { genre: 'Rock', at: 2500 }, // before 3000
    { genre: 'Country', at: 3100 }, { genre: 'Country', at: 3200 }, { genre: 'Pop', at: 3300 }, // after
  ];
  const v = vibeChanger(h, log);
  assert.equal(v.entry.song.title, 'Song ' + (n - 1));
  assert.equal(v.genre, 'Country');
  assert.equal(v.swing, 2);
  // No shift afterwards: no vibe changer.
  assert.equal(vibeChanger(h, log.map((x) => (x.at > 3000 ? { ...x, genre: 'Pop' } : x))), null);
  // Too few suggestions to tell: none.
  assert.equal(vibeChanger(h, log.slice(1)), null);
  // The same genre as the song before it: not a change.
  const same = [played({ genre: 'Country', at: 1000 }), played({ genre: 'Pop', at: 2000 }), played({ genre: 'Country', at: 3000 })];
  assert.equal(vibeChanger(same, log), null);
});

test('the pool: only stats with real data; texts for Copy recap', () => {
  assert.deepEqual(statPool({ history: [], tally: { songs: {}, votes: {}, log: [] }, students: S }), [], 'an empty period: nothing made up');
  const h = [
    played({ genre: 'Pop', year: 1984, ms: 245_000, up: 5, down: 1, device: 'dA' }),
    played({ genre: 'Hip-Hop/Rap', year: 2021, ms: 132_000, up: 2, down: 2, device: 'dB' }),
    played({ genre: 'Pop', year: 2023, ms: 200_000, up: 0, down: 3, device: 'dB', status: 'skipped' }),
  ];
  const pool = statPool({ history: h, tally: { songs: { dA: 1, dB: 2 }, votes: { dC: 6 }, log: [] }, students: S,
    favorite: { id: 'it:9', title: 'Mr. Blue Sky', artist: 'ELO', artwork: '' }, crowd: { nick: 'Ana', up: 5 } });
  assert.deepEqual(ids(pool), ['versus', 'genres', 'longest', 'shortest', 'minutes', 'oldest', 'newest', 'decades', 'mostUp', 'mostDown', 'closest', 'crowd'], 'no all-time favorite: a recap is this room only');
  const by = Object.fromEntries(pool.map((s) => [s.id, s]));
  assert.equal(by.longest.name, h[0].song.title);
  assert.equal(by.longest.text, `🐢 Longest song: "${h[0].song.title}" by ${h[0].song.artist} (4:05)`);
  assert.equal(by.shortest.detail, `${h[1].song.artist} · 2:12`);
  assert.equal(by.minutes.name, '10 min');
  assert.equal(by.oldest.name, '1984');
  assert.equal(by.newest.name, '2023');
  assert.equal(by.mostDown.name, h[2].song.title, 'most 👎 that still played');
  assert.equal(by.closest.name, h[1].song.title, 'a 2-2 tie is the closest');
  assert.equal(by.genres.chart.rows[0].label, 'Pop');
  assert.equal(by.versus.voter.nick, 'Cy');
  for (const s of pool) assert.ok(s.text.length > 5, s.id);
  // One song only: no "longest vs shortest", no genre mix, no oldest/newest.
  const one = statPool({ history: [played({ genre: 'Pop', year: 2000, ms: 1000 })], tally: null, students: S });
  assert.deepEqual(ids(one), []);
});

test('pickStats: the versus card always, plus n others at random', () => {
  const pool = [{ id: 'versus' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  const r = pickStats(pool, 3, () => 0.5);
  assert.equal(r.versus.id, 'versus');
  assert.equal(r.picks.length, 3);
  assert.ok(!r.picks.some((s) => s.id === 'versus'));
  assert.equal(new Set(r.picks.map((s) => s.id)).size, 3);
  assert.deepEqual(pickStats([{ id: 'a' }], 4).picks.map((s) => s.id), ['a']);
  assert.equal(pickStats([], 4).versus, null);
  assert.equal(minutesSeconds(61_400), '1:01');
});

test('the room counts songs suggested and votes cast per device; kick forgets them', () => {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, maxWaitingPerStudent: 5 }, 1000);
  for (const [d, nick] of [['deviceAAAAAAAAAAAAAA', 'Ana'], ['deviceBBBBBBBBBBBBBB', 'Ben']]) s.students[d] = { nick, joinedAt: 1 };
  const A = 'deviceAAAAAAAAAAAAAA';
  const B = 'deviceBBBBBBBBBBBBBB';
  const song = (k, genre) => ({ id: `it:${k}`, title: `T${k}`, artist: `R${k}`, album: '', artwork: '', durationMs: 180_000, explicit: 'notExplicit', previewUrl: '', genre, year: 2000 + k });
  const one = addSuggestion(s, { device: A, nick: 'Ana', song: song(1, 'Pop'), now: 10 }).item;
  const two = addSuggestion(s, { device: A, nick: 'Ana', song: song(2, 'Rock'), now: 20 }).item;
  vote(s, B, one.id, 1);
  vote(s, B, two.id, 1);
  vote(s, B, two.id, -1); // a change is not a new vote
  vote(s, A, two.id, 1);
  vote(s, A, two.id, 0); // refused: votes are final
  assert.deepEqual(s.tally.songs, { [A]: 2 });
  assert.deepEqual(s.tally.votes, { [B]: 2, [A]: 1 });
  assert.deepEqual(s.tally.log, [{ genre: 'Pop', at: 10 }, { genre: 'Rock', at: 20 }]);
  nextSong(s);
  const r = recapOf(s, 99);
  assert.equal(r.stats[0].id, 'versus');
  assert.deepEqual(r.stats[0].contributor, { nick: 'Ana', n: 2 });
  assert.deepEqual(r.stats[0].voter, { nick: 'Ben', n: 2 });
  const text = recapText(r, { stats: r.stats });
  assert.match(text, /🎤 Top contributor: Ana \(2 songs suggested\) vs 🗳 Top voter: Ben \(2 votes cast\)/);
  kickDevice(s, B);
  assert.equal(s.tally.votes[B], undefined);
  assert.deepEqual(recapOf(s).stats[0].voter, { nick: 'Ana', n: 1 });
});

test('songs carry the release year (1900 to next year), else 0', () => {
  assert.equal(releaseYear('2013-11-21T08:00:00Z'), 2013);
  assert.equal(releaseYear('1899-01-01T00:00:00Z'), 0);
  assert.equal(releaseYear('3000-01-01T00:00:00Z'), 0);
  assert.equal(releaseYear('soon'), 0);
  assert.equal(releaseYear(2013), 0);
  const raw = { kind: 'song', trackId: 5, trackName: 'Happy', artistName: 'Pharrell Williams', previewUrl: 'https://audio-ssl.itunes.apple.com/a.m4a', releaseDate: '2013-11-21T08:00:00Z', extra: 'x' };
  assert.equal(toSong(trimResult(raw)).year, 2013);
  assert.equal(toSong({ ...raw, releaseDate: undefined }).year, 0);
});

test('the period\'s running favorite: only for a room with a bell period, one of the random picks', () => {
  const h = [
    played({ genre: 'Pop', year: 1984, ms: 245_000, up: 5, down: 1, device: 'dA' }),
    played({ genre: 'Hip-Hop/Rap', year: 2021, ms: 132_000, up: 2, down: 2, device: 'dB' }),
  ];
  const song = { id: 'it:9', title: 'Mr. Blue Sky', artist: 'ELO', artwork: '' };
  const none = statPool({ history: h, tally: null, students: S });
  assert.ok(!none.some((s) => s.id === 'period'), 'no period: no favorite');
  const pool = statPool({ history: h, tally: null, students: S, periodFavorite: { period: 'P3', song } });
  const p = pool.find((s) => s.id === 'period');
  assert.equal(p.title, 'P3 favorite');
  assert.equal(p.text, '🏅 P3 favorite so far: "Mr. Blue Sky" by ELO');
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(pickStats(pool, 2).picks.some((s) => s.id === 'period'));
  assert.deepEqual([...seen].sort(), [false, true], 'shows some days, not every time');
  // A quiet period (no songs today) still gets ITS OWN running favorite, never another class's.
  const quiet = statPool({ history: [], tally: null, students: S, periodFavorite: { period: 'P3', song } });
  assert.deepEqual(quiet.map((s) => s.id), ['period']);
});
