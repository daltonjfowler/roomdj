// The security headers every response gets (src/worker.js withSecurityHeaders), in their own
// module so the tests can read them: web/public/_headers repeats COMMON_HEADERS + PAGE_CSP for what
// Cloudflare serves without the Worker (wrangler.jsonc run_worker_first), and test/headers.test.mjs
// keeps the two the same.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Spotify Web Playback SDK (host page): its script, and the iframe it plays from.
  // Apple Music (host page): MusicKit JS v3 and the chunks it loads, from js-cdn.music.apple.com.
  "script-src 'self' https://sdk.scdn.co https://www.youtube.com https://js-cdn.music.apple.com",
  // YouTube (host page): iframe_api and the widget script it loads come from www.youtube.com; the
  // player itself is a youtube-nocookie.com iframe.
  "frame-src https://sdk.scdn.co https://www.youtube-nocookie.com https://www.youtube.com",
  "style-src 'self' 'unsafe-inline'",
  // Album art: Apple's image CDN (iTunes), Spotify's (i.scdn.co), YouTube thumbnails.
  "img-src 'self' data: https://*.mzstatic.com https://i.scdn.co https://i.ytimg.com",
  // iTunes 30-second previews.
  // MusicKit plays full songs through Media Source Extensions (blob: URLs).
  'media-src https://*.itunes.apple.com https://*.mzstatic.com https://*.apple.com blob:',
  // 'self' covers the same-origin wss:// room socket.
  // Spotify: login token swaps (accounts) and search / start a track (api), straight from the
  // host page. Spotify tokens never go to this server.
  // Apple Music: the catalog API (api.music.apple.com) and playback, licences and play reports
  // (*.itunes.apple.com), straight from the host page with the teacher's Apple login.
  // iTunes Search (itunes.apple.com): the room's song searches run from the host page (src/host-relay.js).
  "connect-src 'self' https://itunes.apple.com https://accounts.spotify.com https://api.spotify.com https://api.music.apple.com https://*.itunes.apple.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

// Every other page (the student page, legal, 404) loads only this site's own scripts and talks
// only to this server and iTunes Search (browsing before joining searches iTunes from the
// student's browser): no music players there, so an injected script could not lean on YouTube's
// or Spotify's script hosts either.
export const PAGE_CSP = CONTENT_SECURITY_POLICY
  .replace(/script-src [^;]+/, "script-src 'self'")
  .replace(/frame-src [^;]+/, "frame-src 'none'")
  .replace(/connect-src [^;]+/, "connect-src 'self' https://itunes.apple.com");

// The board (/board/, protocol.js BOARD + REMOTE): the projector page. Like the student page, and
// stricter: it plays NOTHING (media-src 'none', no autoplay or DRM), talks only to this server (its
// room socket), and sends no Referer at all (its link's fragment holds the board token).
export const BOARD_CSP = PAGE_CSP
  .replace(/media-src [^;]+/, "media-src 'none'")
  .replace(/connect-src [^;]+/, "connect-src 'self'");
export const BOARD_PERMISSIONS = 'serial=(), usb=(), camera=(), microphone=(), geolocation=(), payment=(), encrypted-media=(), autoplay=()';

export const COMMON_HEADERS = [
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  // encrypted-media + autoplay: Spotify's player iframe plays DRM audio.
  ['permissions-policy', 'serial=(), usb=(), camera=(), microphone=(), geolocation=(), payment=(), encrypted-media=(self "https://sdk.scdn.co" "https://www.youtube-nocookie.com"), autoplay=(self "https://sdk.scdn.co" "https://www.youtube-nocookie.com")'],
  ['cross-origin-opener-policy', 'same-origin'],
];
