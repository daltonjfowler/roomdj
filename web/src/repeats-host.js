// 😴 Repeats on the host page (Dalton, 2026-10-07; protocol.js REPEATS): the Repeat cooldown choice
// in Settings → Songs, and the "😴 Resting songs" list in the ⭐ Favorites dialog, where the
// teacher can wake a song early. The server owns the record (KV `recent`, songs only); this page
// shows what it sends, in this computer's own time zone.

import { $, announce, esc, keepFocus } from './dom.js';
import { COOLDOWN_DAYS } from '../../shared/protocol.js';
import { playedWhen, restingUntilLabel } from '../../shared/repeats.js';

const DAYS_TEXT = { 1: '1 day', 3: '3 days', 7: '1 week', 14: '2 weeks' };

/** @param {{ send: (msg: object) => boolean }} deps */
export function initRepeats({ send }) {
  let list = [];
  let days = null;

  const select = $('#setCooldown');
  select.innerHTML = ['<option value="off">Off</option>', ...COOLDOWN_DAYS.map((d) => `<option value="${d}">${DAYS_TEXT[d] ?? `${d} days`}</option>`)].join('');

  function fillSettings(s) {
    select.value = s.cooldownDays == null ? 'off' : String(s.cooldownDays);
  }
  function readSettings() {
    return { cooldownDays: select.value === 'off' ? null : Number(select.value) };
  }

  function render() {
    $('#restNote').textContent = days
      ? `Songs that played in any of your rooms rest for ${DAYS_TEXT[days] ?? `${days} days`} (Settings, Songs). Wake one to let students pick it again now.`
      : 'The repeat cooldown is off (Settings, Songs): every song can be picked again.';
    $('#restEmpty').hidden = list.length > 0 || !days;
    keepFocus(() => {
      $('#restList').innerHTML = list.map((e) => `<li class="fav-item" data-key="${esc(e.key)}">
        <span class="song-text"><span class="song-title">${esc(e.title || e.key)}</span>
          <span class="song-artist">${esc(e.artist)}</span>
          <small class="note">${esc(`Played ${playedWhen(e.at)} · resting ${restingUntilLabel(e.until)}`)}</small></span>
        <span class="item-tools"><button type="button" data-act="wake" aria-label="${esc(`Wake ${e.title} now`)}">⏰ Wake now</button></span>
      </li>`).join('');
    });
  }

  $('#favBtn').addEventListener('click', () => send({ t: 'resting' }));
  $('#restList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="wake"]');
    if (!btn) return;
    const key = btn.closest('[data-key]').dataset.key;
    const song = list.find((x) => x.key === key);
    if (send({ t: 'wake', key }) && song) announce(`${song.title} can be picked again.`);
  });

  /** Messages from the room: true when this module took it. */
  function onMessage(msg) {
    if (msg.t !== 'restingAll' || !Array.isArray(msg.list)) return false;
    list = msg.list;
    days = msg.cooldownDays ?? null;
    if ($('#favDlg').open) render();
    return true;
  }

  return { fillSettings, readSettings, onMessage };
}
