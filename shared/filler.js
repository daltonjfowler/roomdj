// Background music ("filler") on the host page (web/src/filler.js): the teacher pastes a YouTube link
// (a video or a live stream, e.g. a lofi or jazz stream; or a playlist) or a Spotify playlist or
// album link, and it plays while no student song does. Pure: no DOM, so Node tests run it.
//
// Rules: it never plays at the same time as a queue song (a song that starts pauses it), it may
// come back by itself once nothing plays and the queue is empty ("resume when the queue is
// empty", on by default), and cleanup mode or the room closing stops it.

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_LIST = /^[A-Za-z0-9_-]{2,64}$/;
const SP_ID = /^[A-Za-z0-9]{22}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

export const FILLER_HELP = 'Paste a YouTube video, live stream or playlist link, or a Spotify playlist or album link.';

/**
 * What a pasted link plays:
 *   { ok: true, kind: 'youtube', videoId }          watch?v=, youtu.be/, /live/, /embed/, /shorts/
 *   { ok: true, kind: 'youtubeList', list }         youtube.com/playlist?list=
 *   { ok: true, kind: 'spotify', type, id, contextUri }   open.spotify.com/playlist|album/<id>
 *                                                   (or spotify:playlist:<id>)
 *   { ok: false, message }
 */
export function parseFillerLink(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, message: FILLER_HELP };
  const sp = /^spotify:(playlist|album):([A-Za-z0-9]{22})$/.exec(raw);
  if (sp) return spotify(sp[1], sp[2]);
  if (YT_ID.test(raw)) return { ok: true, kind: 'youtube', videoId: raw };
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false, message: FILLER_HELP }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, message: FILLER_HELP };
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    return YT_ID.test(parts[0] ?? '') ? { ok: true, kind: 'youtube', videoId: parts[0] } : bad('That YouTube link has no video in it.');
  }
  if (YT_HOSTS.has(host)) {
    const v = url.searchParams.get('v');
    if (parts[0] === 'watch' && YT_ID.test(v ?? '')) return { ok: true, kind: 'youtube', videoId: v };
    if (['live', 'embed', 'shorts', 'v'].includes(parts[0]) && YT_ID.test(parts[1] ?? '')) return { ok: true, kind: 'youtube', videoId: parts[1] };
    const list = url.searchParams.get('list');
    if (parts[0] === 'playlist' && YT_LIST.test(list ?? '')) return { ok: true, kind: 'youtubeList', list };
    return bad('That YouTube link has no video in it. Open the video (or live stream) and copy its address.');
  }
  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    const p = /^intl-[a-z-]+$/i.test(parts[0] ?? '') ? parts.slice(1) : parts; // open.spotify.com/intl-de/album/...
    if ((p[0] === 'playlist' || p[0] === 'album') && SP_ID.test(p[1] ?? '')) return spotify(p[0], p[1]);
    if (p[0] === 'track') return bad('That is one Spotify song. Paste a playlist or album link instead.');
    return bad('Paste a Spotify playlist or album link (open.spotify.com/playlist/...).');
  }
  return bad(FILLER_HELP);
}

const bad = (message) => ({ ok: false, message });
const spotify = (type, id) => ({ ok: true, kind: 'spotify', type, id, contextUri: `spotify:${type}:${id}` });

/** The saved filler from storage text: { link, resume } with a link that still parses, or null. */
export function loadFiller(text) {
  let saved = null;
  try { saved = JSON.parse(text); } catch { return null; }
  if (!saved || typeof saved.link !== 'string' || !parseFillerLink(saved.link).ok) return null;
  return { link: saved.link.trim(), resume: saved.resume !== false };
}

/**
 * The filler's state machine. state: 'off' (the teacher has it off) | 'playing' | 'held' (paused
 * for a queue song; comes back when the queue is empty, if `resume` is on).
 * events:
 *   'toggle'      the teacher's button (or G): off/held → playing, playing → off. Refused while
 *                 `blocked` (cleanup mode, no room, no link).
 *   'queuePlays'  a queue song starts: playing → held (resume on) or off (resume off)
 *   'idle'        nothing plays and the queue is empty: held → playing (resume on) or off
 *   'stop'        cleanup mode, the room closed, the link removed: → off
 * → { state, action } action: 'play' | 'pause' | 'stop' | 'refuse' | null (nothing to do)
 */
export function fillerStep(state, event, { resume = true, blocked = false } = {}) {
  const s = state === 'playing' || state === 'held' ? state : 'off';
  switch (event) {
    case 'toggle':
      if (s === 'playing') return { state: 'off', action: 'pause' };
      if (blocked) return { state: 'off', action: 'refuse' };
      return { state: 'playing', action: 'play' };
    case 'queuePlays':
      return s === 'playing' ? { state: resume ? 'held' : 'off', action: 'pause' } : { state: s, action: null };
    case 'idle':
      if (s !== 'held') return { state: s, action: null };
      if (blocked || !resume) return { state: 'off', action: null };
      return { state: 'playing', action: 'play' };
    case 'stop':
      return { state: 'off', action: s === 'off' ? null : 'stop' };
    default:
      return { state: s, action: null };
  }
}
