// The contract between the pages (web/) and the server (src/). Pure JS, no DOM: the Worker, the
// pages and the Node tests all import it. Change it here first, then both sides.
//
// ROOMS AND CLASS CODES
//   A teacher opens a room for the day with the teacher key, a class code for the board (suggested
//   by shared/code.js, or the teacher's own) and an `until` time (the host page sends the end of
//   today in the teacher's own time zone, or one class period). The room closes itself at `until`
//   (Durable Object alarm), or after 12 idle hours, or when the teacher closes it.
//   Each room is one Durable Object (src/room.js) named by a random room id (ROOM_ID_PATTERN).
//   The code is only the way in: KV `room:<codeHash>` → { id, until } (TTL: until) maps a code to
//   its room, and the room keeps the same hash and checks it again (constant time), so a stale KV
//   copy never lets an old code in. Codes are stored only as hashes, never as text.
//   Students join with the code (POST /api/join): the room admits that device and the page gets
//   the room id, which it uses from then on (a refresh rejoins without the code). The teacher can
//   change the code mid-day: admitted students stay in, new devices need the new code.
//   Wrong codes: a per-device lockout (src/lockout.js: 5 wrong in a row lock 5 s, then 10, 20 ...
//   300 s) plus JOIN_RATE_IP per address, counted BEFORE the compare. Never a per-address lockout:
//   a school shares one IP, and one student must never lock out the class or the teacher.
//
// TEACHER PROFILES (Dalton, 2026-10-07; shared/profiles.js, src/profiles.js): every teacher shares the
//   teacher key; after it the host page asks "Who's teaching?". No PIN (Dalton chose trust). KV
//   `profiles` = Profile[] (at most PROFILES_MAX): { id (PROFILE_ID_PATTERN), name (PROFILE_NAME_MAX
//   letters, one line, word-screened like teacher notes), createdAt, legacy?: true, archived?: true }.
//   Teacher-level records are scoped per profile (src/teacher-kv.js teacherKvKey): settings
//   (incl. bellSchedule), banned, approved:* (and approved:song:*), favorites. The LEGACY profile
//   reads and writes the old plain keys, so the data from before profiles is simply its data;
//   every other profile uses p:<id>:<name>. Shared facts stay global: verdict:*, nick:*, search
//   and song caches, yt:*, room:<hash> code routes, catalog tokens, `profiles` itself.
//   First use (any teacher endpoint): no `profiles` yet → the two SEED_PROFILES are written ("Teacher
//   1" = legacy: the existing data; "Teacher 2" = fresh; teachers rename them). Fixed seed ids, so
//   running it twice (or twice at once) writes the same list. A `profiles` list that exists is never
//   reseeded or rewritten by the migration, whatever ids it has (a live install keeps its own). Profiles are never deleted: Hide (archived) keeps all
//   their data and Show brings them back.
//   GET   /api/teacher/profiles                     header x-teacher-key  → 200 { profiles: Profile[] }
//   POST  /api/teacher/profiles  { name }           → 201 { profile, profiles } | 400 name (message says
//        why) | 409 name_taken | 409 full (PROFILES_MAX, hidden ones count)
//   PATCH /api/teacher/profiles/:id  { name?, archived? }  → 200 { profile, profiles } | 404 no_profile
//        | 400 name | 409 name_taken | 409 last (the last teacher who is not hidden)
//   Every other teacher route below names the profile: header x-teacher-profile: <id> (opening a
//   room may send it as body.profile instead). Missing, unknown or hidden → 400 { error: 'profile' }.
//   A room keeps its profile ({ id, name, legacy }) for its whole life (state.profile; a room saved
//   before profiles has null = the legacy profile); "Take back my room" keeps it.
//
// HTTP
//   POST /api/teacher/rooms  { code, until, cleanupAt?, profile? }   header x-teacher-key, x-teacher-profile
//        → 200 { room, code, until, cleanupAt, hostToken }   code = the normalized code
//        until = when class ends (the host page's "Class ends at", or the end of today), absolute ms
//        in the teacher's own time zone; cleanupAt = when cleanup starts (null or missing = no
//        cleanup), after now and before until (CLEANUP below). Both are BELL times: the server adds
//        the teacher's settings.bellOffsetSeconds before checking and keeping them, and answers with
//        the real moments (BELL OFFSET below)
//        | 400 invalid_code (message says why) | 400 until | 400 cleanup | 400 profile | 409 code_taken (another open room has it)
//   POST /api/teacher/board   header x-teacher-key, x-teacher-profile   → the board's sign-in
//        (BOARD + REMOTE, BOARD SIGN-IN below): { room, boardToken, until } | 404 no_room
//   POST /api/teacher/rooms/reclaim  { code }   header x-teacher-key
//        (no profile needed: any teacher with the key may take a room back; it keeps its own profile)
//        → 200 { room, code, until, cleanupAt, hostToken }   "Take back my room": the teacher's room is open, but
//        its host token is on another computer (or a closed window lost it). The room is found by
//        the code's hash (KV, then the room compares it again in constant time, like join), gets a
//        NEW host token (only its hash is kept), and every host page still connected is sent
//        { t: 'error', error: 'host_moved' } and closed with 4002 (it does not reconnect).
//        | 403 code (wrong code, or no open room has it: the same answer as join)
//        | 429 busy (JOIN_RATE_IP, counted before the compare). Same key check as opening a room
//        (300 ms wait on a wrong key, no lockout). Anyone with a teacher key who knows a room's code
//        can take it back: both keys are the same trust (TEACHER_KEY, TEACHER_KEY_2).
//   CLEANUP (Dalton, 2026-10-06; shared/classtime.js): at cleanupAt the room enters cleanup mode
//   (state.cleanup true): suggestions are refused (reason 'cleanup', "🧹 Cleanup time! Suggestions
//   are closed for today."), the host page fades the music out over about 5 s and pauses (it asks
//   for no next song), the big screen shows "🧹 Cleanup time!" with a countdown to until (the bell),
//   and students see a cleanup banner. Votes still count. The room closes at until as before. The
//   teacher can change both times ('times') and stop cleanup ('cleanup' on: false = "Keep the
//   music going": cleanupAt becomes null and the music comes back).
//   BELL OFFSET (2026-10-07; shared/classtime.js shiftTimes, bellTime): settings.bellOffsetSeconds
//   (-120..120, default 0; Settings → Class time, kept per teacher by Save as my default). "The bell
//   rings 3 s late" = +3. The times a teacher types or picks (and the bell schedule) are BELL times,
//   as printed on the school's schedule. Pages always SEND bell times (POST /api/teacher/rooms
//   until/cleanupAt, the 'times' message). The server adds the offset ONCE and keeps the REAL
//   moments: room.until = typed until + offset, room.cleanupAt = typed cleanup + offset (null stays
//   null). Everything that happens at a time uses the real moment: the alarm, cleanup start, the
//   auto-close at until, the code route's expiry, the board's open-room list, and every countdown.
//   State carries the real until/cleanupAt plus bellOffsetSeconds; a page SHOWS a clock time as
//   bellTime(ms) = ms - offset (so "Class ends 10:10" still matches the printed schedule) and counts
//   down to the real ms. Changing the room's offset (a 'settings' message) moves until and a
//   cleanupAt not yet started by the difference (the same typed times, a new real moment).
//   SERVER CLOCK: every State carries serverNow (ms, the server's clock when it was made). Pages keep
//   a clock offset (shared/servertime.js: the median of the last samples, outliers over 1 s from it
//   ignored) and run every countdown and "in 12 min" on serverNow-corrected time, so a Chromebook
//   whose clock is wrong still shows the right countdown.
//   GET  /api/teacher/settings                   header x-teacher-key, x-teacher-profile  → 200 TeacherSettings
//   PUT  /api/teacher/settings  TeacherSettings  header x-teacher-key, x-teacher-profile  → 200 TeacherSettings
//        (the profile's own settings; a new profile starts with DEFAULT_SETTINGS)
//        (may be partial: a missing field keeps its saved value, e.g. the bell schedule editor
//        sends only { bellSchedule })
//   GET  /api/config                             → 200 { services: { preview: true,
//        spotify: { clientId, catalog: boolean } | false, youtube: boolean, apple: boolean } }
//        (public, no secrets). spotify.catalog: SPOTIFY_CLIENT_SECRET is set, so a room whose host
//        plays through Spotify would search Spotify's catalog (dormant: the secret stays unset, CLAUDE.md invariant 10).
//   POST /api/join  { code }                     header x-device
//        → 200 { room, until } | 403 code (wrong code, or no open room has it: the same answer)
//        | 429 locked { retryAfter } (this device: too many wrong tries) | 429 busy (JOIN_RATE_IP)
//        | 403 kicked | 403 full (ADMITTED_MAX devices) | 400 device
//   POST /api/browse  { songs: [{ id, title, artist, album, explicit }] }   header x-device
//        → 200 { allowed: boolean[], art: ('ok'|'hidden'|'unchecked')[] }  (one per song, at most 30;
//        songs may send `artwork`: art is from the KV art cache only, never an AI call: ALBUM ART)
//        Browsing before joining (no room): the student's browser searches iTunes itself
//        (shared/itunes.js; iTunes refuses Cloudflare's addresses but answers the school's) and
//        swaps explicit songs for clean versions in the same results; this says which may show
//        under the teacher's saved default blocklist, the ban list and the explicit flag (the
//        blocked words never reach a page). No room yet, so no profile: every profile's blocked
//        words and bans count (the strictest). Display only, never an AI call.
//        429 rate: 15 a minute per device (SEARCH_RATE), SEARCH_RATE_IP per address and
//        SEARCH_RATE_ALL for everyone together.
//   GET  /api/rooms/:room                        → 200 { open: true, until } | 404 { error: 'no_room' }
//   GET  /api/rooms/:room/search?q=...           header x-device
//        → 200 { results: SearchResult[], catalog: 'itunes' | 'spotify' }
//        Songs the filter blocks before any AI call (explicit, blocklist, ban list) are left out;
//        an explicit song whose clean version exists comes back as the clean version.
//        iTunes, through the teacher's computer: the room hands each uncached iTunes call to its
//        host page (src/host-relay.js; host messages 'lookup' / 'lookupResult'), at most 20 a
//        minute, and maps and checks the raw results itself. 503 search_nohost: no host page
//        answered within 6 seconds (or none is open); 503 search_busy: too many calls right now.
//        (Dormant: with SPOTIFY_CLIENT_SECRET set, a Spotify room would search Spotify's
//        catalog, catalog 'spotify'. It stays unset: Spotify's Developer Policy III.8 and III.14.)
//        Admitted devices only (403 join otherwise).
//   GET  /api/rooms/:room/ws?role=student&device=<id>&nick=<name>   → WebSocket (admitted devices)
//   GET  /api/rooms/:room/ws?role=host&token=<hostToken>            → WebSocket
//   GET  /api/rooms/:room/ws?role=board          → WebSocket; the board token goes in the first
//        message, never in the URL (BOARD + REMOTE below). The page: /board/#<room>.<board token>.
//   GET  /api/rooms/:room/youtube?song=<song id>[&skip=<videoId>]  header x-host-token
//        → 200 { videoId } | 404 youtube_none | 503 youtube_off / youtube_quota | 502 youtube_down
//        Host only. The YouTube video for a song now playing or queued (src/youtube.js); skip = a
//        video that failed in the player (remembered, never picked again). Any error: the host page
//        plays the song's 30-second preview instead. 403 host, 404 no_item, 429 rate (30 a minute).
//        An 'sp:' song is never matched to YouTube (404 youtube_none): Spotify's Developer Policy
//        forbids using its content with another service's streams.
//   GET  /api/apple/token?room=<room>            header x-host-token
//        → 200 { token, exp }  the MusicKit developer token (ES256 JWT, origin claim = this site,
//        exp in seconds; at least 25 hours left) | 403 host (no or wrong host token) | 404 no_room
//        | 404 apple_off (not set up) | 503 apple_key (the APPLE_PRIVATE_KEY secret does not work).
//        Host only. services.apple in /api/config is true when the three APPLE_* secrets are set.
//
// Every error body is { error: <code>, message: <plain sentence a student can read> }.
//
// WEBSOCKET MESSAGES are JSON objects with a `t` field (see CLIENT and SERVER below).
// The server sends a full `state` snapshot after every change. Rooms are small (one class), so
// snapshots are simpler and safer than diffs.

/**
 * A teacher's own class code may be anything with a letter or number (Dalton, 2026-10-05: "let me
 * make any room code"). A short code is easier to guess from outside the class; the per-device
 * lockout and JOIN_RATE_IP still slow guessing, and the filter still guards every song.
 */
export const CODE_MIN_PARTS = 1;
export const CODE_MIN_CHARS = 1;
/** Longest class code, normalized. */
export const CODE_MAX = 40;
/** A teacher profile's id (TEACHER PROFILES above): lower-case letters, digits and dashes. */
export const PROFILE_ID_PATTERN = /^[a-z0-9-]{1,40}$/;
export const PROFILES_MAX = 20;
export const PROFILE_NAME_MAX = 32;
/**
 * First use only (no `profiles` key yet): the existing data becomes the legacy profile's (the plain
 * KV keys); the second starts fresh. Teachers rename them in "Who's teaching?". A list that exists is
 * NEVER reseeded or rewritten (shared/profiles.js migrateProfiles), and no code depends on these ids:
 * the legacy profile is found by its `legacy: true` flag, whatever its id.
 */
export const SEED_PROFILES = Object.freeze([
  Object.freeze({ id: 'teacher-1', name: 'Teacher 1', legacy: true }),
  Object.freeze({ id: 'teacher-2', name: 'Teacher 2' }),
]);

// ---- SPOTIFY SIGN-IN (Dalton, 2026-10-14; src/auth.js, shared/accounts.js, web/src/account.js) ----
// Every teacher signs in with Spotify. The page does the PKCE redirect; the SERVER swaps the code
// for tokens (so it knows which Client ID the login came from), reads GET /v1/me for the Spotify
// user id, hands the tokens back to the page for playback and keeps none of them (never stored,
// never logged). Then a RoomDJ session (random token; KV keeps only its hash) names the teacher.
//   App 'shared': the Client ID is this server's SPOTIFY_CLIENT_ID (Dalton's app; who may log in is
//     its Spotify dashboard User Management list). Its teachers are the `profiles` list. NOBODY PICKS
//     a teacher: the Spotify account's email decides (KV link:v1:<sha256 of "email:<email>"> = a
//     list profile id, set with scripts/link-teacher.mjs; claimed once); an email with no link
//     gets a new list teacher with its Spotify name.
//   App 'own': any other Client ID (the teacher's own dev-mode app). A private profile of their own
//     (KV prof:v1:<id>, id OWN_PROFILE_PREFIX…), never on the list, never seen by other teachers.
//   POST /api/auth/spotify  { code, verifier, clientId, redirectUri }
//        → 200 { session, account: Account, tokens }                (signed in)
//        | 400 login | 403 hidden (that teacher is hidden on the list) | 409 taken (that teacher's
//          email link was used by another Spotify account) | 503 full (FREE TEACHERS) | 429 busy
//   GET  /api/auth/me       header authorization: Bearer <session> → 200 { account } | 401 session
//   POST /api/auth/logout   header authorization: Bearer <session> → 200 { ok: true }
//   Account = { profile: { id, name, legacy? }, app: 'shared'|'own', clientId }
//   Teacher routes take `authorization: Bearer <session>` (the profile is the session's; a body or
//   header profile is ignored) or, only while a TEACHER_KEY secret is set, the old key + profile
//   headers (local tests). GET /api/config says `teacherKey: true` then.
export const SPOTIFY_CLIENT_ID_PATTERN = /^[0-9a-f]{32}$/i;
export const SESSION_TTL_S = 30 * 24 * 3600;
export const OWN_PROFILE_PREFIX = 'u-';
export const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// ---- FREE TEACHERS (Dalton, 2026-10-14: "limit per Spotify account") ----
// A private ('own' app, OWN_PROFILE_PREFIX) teacher costs RoomDJ money only through Workers AI (new
// songs, covers) and the shared YouTube quota / Apple key. Caps PER SPOTIFY ACCOUNT PER DAY (one
// Spotify account = one teacher profile; UTC days; KV use:v1:<profile>:<day>), so more rooms do not
// mean more. RoomDJ's own app's teachers have none of them.
//   AI: FREE_AI_PER_DAY new-song checks (the theme check and its lyrics follow-up; cached verdicts
//     cost nothing and do not count) and FREE_ART_PER_DAY cover checks. Past them a new song is NOT
//     let through: it waits in Needs a look (reason 'limit'), and a new cover shows the 🎵 tile.
//     Nickname checks keep their own per-room limit.
//   Rooms: FREE_ROOMS_PER_DAY opened → 429 rooms_today.
//   Sign-ups: FREE_SIGNUPS_PER_DAY new own-app teachers a day for everyone → 503 full.
//   Music: Spotify and song previews only (no YouTube, no Apple Music).
//   GET /api/teacher/usage → 200 { free: false } | { free: true, caps, used, left: { ai, art, rooms },
//     resetsAt (ms, the next UTC midnight) }: the host page shows what is left (start screen, Settings).
export const FREE_AI_PER_DAY = 150;
export const FREE_ART_PER_DAY = 150;
export const FREE_ROOMS_PER_DAY = 10;
export const FREE_SIGNUPS_PER_DAY = 100;
export const FREE_USE_TTL_S = 2 * 24 * 3600;
/** The KV key of a free teacher's use on the UTC day of `now`. */
export const freeUseKey = (profileId, now = Date.now()) => `use:v1:${profileId}:${new Date(now).toISOString().slice(0, 10)}`;
/** True for a free (own-app) teacher's profile id. */
export const isFreeTeacher = (id) => typeof id === 'string' && id.startsWith(OWN_PROFILE_PREFIX);
/** A room's id: the Durable Object's name and the URL part after /api/rooms/. Random, 128 bits. */
export const ROOM_ID_PATTERN = /^[0-9a-f]{32}$/;
/** How long a room may stay open: at least 10 seconds (the browser test), at most a day. */
export const OPEN_MIN_MS = 10_000;
export const OPEN_MAX_MS = 24 * 60 * 60 * 1000;
/** One class period, in minutes (Dalton's bell schedule: 70-minute periods). The open-room form
 * prefills "Class ends at" with now + the teacher's periodMinutes setting, else this. */
export const CLASS_PERIOD_MIN = 70;
/** A cleanup time up to this long ago (time boxes have whole minutes) means "start cleanup now". */
export const CLEANUP_PAST_SLACK_MS = 2 * 60_000;
/** Most devices one room admits in a day (six classes of 30 fit easily). */
export const ADMITTED_MAX = 400;
export const NICK_MAX = 20;
export const QUERY_MAX = 80;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/**
 * The teacher's own pseudo device (TEACHER PICKS below): the host page's suggestions and votes use
 * it. The ':' is outside DEVICE_ID_PATTERN, so no student device can ever be (or pose as) it.
 */
export const TEACHER_DEVICE = 'teacher:host';
/** The name on a teacher pick when the room has no teacher profile (a room from before profiles). */
export const TEACHER_FALLBACK_NAME = 'Teacher';
/** Teacher suggestions a minute (the host's own, gentler limit; students: 6). */
export const TEACHER_SUGGEST_RATE = 20;
/** Teacher searches a minute (the host's own; the room's 90 a minute counts them too). */
export const TEACHER_SEARCH_RATE = 30;

/** Who suggested a song, as the pages show it: "🍎 Ms Rivera" for a teacher pick. Plain text. */
/** The tag on a song the teacher pushed (TEACHER PUSH), on every page. */
export const PUSH_TAG = '⏫ Teacher pick · plays next';
export function byLabel(item) {
  const by = typeof item?.by === 'string' ? item.by : '';
  return item?.teacher === true ? `🍎 ${by}` : by;
}
/** Most songs a room's "Needs a look" list holds at once. */
export const REVIEW_MAX = 20;
/** Most songs waiting in a room's queue (a class plays about 15 a period; keeps the room's stored
 * state small even if someone scripts many devices). The teacher's Allow may go past it. */
export const QUEUE_MAX = 60;

/** Teacher-wide settings (KV). Each new room copies them; the host can change a room's copy. */
export const DEFAULT_SETTINGS = Object.freeze({
  maxWaitingPerStudent: 2, // suggestions one device may have waiting at once (queued + needs a look)
  removeAtScore: -3, // a song whose score falls to this leaves the queue (never while scoreFloor is on)
  blockUnknownSongs: true, // the AI does not know the song (or the AI failed): it waits on the
  //                          teacher's "Needs a look" list. LOCKED ON (Dalton, 2026-10-16: liability;
  //                          validateSettings and migrateRoomState always set true)
  aiCheck: true, // run the AI theme check on suggestions. LOCKED ON like blockUnknownSongs
  blocklist: [], // extra words (lower case) checked against title, artist, album and nicknames
  maxSongMinutes: 5, // Max song length (Dalton, 2026-10-06): longer songs are refused (reason
  //                    too_long) before anything is charged; null = off (the host's On/Off switch).
  //                    A song with no known length passes.
  instrumentalsOnly: false, // songs with singing or rapping are refused (reason not_instrumental);
  //                           see shared/filter.js instrumentalOf. Unsure: Needs a look.
  cleanupMinutes: 5, // the open-room form prefills "Cleanup starts" this many minutes before class
  //                    ends; 0 = no cleanup. Only a prefill: the room keeps its own cleanupAt.
  bellSchedule: [], // the teacher's bell schedule presets: [{ name, ends: 'HH:MM' }] (24-hour wall-clock
  //                   time in the teacher's own time zone), sorted by time, at most BELL_MAX. The
  //                   open-room form offers them as chips and picks the next one to end.
  startingCredits: null, // credits each student starts with; null = credits off (the host's
  //                        Credits switch; suggesting is free, nobody can jump a song). See CREDITS.
  allowJump: false, // Priority jump: may students spend JUMP_COST to make a song play next? Only
  //                   counts while credits are on. Saved settings without it read as false.
  periodMinutes: 70, // the teacher's class period length (Settings, Teacher preferences); the open-room
  //                    form uses it for the class end time. Saved settings without it read as 70.
  showFavorites: true, // ⭐ Class favorites tab on the student page (FAVORITES below). Off: students get
  //                      an empty list and no tab. Saved settings without it read as true.
  noBackToBackArtist: false, // 🎨 the next song is never by the main artist (filter.js mainArtist) of
  //                            the song that just played, unless every waiting song is (then it plays).
  oneSongPerArtist: false, // 🎨 a suggestion is refused (reason same_artist, never charged) while a song
  //                          by the same main artist waits in the queue or in Needs a look.
  cooldownDays: 1, // 😴 repeat cooldown (REPEATS below): a song that played in any of this teacher's rooms
  //                  rests this many days (one of COOLDOWN_DAYS); null = off. Saved settings without it read as 1.
  recapMusic: true, // 🎵 recap music and sounds (RECAP MUSIC below): while the recap show plays, the host page
  //                   plays the #1 song's 30-second preview and short "ta-da" sounds. Saved settings without it read as true.
  recapVolume: 50, // how loud the recap music and sounds are, in percent of the room's volume (SETTINGS_LIMITS.recapVolume)
  backToWork: true, // 📚 back-to-work screen (BACK TO WORK below): after a suggestion or a vote, a student rests
  //                   backToWorkMinutes before the next one. Saved settings without it read as true.
  backToWorkMinutes: 5, // one of BACK_TO_WORK_MINUTES (Dalton, 2026-10-16: 5, was 3)
  bellOffsetSeconds: 3, // 🔔 bell offset (default +3: Dalton's school bell rings 3 s late, 2026-10-07) (BELL OFFSET above): the school's real bell rings this many seconds
  //                       after (+) or before (-) the typed time. SETTINGS_LIMITS.bellOffsetSeconds.
  //                       Saved settings without it read as 0.
  artCheck: true, // 🖼 album art check (ALBUM ART below): covers are checked by an AI vision model before they show;
  //                 off = covers show without a check (the old behaviour). Saved settings without it read as true.
  hideAllArt: false, // 🖼 never show any album covers (🎵 tiles everywhere). Saved settings without it read as false.
  maxDownvotes: 3, // 👎 per student per class (DOWNVOTE LIMIT below): a whole number 1..20, null = unlimited.
  //                  Saved settings and rooms without it read as 3.
  scoreFloor: true, // scores never go below 0 (SCORE FLOOR below): 👎 can push a song down but never
  //                   remove it. Default on (Dalton, 2026-10-08: "0 is floor, so all student songs get
  //                   to play"). Saved settings without it read as true; ROOMS saved before the
  //                   setting existed keep false (migrateRoomState: no change mid-period).
  downvoteMode: 'off', // 👎 votes (DOWNVOTE MODE below): 'off' | 'hidden' | 'shown' (DOWNVOTE_MODES).
  //                      Default 'off': students only 👍, so every song gets its turn. Saved settings
  //                      without it read as 'off'; ROOMS saved before it read as 'shown' (as before).
  ghostVote: false, // 👻 ghost 👍 (GHOST VOTE below): a waiting song gets one quiet +1 👍 after ghostVoteMinutes.
  //                   Saved settings and rooms without it read as false.
  ghostVoteMinutes: 3, // SETTINGS_LIMITS.ghostVoteMinutes. Saved settings and rooms without it read as 3.
  hideVoteCounts: true, // 🙈 students and boards see no vote numbers (HIDDEN COUNTS below). Saved settings
  //                       without it read as true; ROOMS saved before it read as false (no change mid-period).
});

export const SETTINGS_LIMITS = Object.freeze({
  maxWaitingPerStudent: [1, 10],
  removeAtScore: [-50, -1],
  maxSongMinutes: [1, 20],
  cleanupMinutes: [0, 30],
  bellSchedule: 12, // presets
  bellName: 24, // letters in a preset's name
  blocklistWords: 300,
  blocklistWordLength: 40,
  startingCredits: [0, 50],
  periodMinutes: [10, 240],
  recapVolume: [10, 100],
  bellOffsetSeconds: [-120, 120],
  maxDownvotes: [1, 20],
  ghostVoteMinutes: [1, 10],
});

// DOWNVOTE LIMIT (Dalton, 2026-10-08: kids were 👎-ing good songs; shared/queue.js vote): each student
//   device has settings.maxDownvotes 👎 per ROOM (one class period); null = unlimited. The room
//   counts them in RoomState.downvotes[device] (deleted with the room; kick deletes it; a reload or
//   another tab is the same device, so it survives).
//   - Casting a 👎 on a waiting song uses one (a new 👎, or switching a 👍 to 👎).
//   - Taking it back (v 0) or switching it to 👍 WHILE THE SONG IS STILL WAITING in the queue frees it.
//   - Once the song LEAVES the queue (it starts playing, is vetoed, banned, removed by its score or
//     blocked words, played now) the 👎 stays SPENT: taking back a 👎 on the song playing frees
//     nothing, so a 👎 on a song that is about to play cannot be recycled.
//   - Over the limit, a new 👎 is refused: { t: 'error', error: 'downvotes', id, message: "You've used
//     your 👎 for this class. You can still 👍 songs you like." }; nothing changes, no back-to-work
//     rest starts (a refused vote is not a vote). 👍 and take-backs are never limited.
//   - The teacher (TEACHER_DEVICE) is unlimited and never counted.
//   - Changing the setting applies at once: lowering it never removes a 👎 already cast; it only
//     refuses new ones until the student is under the new limit.
//   Snapshot: you.downvotesLeft (null = unlimited); the host's students[].downvotes (used). The
//   host offers DOWNVOTE_CHOICES (+ Unlimited); any whole number in SETTINGS_LIMITS.maxDownvotes is valid.
export const DOWNVOTE_CHOICES = Object.freeze([1, 2, 3, 5]);

// DOWNVOTE MODE (Dalton, 2026-10-08: "Set default to not show dislikes and 0 is floor. So all student
//   songs will get to play"; shared/queue.js voteRules/itemScore/itemView, shared/highlights.js):
//   settings.downvoteMode, one of DOWNVOTE_MODES:
//   - 'off' (the default): nobody can cast a 👎. The pages show no 👎 buttons (student queue, host
//     queue) and no "👎 N left"; the room refuses a new 👎 with { t: 'error', error: 'downvotes_off',
//     id, message: '👎 is turned off in this class.' } (no rest starts; the teacher too: the veto stays).
//     👎 already cast are KEPT in the room but IGNORED: every score is the 👍 count, every `down` a
//     page gets is 0, `myVote` -1 reads 0, ordering and ties use 👍 only, the remove score never
//     removes anything (no score goes below 0). Switching back on restores them at once (the queue
//     re-sorts; nothing is removed by that switch: the remove score applies again from the next vote).
//     The 👎 limit does not matter while off.
//   - 'hidden': students may 👎 (the 👎 limit applies) but never see 👎 COUNTS: students and boards
//     get `down` 0 and `score` = the 👍 count on every QueueItem and Top5Item (so no net number gives
//     the 👎 away); their own 👎 shows as their `myVote`. Ordering uses the real (floored) score.
//     The host gets the real numbers (it shows 👎 small and muted).
//   - 'shown': everyone sees 👍, 👎 and the net score (the behaviour before this setting).
//   Every state (students, host, boards) carries `downvoteMode` so the page knows what to draw.
//   The recap (host and boards) follows the class view: unless the mode is 'shown' its `down`s are
//   0, `score` is the 👍 count, totals.down 0 (votes = 👍), and the 👎 stats ("Survived the 👎",
//   "Closest vote") are left out. Favorites use the same score as the queue (off: 👍 only).
export const DOWNVOTE_MODES = Object.freeze(['off', 'hidden', 'shown']);

// HIDDEN COUNTS (Dalton, 2026-10-16: "hide counts ... to prevent gaming the system"; shared/queue.js
//   voteRules/itemView): settings.hideVoteCounts (default true). While on, students and boards get
//   up 0, down 0 and score 0 on every queue and now-playing QueueItem and `voteCounts: false` in the
//   State, so the pages draw 👍/👎 buttons with no numbers. They still see the ORDER (that is the
//   point of voting) and their own `myVote`. The host always gets the real numbers. The Top 5 and the
//   recap (songs already played) keep their numbers: nothing left to game there.

// VOTES ARE FINAL (Dalton, 2026-10-16; shared/queue.js vote): once a student device has a vote on a
//   song it cannot take it back or switch it; any change is refused with { t: 'error', error:
//   'vote_final', id, message: VOTE_MESSAGES.vote_final }. The same vote again changes nothing. The
//   teacher (TEACHER_DEVICE) may still change. A 👎 kept while 👎 is off reads as no vote.

// NEXT LOCK (Dalton, 2026-10-16: stop last-second vote sniping; shared/queue.js lockNext/pickNext):
//   when the host's player has NEXT_LOCK_S seconds or less left on a song, the host page sends
//   { t: 'lockNext', id } (id = the song playing; once per song). The room locks the song that would
//   play next right then (RoomState.nextLock { playing, next, at }): it plays next whatever the
//   votes do after. Votes on it still count (Top 5). The lock ends when the next song starts, or
//   when the locked song leaves the queue (veto, ban...). A song the teacher pushes (⏫) AFTER the
//   lock still plays first. Every State has `nextLocked` (true: the first queue song is locked in).
export const NEXT_LOCK_S = 15;

// SCORE FLOOR (Dalton, 2026-10-08; shared/queue.js itemScore/playOrder/pruneLowScores, shared/highlights.js
//   shownScore): settings.scoreFloor (default true since 2026-10-08; rooms saved before the setting
//   existed keep false = the old behaviour). While it is on:
//   - Every score a page gets is max(0, 👍 − 👎): QueueItem.score (queue, nowPlaying, review), Top5Item,
//     the recap's songs and top5. up and down stay the real counts (the recap's "most 👎" stats too).
//   - The remove score never removes a song (pruneLowScores removes nothing): only the teacher's veto
//     or ban does. The host greys out the remove score while the floor is on.
//   - Play order: pushed, then jumped songs as always; then the floored score, highest first; ties →
//     fewer 👎, then more 👍, then the song added first. Top 5: the same ties, then the earlier play.
//   - The 👎 limit (DOWNVOTE LIMIT) still applies.
//   - Turning it on or off re-sorts the queue at once. Turning it OFF removes nothing at that moment:
//     the remove score applies again from the next vote (any song at or below it then leaves), so a
//     settings change never empties the queue by surprise.
//   History entries keep the raw score; the views floor it, so a change applies to the Top 5 at once.

// GHOST VOTE (Dalton, 2026-10-08: "the trick is for unpopular kids to feel loved"; shared/queue.js
//   ghostFor/voteRules/itemScore, shared/highlights.js withGhost): settings.ghostVote (default false) +
//   ghostVoteMinutes (1..10, default 3).
//   - A WAITING song (in the queue: never Needs a look) that has waited ghostVoteMinutes or more gets
//     exactly ONE ghost 👍 (one time, never more). It is not stored as a vote: it is worked out from
//     `addedAt` (Allow in Needs a look sets addedAt, so the clock starts then), so changing the minutes
//     or switching the setting off and on applies at once to every waiting song. Teacher picks too.
//   - It counts exactly like one more 👍 everywhere a class sees or ranks votes: the order (pushed and
//     jumped still first; then the score with the ghost, floor and 👎 mode as usual; ties: more 👍
//     includes it), every `up` and `score` a page gets, the remove score (only matters with the floor
//     off and 👎 on). When a song STARTS PLAYING the ghost it had then is frozen on it (StoredItem.ghost,
//     HistoryEntry.ghost) so the song playing, the Top 5 and the recap's songs, totals and song stats
//     show the same 👍 the class saw.
//   - INVISIBLE TO STUDENTS AND BOARDS: they get the ghost folded into `up`/`score` and nothing else
//     (no `ghost` field, no ghostVote settings), indistinguishable from a real 👍. `myVote` is never
//     touched. Only the HOST's QueueItems carry `ghost: 1` (the normal view shows a small muted 👻).
//   - NEVER counted: the real votes kept on the song (votes{}), Top voter (tally.votes), Top
//     contributor, Crowd favorite, the Class favorites net (FAVORITE_MIN_NET, the net added, the
//     close-time "net above 0" test), the 👎 limit.
//   - Timing: the order changes with no message, so the room's one alarm (shared/classtime.js
//     nextAlarmAt) also rings at the next song's ghost moment (queue.js nextGhostAt); the alarm
//     re-sorts and broadcasts.

// BACK TO WORK (Dalton, 2026-10-07; changed 2026-10-08; shared/backtowork.js): music is a reward, not
//   the lesson. Only a SUCCESSFUL SUGGESTION starts it (the song joins the queue, or waits in Needs a
//   look): that device rests for backToWorkMinutes (one of BACK_TO_WORK_MINUTES; settings.backToWork
//   false = off). Votes (👍/👎) and jumps NEVER start a rest. The room keeps RoomState.rest[device] =
//   { from, grace, until } (ms; deleted with the room; grace = from: there is no vote grace any more).
//   A later suggestion cannot happen during the rest, so `until` never moves.
//   While a device rests the room refuses its 'suggest' (suggested ok: false, reason 'back_to_work')
//   and 'jump' (jumped ok: false, reason 'back_to_work'), each with `left` (ms) and the message
//   "📚 Back to work! You can suggest again in 2:15.", BEFORE anything is checked or charged
//   (credits untouched, not in Blocked today). VOTES ARE NOT REFUSED during a rest (the student
//   page hides the queue while the screen is up, so nobody camps on the page, but a vote from a
//   page that missed the rest still counts). Reloading or another tab cannot get around it: the
//   device has it. The teacher (TEACHER_DEVICE) never rests. The host's { t: 'letBackIn', device }
//   clears one student's rest. Turning backToWork off clears every rest; changing the minutes
//   changes only later rests. Kick removes it; Rename keeps it.
//   The student page shows a full-page "📚 Back to work! Your pick is in. Check back in 5 minutes."
//   with a countdown (search, queue and voting hidden; the song playing stays as one small line),
//   right under the title bar. Pages time it with the RELATIVE `restLeft` (ms at the snapshot), so a
//   Chromebook's wrong clock does not matter (`restGraceLeft` is always 0 now).
export const BACK_TO_WORK_MINUTES = Object.freeze([1, 2, 3, 5, 10]);

// RECAP MUSIC (Dalton, 2026-10-07; shared/recap-music.js, web/src/recap-audio.js): settings.recapMusic
//   (default on) and recapVolume (percent of the room's volume). Only the HOST page makes sound (it
//   owns the speakers); the board never does (invariant 16). While the recap show plays (the host's
//   own show, or a board's: the host page gets the same { t: 'recap', show: true }), the host pauses
//   the room music and the background music (remembering whether each was playing), fades in the
//   period's #1 Top 5 song's 30-second iTunes preview (recap.top5[i].previewUrl, host only; the
//   next Top 5 song with one when #1 has none; none: sounds only), crossfades it into itself when
//   the show runs longer than the clip, and fades it out at the end. Then the room music and the
//   background music resume exactly as they were (paused stays paused; never in cleanup mode).
//   Short "ta-da" sounds (Web Audio oscillators: no files) on each award reveal and a bigger one on
//   the 👑 #1, ducking the song a moment. A board's show sends its cues to the host page:
//   board → server { t: 'recapCue', cue } (cue in RECAP_CUES; shared/board.js boardMessage), relayed
//   to the host pages as { t: 'recapCue', cue }; 'end' (the show finished or was closed) stops the
//   music. The host stops by itself when no cue came for RECAP_CUE_TIMEOUT_MS (a board went away).
//   Off: the old behaviour (the room music turns down to 40% during the show; no sounds).
export const RECAP_CUES = Object.freeze(['start', 'reveal', 'crown', 'end']);
export const RECAP_CUE_TIMEOUT_MS = 90_000;

// REPEATS (Dalton, 2026-10-07; shared/repeats.js). A song in any version is one song: its song key
// (repeats.js songKey: the base title without version labels like (Remix), - Sped Up, (Taylor's
// Version), (feat. ...), plus the main artist) is checked next to its id for 'played' (this room
// period: RoomState.playedKeys) and 'duplicate' (queue, Needs a look, playing). Always on.
//   Repeat cooldown (settings.cooldownDays, 1 by default; null = off): a song that finished, or was
//   skipped after playing REPEAT_MIN_MS or more (or still playing that long when the room closes), in ANY of this teacher's rooms rests that many
//   days. The record is KV teacherKvKey('recent', profile) = { v: 1, songs: { [songKey]: { at,
//   title, artist } } } (songs only; at = when it last played), kept in every case (also while
//   the cooldown is off), pruned to RECENT_KEEP_DAYS and RECENT_MAX on each write. Rooms write it
//   at most once a REST_WRITE_MS (pending plays wait in the room state and are written at close);
//   two rooms writing at once: the last write wins (a play may be lost; accepted, like favorites).
//   A resting song is refused BEFORE anything is charged, reason 'resting', why { id: 'resting' },
//   plus `at` (when it played) and `until` (when it may come back), absolute ms: the server does
//   not know the teacher's time zone, so pages word it ("This song played on Monday. It can come
//   back on Thursday.", repeats.js restingEvidence). Not in Blocked today. Turning the cooldown
//   off makes every song available at once. The teacher can wake a song early ('wake'): its entry
//   leaves the record (the played-this-period rule still holds in the room where it played).
export const COOLDOWN_DAYS = Object.freeze([1, 3, 7, 14]);
export const RECENT_KEEP_DAYS = 14;
export const RECENT_MAX = 2000;
export const REPEAT_MIN_MS = 60_000;
export const REST_WRITE_MS = 30_000;

// CREDITS (Dalton, 2026-10-05). Off unless the teacher turns the Credits switch on (startingCredits,
// a whole number; null = off, the default; the switch is only the page's view of null vs a number). Balances are per device, live in the room
// (RoomState.credits) and go with it; a student who rejoins on the same device keeps theirs. A
// device with no balance yet gets startingCredits as it is then. When the setting changes
// mid-room, students already in the room keep their balance (or, when credits were off, start
// with the new amount): a change applies to students who join later.
//   Suggest: costs SUGGEST_COST, taken when the server starts checking the song. It comes back
//   (refunded: true) when the filter says no (explicit, blocklist, banned, theme), when the teacher
//   presses Remove on it in "Needs a look", or when new blocked words remove it from there (filter
//   outcomes). It stays spent when the song joins the queue, and when the teacher allows, vetoes or
//   bans it, or the class votes it out. Refusals that are not the filter's (limit, locked,
//   duplicate, played, rate, queueFull, reviewFull, unavailable, too_long, same_artist, resting) never
//   cost anything.
//   Jump: JUMP_COST moves a waiting song (not the one playing, not one in Needs a look) to the
//   front: jumped songs play before every other song, first jumped first; votes order the rest.
//   Any student may jump any waiting song, once per song. Never refunded. Jumping also needs the
//   Priority jump switch (allowJump, off by default; Dalton 2026-10-06): while it is off the server
//   refuses 'jump' with reason 'off' (nothing spent) and the student page shows no Jump buttons.
//   Turning it off does not un-jump songs already jumped: they keep their place and their tag.
//   The teacher gives 1 to CREDIT_GRANT_MAX credits to one student or to everyone, or sets one
//   student's balance (0 to CREDITS_MAX). No balance goes above CREDITS_MAX.
export const SUGGEST_COST = 1;
export const JUMP_COST = 2;
export const CREDITS_MAX = 999;

// DISCLAIMER (Dalton, 2026-10-20): the first time a teacher signs in with Spotify, the host page
// shows "the checker cannot catch everything, always do your own due diligence" with an OK button
// that unlocks after DISCLAIMER_SECONDS. Kept per teacher on the server (KV ack:v1:<profile> =
// { v, at }, src/auth.js), so it shows once per account, not once per computer. Raise
// DISCLAIMER_VERSION when the text changes enough that everyone should read it again.
export const DISCLAIMER_VERSION = 1;
export const DISCLAIMER_SECONDS = 5;
export const CREDIT_GRANT_MAX = 100;

/**
 * Song: what the queue holds. `id` names the catalog it came from (shared/catalog.js):
 * 'it:<iTunes trackId>' (iTunes Search) or 'sp:<Spotify track id>' (Spotify's catalog, only in a
 * room that plays through Spotify). Spotify songs have previewUrl '' and never 'cleaned' (Spotify
 * has no such flag). Rooms and KV entries from before catalog ids had a numeric `trackId`; they
 * are read as 'it:<trackId>'.
 * @typedef {{ id: string, title: string, artist: string, album: string, artwork: string,
 *   durationMs: number, explicit: 'explicit'|'cleaned'|'notExplicit', previewUrl: string,
 *   genre?: string, year?: number, art?: 'ok'|'hidden'|'unchecked', artKey?: string, artReason?: string }} Song
 * durationMs 0 = not known (passes Max song length). genre: iTunes primaryGenreName ('' or missing
 * for songs stored before it; a weak hint for Instrumentals only). year: the release year from iTunes
 * releaseDate (1900 to next year), 0 or missing = not known (the recap's oldest / newest song).
 *
 * art: set by the SERVER on every song it sends (ALBUM ART below); a page shows the cover only when
 * art is 'ok'. artKey / artReason: host only, on a cover the check hid.
 *
 * SearchResult: a Song the student may suggest.
 * @typedef {Song} SearchResult
 *
 * QueueItem as each client sees it. `jumped`: a student spent credits to move it to the front
 * (by = their nickname, at = when), else null. `pushed`: the teacher's ⏫ Play next (TEACHER PUSH;
 * at = when, the latest push plays first), else null. `teacher`: true for a teacher pick (TEACHER PICKS;
 * `by` is the teacher's name). For the host, `myVote` is the teacher's own vote and `mine` true
 * on teacher picks.
 * @typedef {{ id: string, song: Song, score: number, up: number, down: number, by: string,
 *   mine: boolean, myVote: -1|0|1, addedAt: number, jumped: { by: string, at: number } | null,
 *   pushed: { at: number } | null, teacher?: true, ghost?: 1 }} QueueItem
 * `ghost` (HOST ONLY): 1 when the song's up/score include a ghost 👍 (GHOST VOTE). Students and
 * boards never get it: their up/score include the ghost with no sign of it.
 *
 * State snapshot (server → client, message { t: 'state', state }).
 * @typedef {{ room: string, until: number, cleanupAt: number|null, cleanup: boolean, teacher: string|null,
 *   serverNow: number, bellOffsetSeconds: number, downvoteMode: 'off'|'hidden'|'shown',
 *   profile?: string|null,
 *   open: boolean, locked: boolean, nowPlaying: QueueItem|null,
 *   queue: QueueItem[], settings: object, top5: Top5Item[],
 *   you: { nick: string, waiting: number, review: number, credits: number|null, restUntil: number|null,
 *     restGraceUntil: number|null, restLeft: number, restGraceLeft: number, downvotesLeft: number|null } | null,
 *   students?: { device: string, nick: string, online: boolean, credits: number|null, restUntil: number|null,
 *     restLeft: number, downvotes: number }[],
 *   aiStatus?: 'ok'|'failing',
 *   review?: QueueItem[] }} State
 *   `room` is the room id, `until` when the room closes itself (ms: class ends). `cleanupAt`:
 *   when cleanup starts (ms), null = none; `cleanup`: true while the room is in cleanup mode
 *   (CLEANUP above). until and cleanupAt are the REAL moments (bell offset included); a page shows
 *   them as clock times minus bellOffsetSeconds (BELL OFFSET above). `serverNow`: the server's clock
 *   when this snapshot was made (pages correct their own clock with it). The class code is not in
 *   the state (the room keeps only its hash); the host page remembers the code it set.
 *   `you` is null for the host. `you.waiting` counts the student's queued songs plus their songs
 *   waiting for a look; `you.review` is the second part alone (both count toward
 *   maxWaitingPerStudent). `students`, `aiStatus` and `review` are sent to the host only.
 *   `review` is the "Needs a look" list (oldest first, at most REVIEW_MAX): songs the AI did not
 *   know while blockUnknownSongs is on. Students never see it. Its items have score 0, no votes.
 *   A review item may have `checked: 'lyrics'`: the AI read the song's lyrics (src/lyrics.js) and
 *   is still not sure (the host shows "Judged from lyrics: still not sure"; never the lyrics).
 *   Students' `settings` leave out `blocklist`, `bellSchedule`, `ghostVote` and `ghostVoteMinutes`
 *   (GHOST VOTE is invisible to them); the host gets the full settings.
 *   `aiStatus` turns 'failing' when a live AI call errors, back to 'ok' on the next good one.
 *   `queue` is already sorted: pushed songs first (latest push first), then jumped songs (earliest
 *   jump first), then highest score first (SCORE FLOOR: the floored score; GHOST VOTE: its ghost 👍 counts as a 👍; ties → fewer 👎, then more 👍),
 *   ties to the earliest addedAt; with noBackToBackArtist on, the song that plays next is moved to
 *   the front (the best-ranked one by another main artist than the song playing).
 *   `top5`: TOP 5 + RECAP above (everyone).
 *   `teacher`: the name of the room's teacher profile ("Ms Rivera's class" on the student page),
 *   null for a room opened before profiles. Only the room's own teacher, never the other profiles.
 *   `profile` (host only): the room's profile id (null = legacy), for "Save as my defaults".
 *   `teacherName` (host only): the name on the teacher's own picks (TEACHER PICKS).
 *   `credits` (you.credits, students[].credits): the balance, or null while credits are off.
 *   `restUntil` (you.restUntil, students[].restUntil): BACK TO WORK, when this device's rest ends (ms),
 *   null = not resting (or backToWork off). you.restGraceUntil: the rest's start (there is no vote
 *   grace any more: BACK TO WORK). you.restLeft / restGraceLeft: the same as ms left
 *   when the snapshot was made (0 = over), for the page's countdown.
 *   `downvoteMode`: the room's 👎 mode (DOWNVOTE MODE above; everyone, boards too). Unless 'shown',
 *   students and boards get `down` 0 and `score` = 👍 (host: 'off' the same, 'hidden' the real counts).
 *   `downvotesLeft` (you): 👎 this device may still cast in this room (DOWNVOTE LIMIT above), null =
 *   unlimited (also null while downvoteMode is 'off'). students[].downvotes (host): 👎 that student has used (shown against settings.maxDownvotes).
 */

// TOP 5 + RECAP (Dalton, 2026-10-06; shared/highlights.js). The room keeps `history`: every song that
// started playing this room session (one class period), with its votes (kept up to date while it
// plays: students may give the song playing a 👍 or take one back, VOTES below; so its final votes
// once it ends), who suggested it, and how it ended ('finished' when the
// player reached its end, 'skipped', 'failed' when it would not play; a song banned while playing
// leaves the history). Kept in the room's state and deleted with the room (invariant 3).
//   state.top5: the TOP5_SIZE played songs (not 'failed') with the highest net score (👍 minus 👎);
//   ties → more 👍, then the earlier one. #1 wears the 👑. Everyone gets it (nicknames stay in the
//   room). Top5Item: { id, song: { id, title, artist, artwork }, by, up, down, score }
//   Recap (host only, 'recap'): { from, at, songs: RecapSong[] (in the order they played, not
//   'failed'), top5: Top5Item[] (plus previewUrl, for the host's recap music: RECAP MUSIC; boards
//   get the recap without it), totals: { songs, votes, up, down }, crowdFavorite: { nick, up } | null }
//   RecapSong: { song: { id, title, artist, artwork }, by, up, down, score, at, status, teacher? }
//   Top5Item and RecapSong carry teacher: true for a teacher pick (TEACHER PICKS; pages: byLabel).
//   crowdFavorite: the student whose played songs got the most 👍 (ties → more songs, then earlier);
//   null when no played song got a 👍. A kicked student's songs read "a classmate" and never win.
//   The room also sends the recap to its host pages just before it closes (the page keeps it in
//   memory only, for the closed screen's "Class recap" button).
export const TOP5_SIZE = 5;
/** Most songs one room's history keeps (a class plays about 15 a period). */
export const HISTORY_MAX = 300;

// FAVORITES (Dalton, 2026-10-06; shared/highlights.js): the teacher's ⭐ Class favorites, kept across
// days in KV `favorites` (per teacher profile, like `settings` and `banned`: TEACHER PROFILES). SONGS
// ONLY: never a nickname, a device id or a room id. A song gets in (or up) when it finishes playing
// with a net score of FAVORITE_MIN_NET or more (its net votes add to its total), and when the room
// closes, each of that period's Top 5 that finished (or was still playing) with a net score above 0
// gets one more "times in a Top 5" (its net votes count once). Score = TOP5_WEIGHT x times in a
// Top 5 + total net votes, halved every FAVORITE_HALF_LIFE_DAYS since it last got in (older
// entries decay). At most FAVORITES_MAX songs: the lowest-scored unpinned ones drop off. Pinned
// songs come first. A banned song leaves the list.
//   FavoriteEntry (KV { v: 1, list }): { song: Song (catalog fields only), top5, net, plays, pinned,
//   firstAt, lastAt }
//   Students (message 'favorites'): the top FAVORITES_STUDENT songs that pass the room's filter
//   without the AI (explicit, the room's blocked words, the ban list: those are left out, as in
//   search, so a blocked word never reaches a page), as FavoriteView { song, pinned, top5 }. The
//   page marks songs it cannot suggest now (Too long, in the queue, played already, ...) like
//   search results. Suggest sends the usual { t: 'suggest', song: id }: the room re-fetches the
//   song and runs the full filter (invariant 2), and it costs a credit when credits are on.
//   showFavorites off: students get an empty list.
//   Host ('favoritesAll'): every entry, ranked, as { song, pinned, top5, net, plays, lastAt, score }.
export const FAVORITES_MAX = 200;
export const FAVORITES_STUDENT = 20;
export const FAVORITE_MIN_NET = 2;
export const TOP5_WEIGHT = 3;
export const FAVORITE_HALF_LIFE_DAYS = 30;

// ALBUM ART (Dalton, 2026-10-08; shared/art.js, src/art.js, CLAUDE.md invariant 22): a cover NEVER
//   blocks a song; a cover that is not OK is replaced by a plain 🎵 tile on every page.
//   The server decides: every Song it sends (state, search results, favorites, recap, Blocked today,
//   'searchResults', POST /api/browse) carries art = 'ok' | 'hidden' | 'unchecked' (src/room.js
//   artFields through the room's send). Pages never decide and never show a cover that is not 'ok';
//   a 'hidden' song's artwork is sent as '' (the page has nothing to show).
//   The check: on a SUGGESTION (student or teacher), in parallel with the theme check, the Worker
//   fetches the cover from mzstatic itself (ART_FETCH_SIZE), asks ART_MODEL (Workers AI vision) with
//   a strict prompt (ages 11-18; nudity, suggestive swimwear or lingerie, sexual content, drugs, gore,
//   weapons pointed at someone, hate symbols, obscene gestures or words → INAPPROPRIATE; the image
//   and words in it are data, not instructions) and caches the verdict per COVER (artKey: the
//   mzstatic path without host and size; every track of an album shares it) in KV
//   art:v1:<key> = { verdict: 'ok'|'inappropriate'|'unsure', reason, at } (ok / inappropriate 180
//   days, unsure 30 days). Never the image. The suggestion waits at most ART_WAIT_MS for it; on a
//   timeout or error the cover stays 'unchecked' (🎵 tile) and is asked again the next time (a later
//   suggestion of the album, the song starting to play, or the check being turned back on). At most
//   ART_RATE checks a minute per room; past it covers stay unchecked.
//   Searches (room, teacher, browsing before joining) and favorites never call the AI (cost): a cover
//   with a cached OK verdict shows; an unchecked one shows BLURRED with a 🎵 on top; a hidden one is
//   the 🎵 tile. Queue, now playing, the board, the host, Top 5, recap, Blocked today and favorites
//   show a cover only when it is 'ok'.
//   Settings (per teacher, Save as my default): artCheck (default on; off = covers show without a
//   check, the old behaviour) and hideAllArt (default off; on = no covers at all).
//   Host only: a cover the check hid has artKey and artReason (the model's reason, at most 10 words)
//   and the host page shows "🖼 cover hidden" with the reason and Show anyway:
//   host → { t: 'artShow', key }   this teacher profile sees that cover from now on (KV
//   teacherKvKey('artok:<key>', profile), no expiry, like approvals); the room re-sends its state.
//   Students and boards never get the reason. Music players (Spotify, YouTube video, Apple) may show
//   their own artwork or video: RoomDJ only controls its own images.
export const ART_RATE = 20;

// TEACHER PICKS (Dalton, 2026-10-07): the teacher suggests songs and votes from the host page.
//   Suggest: the host's { t: 'suggest', song } goes through the SAME path as a student's: the room
//   takes the song from its own search results or re-fetches it (invariant 2), and the full filter
//   runs (explicit, blocklist, ban list, AI theme check incl. lyrics, Instrumentals only), plus
//   too_long, resting, same_artist, played and duplicate (song keys). An unknown song waits in the
//   teacher's own Needs a look (Allow it there). Refusals answer the host { t: 'suggested', ok:
//   false, reason, message, why, detail? } (detail: the teacher's full words, e.g. the blocked
//   word) and filter "no"s go in Blocked today tagged teacher: true. NOT for the teacher: credits
//   (never charged), maxWaitingPerStudent, the student's 6-a-minute limit (the host's own
//   TEACHER_SUGGEST_RATE instead), the lock and cleanup (the teacher may add songs while
//   suggestions are locked or during cleanup).
//   Attribution: the item's device is TEACHER_DEVICE, by = the room's teacher profile name (else
//   TEACHER_FALLBACK_NAME) and teacher: true; pages show byLabel(item) ("🍎 Ms Rivera").
//   Votes: the host's { t: 'vote', id, v } counts as ONE vote, under TEACHER_DEVICE (never the same
//   as a student's), with the student rules (👍/👎 on queued songs; 👍 and take-backs only on the
//   song playing). The host's snapshot carries the teacher's own `myVote` on each item.
//   TEACHER_DEVICE is never a student: not in `students`, `admitted`, credits, kick, rename or nick
//   checks; never counted in tally (Top contributor, Top voter) and never the Crowd favorite. The
//   Top 5, the recap's song list and the history still show teacher picks.
//   Search: { t: 'search', q } on the host socket runs the room's own search (src/search.js: the
//   same relay through the host page and the same KV cache as a student's search), answered
//   { t: 'searchResults', q, results, catalog } | { t: 'searchResults', q, error, message }.
//   The host page also gets 'repeats' (played keys, resting songs) to mark its results.

// TEACHER PUSH (Dalton, 2026-10-07): "Can I push songs to top?" Host socket only (students and
//   boards are refused: studentMessage, board.js boardMessage); the host's message rate limit.
//   ⏫ Play next: { t: 'push', id, on: true } on a WAITING song (never the song playing, never a
//   Needs a look item: error 'playing' | 'review' | 'no_item'). Free, credits on or off. The item
//   gets `pushed: { at }` (strictly after every earlier push): pushed songs play before every other
//   song, jumped ones too, the LATEST push first. noBackToBackArtist never passes over a pushed song
//   (the teacher decided); oneSongPerArtist is unchanged. Votes still count and show, but the
//   remove score never removes a pushed song; a veto or ban still does. ⏬ Undo: { t: 'push', id,
//   on: false } drops the push (back to its student jump, if any, else its votes). A song that
//   starts playing loses `pushed`.
//   ▶ Play now: { t: 'playNow', id, from } on a waiting song (same refusals): the song playing ends
//   exactly like a Skip ('skipped' in the history; the repeat cooldown counts it as a Skip) and this
//   song plays at once; with nothing playing it just starts. `from` is the Skip guard (nextIsFor):
//   ignored when another song is playing by then, so a doubled click or a second tab never skips
//   twice. The host page plays it through its usual nowPlaying change.

// CLIENT → SERVER
//  student: { t: 'suggest', song }                    song = a song id. The server takes the song
//                                                      from its own search results or re-fetches it
//                                                      from its catalog, never trusts song details
//                                                      from the page. An 'sp:' id only while the
//                                                      host plays through Spotify. (An older page's
//                                                      { trackId: <number> } is read as 'it:<n>'.)
//           { t: 'vote', id, v: -1 | 0 | 1 }           0 takes a vote back. VOTES (Dalton 2026-10-07):
//                                                      one vote per device per song, queued or
//                                                      playing now (a student may vote on their own
//                                                      song, as in the queue). The song playing
//                                                      takes 👍 and take-backs only: a new 👎 is
//                                                      refused (error playing_down, "You can only
//                                                      give a 👍 to the song playing now."); the
//                                                      votes it had in the queue stay, 👎 too. Its
//                                                      score updates live in every snapshot and in
//                                                      the history (Top 5, recap, favorites); a vote
//                                                      on it counts as a vote cast (Top voter). The
//                                                      remove score never removes or skips it.
//                                                      A new 👎 over settings.maxDownvotes is refused
//                                                      (error downvotes, DOWNVOTE LIMIT above).
//                                                      Score floor on (SCORE FLOOR above): scores
//                                                      show as max(0, 👍 − 👎) and no vote removes
//                                                      a song.
//                                                      downvoteMode 'off' (DOWNVOTE MODE above): a
//                                                      new 👎 is refused (error downvotes_off).
//           { t: 'jump', id }                          spend JUMP_COST credits: this waiting song
//                                                      plays next (after earlier jumps); answered
//                                                      with 'jumped'
//           suggest and jump are refused while the device rests (BACK TO WORK above; votes never
//           are): reason 'back_to_work' with `left` (ms); nothing checked or charged
//  host:    { t: 'suggest', song }                    a teacher pick (TEACHER PICKS above); answered
//                                                      'suggested' (plus detail on a refusal)
//           { t: 'vote', id, v: -1 | 0 | 1 }           the teacher's one vote (TEACHER_DEVICE)
//           { t: 'search', q }                         the room's search for the teacher; answered
//                                                      'searchResults'
//           { t: 'next', from, failed? }               current song done: top of queue → nowPlaying.
//                                                      from = the nowPlaying id the page is moving
//                                                      on from (null: nothing was playing); ignored
//                                                      when that is no longer the song playing, so
//                                                      a double click or a second tab skips one.
//                                                      failed: true = it would not play (no favorite);
//                                                      else it finished. noBackToBackArtist picks
//                                                      the next song (state.queue[0] shows it)
//           { t: 'skip', from }                        same as next, used by the Skip button
//           { t: 'push', id, on: boolean }             ⏫ Play next / ⏬ Undo (TEACHER PUSH above)
//           { t: 'playNow', id, from }                 ▶ Play now: skip the song playing, play this
//                                                      one (TEACHER PUSH above)
//           { t: 'veto', id, reason?, note? }          remove one queued song, or a review item
//                                                      (= Remove); its student is told why
//                                                      ('removed' or 'reviewed' with `why`)
//           { t: 'ban', id, reason?, note? }           remove it and ban the song id for good (KV),
//                                                      and every other version of the same song
//                                                      (filter.js banKey: base title + main
//                                                      artist); works on review items too.
//                                                      reason/note (both optional, see REASONS):
//                                                      reason = an id from TEACHER_REASONS (default
//                                                      'teacher' for veto, 'banned' for ban); note =
//                                                      up to NOTE_MAX letters the teacher typed. The
//                                                      note passes the word screen (shared/reasons.js
//                                                      screenNote) or is dropped (the host is told
//                                                      with { t: 'error', error: 'note' }); the
//                                                      action still happens. A ban keeps the note in
//                                                      KV "banned" for later refusals.
//           { t: 'blockedAllow', id }                  "Allow anyway" on a Blocked today entry (a
//                                                      filter "no": AI theme or a blocked word): the
//                                                      song joins the queue for that student (no
//                                                      credit charged: it was refunded), is approved
//                                                      like 'allow' (KV approved:), and the student
//                                                      gets 'reviewed' allowed: true
//           { t: 'blockedBan', id, reason?, note? }    ban the song of a Blocked today entry (one that
//                                                      slipped through: a teacher veto or remove, an
//                                                      AI or blocked-word "no")
//           { t: 'allow', id }                         a review item joins the queue, credited to its
//                                                      student (even over their limit), and the
//                                                      song is approved for good: KV
//                                                      approved:<id> and approved:<banKey> (every
//                                                      version, either catalog), checked before the
//                                                      AI, so it passes in every later room
//           { t: 'letBackIn', device }                 BACK TO WORK: end this student's rest now
//           { t: 'kick', device }                      disconnect a device; it cannot rejoin this room
//                                                      (its queued and review songs go)
//           { t: 'rename', device }                    ask a student to pick a different nickname: their
//                                                      pages get { t: 'error', error: 'nick', message }
//                                                      and 4002 and go back to the join screen; the
//                                                      device stays admitted (no class code needed),
//                                                      their songs stay (shown as "a classmate" until
//                                                      the new nickname), and nobody may use the old
//                                                      nickname in this room again
//           { t: 'lock', on: boolean }                 stop / allow new suggestions
//           { t: 'credits', device, amount }           give one student 1 to CREDIT_GRANT_MAX credits
//           { t: 'credits', all: true, amount }        ... or every student in the room
//           { t: 'credits', device, set }              set one student's balance (0 to CREDITS_MAX).
//                                                      Only while credits are on (error 'credits'
//                                                      otherwise). The student is sent 'credits'
//           { t: 'service', service, lookups: true }   what this page plays through: 'preview' |
//                                                      'spotify' | 'youtube' | 'apple' (sent on
//                                                      connect and on every change). lookups: this
//                                                      page answers the room's iTunes 'lookup' jobs
//                                                      (the room only asks pages that said so)
//           { t: 'settings', settings }                change this room's settings (validated; may be
//                                                      partial, merged onto the current ones; a new
//                                                      blocklist also removes matching queued and
//                                                      review songs)
//           { t: 'times', until, cleanupAt }           "Change times": class end and cleanup start
//                                                      (absolute ms, BELL times: the server adds the
//                                                      room's bellOffsetSeconds; cleanupAt null = no cleanup),
//                                                      checked like a new room's (cleanupAt up to
//                                                      CLEANUP_PAST_SLACK_MS ago = now). Answered
//                                                      { t: 'times', ok, message? }; a later
//                                                      cleanupAt ends cleanup mode
//           { t: 'cleanup', on: boolean }              on: start cleanup now; off: "Keep the music
//                                                      going" (cleanup ends, cleanupAt = null)
//           { t: 'code', code }                        change the class code (checked like a new room's;
//                                                      admitted students stay in, new devices need
//                                                      the new code; the old one stops working)
//           { t: 'recap' }                             answered { t: 'recap', recap } (TOP 5 + RECAP)
//           { t: 'favorites' }                         answered { t: 'favoritesAll', list } (FAVORITES)
//           { t: 'favoriteRemove', id }                take a song (its song id) off the favorites
//           { t: 'favoritePin', id, on: boolean }      pin it to the top (or unpin). Both answered
//                                                      'favoritesAll'; students get the new 'favorites'
//           { t: 'resting' }                           answered { t: 'restingAll', list, cooldownDays }
//                                                      (REPEATS): the songs resting now,
//                                                      [{ key, title, artist, at, until }]
//           { t: 'wake', key }                         wake a resting song early (song key); answered
//                                                      'restingAll'; students get a new 'repeats'
//           { t: 'artShow', key }                      🖼 Show anyway: this cover shows for this teacher
//                                                      profile from now on (ALBUM ART above)
//           { t: 'close' }                             close the room; all room data is deleted
//           { t: 'lookupResult', id, status, results? }  the answer to a 'lookup': the HTTP status
//                                                      of the page's own iTunes fetch and, for 200,
//                                                      the raw iTunes results (the fields toSong
//                                                      reads). The room maps and checks them itself.
//  both:    {"t":"ping"}                               keep-alive, exactly this string (the runtime
//                                                      answers {"t":"pong"} without waking the room)
//  `ban` works on a queued song or the one now playing (which then advances to the next).
//
// SERVER → CLIENT
//  { t: 'state', state }
//  { t: 'favorites', list: FavoriteView[] }            to a student: ⭐ Class favorites (FAVORITES), on
//                                                      connect and whenever the list, the room's
//                                                      settings or the ban list change. Not in the
//                                                      state: snapshots go out on every vote.
//  { t: 'favoritesAll', list }                         to the host: the whole favorites list
//  { t: 'repeats', played, resting }                   to a student (REPEATS), on connect, when a song
//                                                      starts, and when the cooldown or the record
//                                                      changes: played = song keys played this period,
//                                                      resting = [[key, at, until]] ([] while off).
//                                                      The page marks results "Played already" and
//                                                      "😴 Resting until Thu" by song key
//  { t: 'restingAll', list, cooldownDays }             to the host: the resting songs (see 'resting')
//  { t: 'recap', recap, closing? }                     to the host: the end-of-class recap (closing:
//                                                      sent just before the room closes)
//  { t: 'suggested', ok: true, song, title }           the student's suggestion joined the queue
//  { t: 'suggested', ok: false, song, reason, message, refunded? }   (song = the song id)
//                                                      not added; reason is one of FILTER_REASONS or
//                                                      'limit' | 'locked' | 'duplicate' | 'played' |
//                                                      'reviewFull' (the Needs a look list is full) | 'queueFull' (QUEUE_MAX songs waiting) |
//                                                      'rate' (over 6 a minute) | 'unavailable'
//                                                      (the catalog is busy or down, or song not found)
//                                                      | 'credits' (credits are on and none are left)
//                                                      | 'too_long' (over maxSongMinutes; never
//                                                      charged, not in Blocked today; why too_long)
//                                                      | 'cleanup' (cleanup time: suggestions closed)
//                                                      | 'same_artist' (oneSongPerArtist: a song by
//                                                      that main artist is waiting; never charged;
//                                                      why same_artist).
//                                                      | 'back_to_work' (BACK TO WORK: the device rests;
//                                                      never charged, not in Blocked today; `left` ms)
//                                                      | 'resting' (the repeat cooldown; never charged,
//                                                      not in Blocked today; why resting, plus at and
//                                                      until in ms: REPEATS).
//                                                      'played' and 'duplicate' also match other
//                                                      versions of the song (song key).
//                                                      'not_instrumental' is a filter refusal
//                                                      (Instrumentals only; refunded, Blocked today).
//                                                      refunded: true = the filter said no and the
//                                                      credit it cost came back.
//                                                      reason 'review' is not a refusal: the song is
//                                                      waiting for the teacher's look (a 'reviewed'
//                                                      message follows when the teacher decides).
//                                                      'duplicate' also covers a song in review.
//                                                      why: { id, evidence? } (REASONS) on every
//                                                      filter refusal and on 'review' (id 'unknown').
//                                                      `reason` + `message` stay as they were, so an
//                                                      older page still works (one release).
//  { t: 'reviewed', song, title, allowed: boolean, refunded?, why? }  to the student who suggested a
//                                                      review item: the teacher allowed it (it is in
//                                                      the queue) or removed it (Remove, Ban, or a
//                                                      blocked word). refunded: its credit came back
//                                                      (Remove or a blocked word; never Ban).
//                                                      why (not allowed): the teacher's reason + note,
//                                                      or blocked_word. Also sent for "Allow anyway".
//  { t: 'removed', id, song, title, why }              to the student whose queued (or playing) song
//                                                      the teacher vetoed or banned, or a new blocked
//                                                      word removed (id = the queue item id)
//  { t: 'blocked', list: BlockedEntry[] }              to the host: "Blocked today", newest first, on
//                                                      connect and after every change (see BLOCKED)
//  { t: 'jumped', ok: true, id, title }                the student's jump worked: it plays next
//  { t: 'jumped', ok: false, id, reason, message }     nothing spent; reason 'credits' (not enough) |
//                                                      'off' (credits or Priority jump off) |
//                                                      'jumped' (already) |
//                                                      'playing' | 'no_item' | 'rate' |
//                                                      'back_to_work' (+ left: BACK TO WORK)
//  { t: 'credits', why: 'grant'|'set', amount, credits }  to a student: the teacher gave `amount`
//                                                      credits, or set the balance; credits = the
//                                                      new balance
//  { t: 'error', error, message }                      error: no_item | bad_vote | playing_down | invalid_settings
//                                                      | downvotes (DOWNVOTE LIMIT; + id of the song)
//                                                      | downvotes_off (DOWNVOTE MODE; + id)
//                                                      (+ details) | rate | bad_message | server
//                                                      | playing | review (push, playNow)
//                                                      | credits (a 'credits' message refused)
//  { t: 'times', ok: true } | { t: 'times', ok: false, message }   to the host: the answer to 'times'
//  { t: 'code', ok: true, code }                       to the host: the class code is now `code`
//  { t: 'code', ok: false, error, message }            to the host: error invalid_code | code_taken
//  { t: 'kicked' } / { t: 'closed', why }              then the server closes the socket; why (closed):
//                                                      'teacher' | 'until' (its end time) | 'idle 12 hours'
//  { t: 'pong' }
//  { t: 'recapCue', cue }                              to the host: a board's recap show cue (RECAP MUSIC)
//  { t: 'lookup', id, url }                            to the host: fetch this iTunes address
//                                                      (https://itunes.apple.com/search|lookup?...)
//                                                      from this computer and answer 'lookupResult'
//
//  { t: 'error', error: 'host_moved', message }        to a host page: "Take back my room" ran on
//                                                      another computer (its host token is no longer
//                                                      valid); then closed with 4002. The page shows
//                                                      "This room was opened on another computer".
//
// BOARD + REMOTE (Dalton, 2026-10-07; shared/board.js, web/board/, web/src/board.js): two computers,
// one room. The desktop runs the host page (it plays the music, all controls); a laptop on the
// projector opens the BOARD: display only, plus a small remote. Music NEVER plays on the board.
//   Board link: https://roomdj.com/board/#<room id>.<board token>. The token is in the URL FRAGMENT,
//   so it never reaches a server log or a Referer; the board page keeps it (cq.board, session +
//   local storage), takes it out of the address bar at once, and sends it in its FIRST WebSocket
//   message, never in the query string. The board token is NOT the host token: it may only watch
//   and send the remote actions below. The room keeps only its hash (like the host token); students
//   never receive it.
//   GET /api/rooms/:room/ws?role=board   → WebSocket; the first message must be { t: 'board', token }.
//        Wrong or no token: { t: 'error', error: 'board', message } and 4002. Any other first message:
//        the same. At most BOARDS_MAX boards at once: a newer one closes the oldest with
//        { t: 'error', error: 'boards', message } and 4002. A new board link (the host's 'boardLink')
//        closes every board on the OLD LINK with { t: 'error', error: 'board_moved', message } and
//        4002 (no reconnect); sign-in boards (BOARD SIGN-IN below) keep their own tokens.
//        Closing or expiring the room closes boards like every page ({ t: 'closed', why }, 4000).
//   Host → server:
//     { t: 'boardLink' }                       make a NEW board link token (the old link stops working;
//                                              its boards are sent board_moved). Answered to that host
//                                              socket only: { t: 'boardLink', token }. The host page
//                                              keeps it in cq.host (like its host token).
//     { t: 'boardInfo', code, display }        what the board shows that the server does not keep:
//                                              the class code (the room keeps only its hash, so the
//                                              host page relays it; kept in the host socket's
//                                              attachment only, gone with that socket, never in
//                                              storage) and the big-screen preferences display
//                                              { size: 's'|'m'|'l', who, art }. Sent on connect
//                                              and on every change.
//     { t: 'progress', id, pos, dur, started, paused }   the host's player: the queue item playing (id),
//                                              seconds in (pos) and long (dur), whether Start music was
//                                              clicked and whether it is paused. Relayed to boards as
//                                              { t: 'progress', ... } (not stored; at most PROGRESS_RATE
//                                              a minute). Sent only while a board is connected.
//     { t: 'recapShow' }                       ▶ Play recap on the board(s): every board AND host page
//                                              gets { t: 'recap', recap, show: true } (the host plays
//                                              it only in big screen).
//   Board → server (BOARD_MESSAGES; anything else: error bad_message; same rate limits as the host):
//     { t: 'skip', from }                      exactly the host's skip (the `from` guard)
//     { t: 'veto', id }                        🚫 the song PLAYING (id = nowPlaying.id, else no_item):
//                                              it stops, leaves the Top 5, its student is told
//                                              ('removed', why teacher) and it goes in Blocked today
//     { t: 'lock', on }                        🔒 the host's lock
//     { t: 'recapShow' }                       as above
//     { t: 'recapCue', cue }                   the board's recap show: cue in RECAP_CUES ('start', 'reveal',
//                                              'crown' (the 👑 #1), 'end'), relayed to the host pages as
//                                              { t: 'recapCue', cue } so the host's recap music and sounds
//                                              follow the board's slides (RECAP MUSIC above). No answer.
//     { t: 'remote', action }                  action in BOARD_REMOTE_ACTIONS: relayed to the host
//                                              pages as { t: 'remote', action } (the host owns the
//                                              player and does exactly what its own button does).
//                                              The board is answered { t: 'remoteResult', action, ok,
//                                              reason?, message? }: reason 'nohost' (no host page
//                                              connected; nothing relayed) or 'start' (the host has
//                                              not had its Start music click: browsers block sound
//                                              until then; relayed anyway so the host says so).
//   Server → board: { t: 'state', state: BoardState } after every change, 'progress', 'recap'
//     (show: true), 'remoteResult', 'error', 'closed'. Never 'blocked', 'favorites', 'lookup' or
//     the host token.
//   BoardState: the student-visible snapshot (room, until, cleanupAt, cleanup, teacher, open, locked,
//     nowPlaying, queue, top5; `mine` false, `myVote` 0; no settings, no `you`) plus
//     reviewCount (Needs a look: the number only, never the songs) and host: { online, code,
//     display, player } (from the newest host page; code null until a host page sent it).
//   Host State gets `boards`: how many boards are connected ("📺 Board connected").
//   BOARD SIGN-IN (Dalton, 2026-10-07: "connect once, then it finds my room"): /board with NO
//   fragment (and no kept link) asks for the teacher key (cq.teacherKey: sessionStorage, and
//   localStorage only when "Remember on this computer" is ticked, exactly like the host page),
//   then "Who's teaching?" (kept per computer in localStorage cq.boardTeacher { id, name }), then
//   finds that teacher's open room by itself, every period:
//   POST /api/teacher/board   header x-teacher-key, x-teacher-profile   (no body)
//        → 200 { room, boardToken, until }   the profile's most recently opened room that is LIVE
//        (the Worker asks each room; closed, expired and other teachers' rooms are skipped) and a
//        NEW board token for it (a SIGN-IN token: its hash is ADDED to the room's board tokens;
//        nothing else changes, no board is kicked; the newest BOARD_SIGNIN_MAX sign-in tokens are
//        kept, an older one's board gets board_moved + 4002 and asks again). The board connects
//        exactly like a link board (token in the first socket message).
//        | 404 no_room (that teacher has no open room: the board waits and asks again)
//        | 401 key (300 ms wait, no lockout) | 400 profile | 429 busy (BOARD_RATE_IP per address).
//        Profile-scoped: only rooms opened as that profile, never another teacher's.
//   Rooms list themselves in KV teacherKvKey('openRooms', profile) = [{ room, until, at }] (newest
//   first, at most OPEN_ROOMS_MAX, TTL the latest until): added when a room opens, refreshed on
//   "Take back my room" and 'times', removed when it closes. KV is only the signpost; the room says
//   whether it is live and whose it is (src/open-rooms.js).
//   The board polls every BOARD_POLL_MS while it waits (BOARD_POLL_SLOW_MS after an hour; never
//   while the tab is hidden), shows "Waiting for <teacher> to open a room…" with a clock, and goes
//   back to waiting when the room closes, so it picks up the teacher's next room by itself. A
//   wrong key (changed password) goes back to the key step. The room's board tokens: at most one
//   LINK token (🔁 New board link replaces it and stops only the boards on it) plus the sign-in
//   tokens; all go with the room.
export const BOARDS_MAX = 3;
/** Sign-in board tokens a room keeps (BOARD SIGN-IN above); the host's link token is extra. */
export const BOARD_SIGNIN_MAX = 3;
/** Open rooms a teacher's KV signpost keeps (BOARD SIGN-IN above). */
export const OPEN_ROOMS_MAX = 10;
/** How often a waiting sign-in board asks for its teacher's room; slower after an hour of waiting. */
export const BOARD_POLL_MS = 10_000;
export const BOARD_POLL_SLOW_MS = 60_000;
export const BOARD_POLL_SLOW_AFTER_MS = 60 * 60_000;
/** A board token: 32 random bytes, base64url (43 letters). */
export const BOARD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** What a board may ask the host page to do (it owns the player). */
export const BOARD_REMOTE_ACTIONS = Object.freeze(['playPause', 'volUp', 'volDown']);
/** Most 'progress' messages a minute the room relays (the host sends one about every 5 s). */
export const PROGRESS_RATE = 40;

// HOST PAGE STORAGE: the host page keeps { room, classCode, token, until } (cq.host) in
// sessionStorage AND localStorage, so closing the window does not lock the teacher out: reopening
// /host on the same computer rejoins. It drops it when `until` passes, when the room is closed or
// gone, or when the host token is refused. The host token is per room, ends with the room and
// controls only that room; the teacher key stays in sessionStorage unless "Remember on this
// computer" is ticked. Who's teaching is localStorage cq.profile ({ id, name }, per computer);
// cq.filler, cq.display, cq.keys and cq.music are kept per teacher as <key>:<profile id>.
//
// A refused socket is accepted, sent one message, then closed (a page cannot read an HTTP error on
// a WebSocket): { t: 'error', error: 'host' | 'nick' | 'device' | 'no_room' | 'join' } or
// { t: 'kicked' }. 'join': this device never joined with the class code (or the room was full).
// 'nick': the nickname check (shared/nick.js) said no. Layer 1, the word lists: built-in words
// (dressed-up spellings undone), names posing as staff ("teacher", "Mr X"), the teacher's
// blocklist, a nickname the teacher renamed in this room. Layer 2, only while the room's aiCheck is
// on and only for a nickname this device is not already using here: Workers AI (the song check's
// model), verdict cached in KV nick:v1:<nickKey> for 30 days, at most 2 uncached checks a minute per
// device ('nick' with "Wait a minute"). AI trouble lets the nickname in (the word lists passed it)
// and turns the host's aiStatus to 'failing'. The message never says why ("Please pick a different
// nickname.").
// 'nick' also when a student who is in the room right now has that nickname (case, spaces,
// accents and look-alike letters ignored), so nobody can pose as a classmate.
// A student page that is IN the room can get 'nick' too: the teacher's Rename (then 4002).
// One device has at most 3 student sockets open (tabs): a new one closes its oldest with
// { t: 'error', error: 'tabs' } and 4002. Over 20 new student sockets a minute from one device:
// closed with 1013 and no message (not final: the page retries after its backoff).
// Close codes: 4000 room closed, 4001 kicked, 4002 refused (also 'tabs', 'host_moved', and for
// boards 'board', 'boards' and 'board_moved'). Never auto-reconnect after these.
// Roles (?role=): 'host' (host token), 'student' (admitted device), 'board' (board token in the
// first message: BOARD + REMOTE above).
//
// Search errors (HTTP): 429 rate (15 a minute per device, 90 per room), 503 search_busy |
// search_down | search_nohost (the teacher's computer is not answering searches), 400 device, 403 kicked, 403 join (a room search from a device that never joined).

export const FILTER_REASONS = Object.freeze({
  explicit: 'That song is marked explicit.',
  blocklist: 'That song has a word your teacher has blocked.',
  banned: 'Your teacher has banned that song.',
  theme: 'That song does not seem right for school.',
  review: 'Your teacher needs to check that song first. It joins the queue if they say yes.',
  not_instrumental: 'Your teacher wants instrumental music right now: songs with no singing.',
});

// REASONS (Dalton, 2026-10-05): every "no" carries why = { id, evidence? }. The single list of
// reasons, each with an emoji, the student's label and the teacher's label. Students see
// "<emoji> <label>: <evidence>" (whyText); evidence is short and kid-safe:
//   explicit      "Apple marks this song explicit." (search already swaps in a clean version when
//                 there is one)
//   AI categories the AI's own words (at most 15, never lyrics), passed through the word screen
//                 (shared/reasons.js kidEvidence); when it fails, a plain sentence instead
//   blocked_word  "It has a word your teacher blocked." Never the word (the teacher sees it)
//   banned        the teacher's ban note, if any
//   unknown       "Your teacher will check it." (Needs a look)
//   teacher picks the teacher's note (NOTE_MAX letters, word-screened), if any
//   too_long      "This song is 7:12; the limit is 5:00." (Max song length; never charged)
//   not_instrumental "This song has singing." (Instrumentals only; the AI's answer or the catalog)
//   same_artist   "A song by <artist> is already waiting." (One song per artist; never charged)
//   resting       "This song played on Monday. It can come back on Thursday." (Repeat cooldown;
//                 never charged; worded by the page from `at` and `until`)
// The teacher also sees `detail` (Blocked today): the blocked word, the AI's evidence in full.
export const REASONS = Object.freeze({
  explicit: { emoji: '🔞', student: 'Explicit lyrics', teacher: 'Explicit lyrics' },
  drugs: { emoji: '💊', student: 'Drug references', teacher: 'Drug references' },
  alcohol: { emoji: '🍺', student: 'Alcohol or partying', teacher: 'Alcohol or partying' },
  sexual: { emoji: '💋', student: 'Sexual content or innuendo', teacher: 'Sexual content or innuendo' },
  violence: { emoji: '🔪', student: 'Violence or weapons', teacher: 'Violence or weapons' },
  selfharm: { emoji: '💔', student: 'Self-harm', teacher: 'Self-harm' },
  hate: { emoji: '🚫', student: 'Hate or slurs', teacher: 'Hate or slurs' },
  swearing: { emoji: '🤬', student: 'Heavy swearing', teacher: 'Heavy swearing' },
  blocked_word: { emoji: '📝', student: 'Blocked word', teacher: 'Blocked word' },
  banned: { emoji: '⛔', student: 'Banned by your teacher', teacher: 'Banned' },
  unknown: { emoji: '❓', student: 'The checker does not know this song', teacher: 'Checker does not know it' },
  too_long: { emoji: '⏱', student: 'Too long', teacher: 'Too long' },
  not_instrumental: { emoji: '🎹', student: 'Instrumentals only right now', teacher: 'Not instrumental' },
  same_artist: { emoji: '🎨', student: 'One song per artist', teacher: 'One song per artist' },
  resting: { emoji: '😴', student: 'Resting', teacher: 'Resting (repeat cooldown)' },
  teacher: { emoji: '🍎', student: "Teacher's choice", teacher: "Teacher's choice" },
  other: { emoji: '', student: 'Other', teacher: 'Other' },
});
/** The categories the AI theme check may answer (shared/filter.js); anything else reads as 'other'. */
export const AI_CATEGORIES = Object.freeze(['drugs', 'alcohol', 'sexual', 'violence', 'selfharm', 'hate', 'swearing', 'other']);
/** What the teacher's quick-pick offers for Veto, Remove and Ban (in this order). */
export const TEACHER_REASONS = Object.freeze(['teacher', 'explicit', 'drugs', 'alcohol', 'sexual', 'violence', 'selfharm', 'hate', 'swearing', 'other']);
/** Longest teacher note (letters). */
export const NOTE_MAX = 80;

/**
 * "<emoji> <label>: <evidence>" for a why object; `who` 'student' or 'teacher' picks the label.
 * Plain text (the pages put it in with textContent or esc()). '' for no why.
 */
export function whyText(why, who = 'student') {
  const r = REASONS[why?.id] ?? (why ? REASONS.other : null);
  if (!r) return '';
  const label = `${r.emoji ? `${r.emoji} ` : ''}${r[who] ?? r.student}`;
  const evidence = typeof why.evidence === 'string' ? why.evidence.trim() : '';
  return evidence ? `${label}: ${evidence}` : label;
}

// BLOCKED ("Blocked today", host only): every rejected suggestion this room session, newest
// first, at most BLOCKED_MAX (older ones drop off). Kept in the room's own DO storage (key
// 'blocked'), deleted with the room (CLAUDE.md invariant 3).
// BlockedEntry: { id, at, song: { id, title, artist, artwork }, by, why, detail, teacher?: true,
//   source: 'filter'|'teacher', action: 'suggest'|'veto'|'remove'|'ban'|'blocklist',
//   status: null|'allowed'|'banned', canAllow: boolean, canBan: boolean }
//   detail = what the teacher sees in full (the blocked word, the AI's evidence, the note).
//   canAllow: a filter "no" from the AI theme check or a blocked word ("Allow anyway"; never
//   explicit or banned songs). canBan: not banned already and not explicit.
export const BLOCKED_MAX = 100;
