// Spotify login for the host page: Authorization Code with PKCE. There is no client secret
// anywhere, and the tokens never go to students (invariant 1): they live in this computer's
// localStorage so a refresh keeps the login. A Spotify SIGN-IN (account.js) has the RoomDJ server
// swap the code once (it keeps no token: invariant 27) and hands the tokens to saveSpotifyTokens;
// the old teacher-key way (local tests) swaps and refreshes here, with accounts.spotify.com only.
//
// Login: login() saves a code verifier + state in sessionStorage and goes to Spotify. Spotify sends
// the browser back to <origin>/host/?code=…&state=…; takeSpotifyRedirect() strips that from the
// address bar at once, and finish() checks the state and swaps the code for tokens.

import {
  SPOTIFY_TOKEN_URL, authorizeUrl, needsRefresh, pkceChallenge, randomToken, readRedirect, tokenRequestBody, tokensFromReply,
} from '../../shared/spotify.js';

const TOKENS = 'cq.spotify';
const PENDING = 'cq.spotifyLogin';

const store = (area) => ({
  get(key) { try { return JSON.parse(area().getItem(key)); } catch { return null; } },
  set(key, v) { try { area().setItem(key, JSON.stringify(v)); } catch { /* blocked */ } },
  del(key) { try { area().removeItem(key); } catch { /* blocked */ } },
});
const local = store(() => localStorage);
const session = store(() => sessionStorage);

/** Read Spotify's answer from the address bar (if any) and remove it from there right away. */
export function takeSpotifyRedirect() {
  const found = readRedirect(location.search);
  if (!found) return null;
  const u = new URL(location.href);
  for (const k of ['code', 'state', 'error', 'error_description']) u.searchParams.delete(k);
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  return found;
}

/** Keep tokens a Spotify sign-in got (account.js; the server swapped the code) for playback here. */
export function saveSpotifyTokens(tokens, clientId) {
  if (tokens?.access) local.set(TOKENS, { ...tokens, clientId });
}

/** Sign out: this computer forgets the Spotify login too. */
export function forgetSpotifyTokens() {
  local.del(TOKENS);
}

export function createSpotifyAuth(clientId) {
  const redirectUri = `${location.origin}/host/`;
  let tokens = local.get(TOKENS);
  if (tokens?.clientId !== clientId) tokens = null;
  let refreshing = null;

  function save(t) {
    tokens = t ? { ...t, clientId } : null;
    if (tokens) local.set(TOKENS, tokens);
    else local.del(TOKENS);
  }

  async function post(body) {
    const r = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  async function refresh() {
    const old = tokens;
    if (!old?.refresh) return null;
    try {
      const r = await post(tokenRequestBody({ clientId, refreshToken: old.refresh }));
      const next = r.ok ? tokensFromReply(r.data, Date.now(), old.refresh) : null;
      if (next) {
        save(next);
        return next.access;
      }
      // invalid_grant: the login was taken back (or the refresh token is used up). Log out.
      if (r.status === 400 || r.status === 401) save(null);
    } catch {
      // Offline for a moment: keep the login and try again next time.
    }
    return tokens && tokens.expiresAt > Date.now() ? tokens.access : null;
  }

  return {
    clientId,
    redirectUri,
    connected: () => Boolean(tokens?.refresh || (tokens?.access && tokens.expiresAt > Date.now())),

    /** Go to Spotify's login page. Resolves with the URL (the page is leaving). */
    async login() {
      const verifier = randomToken(64), state = randomToken(16);
      session.set(PENDING, { verifier, state, clientId });
      const url = authorizeUrl({ clientId, redirectUri, challenge: await pkceChallenge(verifier), state });
      location.assign(url);
      return url;
    },

    /** Finish a login from takeSpotifyRedirect()'s answer. → { ok: true } | { ok: false, message } */
    async finish(redirect) {
      const pending = session.get(PENDING);
      session.del(PENDING);
      if (!pending || pending.clientId !== clientId || !redirect.state || pending.state !== redirect.state) {
        return { ok: false, message: 'That Spotify login did not come from this page. Click Connect Spotify to try again.' };
      }
      if (redirect.error) {
        return { ok: false, message: redirect.error === 'access_denied' ? 'Spotify login was cancelled.' : 'Spotify login did not work. Try again.' };
      }
      try {
        const r = await post(tokenRequestBody({ clientId, code: redirect.code, verifier: pending.verifier, redirectUri }));
        const t = r.ok ? tokensFromReply(r.data) : null;
        if (!t) return { ok: false, message: 'Spotify login did not work. Try again.' };
        save(t);
        return { ok: true };
      } catch {
        return { ok: false, message: 'Could not reach Spotify. Check the internet and try again.' };
      }
    },

    /** A usable access token (refreshed first when it is about to run out), or null. */
    async token() {
      if (!tokens) return null;
      if (!needsRefresh(tokens)) return tokens.access;
      refreshing ??= refresh().finally(() => { refreshing = null; });
      return refreshing;
    },

    /** After a 401 from Spotify: get a new access token now. */
    async refreshNow() {
      refreshing ??= refresh().finally(() => { refreshing = null; });
      return refreshing;
    },

    disconnect() {
      save(null);
    },
  };
}
