import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLIENT_ID_PATTERN, SPOTIFY_SCOPES, authorizeUrl, combineMatches, looseQuery, matchScore, matchTitle, needsRefresh,
  pickMatch, pkceChallenge, randomToken, readRedirect, searchQuery, skipMessage, tokenRequestBody, tokensFromReply,
  createEndWatch, otherSong, stateSummary,
} from '../shared/spotify.js';

const song = (over = {}) => ({
  id: 'it:1', title: 'Happy (From "Despicable Me 2")', artist: 'Pharrell Williams', album: 'G I R L', artwork: '',
  durationMs: 233_000, explicit: 'notExplicit', previewUrl: 'https://x', ...over,
});
const track = (over = {}) => ({
  uri: 'spotify:track:aaa', name: 'Happy - From "Despicable Me 2"', artists: [{ name: 'Pharrell Williams' }],
  duration_ms: 232_720, explicit: false, ...over,
});

// ---- PKCE ----

test('RFC 7636 appendix B: S256 challenge of the sample verifier', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('random verifier: base64url, 43 to 128 characters, different every time', () => {
  const a = randomToken(), b = randomToken();
  assert.match(a, /^[A-Za-z0-9_-]{43,128}$/);
  assert.notEqual(a, b);
});

test('authorize URL carries the PKCE and login parameters', () => {
  const u = new URL(authorizeUrl({ clientId: 'c'.repeat(32), redirectUri: 'http://127.0.0.1:8792/host/', challenge: 'CH', state: 'ST' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  const p = Object.fromEntries(u.searchParams);
  assert.deepEqual(p, {
    client_id: 'c'.repeat(32), response_type: 'code', redirect_uri: 'http://127.0.0.1:8792/host/',
    code_challenge_method: 'S256', code_challenge: 'CH', state: 'ST', scope: SPOTIFY_SCOPES.join(' '),
  });
  assert.ok(p.scope.includes('streaming'));
});

test('token request bodies: code exchange and refresh, never a secret', () => {
  const ex = Object.fromEntries(new URLSearchParams(tokenRequestBody({ clientId: 'id', code: 'C', verifier: 'V', redirectUri: 'R' })));
  assert.deepEqual(ex, { grant_type: 'authorization_code', code: 'C', redirect_uri: 'R', client_id: 'id', code_verifier: 'V' });
  const rf = Object.fromEntries(new URLSearchParams(tokenRequestBody({ clientId: 'id', refreshToken: 'RT' })));
  assert.deepEqual(rf, { grant_type: 'refresh_token', refresh_token: 'RT', client_id: 'id' });
});

test('tokens from a reply: expiry, kept refresh token, refresh timing', () => {
  const t = tokensFromReply({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }, 1000);
  assert.deepEqual(t, { access: 'A', refresh: 'R', expiresAt: 3_601_000 });
  assert.equal(tokensFromReply({ access_token: 'B', expires_in: 3600 }, 0, 'R').refresh, 'R');
  assert.equal(tokensFromReply({ error: 'invalid_grant' }), null);
  assert.equal(needsRefresh(t, 1000), false);
  assert.equal(needsRefresh(t, 3_601_000 - 60_000), true); // inside the last two minutes
  assert.equal(needsRefresh(null), true);
});

test('redirect back from Spotify', () => {
  assert.deepEqual(readRedirect('?code=abc&state=s1'), { code: 'abc', state: 's1' });
  assert.deepEqual(readRedirect('?error=access_denied&state=s1'), { error: 'access_denied', state: 's1' });
  assert.equal(readRedirect('?room=x'), null);
});

test('client id shape', () => {
  assert.ok(CLIENT_ID_PATTERN.test('0123456789abcdef0123456789ABCDEF'));
  assert.ok(!CLIENT_ID_PATTERN.test(''));
  assert.ok(!CLIENT_ID_PATTERN.test('not-an-id'));
});

// ---- Matching ----

test('titles lose version labels and featured artists', () => {
  assert.equal(matchTitle('Levitating (feat. DaBaby)'), 'levitating');
  assert.equal(matchTitle('Mr. Brightside - Remastered 2021'), 'mr brightside');
  assert.equal(matchTitle('Rock & Roll'), 'rock and roll');
  assert.equal(matchTitle('Uptown Funk (feat. Bruno Mars)'), matchTitle('Uptown Funk'));
});

test('search query uses field filters on the cleaned title and main artist', () => {
  assert.equal(searchQuery(song({ title: 'Mr. Brightside (Remastered)', artist: 'The Killers' })), 'track:"Mr. Brightside" artist:"the killers"');
  assert.equal(searchQuery(song({ title: 'Uptown Funk', artist: 'Mark Ronson & Bruno Mars' })), 'track:"Uptown Funk" artist:"mark ronson"');
  assert.equal(looseQuery(song({ title: 'Levitating (feat. DaBaby)', artist: 'Dua Lipa' })), 'levitating dua lipa');
});

test('same recording scores; different song, artist or length does not', () => {
  assert.ok(matchScore(song(), track()) > 2);
  assert.equal(matchScore(song(), track({ name: 'Sad' })), 0);
  assert.equal(matchScore(song(), track({ artists: [{ name: 'Someone Else' }] })), 0);
  assert.equal(matchScore(song(), track({ duration_ms: 233_000 + 11_000 })), 0); // a live or extended cut
  assert.ok(matchScore(song(), track({ duration_ms: 233_000 + 9_000 })) > 0);
  assert.equal(matchScore(song(), track({ is_playable: false })), 0);
  assert.equal(matchScore(song(), track({ uri: 'spotify:episode:x' })), 0);
  // Several artists on either side: the main one counts.
  assert.ok(matchScore(song({ title: 'Uptown Funk', artist: 'Mark Ronson & Bruno Mars', durationMs: 270_000 }),
    track({ name: 'Uptown Funk (feat. Bruno Mars)', artists: [{ name: 'Mark Ronson' }, { name: 'Bruno Mars' }], duration_ms: 269_000 })) > 2);
});

test('the closest length wins among matches', () => {
  const r = pickMatch(song(), [track({ uri: 'spotify:track:far', duration_ms: 241_000 }), track({ uri: 'spotify:track:near' })]);
  assert.deepEqual(r, { status: 'ok', uri: 'spotify:track:near', name: track().name });
});

test('explicit safety: a clean version is used, an explicit-only song is skipped', () => {
  const dirty = track({ uri: 'spotify:track:dirty', explicit: true });
  const clean = track({ uri: 'spotify:track:clean', explicit: false, duration_ms: 230_000 });
  assert.equal(pickMatch(song(), [dirty, clean]).uri, 'spotify:track:clean');
  // Even when the explicit one is the closer length.
  assert.equal(pickMatch(song(), [clean, dirty]).uri, 'spotify:track:clean');
  assert.deepEqual(pickMatch(song(), [dirty]), { status: 'explicit' });
  // A track without the explicit flag counts as explicit.
  assert.deepEqual(pickMatch(song(), [track({ explicit: undefined })]), { status: 'explicit' });
  assert.deepEqual(pickMatch(song(), []), { status: 'none' });
  assert.deepEqual(pickMatch(song(), [track({ name: 'Other' })]), { status: 'none' });
});

test('combining two searches: ok beats explicit beats none', () => {
  assert.equal(combineMatches([{ status: 'explicit' }, { status: 'ok', uri: 'u' }]).uri, 'u');
  assert.equal(combineMatches([{ status: 'none' }, { status: 'explicit' }]).status, 'explicit');
  assert.equal(combineMatches([{ status: 'none' }]).status, 'none');
});

test('skip notices name the song', () => {
  assert.equal(skipMessage(song({ title: 'X' }), 'explicit'), 'Spotify only has the explicit version of "X" by Pharrell Williams.');
  assert.match(skipMessage(song({ title: 'X' }), 'none'), /does not have "X"/);
});

// ---- End of track ----

const ME = 'spotify:track:me';
const MY_SONG = { id: 'it:9', title: 'Shake It Off', artist: 'Taylor Swift', durationMs: 219_000 };
const st = (over = {}, tw = {}) => ({
  paused: false, position: 1000, duration: 219_000,
  track_window: { current_track: { uri: ME, name: 'Shake It Off', artists: [{ name: 'Taylor Swift' }] }, previous_tracks: [], ...tw },
  ...over,
});
const other = (over = {}) => st(over, { current_track: { uri: 'spotify:track:radio', name: 'Blank Space', artists: [{ name: 'Taylor Swift' }] } });

/** Feed [msFromStart, state] pairs to a new watch; returns the decisions. */
function run(steps, song = MY_SONG) {
  const w = createEndWatch({ song, startedUri: ME });
  return steps.map(([t, s]) => w.observe(s, 1_000_000 + t).decision);
}
/** Playing from `from` to `to` ms of the song, one state a second (time = position - from). */
function playing(from, to, at = 0) {
  const out = [];
  for (let p = from; p <= to; p += 1000) out.push([at + p - from, st({ position: p })]);
  return out;
}

test('end watch: waits for our song, starts on it (by uri, or by name when relinked)', () => {
  assert.deepEqual(run([[0, st({ paused: true, position: 0 })], [500, st({ position: 300 })]]), ['wait', 'start']);
  const relinkedAtStart = st({ position: 300 }, { current_track: { uri: 'spotify:track:other1', name: 'Shake It Off' } });
  assert.deepEqual(run([[0, other({ position: 5000 })], [500, relinkedAtStart]]), ['wait', 'start']);
});

test('end watch: uri flips to a relinked track mid-song (same name) → no end, uri adopted', () => {
  const flip = (p) => st({ position: p }, { current_track: { uri: 'spotify:track:relink', name: 'Shake It Off', artists: [{ name: 'Taylor Swift' }] } });
  const w = createEndWatch({ song: MY_SONG, startedUri: ME });
  w.observe(st({ position: 500 }), 0);
  assert.equal(w.observe(flip(3000), 2500).decision, 'relink');
  assert.equal(w.uri, 'spotify:track:relink');
  for (let t = 3500; t < 8000; t += 1000) assert.equal(w.observe(flip(t + 500), t).decision, 'play');
  // The uri flips back: still the same song.
  assert.equal(w.observe(st({ position: 9000 }), 8500).decision, 'relink');
});

test('end watch: paused at 0 while it buffers at the start → no end', () => {
  const d = run([
    [0, st({ position: 200 })], [1000, st({ paused: true, position: 0 })], [2000, st({ paused: true, position: 0 })],
    [3000, st({ paused: true, position: 0 })], [4000, st({ position: 800 })],
  ]);
  assert.ok(!d.includes('ended'), d.join());
  // Still nothing after the start grace: it never played past 70% or near the end.
  assert.ok(!run([...playing(0, 20_000), [21_000, st({ paused: true, position: 0 })], [22_000, st({ paused: true, position: 0 })]]).includes('ended'));
});

test('end watch: our uri in previous_tracks from an earlier play → no end at the start', () => {
  const prevMe = { previous_tracks: [{ uri: ME }] };
  const d = run([
    [0, st({ position: 100 }, prevMe)], [1000, st({ paused: true, position: 0 }, prevMe)], [2000, st({ paused: true, position: 0 }, prevMe)],
    [3000, st({ position: 1500 }, prevMe)], [12_000, st({ paused: true, position: 0 }, prevMe)], [13_000, st({ paused: true, position: 0 }, prevMe)],
  ]);
  assert.ok(!d.includes('ended'), d.join());
});

test('end watch: a real end (near the end, then paused at 0) → end at once', () => {
  const d = run([...playing(200_000, 216_000), [17_000, st({ paused: true, position: 0 }, { previous_tracks: [{ uri: ME }] })]]);
  assert.equal(d.at(-1), 'ended');
  assert.equal(d.filter((x) => x === 'ended').length, 1);
});

test('end watch: paused at 0 after 70% but not seen near the end → end on the second look', () => {
  const w = createEndWatch({ song: MY_SONG, startedUri: ME });
  for (const [t, s] of playing(150_000, 170_000)) w.observe(s, t);
  assert.equal(w.observe(st({ paused: true, position: 0 }), 40_000).decision, 'maybe-end');
  assert.equal(w.observe(st({ paused: true, position: 0 }), 40_300).decision, 'maybe-end'); // too soon
  assert.equal(w.observe(st({ paused: true, position: 0 }), 40_800).decision, 'ended');
});

test('end watch: Spotify autoplays another song after the end → end', () => {
  // Seen in its last seconds: at once.
  assert.equal(run([...playing(210_000, 216_000), [7000, other({ position: 500 })]]).at(-1), 'ended');
  // Last seen at 80% (a slow poll): on the second look.
  const d = run([...playing(170_000, 175_000), [40_000, other({ position: 500 })], [41_000, other({ position: 1500 })]]);
  assert.deepEqual(d.slice(-2), ['maybe-other', 'ended']);
});

test('end watch: a different song for one look early on → no end; for two looks → end', () => {
  const blip = run([...playing(0, 5000), [5500, other({ position: 5000 })], [6000, st({ position: 6000 })], [7000, st({ position: 7000 })]]);
  assert.ok(!blip.includes('ended'), blip.join());
  const picked = run([...playing(0, 5000), [6000, other({ position: 300 })], [7000, other({ position: 1300 })]]);
  assert.deepEqual(picked.slice(-2), ['maybe-other', 'ended']);
  // A paused leftover state of another song early on never counts.
  const left = run([...playing(0, 5000), [6000, other({ paused: true, position: 0 })], [7000, other({ paused: true, position: 0 })]]);
  assert.ok(!left.includes('ended'), left.join());
});

test('end watch: a pause in the middle, a seek to 0, no state → no end', () => {
  const d = run([...playing(0, 50_000), [51_000, st({ paused: true, position: 50_000 })], [52_000, st({ paused: true, position: 0 })],
    [53_000, st({ paused: true, position: 0 })], [54_000, null]]);
  assert.ok(!d.includes('ended'), d.join());
});

test('end watch: a short track ends only after min(duration - 3 s, 30 s) played', () => {
  const short = { ...MY_SONG, durationMs: 12_000 };
  const s = (p, paused = false) => st({ position: p, paused, duration: 12_000 });
  assert.ok(!run([[0, s(0)], [1000, s(1000)], [11_000, s(0, true)], [12_000, s(0, true)]], short).includes('ended'));
  assert.equal(run([[0, s(0)], [4000, s(4000)], [8000, s(8000)], [9000, s(9000)], [10_000, s(0, true)]], short).at(-1), 'ended');
});

test('otherSong: title (and main artist when both sides have one)', () => {
  assert.equal(otherSong(MY_SONG, { name: 'Shake It Off - Taylor\'s Version' }), false);
  assert.equal(otherSong(MY_SONG, { name: 'Shake It Off', artists: [{ name: 'Taylor Swift' }] }), false);
  assert.equal(otherSong(MY_SONG, { name: 'Blank Space' }), true);
  assert.equal(otherSong(MY_SONG, { name: 'Shake It Off', artists: [{ name: 'Mariah Carey' }] }), true);
});

test('stateSummary: short, no tokens', () => {
  assert.deepEqual(stateSummary(st({ position: 1234.4 }, { previous_tracks: [{ uri: 'spotify:track:abcdef123456' }] })),
    { uri: 'ack:me', name: 'Shake It Off', paused: false, pos: 1234, dur: 219_000, prev: ['123456'] });
  assert.deepEqual(stateSummary(null), { none: true });
});

test('end watch: resumed near the end (another device gave it back) → the real end is not held by the start grace', () => {
  assert.equal(run([[0, st({ position: 214_000 })], [1000, st({ position: 215_000 })], [2000, st({ paused: true, position: 0 })]]).at(-1), 'ended');
  // Autoplay to a long song: our length counts, not the new song's.
  assert.equal(run([...playing(210_000, 216_000), [7000, other({ position: 500, duration: 600_000 })]]).at(-1), 'ended');
});
