// Spotify sign-in on the host page and the board (protocol.js SPOTIFY SIGN-IN). The session lives
// for this tab in sessionStorage, and in localStorage too only when "Stay signed in on this
// computer" is ticked (the teacher key's rules, CLAUDE.md invariant 6). Never in a URL.
//
// login() goes to Spotify with the Client ID the teacher chose; Spotify sends the browser back to
// /host/?code=…&state=…. This module takes that answer out of the address bar AS SOON AS IT LOADS
// (before music.js looks for a music-only login), and finish() has the server swap it.

import { authorizeUrl, pkceChallenge, randomToken, readRedirect } from '../../shared/spotify.js';
import { forgetSpotifyTokens, saveSpotifyTokens } from './spotify-auth.js';

const SESSION = 'cq.session'; // { session, account }
const PENDING = 'cq.signin'; // sessionStorage: { verifier, state, clientId, remember, then }

function get(area, key) { try { return JSON.parse(area.getItem(key)); } catch { return null; } }
function set(area, key, v) { try { area.setItem(key, JSON.stringify(v)); } catch { /* blocked */ } }
function del(area, key) { try { area.removeItem(key); } catch { /* blocked */ } }
const ss = () => { try { return sessionStorage; } catch { return null; } };
const ls = () => { try { return localStorage; } catch { return null; } };

/** This tab's sign-in, else this computer's: { session, account } or null. */
export function signedInAs() {
  const v = (ss() && get(ss(), SESSION)) || (ls() && get(ls(), SESSION));
  return typeof v?.session === 'string' && v.account?.profile?.id ? v : null;
}

/** True when this computer keeps the sign-in ("Stay signed in on this computer"). */
export function staysSignedIn() {
  return Boolean(ls() && get(ls(), SESSION));
}

/** Headers for a teacher call while signed in (else null). */
export function sessionHeaders() {
  const v = signedInAs();
  return v ? { authorization: `Bearer ${v.session}` } : null;
}

function keep(v, remember) {
  if (ss()) set(ss(), SESSION, v);
  if (!ls()) return;
  if (remember) set(ls(), SESSION, v);
  else del(ls(), SESSION);
}

/** A new name (renamed): kept wherever the sign-in is kept. */
export function updateAccount(account) {
  const v = signedInAs();
  if (!v) return;
  keep({ ...v, account }, staysSignedIn());
}

/** Forget the sign-in in this tab and on this computer, and the Spotify login with it. */
export function forgetSignin() {
  if (ss()) del(ss(), SESSION);
  if (ls()) del(ls(), SESSION);
  forgetSpotifyTokens();
}

/** Sign out: the server forgets the session too. */
export async function signOut() {
  const h = sessionHeaders();
  forgetSignin();
  if (h) await fetch('/api/auth/logout', { method: 'POST', headers: h }).catch(() => {});
}

/** Go to Spotify's login page with `clientId`. `then`: 'board' goes on to /board/ afterwards. */
export async function login({ clientId, remember = false, then = null }) {
  const verifier = randomToken(64), state = randomToken(16);
  if (ss()) set(ss(), PENDING, { verifier, state, clientId, remember, then });
  location.assign(authorizeUrl({ clientId, redirectUri: `${location.origin}/host/`, challenge: await pkceChallenge(verifier), state }));
}

// Spotify's answer to a sign-in, taken out of the address bar right away (null: none).
function takeReturn() {
  const pending = ss() && get(ss(), PENDING);
  if (!pending || location.pathname !== '/host/') return null;
  const redirect = readRedirect(location.search);
  if (!redirect) return null;
  del(ss(), PENDING);
  const u = new URL(location.href);
  for (const k of ['code', 'state', 'error', 'error_description']) u.searchParams.delete(k);
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  return { redirect, pending };
}
export const signinReturn = takeReturn();

async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: { message: 'Could not reach RoomDJ. Check the internet and try again.' } };
  }
}

/**
 * Finish a sign-in from signinReturn. → { ok: true, account, then } | { ok: false, message }
 */
export async function finish({ redirect, pending }) {
  if (!redirect.state || redirect.state !== pending.state) return { ok: false, message: 'That Spotify login did not come from this page. Try again.' };
  if (redirect.error) return { ok: false, message: redirect.error === 'access_denied' ? 'Spotify login was cancelled.' : 'Spotify login did not work. Try again.' };
  const r = await post('/api/auth/spotify', { code: redirect.code, verifier: pending.verifier, clientId: pending.clientId, redirectUri: `${location.origin}/host/` });
  if (!r.ok) return { ok: false, message: r.data.message || 'Spotify login did not work. Try again.' };
  saveSpotifyTokens(r.data.tokens, pending.clientId);
  keep({ session: r.data.session, account: r.data.account }, pending.remember);
  return { ok: true, account: r.data.account, then: pending.then };
}

/** Ask the server who is signed in (renamed elsewhere, hidden, signed out). → account | null (gone) | undefined (offline) */
export async function checkSignin() {
  const h = sessionHeaders();
  if (!h) return null;
  try {
    const r = await fetch('/api/auth/me', { headers: h });
    if (r.status === 401) {
      forgetSignin();
      return null;
    }
    if (!r.ok) return undefined;
    const { account, admin } = await r.json();
    const kept = { ...account, admin: admin === true }; // admin: only shows the link; the server decides
    updateAccount(kept);
    return kept;
  } catch {
    return undefined;
  }
}
