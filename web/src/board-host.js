// The host page's side of the board (protocol.js BOARD + REMOTE): the 📺 Board link dialog (Copy,
// 🔁 New board link), the "📺 Board connected" pill, and what the boards need from this page that
// the server does not keep: the class code and the big-screen preferences ('boardInfo'), and the
// player's position ('progress', only while a board is connected). The board token is kept with
// the room's host entry (cq.host), like the host token; it never goes anywhere but this dialog.

import { $, announce, ask, toast } from './dom.js';
import { boardLink } from '../../shared/board.js';

const PROGRESS_MS = 5000;

/**
 * @param {{
 *   send: (msg: object) => boolean,           to the room, quietly (false while reconnecting)
 *   room: () => object|null,                  the room entry { room, classCode, boardToken? }
 *   saveToken: (token: string) => void,       keep the new board token with the room entry
 *   latestToken: () => string|null,           the token another tab of this computer may have saved
 *   display: () => { size, who, art },        the big-screen preferences
 *   player: () => { id, pos, dur, started, paused },
 * }} deps
 */
export function initBoardHost({ send, room, saveToken, latestToken, display, player }) {
  let boards = 0;
  let lastInfo = '';
  let lastProgress = { at: 0, key: '' };

  // ---- What the boards show that the server does not keep ----
  function sendInfo(force = false) {
    const r = room();
    if (!r) return;
    const msg = { t: 'boardInfo', code: r.classCode ?? '', display: display() };
    const key = JSON.stringify(msg);
    if (!force && key === lastInfo) return;
    if (send(msg)) lastInfo = key;
  }

  /** The player's position, about every 5 s and at once when it starts, pauses or changes song. */
  function progress(force = false) {
    if (!boards || !room()) return;
    const p = player();
    const key = `${p.id}|${p.started}|${p.paused}`;
    const now = Date.now();
    if (!force && key === lastProgress.key && now - lastProgress.at < PROGRESS_MS) return;
    if (send({ t: 'progress', ...p })) lastProgress = { at: now, key };
  }

  /** A new socket (connect or reconnect): its attachment is empty, so the boards need it all again. */
  function connected() {
    lastInfo = '';
    lastProgress = { at: 0, key: '' };
    sendInfo(true);
    progress(true);
  }

  function render(state) {
    const was = boards;
    boards = Number(state?.boards) || 0;
    $('#boardPill').hidden = boards === 0;
    $('#boardPill').textContent = boards > 1 ? `📺 ${boards} boards connected` : '📺 Board connected';
    if (boards > was) {
      if (was === 0) announce('A board is connected.');
      sendInfo(true);
      progress(true);
    }
    if ($('#boardDlg').open) renderDialog();
  }

  // ---- 📺 Board link dialog ----
  function token() {
    const r = room();
    if (!r) return null;
    const latest = latestToken();
    if (latest && latest !== r.boardToken) saveToken(latest);
    return r.boardToken ?? null;
  }

  function renderDialog(status = null) {
    const t = token();
    const r = room();
    $('#boardHave').hidden = !t;
    $('#boardNone').hidden = Boolean(t);
    if (t && r) $('#boardUrl').value = boardLink(location.origin, r.room, t);
    $('#boardNew').textContent = t ? '🔁 New board link' : '📺 Make a board link';
    $('#boardNew').classList.toggle('primary', !t);
    if (status !== null) $('#boardStatus').textContent = status;
    else $('#boardStatus').textContent = boards ? (boards === 1 ? 'A board is connected now.' : `${boards} boards are connected now.`) : 'No board is connected.';
  }

  function openDialog() {
    $('#boardSigninUrl').textContent = `${location.host}/board`;
    renderDialog();
    $('#boardDlg').showModal();
    (token() ? $('#boardCopy') : $('#boardNew')).focus();
  }
  $('#boardBtn').addEventListener('click', openDialog);
  // 🖥️ Projector on the toolbar (Dalton, 2026-10-16: most teachers never found it in the Screen menu).
  $('#projectorBtn').addEventListener('click', openDialog);

  $('#boardCopy').addEventListener('click', async () => {
    const url = $('#boardUrl').value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast('Board link copied. Open it on the projector computer.', 'ok');
    } catch {
      $('#boardUrl').select();
      toast('Press Ctrl+C to copy the board link.', 'warn');
    }
  });

  $('#boardNew').addEventListener('click', async () => {
    if (token() || boards) {
      $('#boardDlg').close();
      const ok = await ask('Make a new board link?', 'New board link',
        'The old link stops working, and a board using it goes dark until you open the new link on the projector computer. Boards that signed in (roomdj.com/board) keep working.');
      $('#boardDlg').showModal();
      if (!ok) return;
    }
    if (!send({ t: 'boardLink' })) return void renderDialog('Reconnecting to the room. Try again in a moment.');
    renderDialog('Making a new board link…');
  });

  /** Messages from the room: true when this module took it. */
  function onMessage(msg) {
    if (msg.t !== 'boardLink') return false;
    if (typeof msg.token !== 'string') return true;
    saveToken(msg.token);
    if ($('#boardDlg').open) {
      renderDialog('New board link ready. Copy it to the projector computer.');
      $('#boardCopy').focus();
    } else toast('New board link ready (📺 Board link).', 'ok');
    return true;
  }

  function reset() {
    boards = 0;
    lastInfo = '';
    $('#boardPill').hidden = true;
    if ($('#boardDlg').open) $('#boardDlg').close();
  }

  return { render, onMessage, sendInfo, progress, connected, reset, get boards() { return boards; } };
}
