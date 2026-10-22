# RoomDJ

A classroom music queue, built for Chromebook classrooms. Students join with today's class code,
search for songs, suggest them and vote 👍 and 👎 (3 of each per class by default; the teacher can change either or turn it off). The teacher's computer on the projector plays
the winners through the teacher's own music account, and a filter keeps it school-appropriate:
no explicit songs, the teacher's blocked words and banned songs, and an AI theme check (songs the
model does not know, mostly newer ones, are judged from their lyrics, fetched once from
[LRCLIB](https://lrclib.net) and never stored). Free and open source, a sibling of
[uploadmycode](https://uploadmycode.com),
[uploadmylaser](https://uploadmylaser.com), [uploadmymodel](https://uploadmymodel.com) and
[uploadmycut](https://uploadmycut.com). Made by [Dalton Fowler](https://daltonjfowler.com).

**Status (2026-10-04):** live at [roomdj.com](https://roomdj.com). The code and the
Worker keep the old working name `classqueue` (and the `cq.*` browser keys), so nothing breaks. Song
previews, Spotify and YouTube play on the host page; Apple Music is being added (see
[docs/APPLE-SETUP.md](docs/APPLE-SETUP.md)).

No student accounts. A room holds only nicknames, device ids, votes and songs, and all of it is
deleted when the room closes (the teacher closes it, its closing time passes, or 12 idle hours).

## What is in it

- **Student page** (`/`): look for allowed songs before joining, join with the class code and a
  nickname, suggest songs and vote. Works on a phone or a Chromebook, light or dark.
- **Teacher profiles** ("Who's teaching?"): every teacher shares the key, then picks their name
  (no PIN; add, rename, hide). Each teacher has their own default settings, bell schedule, banned
  and allowed songs and favorites; the data from before profiles belongs to the legacy profile ("Teacher 1" on a new install). The computer
  remembers the last teacher picked, and keeps keys, display, background music and Music from per
  teacher. Students see "<name>'s class".
- **Host page** (`/host/`): the teacher key opens today's room with a class code (suggested, or
  the teacher's own) and the site address for the board (plus a join link for Google Classroom). Play, pause, skip, veto, ban, lock suggestions,
  kick a student, change the code mid-day, room settings, and **Needs a look** for songs the AI
  checker does not know. **Teacher picks**: 🔎 Suggest a song (A) and ➕ Suggest in ⭐ Favorites
  run the room's own search and the students' suggest path on the server (the same filter,
  repeats, Max song length and artist rules; unknown songs to Needs a look), shown as "👩‍🏫
  <name>", never charged and not held by the lock, cleanup or the per-student limit; the teacher's
  👍/👎 is one vote under a pseudo device (`teacher:host`) that is never a student (no credits,
  never Top contributor, Top voter or Crowd favorite). **⏫ Play next / ⏬ Undo** puts a waiting
  song ahead of everything (votes, ⚡ jumps; the latest push first; free; never voted out or passed
  over by the artist rule) and **▶ Play now** skips the song playing to start it at once (host
  socket only; "⏫ Teacher pick · plays next" on every page). **📚 Back to work** (on, 3 minutes;
  Off, 1/2/3/5/10): after a student's suggestion (only that: votes and jumps never start it), a
  full-page "Back to work!" with a countdown; the room refuses that device's suggest/jump until then
  (reason `back_to_work`, nothing charged; votes are never refused), the teacher's Students list shows 📚 m:ss and **Let
  back in**; the teacher never waits. **🎵 Recap music** (on): during ▶ Play recap the host page
  pauses the room and background music, plays the #1 Top 5 song's 30-second preview (crossfaded
  to cover the show) with Web Audio "ta-da" sounds on each reveal, then resumes the room music
  exactly as it was; a board's show sends cues so the desktop's sounds follow it. **👎 per student
  per class** (3; 1/2/3/5/Unlimited): a 👎 on a waiting song uses one for the room; taking it back
  or switching to 👍 while the song waits gives it back; once the song leaves the queue it stays
  used; over the limit the room refuses with `downvotes` (no rest starts); "👎 2 left" on the student
  page, "👎 2/3" in Students; the teacher is unlimited. **👎 votes** (Off; On, counts hidden; On,
  counts shown): off = no 👎 buttons anywhere and the room refuses a 👎 (`downvotes_off`); 👎 already
  given are kept but ignored (score = 👍) and count again when it is turned back on; counts hidden =
  students may 👎 but students, boards and the recap see only 👍 counts (the teacher sees 👎, muted);
  rooms opened before the setting keep 👎 shown. **Scores never go below 0** (on; old rooms keep
  off): scores
  show as max(0, 👍 − 👎) everywhere, 👎 never removes a song (the remove score is greyed out; only
  the teacher's veto or ban does), ties go to fewer 👎, then more 👍; turning it off removes nothing
  at once, the remove score applies again from the next vote. **👻 Ghost 👍** (off; 1 to 10
  minutes, 3): a waiting song gets one quiet +1 👍 after that many minutes in the queue (from Allow
  for a Needs a look song), worked out from when it joined (not stored), so it moves up like a real
  👍; the room's alarm re-sorts and broadcasts at each song's moment. Students and boards cannot
  tell it apart (folded into 👍; no ghost field or setting reaches them); the teacher's normal view
  shows a muted 👻. It sticks to a song that starts playing (Top 5 and recap show what the class
  saw) and never counts for favorites, Crowd favorite, Top voter/contributor or the 👎 limit.
  **Big screen** shows only the address, code, now playing and the top five, in
  type you can read from the back of the room (Esc leaves it; F for full screen). **Keyboard
  shortcuts** (Space, N, B, F, L, M, arrows, G, A, S, E, ?; the teacher can change the keys, kept per
  computer), **✏️ Edit layout** (📺 Screen menu or E; the board: E or its remote's ⋯): drag panels
  to swap columns, drag the gutters to resize columns, scale a panel's text (corner grip, A−/A+,
  Ctrl + wheel; 60% to 250%), hide panels (never Now playing or Needs a look on the teacher's own
  view); per computer, per teacher and per view (normal, big screen, board) in localStorage
  `cq.layout:<view>[:<profile>]`), **Teacher preferences** (class period length, saved with the defaults; big screen
  text size, who suggested, album art, start in big screen, per computer) and **Background music**
  (a YouTube video, live stream or playlist in its own visible player, or a Spotify playlist or
  album on the RoomDJ speaker) that pauses for student songs and comes back when the queue is empty. Closing the window does not close
  the room: reopening `/host/` on the same computer rejoins it, and **Take back my room** moves it
  to another computer (`POST /api/teacher/rooms/reclaim`; the old page stops).
- **Board** (`/board/`): two computers, one room. The desktop with the speakers runs the host page
  (it plays the music); **📺 Board link** gives a secret link (`/board/#<room>.<board token>`: the
  token is in the fragment, so it never reaches a server log, and goes in the board's first socket
  message) for the laptop on the projector. The board shows what Big screen shows (code, now
  playing with progress, the top five, Top 5 and the cleanup countdown, the Needs a look count),
  keeps the laptop awake, and has a small auto-hiding remote: play/pause and volume (carried out by
  the desktop, which owns the player), skip, veto the song playing, lock, ▶ Play recap (the show
  plays on the board). Music never plays on the board (its CSP has `media-src 'none'`). The board
  token only watches and sends those actions; **🔁 New board link** cuts off the old one.
  **Board sign-in** (the easy way): `/board` with no link asks for the teacher key once
  ("Remember on this computer", like the host page) and "Who's teaching?", then finds that
  teacher's open room by itself (`POST /api/teacher/board`: key and profile in headers; each room
  lists itself in KV `openRooms` per profile while open), waits with a clock while none is open,
  and follows the teacher to the next room when one closes. A sign-in token is added to the room's
  board tokens (nothing is kicked); it dies with the room.
- **Music from**: 30-second song previews (no account needed), Spotify (Premium, the Web
  Playback SDK speaker "RoomDJ"; the login stays in the teacher's browser), YouTube (matched
  videos in the IFrame player) and Apple Music.
- **Song search**: Apple's iTunes Search, run from the teacher's computer: iTunes refuses
  Cloudflare's shared addresses, so the room hands each search to the host page, which asks iTunes
  from the school's own address and sends the raw results back; the server maps and checks them
  itself. Browsing before joining searches iTunes from the student's browser (display only).
  Song ids name their catalog (`it:<n>`). A Spotify catalog search exists in the code but stays
  off (Spotify's Developer Policy III.8, products for children, and III.14, no Spotify content
  into AI models).
- **The filter** runs on the server for every suggestion: a song comes from the room's own
  search results or is re-fetched by its id (through the host page), never trusted from a student's
  page. Explicit songs swap to the clean version when one exists. Every "no" carries a reason
  from one preset list (`shared/protocol.js` REASONS) and short, kid-safe evidence (the AI
  checker names a category and says why in its own words, never lyrics); the teacher's Veto,
  Remove and Ban take an optional reason and note, and **Blocked today** on the host page lists
  every song turned down in the room with the full details, **Allow anyway** and **Ban**.
- **Class time**: the room closes when class ends (a bell from the teacher's saved bell schedule,
  the next one picked for them, a custom time, or the end of today). At **Cleanup starts** (5
  minutes before, to start) the music fades out, suggestions close and Big screen counts down to
  the bell; **Change times** and **Keep the music going** during the room. **Max song length**
  (5 minutes to start) and **Instrumentals only** (the AI checker's same call also says whether a
  song has singing) are room settings.
- **Credits** (off unless the teacher switches Credits on in Settings): a suggestion costs 1, a
  filter "no" gives the credit back, and the teacher gives credits to one student or everyone.
  **⚡ Jump** (2) makes a waiting song play next, only while the separate **Priority jump** switch
  is on too (off by default). Balances live in the room, per device, and the server checks
  every charge, refund and grant.
- **🏆 Top 5 and the class recap**: the five songs with the best votes this period (👑 on #1) on
  the host page, the student page and, in cleanup, the big screen. **▶ Play recap** runs an awards
  show on the big screen (fun stats picked at random, the Top 5 countdown, and the finale: 🎤 Top
  contributor vs 🗳 Top voter); the recap card has the same stats and **Copy recap** for Google
  Classroom. All of it goes with the room.
- **⭐ Class favorites**: songs that finish with +2 or better, or make a period's Top 5, are kept
  across days (songs only, never names). Students see the top 20 next to search and can suggest one
  with a tap (the full filter still runs); the teacher pins or removes songs.
- **🎨 Artist switches** (off to start): **No back-to-back artist** and **One song per artist**.
- **🖼 Album art check** (on to start): a suggested song's cover is checked by an AI vision model
  (Workers AI, Llama 4 Scout) on the server; a cover that is not right for class (nudity, suggestive
  poses, drugs, gore, ...) is replaced by a plain 🎵 tile on every page, and the song still plays.
  Covers not checked yet are 🎵 too (blurred in search results). Only the verdict is kept, per
  cover, never the image. The teacher sees why and can **Show anyway**; **Hide all album covers**
  turns covers off. `node scripts/art-test.mjs` runs the prompt against 26 known covers.
- **😴 Repeats**: a remix, sped-up, live or "Taylor's Version" of a song counts as the song (never
  twice in one class), and the **Repeat cooldown** (1 day to start; off, 1 day to 2 weeks) rests a
  song that played in any of the teacher's rooms; the teacher can wake one early. Songs only.

How to run it in class: [docs/TEACHER_GUIDE.md](docs/TEACHER_GUIDE.md). Code layout and the
rules the code keeps are in [CLAUDE.md](CLAUDE.md); the HTTP and WebSocket
contract is [shared/protocol.js](shared/protocol.js).

## Secrets and settings

Worker secrets (`npx wrangler secret put <NAME>`). Never commit their values; for local dev put
throwaway values in `.dev.vars` (gitignored).

| Name | What it is |
| --- | --- |
| `TEACHER_KEY` | The shared teacher password (the same one as the sibling sites). No key set = no teacher access. |
| `TEACHER_KEY_2` | Optional second teacher password (a student teacher). |
| `YOUTUBE_API_KEY` | YouTube Data API key for matching songs to videos. Not set = YouTube is hidden. |
| `SPOTIFY_CLIENT_SECRET` | **Leave unset.** It would turn on the dormant Spotify catalog search, which Spotify's Developer Policy does not allow for RoomDJ (III.8 children, III.14 AI). See CLAUDE.md invariant 10. |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple Music (MusicKit) developer token pieces. See [docs/APPLE-SETUP.md](docs/APPLE-SETUP.md). |

`SPOTIFY_CLIENT_ID` is **not** a secret: it is a public `vars` entry in `wrangler.jsonc` (the
host page logs in with PKCE and never sees `SPOTIFY_CLIENT_SECRET`). The KV namespace
(`classqueue-CLASS_KV`), the room Durable Object, Workers AI and the rate limits are bindings in
`wrangler.jsonc`.

## Run it locally

```sh
npm install
echo TEACHER_KEY=pick-a-throwaway-key > .dev.vars
npm run dev           # build, then wrangler dev on http://127.0.0.1:8792
```

Open `http://127.0.0.1:8792/host/` for the teacher and `http://127.0.0.1:8792/` for a student.
On Windows, restart `wrangler dev` after each `npm run build`, and stop the leftover
`workerd.exe` first. When you start `wrangler dev` by hand, add `--local-upstream 127.0.0.1:<port>`
as `npm run dev` does: the `roomdj.com` routes in `wrangler.jsonc` otherwise make local requests
look like roomdj.com, and the https redirect loops.

## Tests

```sh
npm test              # unit tests: codes, queue, filter, reasons, settings, catalogs, Spotify and YouTube matching, socket watchdog, shortcut keys, background music, teacher profiles, class time
npm run build
npm run test:browser  # room flows in Chrome against npm run dev
npm run test:spotify  # Spotify login and playback with a fake SDK and API
npm run test:relay    # the host page runs the room's iTunes searches (stubbed iTunes; see the file's header)
npm run test:reclaim  # close the host window and come back; Take back my room (against npm run dev)
npm run test:credits  # credits: charge, refunds, Needs a look hold, Priority jump on/off, jump, give, give everyone (against npm run dev)
npm run test:reasons  # why a song was turned down, the quick pick, Blocked today (seeded verdicts; against npm run dev)
npm run test:catalog  # the dormant Spotify catalog, against a fake Spotify (see the file's header)
npm run test:youtube  # the real YouTube IFrame player (see the file's header)
npm run test:a11y     # axe-core scan, light and dark, phone width and 200% zoom
npm run test:teacher  # shortcuts, changing keys, teacher preferences, background music (YouTube + fake Spotify)
npm run test:classtime  # bell schedule, class end + cleanup, Change times, Max song length, Instrumentals only (seeded verdicts)
npm run test:favorites  # Top 5, the recap card and the Play recap show (+ recap music: the #1 preview plays, the room music comes back), Class favorites, the artist switches (against npm run dev)
npm run test:profiles   # Who's teaching?: first-use migration, settings/bans/approvals/favorites per teacher, add/rename/hide (against npm run dev)
npm run test:repeats  # other versions count as played, the repeat cooldown across rooms, wake early, Off (seeded local KV; against npm run dev)
npm run test:lyrics   # unknown songs judged from lyrics, against a fake LRCLIB (its own wrangler dev with LYRICS_TEST_BASE; see the file's header; 2 real AI calls)
npm run test:board    # the board + remote: board link, the board page, remote skip/lock/veto/pause/volume/recap, New board link, what a student or a board cannot do (against npm run dev)
npm run test:bell     # bell countdown + bell offset: +3 s moves cleanup and auto-close, a student with a wrong Chromebook clock sees the server's countdown, announced once (against npm run dev)
npm run test:focus    # 📚 back to work: the screen + countdown (card under the title bar, no empty band), reload still blocked, forced suggest/jump refused (no credit), a vote counts and never rests, Let back in, Off (against npm run dev)
npm run test:teacher-push     # ⏫ Play next / ⏬ Undo / ▶ Play now: order, tags on student + board, plays next, skip counted, no double advance, board refused (against npm run dev)
npm run test:teacher-suggest  # teacher picks: search + suggest (👩‍🏫 on student, host, board), blocked/explicit refused, unknown → Needs a look, locked, credits, the teacher's votes, recap awards (seeded verdicts; against npm run dev)
npm run test:layout   # ✏️ Edit layout: gutter, corner scale, move, hide/show, Esc/Done, kept per view + per teacher, the board's layout, Reset all, axe in edit mode; screenshots (LAYOUT_SHOTS) (against npm run dev)
npm run test:art      # 🖼 album art: blurred search results, a flagged cover hidden on student/host/board, Show anyway, Hide all, check off (seeded verdicts, no AI; against npm run dev)
npm run test:board-signin  # the board's sign-in: key + Remember + Who's teaching, waiting, finds and follows the teacher's rooms, never another teacher's, link boards not kicked, key changed, Forget (against npm run dev)
```

The browser tests need Chrome and `playwright-core` (and `axe-core`), taken from
`../uploadmycut/node_modules` when this repo does not have them. They take the server URL as an
argument; for a dev server started with `--persist-to <dir>`, set `CQ_PERSIST=<dir>` (flows) or
`PERSIST_TO=<dir>` (YouTube).

## Deploy

```sh
npm run deploy        # build and deploy (with Dalton's go-ahead)
```

## Trademarks and privacy

Independent school project. Not affiliated with, made by or endorsed by Apple, Spotify or
Google. Apple Music, iTunes, Spotify and YouTube are trademarks of their owners. Songs come from
the iTunes Search API (called from the teacher's and students' browsers); playback uses each
service's own player and the teacher's own account.
See [Privacy and legal](https://roomdj.com/legal.html).

## Running your own copy

No secrets are in this repo: every key and password is a Worker secret (or, for local dev, a
line in the gitignored `.dev.vars`). To run your own copy, create your own Cloudflare account,
KV namespace (put its id in `wrangler.jsonc`) and routes, and set your OWN `TEACHER_KEY` (and
optionally `TEACHER_KEY_2`, `YOUTUBE_API_KEY`, the Apple Music keys) with
`npx wrangler secret put <NAME>`; see [Secrets and settings](#secrets-and-settings). Pick a long,
unguessable teacher key: anyone who has it can open rooms and change settings. The first teacher
call creates two profiles, "Teacher 1" and "Teacher 2"; rename them in "Who's teaching?".

## Disclaimer

RoomDJ is provided "as is", with no warranty of any kind (see [LICENSE](LICENSE)). It is not affiliated with or endorsed by Spotify, Apple, Google/YouTube,
LRCLIB or Cloudflare; their names and marks belong to their owners. Anyone who deploys their own
copy is responsible for following those services' terms (developer policies, API terms and
quotas), their school's policies and student privacy laws (such as FERPA and COPPA in the US), and
for their own API keys and costs. The AI filter can make mistakes, in both directions, and is not a
substitute for adult supervision.

## License

MIT. See [LICENSE](LICENSE).
