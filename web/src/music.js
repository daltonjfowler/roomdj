// The "Music from" picker on the host page. It lists only the services this server has set up
// (GET /api/config) and that have a player in player.js, and remembers the choice on this
// computer, per teacher (localStorage cq.music:<profile>, profile.js). Spotify and Apple Music also get a Connect / Disconnect button here.
// host.js hands over `use(player)`; this file only decides which player that is.

import { $ } from './dom.js';
import { prefKey } from './profile.js';
import { PLAYERS, createPlayer } from './player.js';
import { createSpotifyAuth, takeSpotifyRedirect } from './spotify-auth.js';

const SAVED = 'cq.music';
const LABELS = { preview: 'Song previews (30 seconds)', spotify: 'Spotify', youtube: 'YouTube', apple: 'Apple Music' };

function saved() { try { return localStorage.getItem(prefKey(SAVED)); } catch { return null; } }
function remember(service) { try { localStorage.setItem(prefKey(SAVED), service); } catch { /* blocked */ } }

async function readConfig() {
  try {
    const r = await fetch('/api/config');
    if (r.ok) return (await r.json())?.services ?? {};
  } catch { /* offline: previews only */ }
  return {};
}

/**
 * @param {{ use: (player: object) => void, notify: (text: string, kind?: string) => void }} host
 */
export async function initMusic({ use, notify, signin = null }) {
  // Spotify's answer is in the address bar after a login: take it out before anything else.
  const redirect = takeSpotifyRedirect();
  const services = await readConfig();
  // Signed in with Spotify (account.js): that login's own app plays, whatever this server's app is.
  const clientId = signin?.clientId ?? services.spotify?.clientId;
  const auth = clientId ? createSpotifyAuth(clientId) : null;
  if (signin?.clientId) services.spotify = { ...(services.spotify || {}), clientId };
  if (signin?.free) services.youtube = services.apple = false; // the server refuses them too

  const offered = Object.keys(LABELS).filter((s) => s === 'preview' || (services[s] && PLAYERS[s]));
  const select = $('#service');
  select.innerHTML = '';
  for (const s of offered) select.add(new Option(LABELS[s], s));
  $('#musicFrom').hidden = offered.length < 2;

  let service = 'preview';
  let current = null;
  const options = () => ({ auth, notify, onAuth: () => showStatus() });
  function choose(next) {
    service = offered.includes(next) ? next : 'preview';
    select.value = service;
    current = createPlayer(service, options());
    use(current);
    showStatus();
  }

  function showStatus() {
    const spotify = service === 'spotify' && auth;
    const btn = $('#spotifyBtn');
    btn.hidden = !spotify;
    btn.textContent = auth?.connected() ? 'Disconnect Spotify' : 'Connect Spotify';
    btn.classList.toggle('primary', Boolean(spotify && !auth.connected()));
    const note = $('#musicNote');
    note.hidden = !(spotify && !auth.connected());
    note.textContent = 'Connect the Spotify account that plays the music. It needs Spotify Premium. The login stays on this computer only.';

    const apple = service === 'apple' && current?.connect;
    const appleOn = Boolean(apple && current.connected());
    const abtn = $('#appleBtn');
    abtn.hidden = !apple;
    abtn.textContent = appleOn ? 'Disconnect Apple Music' : 'Connect Apple Music';
    abtn.classList.toggle('primary', Boolean(apple && !appleOn));
    if (apple && !appleOn) {
      note.hidden = false;
      note.textContent = 'Connect the Apple account that plays the music. It needs an Apple Music subscription. The login stays on this computer only.';
    }
  }

  if (redirect && auth) {
    const done = await auth.finish(redirect);
    if (done.ok) {
      remember('spotify');
      notify('Spotify is connected. Click Start music to play.', 'ok');
    } else {
      notify(done.message, 'bad');
    }
  }

  select.addEventListener('change', () => {
    remember(select.value);
    choose(select.value);
  });

  $('#spotifyBtn').addEventListener('click', async () => {
    if (!auth) return;
    if (auth.connected()) {
      auth.disconnect();
      choose('spotify'); // a fresh player: the old speaker disconnects
      notify('Spotify is disconnected on this computer.', 'ok');
      return;
    }
    $('#spotifyBtn').disabled = true;
    try {
      if (signin) await signin.reconnect(); // a fresh Spotify sign-in (the server swaps the code)
      else await auth.login(); // the page goes to Spotify and comes back to /host/
    } finally {
      $('#spotifyBtn').disabled = false;
    }
  });

  // MusicKit gets ready before the click, so Apple's login window is not blocked as a popup.
  for (const ev of ['pointerenter', 'focus']) $('#appleBtn').addEventListener(ev, () => current?.prepare?.());
  $('#appleBtn').addEventListener('click', async () => {
    if (service !== 'apple' || !current?.connect) return;
    const btn = $('#appleBtn');
    btn.disabled = true;
    try {
      if (current.connected()) {
        await current.disconnect();
        notify('Apple Music is disconnected on this computer.', 'ok');
      } else {
        const done = await current.connect(); // Apple's login window
        if (done.ok) notify('Apple Music is connected. Click Start music to play.', 'ok');
        else notify(done.message, 'bad');
      }
    } finally {
      btn.disabled = false;
      showStatus();
    }
  });

  const want = saved() ?? 'preview';
  if (want !== 'preview' && offered.includes(want)) choose(want);
  else {
    select.value = 'preview';
    showStatus();
  }
}
