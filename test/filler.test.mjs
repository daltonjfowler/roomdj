import assert from 'node:assert/strict';
import test from 'node:test';
import { fillerStep, loadFiller, parseFillerLink } from '../shared/filler.js';
import { createEndWatch } from '../shared/spotify.js';

const VID = 'M7lc1UVf-VE';
const SP = '37i9dQZF1DXcBWIGoYBM5M';

test('YouTube links: watch?v=, youtu.be/, /live/, /embed/, /shorts/, a bare id; playlists', () => {
  for (const link of [
    `https://www.youtube.com/watch?v=${VID}`, `https://youtube.com/watch?v=${VID}&list=PL123&t=30`, `https://m.youtube.com/watch?v=${VID}`,
    `https://music.youtube.com/watch?v=${VID}`, `https://youtu.be/${VID}?si=abc`, `https://www.youtube.com/live/${VID}?feature=share`,
    `https://www.youtube.com/embed/${VID}`, `https://www.youtube-nocookie.com/embed/${VID}`, `https://www.youtube.com/shorts/${VID}`,
    `youtube.com/watch?v=${VID}`, `  ${VID}  `,
  ]) {
    assert.deepEqual(parseFillerLink(link), { ok: true, kind: 'youtube', videoId: VID }, link);
  }
  assert.deepEqual(parseFillerLink('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'),
    { ok: true, kind: 'youtubeList', list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' });
  for (const bad of ['https://www.youtube.com/@lofigirl', 'https://youtu.be/', 'https://www.youtube.com/watch?v=short',
    `https://evil.example/watch?v=${VID}`, `javascript:alert(1)//${VID}`, '', 'hello there']) {
    const r = parseFillerLink(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.message, bad);
  }
});

test('Spotify links: playlist and album → context uri; a track or anything else → a message', () => {
  assert.deepEqual(parseFillerLink(`https://open.spotify.com/playlist/${SP}?si=xyz`),
    { ok: true, kind: 'spotify', type: 'playlist', id: SP, contextUri: `spotify:playlist:${SP}` });
  assert.equal(parseFillerLink(`https://open.spotify.com/album/${SP}`).contextUri, `spotify:album:${SP}`);
  assert.equal(parseFillerLink(`https://open.spotify.com/intl-de/album/${SP}`).contextUri, `spotify:album:${SP}`);
  assert.equal(parseFillerLink(`spotify:playlist:${SP}`).contextUri, `spotify:playlist:${SP}`);
  assert.match(parseFillerLink(`https://open.spotify.com/track/${SP}`).message, /one Spotify song/);
  assert.equal(parseFillerLink(`https://open.spotify.com/artist/${SP}`).ok, false);
  assert.equal(parseFillerLink('https://open.spotify.com/playlist/tooShort').ok, false);
});

test('saved filler: { link, resume } with a link that parses', () => {
  assert.deepEqual(loadFiller(JSON.stringify({ link: ` https://youtu.be/${VID} ` })), { link: `https://youtu.be/${VID}`, resume: true });
  assert.deepEqual(loadFiller(JSON.stringify({ link: `https://youtu.be/${VID}`, resume: false })), { link: `https://youtu.be/${VID}`, resume: false });
  for (const t of [null, '', 'x', '{}', '{"link":"nope"}', '{"link":5}']) assert.equal(loadFiller(t), null, String(t));
});

/** Run events from 'off'; returns [state, action] after each. */
function walk(events, opts) {
  let s = 'off';
  return events.map((e) => {
    const r = fillerStep(s, e, opts);
    s = r.state;
    return [r.state, r.action];
  });
}

test('filler: a queue song pauses it, an empty queue brings it back (resume on, the default)', () => {
  assert.deepEqual(walk(['toggle', 'queuePlays', 'queuePlays', 'idle', 'idle']), [
    ['playing', 'play'], ['held', 'pause'], ['held', null], ['playing', 'play'], ['playing', null],
  ]);
});

test('filler: resume off → a queue song turns it off; idle does not bring it back', () => {
  assert.deepEqual(walk(['toggle', 'queuePlays', 'idle'], { resume: false }), [['playing', 'play'], ['off', 'pause'], ['off', null]]);
});

test('filler: the teacher button: off and playing; from held it plays (the host pauses the queue song)', () => {
  assert.deepEqual(walk(['toggle', 'toggle']), [['playing', 'play'], ['off', 'pause']]);
  assert.deepEqual(walk(['toggle', 'queuePlays', 'toggle']), [['playing', 'play'], ['held', 'pause'], ['playing', 'play']]);
  // Never on by itself: idle and queuePlays from off do nothing.
  assert.deepEqual(walk(['idle', 'queuePlays']), [['off', null], ['off', null]]);
});

test('filler: cleanup mode or the room closing stops it, and it cannot start or come back meanwhile', () => {
  assert.deepEqual(walk(['toggle', 'stop']), [['playing', 'play'], ['off', 'stop']]);
  assert.deepEqual(walk(['toggle', 'queuePlays', 'stop']), [['playing', 'play'], ['held', 'pause'], ['off', 'stop']]);
  assert.deepEqual(fillerStep('off', 'toggle', { blocked: true }), { state: 'off', action: 'refuse' });
  assert.deepEqual(fillerStep('held', 'idle', { blocked: true }), { state: 'off', action: null });
  assert.deepEqual(fillerStep('off', 'stop'), { state: 'off', action: null });
});

// ---- The queue's Spotify end-watch on a speaker the background music also uses ----
const ME = 'spotify:track:me';
const SONG = { id: 'it:9', title: 'Shake It Off', artist: 'Taylor Swift', durationMs: 219_000 };
const CTX = `spotify:playlist:${SP}`;
const mine = (position, paused = false) => ({ paused, position, duration: 219_000, context: { uri: '' },
  track_window: { current_track: { uri: ME, name: 'Shake It Off', artists: [{ name: 'Taylor Swift' }] }, previous_tracks: [] } });
const lofi = (position, paused = false) => ({ paused, position, duration: 180_000, context: { uri: CTX },
  track_window: { current_track: { uri: 'spotify:track:lofi', name: 'Rainy Study', artists: [{ name: 'Lofi Beats' }] }, previous_tracks: [] } });

test('end watch: late background music states never end a queue song (ignoreContext)', () => {
  const w = createEndWatch({ song: SONG, startedUri: ME, ignoreContext: CTX });
  assert.equal(w.observe(lofi(90_000), 0).decision, 'filler-ignored'); // before ours starts
  assert.equal(w.observe(mine(200), 500).decision, 'start');
  for (let t = 1000; t <= 6000; t += 1000) w.observe(mine(t), t);
  assert.equal(w.observe(lofi(91_000), 6500).decision, 'filler-ignored');
  assert.equal(w.observe(lofi(92_000), 7500).decision, 'filler-ignored');
  assert.equal(w.observe(mine(7000), 8000).decision, 'play');
  // Without ignoreContext the same two looks would have ended the song.
  const plain = createEndWatch({ song: SONG, startedUri: ME });
  plain.observe(mine(200), 500);
  for (let t = 1000; t <= 6000; t += 1000) plain.observe(mine(t), t);
  plain.observe(lofi(91_000), 6500);
  assert.equal(plain.observe(lofi(92_000), 7500).decision, 'ended');
  // A real end still ends: last seconds, then paused at 0.
  const real = createEndWatch({ song: SONG, startedUri: ME, ignoreContext: CTX });
  for (let p = 205_000, t = 0; p <= 216_000; p += 1000, t += 1000) real.observe(mine(p), t);
  assert.equal(real.observe(mine(0, true), 13_000).decision, 'ended');
});
