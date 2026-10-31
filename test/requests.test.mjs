// The song request log (shared/requests.js): what a row keeps, what it never keeps, and the CSV.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_LOG_MAX, CSV_COLUMNS, askEntry, csvLines, finishAsks, logAsk } from '../shared/requests.js';

const song = (title, artist = 'Drake', extra = {}) => ({
  id: `it:${title.length}`, title, artist, album: 'Views', genre: 'Hip-Hop/Rap', year: 2016, durationMs: 267_000,
  explicit: 'notExplicit', previewUrl: 'https://x', artwork: 'https://y', ...extra,
});
const AT = Date.UTC(2026, 9, 30, 14, 25);

test('a row keeps the song, the hour and what happened, never a device, nickname or room', () => {
  const state = { askLog: [] };
  logAsk(state, askEntry(song('Hotline Bling', 'Drake', { explicit: 'cleaned' }), 'queued', { device: 'dev-secret-1', item: 'q1', now: AT }));
  const rows = finishAsks(state.askLog, [{ id: 'q1', device: 'dev-secret-1', by: 'Calm Otter', status: 'finished', up: 7, down: 1 }]);
  assert.deepEqual(rows, [{
    hour: '2026-10-30T14', song: 'it:13', title: 'Hotline Bling', artist: 'Drake', album: 'Views', genre: 'Hip-Hop/Rap',
    year: 2016, seconds: 267, clean: 1, outcome: 'queued', reason: '', why: '', fate: 'played', up: 7, down: 1,
  }]);
  const text = JSON.stringify(rows) + csvLines(rows);
  assert.doesNotMatch(text, /dev-secret|Calm Otter|q1/);
});

test('one student asking again for the same song counts once (the furthest outcome, the first time)', () => {
  const s = {};
  const one = song('Toxic', 'Britney Spears');
  logAsk(s, askEntry(one, 'blocked', { device: 'a', reason: 'theme', why: 'sexual', now: AT }));
  logAsk(s, askEntry(one, 'blocked', { device: 'a', reason: 'theme', why: 'sexual', now: AT + 60_000 }));
  logAsk(s, askEntry(one, 'blocked', { device: 'b', reason: 'theme', why: 'sexual', now: AT + 3_600_000 }));
  logAsk(s, askEntry(song('One Dance'), 'refused', { device: 'a', reason: 'duplicate', now: AT }));
  logAsk(s, askEntry(song('One Dance'), 'review', { device: 'a', reason: 'nolyrics', item: 'r1', now: AT + 120_000 }));
  const rows = finishAsks(s.askLog, []);
  assert.equal(rows.filter((r) => r.title === 'Toxic').length, 2, 'two students');
  assert.deepEqual(rows.filter((r) => r.title === 'Toxic').map((r) => [r.hour, r.outcome, r.reason, r.why, r.fate]),
    [['2026-10-30T14', 'blocked', 'theme', 'sexual', ''], ['2026-10-30T15', 'blocked', 'theme', 'sexual', '']]);
  const dance = rows.find((r) => r.title === 'One Dance');
  assert.equal(dance.outcome, 'review', 'the furthest outcome');
  assert.equal(dance.fate, 'not played', 'waited for the teacher, never started');
  assert.equal(dance.hour, '2026-10-30T14', 'the first time');
});

test('fate comes from the history: skipped, still playing, never played', () => {
  const s = {};
  logAsk(s, askEntry(song('A'), 'queued', { device: 'a', item: 'i1', now: AT }));
  logAsk(s, askEntry(song('B'), 'queued', { device: 'a', item: 'i2', now: AT }));
  logAsk(s, askEntry(song('Cc'), 'queued', { device: 'a', item: 'i3', now: AT }));
  const rows = finishAsks(s.askLog, [{ id: 'i1', status: 'skipped', up: 0, down: 4 }, { id: 'i2', status: 'playing', up: 2, down: 0 }]);
  assert.deepEqual(rows.map((r) => [r.title, r.fate, r.up, r.down]), [['A', 'skipped', 0, 4], ['B', 'playing', 2, 0], ['Cc', 'not played', 0, 0]]);
});

test('the room keeps at most ASK_LOG_MAX asks (the oldest go)', () => {
  const s = {};
  for (let i = 0; i < ASK_LOG_MAX + 5; i++) logAsk(s, askEntry(song(`S${i}`), 'refused', { device: 'a', reason: 'resting', now: AT }));
  assert.equal(s.askLog.length, ASK_LOG_MAX);
  assert.equal(s.askLog[0].song.title, 'S5');
});

test('CSV: one line per row, quoted when needed, never a spreadsheet formula', () => {
  const rows = finishAsks([askEntry(song('=HYPERLINK("x")', 'Smith, "Jr"'), 'refused', { device: 'a', reason: 'same_artist', now: AT })], []);
  const line = csvLines(rows);
  assert.equal(line.split(',').length >= CSV_COLUMNS.length, true);
  assert.match(line, /^2026-10-30T14:00Z,"'=HYPERLINK\(""x""\)","Smith, ""Jr""",Views,/);
  assert.doesNotMatch(line, /\n/);
});

test('the admin CSV: a header, then every page of the log, oldest first', async () => {
  const { requestsCsv } = await import('../src/admin.js');
  const all = finishAsks(Array.from({ length: 7 }, (_, i) => askEntry(song(`Song ${i}`), 'queued', { device: `d${i}`, now: AT })), []);
  const stub = {
    async page(after = 0) {
      const rows = all.slice(after, after + 3).map((r, i) => ({ rid: after + i + 1, ...r }));
      return { rows, last: rows.length ? rows[rows.length - 1].rid : null };
    },
  };
  const env = { REQUEST_LOG: { idFromName: (n) => n, get: () => stub } };
  const r = requestsCsv(env);
  assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
  const lines = (await r.text()).trim().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.deepEqual(lines.slice(1).map((l) => l.split(',')[1]), all.map((x) => x.title));
  assert.equal(requestsCsv({}).status, 503, 'no binding: a clear error');
});
