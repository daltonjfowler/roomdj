// 🎵 Recap music (protocol.js RECAP MUSIC, shared/recap-music.js): which preview plays, how loud, the
// loop's crossfade, the reveal sounds, the room music around the show, the board's cues and that
// boards never get the preview links.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import {
  afterShow, crossfadeAt, cueFor, holdForShow, previewOk, recapLevel, recapMusicOn, recapPreview,
} from '../shared/recap-music.js';
import { boardMessage } from '../shared/board.js';
import { recapOf } from '../shared/highlights.js';
import { newRoomState } from '../shared/queue.js';
import { validateSettings } from '../shared/settings.js';

const P = (n) => `https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/p${n}.m4a`;
const t5 = (n, previewUrl) => ({ id: `q${n}`, song: { id: `it:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, artwork: '' }, by: 'Ana', up: 1, down: 0, score: 1, previewUrl });

test('the #1 song\'s preview; the next Top 5 song with one when #1 has none; none: null', () => {
  assert.deepEqual(recapPreview([t5(1, P(1)), t5(2, P(2))]), { url: P(1), title: 'Song 1', artist: 'Artist 1', rank: 1 });
  assert.deepEqual(recapPreview([t5(1, ''), t5(2, undefined), t5(3, P(3))]), { url: P(3), title: 'Song 3', artist: 'Artist 3', rank: 3 });
  assert.equal(recapPreview([t5(1, ''), t5(2, '')]), null);
  assert.equal(recapPreview([]), null);
  assert.equal(recapPreview(undefined), null);
});

test('only previews the host page may play (https, iTunes / mzstatic)', () => {
  assert.equal(previewOk(P(1)), true);
  assert.equal(previewOk('https://audio-ssl.itunes.apple.com.evil.example/p.m4a'), false);
  assert.equal(previewOk('http://audio-ssl.itunes.apple.com/p.m4a'), false);
  assert.equal(previewOk('https://a1.mzstatic.com/x.m4a'), true);
  assert.equal(previewOk('javascript:alert(1)'), false);
  assert.equal(previewOk(42), false);
  assert.equal(recapPreview([t5(1, 'https://evil.example/p.m4a'), t5(2, P(2))]).rank, 2);
});

test('settings: on by default, volume 10..100 percent of the room volume', () => {
  assert.equal(DEFAULT_SETTINGS.recapMusic, true);
  assert.equal(recapMusicOn({}), true);
  assert.equal(recapMusicOn({ recapMusic: false }), false);
  assert.equal(validateSettings({ recapVolume: 5 }).ok, false);
  assert.equal(validateSettings({ recapVolume: 101 }).ok, false);
  assert.equal(validateSettings({ recapVolume: 70 }).settings.recapVolume, 70);
  assert.equal(validateSettings({ recapMusic: 'on' }).ok, false);
  assert.equal(recapLevel(1, { recapVolume: 50 }), 0.5);
  assert.equal(recapLevel(0.5, { recapVolume: 80 }), 0.4);
  assert.equal(recapLevel(2, { recapVolume: 100 }), 1, 'never above 1');
  assert.equal(recapLevel(1, { recapVolume: 'x' }), DEFAULT_SETTINGS.recapVolume / 100, 'a bad value: the default');
  assert.equal(recapLevel(NaN, {}), 0.5);
});

test('the loop crossfades right at the clip\'s end, quickly (a 30 s preview at 29.4 s)', () => {
  assert.equal(crossfadeAt(30), 29.4);
  assert.equal(crossfadeAt(NaN), 29.4, 'unknown length: 30 s');
  assert.equal(crossfadeAt(1), 0.5, 'a very short clip: half way');
});

test('reveal sounds: none on the title card, a crown on #1, a ta-da on the others', () => {
  assert.equal(cueFor({ kind: 'title' }), null);
  assert.equal(cueFor({ kind: 'stat' }), 'reveal');
  assert.equal(cueFor({ kind: 'top5', rank: 3 }), 'reveal');
  assert.equal(cueFor({ kind: 'top5', rank: 1 }), 'crown');
  assert.equal(cueFor({ kind: 'versus' }), 'reveal');
  assert.equal(cueFor(null), null);
});

test('the room music: the show pauses what played, then resumes exactly that', () => {
  const playing = holdForShow({ started: true, paused: false, filler: 'off' });
  assert.deepEqual(playing, { queue: true, filler: false });
  assert.deepEqual(afterShow(playing, { started: true, paused: true }), { queue: true, filler: false });
  // It was paused: it stays paused.
  const pausedBefore = holdForShow({ started: true, paused: true, filler: 'off' });
  assert.deepEqual(afterShow(pausedBefore, { started: true, paused: true }), { queue: false, filler: false });
  // Not started yet (no Start music click): nothing to resume.
  assert.deepEqual(holdForShow({ started: false, paused: false }), { queue: false, filler: false });
  // The background music.
  const bg = holdForShow({ started: true, paused: true, filler: 'playing' });
  assert.deepEqual(afterShow(bg, { started: true, paused: true }), { queue: false, filler: true });
  // The teacher pressed play during the show: nothing more to do.
  assert.deepEqual(afterShow(playing, { started: true, paused: false }), { queue: false, filler: false });
  // Cleanup started during the show: the music stays off.
  assert.deepEqual(afterShow(playing, { started: true, paused: true, cleanup: true }), { queue: false, filler: false });
  assert.deepEqual(afterShow(null, { started: true, paused: true }), { queue: false, filler: false });
});

test('the board\'s cues: only start / reveal / crown / end pass boardMessage', () => {
  for (const cue of ['start', 'reveal', 'crown', 'end']) assert.deepEqual(boardMessage({ t: 'recapCue', cue, extra: 1 }), { t: 'recapCue', cue });
  assert.equal(boardMessage({ t: 'recapCue', cue: 'play' }), null);
  assert.equal(boardMessage({ t: 'recapCue' }), null);
});

test('the recap carries the Top 5 previews for the host; the state\'s top5 and the board do not', () => {
  const s = newRoomState('0123456789abcdef0123456789abcdef', DEFAULT_SETTINGS, 1000);
  s.history = [1, 2].map((n) => ({ id: `q${n}`, song: { id: `it:${n}`, title: `S${n}`, artist: 'A', artwork: '', previewUrl: P(n) }, device: null, by: 'Ana', up: n, down: 0, score: n, at: n, status: 'finished' }));
  const recap = recapOf(s, 5000);
  assert.deepEqual(recap.top5.map((t) => t.previewUrl), [P(2), P(1)]);
  assert.equal(recapPreview(recap.top5).url, P(2));
  const src = readFileSync(new URL('../src/room.js', import.meta.url), 'utf8');
  const show = src.slice(src.indexOf('  async recapShow()'), src.indexOf('  async boardRemote(ws, raw)'));
  assert.match(show, /top5: recap\.top5\.map\(\(\{ previewUrl, \.\.\.t \}\) => t\)/);
  assert.match(show, /socketsOf\('board'\)\) this\.send\(s, \{ t: 'recap', recap: boardRecap, show: true \}\)/);
  // Cues go to the host pages only.
  const remote = src.slice(src.indexOf('  async boardRemote(ws, raw)'));
  assert.match(remote, /case 'recapCue':\s*\r?\n[^\n]*\r?\n\s*for \(const h of this\.socketsOf\('host'\)\) this\.send\(h, \{ t: 'recapCue', cue: msg\.cue \}\)/);
});
