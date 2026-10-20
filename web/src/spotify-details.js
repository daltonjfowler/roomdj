// "Spotify details" on the host page: a small link in the music area, there only while the Spotify
// player is in use. It opens a dialog with the player's recent Spotify states and what RoomDJ made
// of them (players/spotify.js keeps the log), and a Copy details button, so a teacher can send us
// what happened when a song stopped by itself. The text has song names and positions, never a token.

/** Adds the link and its dialog; `text()` gives the details. Returns { remove() }. */
export function mountSpotifyDetails(text) {
  const area = document.getElementById('musicFrom');
  if (!area) return { remove() {} };

  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'linkbtn';
  link.id = 'spotifyDetailsBtn';
  link.textContent = 'Spotify details';
  link.title = 'What the Spotify player saw lately, to copy and send if songs stop by themselves';
  link.setAttribute('aria-haspopup', 'dialog');

  const dlg = document.createElement('dialog');
  dlg.id = 'spotifyDetailsDlg';
  dlg.className = 'dialog wide-dialog';
  dlg.setAttribute('aria-labelledby', 'spotifyDetailsTitle');
  dlg.innerHTML = `<form method="dialog">
      <h2 id="spotifyDetailsTitle">Spotify details</h2>
      <p class="note">What the Spotify player reported for the last songs, and what RoomDJ decided. If something went wrong (a song stopped too early, skipped or never started), send it to Dalton as a bug report: click <b>Email it to Dalton</b>, or Copy details and paste it into an email to <a href="mailto:dalton@teachchat.app">dalton@teachchat.app</a>. It has song names and times only, no passwords or logins.</p>
      <label for="spotifyDetailsText" class="sr-only">Spotify details</label>
      <textarea id="spotifyDetailsText" class="text" rows="14" readonly spellcheck="false"></textarea>
      <p class="note" data-copied aria-live="polite"></p>
      <div class="dialog-actions">
        <button type="button" data-copy>Copy details</button>
        <button type="button" data-email>🐞 Email it to Dalton</button>
        <button class="primary" value="done">Done</button>
      </div>
    </form>`;
  const box = dlg.querySelector('textarea');
  box.style.width = '100%';
  box.style.fontFamily = 'ui-monospace, Consolas, monospace';
  box.style.fontSize = '0.8rem';
  const said = dlg.querySelector('[data-copied]');

  link.addEventListener('click', () => {
    box.value = text();
    said.textContent = '';
    dlg.showModal();
  });
  dlg.querySelector('[data-copy]').addEventListener('click', async () => {
    box.value = text();
    try {
      await navigator.clipboard.writeText(box.value);
    } catch {
      box.select();
      document.execCommand?.('copy');
    }
    said.textContent = 'Copied. Paste it into an email to dalton@teachchat.app.';
  });
  // A bug report to Dalton: the details are copied (all of them) and the email starts with as much
  // as fits in a mailto link (long ones are cut; the copy has the rest).
  dlg.querySelector('[data-email]').addEventListener('click', async () => {
    box.value = text();
    try { await navigator.clipboard.writeText(box.value); } catch { /* the email still has the start */ }
    const MAX = 1500;
    const cut = box.value.length > MAX;
    const body = `What happened? (for example: the song stopped after a few seconds)\n\n\n--- Spotify details${cut ? ' (cut short: paste the full copy here)' : ''} ---\n${box.value.slice(0, MAX)}`;
    location.href = `mailto:dalton@teachchat.app?subject=${encodeURIComponent('RoomDJ bug report (Spotify)')}&body=${encodeURIComponent(body)}`;
    said.textContent = cut ? 'Your email app should open. The details are copied too: paste them in if the email cut them short.' : 'Your email app should open with the details in it.';
  });

  area.append(link);
  document.body.append(dlg);
  return {
    remove() {
      if (dlg.open) dlg.close();
      link.remove();
      dlg.remove();
    },
  };
}
