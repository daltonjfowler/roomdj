// Spotify sign-in rules (protocol.js SPOTIFY SIGN-IN). Pure JS: the Worker (src/auth.js) and the
// Node tests use it.

import { OWN_PROFILE_PREFIX, SPOTIFY_CLIENT_ID_PATTERN } from './protocol.js';
import { cleanProfileName, newProfileId } from './profiles.js';

/** A Client ID as typed (spaces dropped, lower case), or null when it is not 32 hex characters. */
export function cleanClientId(raw) {
  const id = String(raw ?? '').trim().toLowerCase();
  return SPOTIFY_CLIENT_ID_PATTERN.test(id) ? id : null;
}

/** 'shared' when the login came from this server's own Spotify app, else 'own'. */
export function appOf(clientId, sharedClientId) {
  const shared = cleanClientId(sharedClientId);
  return shared && cleanClientId(clientId) === shared ? 'shared' : 'own';
}

/** The name a new teacher starts with: their Spotify display name if students may see it, else "Teacher". */
export function startName(displayName) {
  const v = cleanProfileName(displayName);
  return v.ok ? v.name : 'Teacher';
}

/** A private profile's id (never one of the list's ids: those have no OWN_PROFILE_PREFIX). */
export function newOwnProfileId(random) {
  return OWN_PROFILE_PREFIX + newProfileId([], random) + newProfileId([], random);
}

/** What a page learns about the signed-in teacher. */
export function accountView(profile, app, clientId) {
  return {
    profile: { id: profile.id, name: profile.name, ...(profile.legacy ? { legacy: true } : {}) },
    app,
    clientId,
  };
}
