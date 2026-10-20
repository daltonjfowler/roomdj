// Spotify helpers with no DOM, so Node tests can run them: PKCE login pieces, matching an iTunes
// song to a Spotify track (and the explicit-version safety rule), and spotting the end of a track
// in the Web Playback SDK's player state. The host page uses them (web/src/spotify-auth.js and
// web/src/players/spotify.js). Tokens never leave the teacher's browser.

import { normalizeWords, promptTitle } from './filter.js';

export const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API = 'https://api.spotify.com/v1';
// streaming + user-read-email + user-read-private: what the Web Playback SDK needs.
// The two playback scopes: start a track on our device, read what it is doing.
// playlist-modify-private: ⭐ RoomDJ Favs, the teacher's own private playlist (players/spotify.js saveToFavs).
export const SPOTIFY_SCOPES = [
  'streaming', 'user-read-email', 'user-read-private', 'user-read-playback-state', 'user-modify-playback-state',
  'playlist-modify-private',
];
/** A Spotify Client ID is 32 hex characters. */
export const CLIENT_ID_PATTERN = /^[0-9a-f]{32}$/i;
/** Refresh the access token this long before it runs out. */
export const REFRESH_EARLY_MS = 2 * 60 * 1000;
/** A Spotify track this far from the iTunes length is a different recording. */
export const MAX_DURATION_DIFF_MS = 10_000;

// ---- PKCE (RFC 7636) ---------------------------------------------------------------------------

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random base64url text from `bytes` random bytes (64 bytes → 86 characters, inside 43..128). */
export function randomToken(bytes = 64) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** S256 code challenge for a code verifier. */
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authorizeUrl({ clientId, redirectUri, challenge, state, scopes = SPOTIFY_SCOPES }) {
  const u = new URL(SPOTIFY_AUTHORIZE_URL);
  u.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: scopes.join(' '),
  }).toString();
  return u.toString();
}

/** Form body for the token endpoint: exchange a code, or refresh. No client secret (PKCE). */
export function tokenRequestBody({ clientId, code, verifier, redirectUri, refreshToken }) {
  const p = refreshToken
    ? { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }
    : { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier };
  return new URLSearchParams(p).toString();
}

/**
 * Saved tokens from a token endpoint reply. A refresh reply may leave out refresh_token: keep the
 * old one then. Returns null for a reply without an access token.
 */
export function tokensFromReply(reply, now = Date.now(), oldRefresh = null) {
  if (!reply || typeof reply.access_token !== 'string' || !reply.access_token) return null;
  const seconds = Number(reply.expires_in) > 0 ? Number(reply.expires_in) : 3600;
  return {
    access: reply.access_token,
    refresh: typeof reply.refresh_token === 'string' && reply.refresh_token ? reply.refresh_token : oldRefresh,
    expiresAt: now + seconds * 1000,
  };
}

export function needsRefresh(tokens, now = Date.now()) {
  return !tokens?.access || !(tokens.expiresAt > now + REFRESH_EARLY_MS);
}

/** What the redirect back from Spotify carried: { code, state } or { error, state } or null. */
export function readRedirect(search) {
  const p = new URLSearchParams(search);
  const state = p.get('state');
  if (p.get('code')) return { code: p.get('code'), state };
  if (p.get('error')) return { error: p.get('error'), state };
  return null;
}

// ---- Matching an iTunes song to a Spotify track ------------------------------------------------

/** Title without version labels ("Remastered", "Radio Edit", "feat. X"), as plain words. */
export function matchTitle(title) {
  const t = promptTitle(title)
    .replace(/\s*[([](feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '');
  return normalizeWords(t.replace(/&/g, ' and '));
}

/** The artist words, with "&", "and", "feat." and commas as separators. */
function artistNames(text) {
  return String(text ?? '')
    .split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/i)
    .map((a) => normalizeWords(a))
    .filter(Boolean);
}

/** Spotify search text for a song: field filters on the cleaned title and the main artist. */
export function searchQuery(song) {
  const title = promptTitle(song.title).replace(/"/g, '');
  const artist = (artistNames(song.artist)[0] ?? normalizeWords(song.artist)).replace(/"/g, '');
  return `track:"${title}" artist:"${artist}"`;
}

/** Looser search text, for a second try (finds clean versions filed under another title). */
export function looseQuery(song) {
  return `${matchTitle(song.title)} ${artistNames(song.artist)[0] ?? ''}`.trim();
}

function wordOverlap(a, b) {
  const x = new Set(a.split(' ').filter(Boolean)), y = new Set(b.split(' ').filter(Boolean));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.max(x.size, y.size);
}

export function titleScore(itunesTitle, spotifyTitle) {
  const a = matchTitle(itunesTitle), b = matchTitle(spotifyTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return 0.8;
  return wordOverlap(a, b);
}

export function artistScore(itunesArtist, spotifyArtists) {
  const mine = artistNames(itunesArtist);
  const theirs = (spotifyArtists ?? []).flatMap((a) => artistNames(a?.name));
  if (!mine.length || !theirs.length) return 0;
  // The main artist on both sides is the strong signal.
  if (mine[0] === theirs[0]) return 1;
  if (theirs.includes(mine[0]) || mine.includes(theirs[0])) return 0.9;
  return Math.max(...theirs.map((t) => wordOverlap(mine[0], t)));
}

/**
 * How well a Spotify track matches an iTunes song: a number, or 0 when it is not the same
 * recording (title or artist too different, or the length is off by more than ~10 seconds).
 */
export function matchScore(song, track) {
  if (!track || typeof track.uri !== 'string' || !track.uri.startsWith('spotify:track:')) return 0;
  if (track.is_playable === false) return 0;
  const t = titleScore(song.title, track.name);
  const a = artistScore(song.artist, track.artists);
  if (t < 0.8 || a < 0.8) return 0;
  let timing = 0.5;
  if (song.durationMs > 0 && track.duration_ms > 0) {
    const diff = Math.abs(song.durationMs - track.duration_ms);
    if (diff > MAX_DURATION_DIFF_MS) return 0;
    timing = 1 - diff / MAX_DURATION_DIFF_MS;
  }
  return t + a + timing * 0.5;
}

/**
 * The best Spotify track for an iTunes song out of search results. School rule: never play an
 * explicit track. Returns
 *   { status: 'ok', uri, name }     a non-explicit match
 *   { status: 'explicit' }          the song is on Spotify, but only as an explicit track
 *   { status: 'none' }              no track is the same song
 */
export function pickMatch(song, tracks) {
  let best = null, bestScore = 0, sawExplicit = false;
  for (const track of tracks ?? []) {
    const score = matchScore(song, track);
    if (!score) continue;
    if (track.explicit !== false) { sawExplicit = true; continue; } // missing flag counts as explicit
    if (score > bestScore) { best = track; bestScore = score; }
  }
  if (best) return { status: 'ok', uri: best.uri, name: best.name };
  return { status: sawExplicit ? 'explicit' : 'none' };
}

/** pickMatch over several result lists (first search, then the looser one): the best answer. */
export function combineMatches(results) {
  return results.find((r) => r.status === 'ok') ?? results.find((r) => r.status === 'explicit') ?? { status: 'none' };
}

/** Why Spotify cannot play a song here (the host page adds "Skipping it."). */
export function skipMessage(song, status) {
  const what = `"${song.title}" by ${song.artist}`;
  if (status === 'explicit') return `Spotify only has the explicit version of ${what}.`;
  return `Spotify does not have ${what}.`;
}

// ---- End of track from the Web Playback SDK ------------------------------------------------------
//
// The SDK has no "ended" event, and its states are noisy: the track uri can change a few seconds
// into the SAME song (Spotify relinks tracks, and since Feb 2026 there is no `linked_from` to see
// it), it can report paused at 0 while it buffers, and previous_tracks can hold our track from an
// earlier play. So the end is never taken from one state: an end needs the same song to have
// really played, and (except the clear cases) the same answer twice, at least 700 ms apart.

export const END_RULES = {
  /** Two observations of an end must be at least this far apart. */
  CONFIRM_MS: 700,
  /** Paused at 0 this soon after the song started is loading, never the end. */
  START_GRACE_MS: 10_000,
  /** "Near the end": this close to it, or this far through. */
  NEAR_END_MS: 5000,
  NEAR_FRACTION: 0.7,
  /** Never end before the song played min(duration - 3 s, 30 s), unless another song is on. */
  SAFETY_MAX_MS: 30_000,
  SAFETY_TAIL_MS: 3000,
};

/**
 * True when the SDK's track is a different SONG from ours (not just a different uri): the title
 * is not a match, or both sides name artists and the main ones differ.
 */
export function otherSong(song, track) {
  if (!track) return false;
  if (titleScore(song?.title, track.name) < 0.8) return true;
  const names = (track.artists ?? []).filter((a) => a?.name);
  return Boolean(song?.artist && names.length && artistScore(song.artist, names) < 0.5);
}

const tail = (uri) => (typeof uri === 'string' ? uri.slice(-6) : '');

/** A short, token-free summary of an SDK state, for the diagnostics log. */
export function stateSummary(state) {
  if (!state) return { none: true };
  const cur = state.track_window?.current_track;
  return {
    uri: tail(cur?.uri),
    name: typeof cur?.name === 'string' ? cur.name.slice(0, 60) : '',
    paused: Boolean(state.paused),
    pos: Math.round(Number(state.position) || 0),
    dur: Math.round(Number(state.duration) || 0),
    prev: (state.track_window?.previous_tracks ?? []).map((t) => tail(t?.uri)),
  };
}

/**
 * Watches the SDK states for one song we started. `observe(state, now)` returns
 *   { decision, uri }
 * decision: 'wait' (our song is not on yet), 'start' (it is now), 'play', 'relink' (same song,
 * new uri: adopted), 'early-paused-0' / 'paused-0-ignored' (not the end), 'maybe-end' /
 * 'maybe-other' (an end seen once: needs a second look), 'ended' (call ended()).
 * `uri` is the track Spotify plays for our song (null before 'start').
 * `ignoreContext`: the background music's context uri (spotify:playlist:...): a state from it
 * that is not our song is never an end ('filler-ignored'), so a late background music state on
 * the same speaker cannot skip a queue song.
 */
export function createEndWatch({ song, startedUri, ignoreContext = null, rules = END_RULES } = {}) {
  let playingUri = null;
  let startAt = 0;
  let maxPos = 0; // the furthest position seen while our song played (not paused)
  let lastPlaying = null; // the last not-paused state of our song
  let pending = null; // { kind, at }: an end seen once

  const durationOf = (state) => (state?.duration > 0 ? state.duration : (song?.durationMs > 0 ? song.durationMs : 0));
  const confirm = (kind, now) => {
    if (pending?.kind === kind) {
      if (now - pending.at >= rules.CONFIRM_MS) return 'ended';
    } else pending = { kind, at: now };
    return kind === 'other' ? 'maybe-other' : 'maybe-end';
  };

  function observe(state, now = Date.now()) {
    if (!state) return { decision: 'none', uri: playingUri };
    const cur = state.track_window?.current_track;
    const ours = (t) => Boolean(t) && (t.uri === playingUri || t.uri === startedUri || !otherSong(song, t));
    if (ignoreContext && state.context?.uri === ignoreContext && !(cur && ours(cur))) {
      return { decision: 'filler-ignored', uri: playingUri };
    }

    if (!playingUri) {
      // Wait for Spotify to say our song plays (by uri, or by name when Spotify relinked it).
      if (!cur || state.paused || !ours(cur)) return { decision: 'wait', uri: null };
      playingUri = cur.uri;
      startAt = now;
    }
    let decision = 'play';
    const dur = durationOf(!cur || ours(cur) ? state : lastPlaying); // our song's length, not another's
    const nearEnd = (pos) => dur > 0 && (dur - pos < rules.NEAR_END_MS || pos >= dur * rules.NEAR_FRACTION);
    const safe = dur > 0 && maxPos >= Math.min(dur - rules.SAFETY_TAIL_MS, rules.SAFETY_MAX_MS);

    if (cur && cur.uri !== playingUri) {
      if (ours(cur)) {
        playingUri = cur.uri;
        decision = 'relink';
      } else {
        // A different song is on: Spotify's autoplay after the end, or someone picked another song.
        // Right after we saw the last seconds of ours, that is clearly the end.
        if (safe && lastPlaying && dur - lastPlaying.position < rules.NEAR_END_MS) return { decision: 'ended', uri: playingUri };
        // Early on, only another song that really plays counts (not a paused leftover state).
        if (!safe && state.paused) {
          pending = null;
          return { decision: 'other-paused-ignored', uri: playingUri };
        }
        return { decision: confirm('other', now), uri: playingUri };
      }
    }

    if (state.paused && Number(state.position) === 0) {
      // The clear case: playing in its last seconds, then paused at 0.
      if (safe && lastPlaying && dur - lastPlaying.position < rules.NEAR_END_MS) return { decision: 'ended', uri: playingUri };
      if (now - startAt < rules.START_GRACE_MS) {
        pending = null;
        return { decision: 'early-paused-0', uri: playingUri };
      }
      if (!safe || !(maxPos > 0 && nearEnd(maxPos))) {
        pending = null;
        return { decision: 'paused-0-ignored', uri: playingUri };
      }
      return { decision: confirm('paused-0', now), uri: playingUri };
    }

    pending = null;
    if (!state.paused) {
      lastPlaying = state;
      maxPos = Math.max(maxPos, Number(state.position) || 0);
    }
    if (decision === 'play' && startAt === now) decision = 'start';
    else if (decision === 'play' && state.paused) decision = 'paused';
    return { decision, uri: playingUri };
  }

  return {
    observe,
    get uri() { return playingUri; },
    get maxPos() { return maxPos; },
  };
}
