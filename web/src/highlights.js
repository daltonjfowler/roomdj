// Top 5, the end-of-class recap and the ⭐ Class favorites on the host page (Dalton, 2026-10-06;
// protocol.js TOP 5 + RECAP and FAVORITES): the 🏆 Top 5 dialog, the Top 5 board under the cleanup
// banner (big screen too), the 🎬 recap (fun stats from shared/stats.js, "🎲 More stats", "Copy
// recap") and "▶ Play recap" (recap-show.js, the full-screen awards show), the ⭐ Favorites dialog
// (pin, remove) and the 🎨 artist + favorites switches in Settings. The server owns all of it; this
// page shows what it sends. The recap the room sends as it closes is kept in memory only (the
// closed screen's "Class recap" button); nothing here goes to storage.

import './highlights.css';
import { $, announce, artHtml, ask, esc, keepFocus, toast } from './dom.js';
import { recapText } from '../../shared/highlights.js';
import { byLabel } from '../../shared/protocol.js';
import { pickStats } from '../../shared/stats.js';
import { initRecapShow } from './recap-show.js';
import { cueFor } from '../../shared/recap-music.js';

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * One Top 5 row: rank (👑 for #1), art, title, artist, who suggested it, net score. `downs` false
 * (protocol.js DOWNVOTE MODE: 👎 off, or counts hidden where the class may see it): 👍 alone.
 */
export function top5Html(list, { who = true, downs = true } = {}) {
  return list.map((t, i) => `<li class="top5-item${i === 0 ? ' crown' : ''}">
      <span class="top5-rank" aria-label="${i === 0 ? 'Number 1' : `Number ${i + 1}`}">${i === 0 ? '👑' : i + 1}</span>
      ${artHtml(t.song, 100)}
      <span class="song-text"><span class="song-title">${esc(t.song.title)}</span>
        <span class="song-artist">${esc(t.song.artist)}${who ? `<span class="top5-by"> · by ${esc(byLabel(t))}</span>` : ''}</span></span>
      ${downs ? `<span class="top5-score" title="👍 ${t.up}, 👎 ${t.down}"><b>${signed(t.score)}</b><small>👍 ${t.up} · 👎 ${t.down}</small></span>`
    : `<span class="top5-score" title="👍 ${t.up}"><b>👍 ${t.up}</b></span>`}
    </li>`).join('');
}

/**
 * @param {{ send: (msg: object) => boolean, duck?: (on: boolean) => void, boards?: () => number, isBig?: () => boolean,
 *   picks?: object, audio?: object }} deps
 *   send: to the room (false while reconnecting); duck: turn the room music down a little while the
 *   recap show plays; boards: how many boards are connected (▶ Play recap then plays there:
 *   protocol.js BOARD + REMOTE); isBig: this page is in big screen (it plays the show too);
 *   picks: the teacher's own suggestions (teacher-suggest.js): ➕ Suggest on each favorite;
 *   audio: the recap music and sounds (recap-audio.js; protocol.js RECAP MUSIC). Off in Settings:
 *   the room music only turns down (duck) while the show plays
 */
export function initHighlights({ send, duck = () => {}, boards = () => 0, isBig = () => false, picks = null, audio = null }) {
  let top5 = [];
  let mode = 'shown'; // the room's 👎 mode (protocol.js DOWNVOTE MODE)
  let recap = null; // the last recap (kept in memory only)
  let favorites = [];

  // ---- 🏆 Top 5: the dialog, and the board under the cleanup banner ----
  function render(state) {
    top5 = Array.isArray(state?.top5) ? state.top5 : [];
    mode = ['off', 'hidden', 'shown'].includes(state?.downvoteMode) ? state.downvoteMode : 'shown';
    $('#top5Count').textContent = top5.length ? `(${top5.length})` : '';
    const board = top5.length > 0 && state?.cleanup === true;
    $('#top5Board').hidden = !board;
    // The board under the cleanup banner is for the class: 👎 numbers only while they are 'shown'.
    if (board) $('#top5BoardList').innerHTML = top5Html(top5, { downs: mode === 'shown' });
    if ($('#top5Dlg').open) renderTop5();
    if ($('#favDlg').open) renderFavorites(); // the ➕ Suggest buttons follow the queue
  }
  function renderTop5() {
    $('#top5List').innerHTML = top5Html(top5, { downs: mode !== 'off' }); // the teacher's own dialog
    $('#top5Empty').hidden = top5.length > 0;
  }
  $('#top5Btn').addEventListener('click', () => {
    renderTop5();
    $('#top5Dlg').showModal();
  });

  // ---- 🎬 End-of-class recap: totals, 3 or 4 fun stats + the versus card, Top 5, songs ----
  let shown = null; // { versus, picks }: the stats on the card now (Copy recap and the show use them)
  let playWhenHere = false; // "▶ Play recap" pressed: play as soon as the room's recap comes
  let ducked = false;
  const recapShow = initRecapShow({
    onStart(r) {
      if (audio?.start(r, 'own')) return;
      ducked = true;
      duck(true);
    },
    onReveal: (slide) => audio?.sound(cueFor(slide)),
    onFinish: () => audio?.stop(),
    onEnd() {
      audio?.stop();
      if (ducked) duck(false);
      ducked = false;
    },
  });

  function askRecap({ play = false } = {}) {
    // A board is connected: the show plays there (and here too in big screen).
    if (play && boards() > 0) return void send({ t: 'recapShow' });
    if (!send({ t: 'recap' })) return;
    playWhenHere = play;
    if (play) return;
    $('#recapBody').innerHTML = '<p class="note">Getting the recap…</p>';
    if (!$('#recapDlg').open) $('#recapDlg').showModal();
  }
  $('#recapBtn').addEventListener('click', () => {
    $('#top5Dlg').close();
    askRecap();
  });
  for (const id of ['#playRecapBtn', '#playRecapMenu', '#cleanupRecap']) $(id).addEventListener('click', () => {
    if ($('#top5Dlg').open) $('#top5Dlg').close();
    askRecap({ play: true });
  });
  $('#closedRecap').addEventListener('click', () => {
    if (!recap) return;
    renderRecap();
    $('#recapDlg').showModal();
  });
  $('#recapMore').addEventListener('click', () => {
    if (!recap) return;
    shown = pickStats(recap.stats ?? [], 4);
    renderRecap({ keepPicks: true });
  });
  $('#recapPlay').addEventListener('click', () => {
    if (!recap) return;
    $('#recapDlg').close();
    recapShow.play(recap, shown);
  });

  function statHtml(s) {
    const chart = s.chart ? `<ul class="recap-bars" aria-label="${esc(s.chart.label)}">${s.chart.rows.map((r) => {
      const max = Math.max(1, ...s.chart.rows.map((x) => x.n));
      return `<li><span>${esc(r.label)}</span><span class="recap-bar"><span style="width:${Math.round((r.n / max) * 100)}%"></span></span><b>${r.n}</b></li>`;
    }).join('')}</ul>` : '';
    return `<div class="recap-fun" data-stat="${esc(s.id)}"><span class="recap-fun-title">${esc(s.emoji)} ${esc(s.title)}</span>
      <b class="recap-fun-name">${esc(s.name)}</b>${s.detail ? `<span class="recap-fun-detail">${esc(s.detail)}</span>` : ''}${chart}</div>`;
  }
  function versusHtml(v) {
    if (!v) return '';
    const side = (who, emoji, title, unit) => `<div class="recap-vs-side"><span>${emoji} ${title}</span>
      <b>${who ? esc(who.nick) : 'Nobody yet'}</b><small>${who ? esc(`${plural(who.n, unit[0])} ${unit[1]}`) : ''}</small></div>`;
    return `<div class="recap-vs" data-stat="versus">${side(v.contributor, '🎤', 'Top contributor', ['song', 'suggested'])}
      <span class="recap-vs-mark" aria-label="versus">VS</span>${side(v.voter, '🗳', 'Top voter', ['vote', 'cast'])}</div>`;
  }

  function renderRecap({ keepPicks = false } = {}) {
    if (!recap) return;
    const r = recap;
    // DOWNVOTE MODE: unless 👎 is 'shown' the recap has no 👎 numbers (the room sends none).
    const downs = (r.downvoteMode ?? 'shown') === 'shown';
    if (!keepPicks || !shown) shown = pickStats(r.stats ?? [], 4);
    $('#recapMore').hidden = (r.stats ?? []).filter((x) => x.id !== 'versus').length <= shown.picks.length;
    $('#recapBody').innerHTML = `
      <div class="recap-stats">
        <div class="recap-stat"><b>${r.totals.songs}</b><span>${r.totals.songs === 1 ? 'song played' : 'songs played'}</span></div>
        <div class="recap-stat"><b>${r.totals.votes}</b><span>${r.totals.votes === 1 ? 'vote' : 'votes'} (👍 ${r.totals.up}${downs ? ` · 👎 ${r.totals.down}` : ''})</span></div>
      </div>
      ${versusHtml(shown.versus)}
      ${shown.picks.length ? `<div class="recap-funs">${shown.picks.map(statHtml).join('')}</div>` : ''}
      ${r.top5.length ? `<h3 class="recap-h">🏆 Top 5</h3><ol class="top5-list recap-top5">${top5Html(r.top5, { downs })}</ol>` : '<p class="note">No songs played yet.</p>'}
      ${r.songs.length ? `<h3 class="recap-h">🎵 Songs in order</h3>
      <ol class="recap-songs">${r.songs.map((s) => `<li><time>${esc(clock(s.at))}</time>
        <span class="song-title">${esc(s.song.title)}</span> <span class="song-artist">· ${esc(s.song.artist)} · by ${esc(byLabel(s))}</span>
        <b class="recap-net">${downs ? signed(s.score) : `👍 ${s.up}`}</b>${s.status === 'skipped' ? ' <small class="note">(skipped)</small>' : ''}</li>`).join('')}</ol>` : ''}`;
    announce(`Class recap: ${plural(r.totals.songs, 'song')} played, ${plural(r.totals.votes, 'vote')}.${shown.versus ? ` ${shown.versus.text}.` : ''}`);
  }

  $('#recapCopy').addEventListener('click', async () => {
    if (!recap) return;
    const stats = [shown?.versus, ...(shown?.picks ?? [])].filter(Boolean);
    const text = recapText(recap, { stats, date: new Date(recap.at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) });
    try {
      await navigator.clipboard.writeText(text);
      toast('Recap copied. Paste it in Google Classroom or an email.', 'ok');
    } catch {
      window.prompt('Copy this recap:', text);
    }
  });

  // ---- ⭐ Favorites (KV, songs only): pin to the top, or take off ----
  let favKey = '';
  function renderFavorites() {
    $('#favEmpty').hidden = favorites.length > 0;
    // Only when something shown changed (every vote sends a snapshot): pictures do not flicker.
    const key = JSON.stringify([favorites, favorites.map((f) => picks?.stateOf(f.song) ?? null)]);
    if (key === favKey) return;
    favKey = key;
    keepFocus(() => {
      $('#favList').innerHTML = favorites.map((f) => `<li class="fav-item${f.pinned ? ' pinned' : ''}" data-id="${esc(f.song.id)}">
        ${artHtml(f.song, 100)}
        <span class="song-text"><span class="song-title">${f.pinned ? '📌 ' : ''}${esc(f.song.title)}</span>
          <span class="song-artist">${esc(f.song.artist)}</span>
          <small class="note">${f.top5 ? `🏆 ${plural(f.top5, 'Top 5')} · ` : ''}${f.net >= 0 ? '+' : ''}${f.net} net · score ${f.score}</small></span>
        <span class="item-tools">
          ${picks ? picks.buttonHtml(f.song, 'fsuggest') : ''}
          <button type="button" data-act="pin" aria-pressed="${f.pinned}" aria-label="${esc(`${f.pinned ? 'Unpin' : 'Pin'} ${f.song.title}`)}">${f.pinned ? 'Unpin' : '📌 Pin'}</button>
          <button type="button" data-act="remove" class="danger" aria-label="${esc(`Remove ${f.song.title} from the favorites`)}">Remove</button>
        </span>
      </li>`).join('');
    });
  }
  $('#favBtn').addEventListener('click', () => {
    if (!send({ t: 'favorites' })) return;
    $('#favEmpty').hidden = true;
    favKey = '';
    if (!favorites.length) $('#favList').innerHTML = '<li class="note">Loading…</li>';
    $('#favDlg').showModal();
  });
  if (picks) picks.onChange = () => { if ($('#favDlg').open) renderFavorites(); };
  $('#favList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    const id = btn.closest('[data-id]').dataset.id;
    const fav = favorites.find((f) => f.song.id === id);
    if (!fav) return;
    // ➕ Suggest: the teacher's own pick, through the same song check as a student's (one tap).
    if (btn.dataset.act === 'fsuggest') return picks?.suggest(fav.song);
    if (btn.dataset.act === 'twhy') return picks?.whyToast(fav.song);
    if (btn.dataset.act === 'pin') {
      send({ t: 'favoritePin', id, on: !fav.pinned });
    } else {
      $('#favDlg').close();
      const ok = await ask(`Take "${fav.song.title}" off the favorites?`, 'Remove',
        'Students stop seeing it under ⭐ Class favorites. It can come back if a class votes it up again.');
      if (ok) send({ t: 'favoriteRemove', id });
      $('#favDlg').showModal();
    }
  });

  // ---- 🎨 Settings switches (shared/protocol.js DEFAULT_SETTINGS) ----
  function fillSettings(s) {
    $('#setShowFav').checked = s.showFavorites !== false;
    $('#setBackToBack').checked = s.noBackToBackArtist === true;
    $('#setOnePerArtist').checked = s.oneSongPerArtist === true;
  }
  function readSettings() {
    return {
      showFavorites: $('#setShowFav').checked,
      noBackToBackArtist: $('#setBackToBack').checked,
      oneSongPerArtist: $('#setOnePerArtist').checked,
    };
  }

  /** Messages from the room: true when this module took it. */
  function onMessage(msg) {
    if (msg.t === 'recap' && msg.recap) {
      recap = msg.recap;
      $('#closedRecap').hidden = false;
      shown = null; // a new recap: new random stats
      if (msg.show) {
        // ▶ Play recap for the board(s), from here or from a board's remote.
        if (isBig()) {
          shown = pickStats(recap.stats ?? [], 4);
          recapShow.play(recap, shown);
        } else {
          toast('▶ The recap is playing on the board.', 'ok');
          audio?.start(recap, 'board'); // this computer's speakers play its music (the board's cues time the sounds)
        }
      } else if (playWhenHere && !msg.closing) {
        playWhenHere = false;
        shown = pickStats(recap.stats ?? [], 4);
        recapShow.play(recap, shown);
      } else if ($('#recapDlg').open) renderRecap();
      return true;
    }
    if (msg.t === 'recapCue') {
      audio?.onCue(msg.cue);
      return true;
    }
    if (msg.t === 'favoritesAll' && Array.isArray(msg.list)) {
      favorites = msg.list;
      if ($('#favDlg').open) renderFavorites();
      return true;
    }
    return false;
  }

  /** A new room: the old recap goes (it was only for the closed screen). */
  function reset() {
    recap = null;
    top5 = [];
    $('#closedRecap').hidden = true;
    for (const id of ['#recapDlg', '#top5Dlg', '#favDlg']) if ($(id).open) $(id).close();
    recapShow.close();
    audio?.stop();
  }

  return { render, onMessage, fillSettings, readSettings, reset };
}
