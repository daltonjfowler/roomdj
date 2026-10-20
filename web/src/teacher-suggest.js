// The teacher's own picks on the host page (Dalton, 2026-10-07; protocol.js TEACHER PICKS):
// "🔎 Suggest a song" (the room's own search over the host socket: the same relay and cache as a
// student's search), Suggest from ⭐ Favorites, and the answer to each pick. The server runs the
// same filter as for students (an unknown song waits in Needs a look) and never charges the
// teacher; this page only shows what it says. Results are marked like the student page's: In the
// queue, Played already, 😴 Resting, ⏱ Too long, 🎨 Artist waiting, Not allowed + Why?.

import { $, announce, artHtml, esc, keepFocus, spotifyMark, toast } from './dom.js';
import { QUERY_MAX, whyText } from '../../shared/protocol.js';
import { tooLong } from '../../shared/classtime.js';
import { mainArtist, mainArtistName } from '../../shared/filter.js';
import { restingEvidence, restingUntilLabel, songKey } from '../../shared/repeats.js';

const SEARCH_DELAY_MS = 350;
/** A refusal that will not change today: the result shows this instead of a Suggest button. */
const REFUSED_LABEL = {
  explicit: 'Not allowed', blocklist: 'Not allowed', banned: 'Not allowed', theme: 'Not allowed', not_instrumental: 'Not allowed',
  played: 'Played already',
};
/** Refusals that mean "not now" rather than "no": an amber toast. */
const WAIT = new Set(['duplicate', 'rate', 'reviewFull', 'unavailable', 'queueFull', 'too_long', 'same_artist', 'resting']);
const TOO_LONG = '⏱ Too long';
const ARTIST_WAITING = '🎨 Artist waiting';
const RESTING = '😴 Resting';
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * @param {{ send: (msg: object) => boolean, getState: () => object|null }} deps
 *   send: to the room (false while reconnecting); getState: the host's last snapshot
 */
export function initTeacherSuggest({ send, getState }) {
  let results = [];
  let asked = ''; // the query the results are for
  let searchTimer = 0;
  const pending = new Set(); // song ids sent, waiting for 'suggested'
  const refused = new Map(); // song id → short label
  const refusedWhy = new Map(); // song id → the teacher's full reason
  const played = new Set(); // song ids seen playing in this room
  const songs = new Map(); // song id → song (results and favorites), for 'suggested' answers
  let playedKeys = new Set(); // 'repeats': song keys played this period (any version)
  let resting = new Map(); // 'repeats': song key → [at, until]
  let renderedKey = '';

  const state = () => getState();
  const restingOf = (song) => {
    const r = resting.get(songKey(song));
    return r && Date.now() < r[1] ? r : null;
  };
  const longWhy = (song) => {
    const long = tooLong(song, state()?.settings);
    return long ? whyText({ id: 'too_long', evidence: long.evidence }, 'teacher') : '';
  };
  /** One song per artist: the waiting song (queue or Needs a look) by the same main artist. */
  const artistWhy = (song) => {
    const s = state();
    if (s?.settings?.oneSongPerArtist !== true) return '';
    const artist = mainArtist(song.artist);
    const hit = artist && [...(s.queue ?? []), ...(s.review ?? [])].find((q) => q.song.id !== song.id && mainArtist(q.song.artist) === artist);
    return hit ? whyText({ id: 'same_artist', evidence: `A song by ${mainArtistName(hit.song.artist) || hit.song.artist} is already waiting.` }, 'teacher') : '';
  };
  const restingWhy = (song) => {
    const r = restingOf(song);
    return r ? whyText({ id: 'resting', evidence: restingEvidence(r[0], r[1]) }, 'teacher') : '';
  };

  /**
   * What a result's button says, and the reason behind it: [label, kind, why]. kind '' = Suggest,
   * 'status' = a label instead of a button; why = the text for its Why? ('' = none).
   */
  function stateOf(song) {
    const s = state();
    const id = song.id;
    const key = songKey(song);
    const same = (q) => q && (q.song.id === id || (key && songKey(q.song) === key));
    if (same(s?.nowPlaying)) return ['▶ Playing now', 'status', ''];
    if ((s?.queue ?? []).some(same)) return ['✓ In the queue', 'status', ''];
    if ((s?.review ?? []).some(same)) return ['👀 Needs a look', 'status', ''];
    if (pending.has(id)) return ['Checking…', 'status', ''];
    if (played.has(id) || playedKeys.has(key)) return ['Played already', 'status', ''];
    if (refused.has(id)) return [refused.get(id), 'status', refusedWhy.get(id) ?? ''];
    const rest = restingOf(song);
    if (rest) return [`${RESTING} ${restingUntilLabel(rest[1])}`, 'status', restingWhy(song)];
    const long = longWhy(song);
    if (long) return [TOO_LONG, 'status', long];
    const artist = artistWhy(song);
    if (artist) return [ARTIST_WAITING, 'status', artist];
    return ['Suggest', '', ''];
  }

  /** One row's Suggest button, or its label + Why?. `act` names the click (the favorites list has its own). */
  function buttonHtml(song, act = 'tsuggest') {
    const [label, kind, why] = stateOf(song);
    const spoken = label === 'Suggest' ? 'Suggest' : label.replace(/^[^A-Za-z]+/, '');
    const button = `<button type="button" class="${kind ? 'status' : 'primary'}" data-act="${act}" ${kind ? 'disabled' : ''}
      aria-label="${esc(`${spoken}: ${song.title} by ${song.artist}`)}">${esc(label === 'Suggest' ? '➕ Suggest' : label)}</button>`;
    return why ? `${button}<button type="button" data-act="twhy" aria-label="${esc(`Why: ${song.title}`)}">Why?</button>` : button;
  }

  function render() {
    if (!$('#suggestDlg').open) return;
    const key = JSON.stringify(results.map((song) => [song.id, ...stateOf(song)]));
    if (key === renderedKey) return;
    renderedKey = key;
    keepFocus(() => {
      $('#tResults').innerHTML = results.map((song) => `<li class="fav-item" data-id="${esc(song.id)}">
        ${artHtml(song, 100, { blur: true })}
        <span class="song-text"><span class="song-title">${esc(song.title)}</span>
          <span class="song-artist">${spotifyMark(song)}${esc(song.artist)}</span>
          ${song.explicit === 'cleaned' ? '<small class="note">Clean version</small>' : ''}</span>
        <span class="item-tools">${buttonHtml(song)}</span>
      </li>`).join('');
    });
  }

  /** Suggest one song (from the results or the favorites). */
  function suggest(song) {
    if (!song?.id || pending.has(song.id)) return;
    songs.set(song.id, song);
    if (!send({ t: 'suggest', song: song.id })) return;
    pending.add(song.id);
    announce(`Checking ${song.title}…`);
    render();
  }

  function search() {
    clearTimeout(searchTimer);
    const q = $('#tq').value.trim().slice(0, QUERY_MAX);
    if (q.length < 2) {
      results = [];
      asked = '';
      $('#tqMsg').classList.remove('busy');
      $('#tqMsg').textContent = q.length === 1 ? 'Keep typing…' : '';
      renderedKey = '';
      return render();
    }
    if (q === asked && results.length) return;
    asked = q;
    if (!send({ t: 'search', q })) return void ($('#tqMsg').textContent = 'Reconnecting to the room. Try again in a moment.');
    $('#tqMsg').classList.add('busy');
    $('#tqMsg').textContent = 'Searching…';
    $('#tResults').classList.add('stale');
  }

  function open() {
    if (!$('#suggestDlg').open) $('#suggestDlg').showModal();
    renderedKey = '';
    render();
    $('#tq').focus();
    $('#tq').select();
  }

  $('#suggestBtn').addEventListener('click', open);
  $('#tSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    asked = ''; // Search again on Enter
    search();
  });
  $('#tq').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, SEARCH_DELAY_MS);
  });
  $('#tResults').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    const song = results.find((s) => s.id === btn.closest('[data-id]').dataset.id);
    if (!song) return;
    if (btn.dataset.act === 'tsuggest') suggest(song);
    if (btn.dataset.act === 'twhy') whyToast(song);
  });

  function whyToast(song) {
    const why = stateOf(song)[2];
    if (why) toast(sentence(why), 'warn', 9000);
    if (why) announce(why);
  }

  /** The teacher's words for a 'suggested' refusal: the reason, plus the full detail (the blocked word...). */
  function reasonText(msg, song) {
    if (msg.reason === 'resting' && Number.isFinite(msg.until)) return whyText({ id: 'resting', evidence: restingEvidence(msg.at, msg.until) }, 'teacher');
    const why = msg.why ? whyText(msg.why, 'teacher') : '';
    const detail = typeof msg.detail === 'string' && msg.detail && !why.includes(msg.detail) ? msg.detail : '';
    return [why || msg.message || 'That song could not be added.', detail].filter(Boolean).map(sentence).join(' ')
      || `"${song?.title ?? 'That song'}" could not be added.`;
  }

  /** Messages from the room: true when this module took it. */
  function onMessage(msg) {
    if (msg.t === 'searchResults') {
      if (msg.q !== asked) return true; // an older search
      $('#tqMsg').classList.remove('busy');
      $('#tResults').classList.remove('stale');
      if (msg.error) {
        results = [];
        $('#tqMsg').textContent = msg.message || 'Search is not working right now. Try again in a moment.';
      } else {
        results = Array.isArray(msg.results) ? msg.results.filter((s) => s?.id) : [];
        for (const s of results) songs.set(s.id, s);
        $('#tqMsg').textContent = results.length
          ? `${results.length} ${results.length === 1 ? 'song' : 'songs'} found.`
          : 'No songs found. Try other words, or just the artist\'s name.';
      }
      renderedKey = '';
      render();
      return true;
    }
    if (msg.t === 'suggested') {
      pending.delete(msg.song);
      const song = songs.get(msg.song);
      const title = msg.title ?? song?.title ?? 'That song';
      if (msg.ok) {
        const name = state()?.teacherName;
        toast(`"${title}" joined the queue${name ? ` as 🍎 ${name}` : ''}.`, 'ok');
        announce(`${title} joined the queue.`);
      } else if (msg.reason === 'review') {
        toast(`"${title}" waits in 👀 Needs a look: the song checker does not know it. Allow it there to queue it.`, 'warn', 9000);
      } else {
        const text = reasonText(msg, song);
        if (REFUSED_LABEL[msg.reason]) refused.set(msg.song, REFUSED_LABEL[msg.reason]);
        if (msg.reason === 'resting' && song && Number.isFinite(msg.until)) resting.set(songKey(song), [msg.at, msg.until]);
        if (msg.why || msg.detail) refusedWhy.set(msg.song, text);
        toast(`Not added: "${title}". ${text}`, WAIT.has(msg.reason) ? 'warn' : 'bad', 10000);
      }
      renderedKey = '';
      render();
      onChange();
      return true;
    }
    if (msg.t === 'repeats') {
      playedKeys = new Set(Array.isArray(msg.played) ? msg.played : []);
      resting = new Map((Array.isArray(msg.resting) ? msg.resting : []).filter((r) => Array.isArray(r) && r.length === 3).map(([k, at, until]) => [k, [at, until]]));
      render();
      onChange();
      return true;
    }
    return false;
  }

  let onChange = () => {};
  /** A new snapshot: songs seen playing, and the rows' labels. */
  function onState(s) {
    if (s?.nowPlaying) played.add(s.nowPlaying.song.id);
    render();
  }

  /** A new room: nothing carries over. */
  function reset() {
    results = [];
    asked = '';
    pending.clear();
    refused.clear();
    refusedWhy.clear();
    played.clear();
    playedKeys = new Set();
    resting = new Map();
    renderedKey = '';
    $('#tResults').innerHTML = '';
    $('#tqMsg').textContent = '';
    $('#tq').value = '';
    if ($('#suggestDlg').open) $('#suggestDlg').close();
  }

  return {
    open, suggest, onMessage, onState, reset, stateOf, buttonHtml, whyToast,
    /** Called when a pick's answer or the repeats change (the favorites list re-draws its buttons). */
    set onChange(fn) { onChange = fn; },
  };
}
