// Playback on the host page, behind one small interface so other music services can slot in.
// Phase 1 plays iTunes 30-second previews (players/preview.js), which needs no music account.
// A later service (Spotify, YouTube, Apple Music) adds a file in players/ with the same shape and a
// line in PLAYERS; host.js only ever talks to this interface.
//
// @typedef {import('../../shared/protocol.js').Song} Song
//
// Player:
//   name                    short label shown on the host page ("30-second previews")
//   service                 the "Music from" key ('preview', 'spotify', ...), set by createPlayer;
//                           the host page tells the room (message 'service')
//   canPlay(song) → bool    false when this service has no way to play the song (host skips it).
//                           Songs from Spotify's catalog ('sp:' ids) play only through Spotify:
//                           Spotify's Developer Policy forbids using them with another service
//   load(song) → Promise    get ready to play `song` from the start; replaces any loaded song
//   play() → Promise        start or resume; rejects when the browser blocks sound (no click yet)
//   pause()                 pause; play() resumes
//   stop()                  unload; nothing plays and no 'ended' fires
//   setVolume(0..1)
//   onEnded(fn)             fn() when the loaded song finishes by itself
//   onError(fn)             fn(message) when the loaded song cannot play
//   onTime(fn)              fn(seconds, durationSeconds) while playing, for the progress bar
//   destroy()               optional: leave for good (another service was picked)
//   onInterrupted(fn)       optional: fn(message) when playback left this page by itself (Spotify:
//                           another device took over); the host shows it and waits for Start music
//
// play() may reject with an Error named 'PlayerNotReady' (for example "Connect Spotify first");
// the host page shows its message and waits for another Start music click.
import { createPreviewPlayer } from './players/preview.js';
import { createSpotifyPlayer } from './players/spotify.js';
import { createYoutubePlayer } from './players/youtube.js';
import { createApplePlayer } from './players/apple.js';

export const PLAYERS = {
  preview: createPreviewPlayer,
  spotify: createSpotifyPlayer,
  youtube: createYoutubePlayer,
  apple: createApplePlayer,
};

/** @returns {Player} */
export function createPlayer(service = 'preview', options = {}) {
  const make = PLAYERS[service];
  if (!make) throw new Error(`No player for ${service}`);
  const player = make(options);
  player.service = service;
  return player;
}
