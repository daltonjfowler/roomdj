// Class time on the host page (Dalton, 2026-10-06; protocol.js CLEANUP): "Class ends at" on the
// open-room form (the bell schedule presets, a custom time or the end of today) and "Cleanup
// starts", the bell schedule editor, "Change times" during a room, the cleanup banner with its
// countdown to the bell, and the Songs settings (Max song length, Instrumentals only).
// Times are this computer's own clock and time zone, sent as absolute ms. They are BELL times: the
// server adds the bell offset (protocol.js BELL OFFSET); a room's until/cleanupAt are shown minus it,
// and the countdowns run on the server's clock (server-clock.js).

import './classtime.css';
import { $, announce, esc, toast } from './dom.js';
import { CLEANUP_PAST_SLACK_MS, DEFAULT_SETTINGS, SETTINGS_LIMITS } from '../../shared/protocol.js';
import { untilFor } from '../../shared/code.js';
import { cleanBellSchedule } from '../../shared/settings.js';
import {
  bellChoices, bellTime, countdownText, defaultTimes, nextBell, timeAhead, timeValue, validateTimes,
} from '../../shared/classtime.js';
import { showTimes } from './times.js';
import { serverClock } from './server-clock.js';

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * @param {{ headers: () => object|null, send: (msg: object) => boolean, onCleanup: (on: boolean) => void }} deps
 *   headers: the teacher key + profile headers (null before both are known: the settings are per
 *   teacher); onCleanup: cleanup mode turned on/off (the host page fades the music out, or brings it back).
 */
export function initClassTime({ headers, send, onCleanup }) {
  /** The teacher's saved settings (GET /api/teacher/settings), for the bells and the prefill. */
  let defaults = { ...DEFAULT_SETTINGS };
  let roomState = null;
  let countdown = 0;
  let cleanupWas = false;

  const bells = () => defaults.bellSchedule ?? [];

  async function loadDefaults() {
    const h = headers();
    defaults = { ...DEFAULT_SETTINGS }; // another teacher's bells never show
    if (!h) return;
    try {
      const r = await fetch('/api/teacher/settings', { headers: h });
      if (r.ok) defaults = { ...DEFAULT_SETTINGS, ...(await r.json()) };
    } catch { /* offline: the built-in defaults */ }
  }

  // ---- "Class ends at": presets, custom time, the end of today (p = 'open' | 'times') ----
  function renderEnds(p, choose) {
    const now = new Date();
    const list = bellChoices(bells(), now);
    $(`#${p}Bells`).innerHTML = list.map((b, i) => `<label class="pick bell-pick${b.passed ? ' passed' : ''}">
        <input type="radio" name="${p}End" value="bell:${i}"${b.passed ? ' disabled' : ''}>
        <span>${esc(b.name)} · ${esc(b.at === null ? b.ends : clock(b.at))}${b.passed ? ' <small>(passed)</small>' : ''}</span></label>`).join('');
    choose(list);
  }
  function pick(p, value) {
    const input = document.querySelector(`input[name="${p}End"][value="${value}"]`);
    if (input) input.checked = true;
  }
  /** The chosen class end as absolute ms, or { message }. */
  function readEnd(p) {
    const choice = document.querySelector(`input[name="${p}End"]:checked`)?.value;
    if (choice === 'day') return { until: untilFor('day') };
    if (choice?.startsWith('bell:')) {
      const b = bellChoices(bells())[Number(choice.slice(5))];
      if (!b || b.passed) return { message: 'That bell has passed today. Pick another time.' };
      return { until: b.at, period: b.name || null }; // the period's own running favorite (room.js)
    }
    // After midnight late in the evening = tomorrow (timeAhead), so a period that crosses midnight works.
    const until = timeAhead($(`#${p}Custom`).value);
    if (until === null) return { message: 'Type the time class ends, or pick a bell.' };
    return { until };
  }
  /** Cleanup prefill: cleanupMinutes before class ends (none for the end of today, or when 0). */
  function prefillCleanup(p) {
    const end = readEnd(p);
    const choice = document.querySelector(`input[name="${p}End"]:checked`)?.value;
    const minutes = Number.isInteger(defaults.cleanupMinutes) ? defaults.cleanupMinutes : 5;
    $(`#${p}Cleanup`).value = end.until && choice !== 'day' && minutes > 0 ? timeValue(end.until - minutes * 60_000) : '';
  }
  function readTimes(p) {
    const end = readEnd(p);
    if (end.message) return { ok: false, message: end.message, focus: `#${p}Custom` };
    const raw = $(`#${p}Cleanup`).value;
    const cleanupAt = raw ? timeAhead(raw, new Date(), { pastSlackMs: CLEANUP_PAST_SLACK_MS }) : null;
    if (raw && cleanupAt === null) return { ok: false, message: 'Type when cleanup starts, or leave it empty.', focus: `#${p}Cleanup` };
    const v = validateTimes({ until: end.until, cleanupAt });
    if (!v.ok) return { ok: false, message: v.message, focus: v.error === 'cleanup' ? `#${p}Cleanup` : `#${p}Custom` };
    return { ...v, period: end.period ?? null };
  }
  for (const p of ['open', 'times']) {
    $(`#${p}Bells`).closest('fieldset').addEventListener('change', (e) => {
      if (e.target.name === `${p}End`) prefillCleanup(p);
    });
    $(`#${p}Custom`).addEventListener('input', () => {
      pick(p, 'custom');
      prefillCleanup(p);
    });
  }

  /** The open-room form: the next bell if there is one, else one class period from now. */
  function chooseOpen(list) {
    const next = nextBell(bells());
    const d = defaultTimes(defaults);
    $('#openCustom').value = d.classEnd;
    if (next >= 0) pick('open', `bell:${next}`);
    else pick('open', 'custom');
    prefillCleanup('open');
    if (!list.length) $('#openBells').innerHTML = '';
  }
  async function prepareOpen() {
    renderEnds('open', chooseOpen); // at once, with what we know
    await loadDefaults();
    if (!$('#startScreen').hidden) renderEnds('open', chooseOpen);
  }

  // ---- Change times (during a room) ----
  $('#timesBtn').addEventListener('click', async () => {
    if (!roomState) return;
    const s = roomState;
    // The room keeps real moments; the dialog shows (and sends back) bell times.
    const bellUntil = bellTime(s.until, s.bellOffsetSeconds);
    renderEnds('times', (list) => {
      const i = list.findIndex((b) => b.at === bellUntil && !b.passed);
      $('#timesCustom').value = timeValue(bellUntil);
      if (i >= 0) pick('times', `bell:${i}`);
      else if (bellUntil === untilFor('day')) pick('times', 'day');
      else pick('times', 'custom');
      $('#timesCleanup').value = s.cleanupAt ? timeValue(bellTime(s.cleanupAt, s.bellOffsetSeconds)) : '';
    });
    $('#timesMsg').textContent = '';
    $('#timesSave').disabled = false;
    $('#timesDlg').showModal();
    document.querySelector('input[name="timesEnd"]:checked')?.focus();
  });
  $('#timesCancel').addEventListener('click', () => $('#timesDlg').close());
  $('#timesForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = readTimes('times');
    if (!v.ok) {
      $('#timesMsg').textContent = v.message;
      return $(v.focus)?.focus();
    }
    if (send({ t: 'times', until: v.until, cleanupAt: v.cleanupAt })) $('#timesSave').disabled = true; // the answer closes it
  });
  function onTimes(msg) {
    if (msg.ok) {
      $('#timesDlg').close();
      toast('Class times changed.', 'ok');
    } else {
      $('#timesMsg').textContent = msg.message || 'Those times did not work.';
      $('#timesSave').disabled = false;
    }
  }

  // ---- Cleanup mode ----
  $('#cleanupKeep').addEventListener('click', () => {
    if (send({ t: 'cleanup', on: false })) toast('Cleanup is off. The music keeps going.', 'ok');
  });
  function tick() {
    if (!roomState?.cleanup) return;
    $('#cleanupCount').textContent = countdownText(roomState.until - serverClock.now());
  }

  /** Every snapshot: the times note, the cleanup banner and its countdown. */
  function render(s) {
    roomState = s;
    showTimes(s);
    const on = s.cleanup === true;
    $('#cleanupBanner').hidden = !on;
    document.body.classList.toggle('cleanup', on);
    if (on && !countdown) countdown = setInterval(tick, 1000);
    if (!on && countdown) {
      clearInterval(countdown);
      countdown = 0;
    }
    tick();
    if (on !== cleanupWas) {
      cleanupWas = on;
      if (on) announce(`Cleanup time! The bell rings at ${clock(bellTime(s.until, s.bellOffsetSeconds))}.`);
      onCleanup(on);
    }
  }
  /** Leaving the room. */
  function reset() {
    roomState = null;
    clearInterval(countdown);
    countdown = 0;
    cleanupWas = false;
    document.body.classList.remove('cleanup');
    $('#cleanupBanner').hidden = true;
  }

  // ---- The bell schedule editor ----
  const rowHtml = (b = { name: '', ends: '' }) => `<li class="bell-row">
      <input class="text bell-name" maxlength="${SETTINGS_LIMITS.bellName}" value="${esc(b.name)}" aria-label="Name (like P1 or Lunch)" placeholder="P1">
      <input class="text bell-ends" type="time" value="${esc(b.ends)}" aria-label="Ends at">
      <button type="button" class="bell-remove" aria-label="Remove ${esc(b.name || 'this bell time')}">Remove</button>
    </li>`;
  function bellRows() {
    return [...$('#bellRows').children].map((li) => ({ name: li.querySelector('.bell-name').value, ends: li.querySelector('.bell-ends').value }));
  }
  function showAdd() {
    $('#bellAdd').disabled = $('#bellRows').children.length >= SETTINGS_LIMITS.bellSchedule;
  }
  let bellFrom = null;
  async function openBells(from) {
    bellFrom = from;
    await loadDefaults();
    const list = bells();
    $('#bellRows').innerHTML = (list.length ? list : [{ name: '', ends: '' }]).map(rowHtml).join('');
    $('#bellMsg').textContent = headers() ? '' : 'Type the teacher key and pick who is teaching first: the bell schedule is kept for each teacher.';
    showAdd();
    $('#bellDlg').showModal();
    $('#bellRows .bell-name')?.focus();
  }
  $('#bellEditBtn').addEventListener('click', () => openBells($('#bellEditBtn')));
  $('#bellEditSettingsBtn').addEventListener('click', () => openBells($('#bellEditSettingsBtn')));
  $('#bellAdd').addEventListener('click', () => {
    $('#bellRows').insertAdjacentHTML('beforeend', rowHtml());
    showAdd();
    [...$('#bellRows').querySelectorAll('.bell-name')].pop()?.focus();
  });
  $('#bellRows').addEventListener('click', (e) => {
    const btn = e.target.closest('.bell-remove');
    if (!btn) return;
    const li = btn.closest('li');
    (li.nextElementSibling ?? li.previousElementSibling)?.querySelector('.bell-name')?.focus();
    li.remove();
    showAdd();
    if (!$('#bellRows').children.length) $('#bellAdd').focus();
  });
  function closeBells() {
    $('#bellDlg').close();
    if (bellFrom?.isConnected) bellFrom.focus();
  }
  $('#bellCancel').addEventListener('click', closeBells);
  $('#bellForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Empty rows are dropped; the server checks again (and screens the names).
    const rows = bellRows().filter((b) => b.name.trim() || b.ends);
    const errors = [];
    const schedule = cleanBellSchedule(errors, rows);
    if (errors.length) return void ($('#bellMsg').textContent = errors[0]);
    const h = headers();
    if (!h) return void ($('#bellMsg').textContent = 'Type the teacher key and pick who is teaching first: the bell schedule is kept for each teacher.');
    $('#bellSave').disabled = true;
    try {
      const r = await fetch('/api/teacher/settings', {
        method: 'PUT',
        headers: { ...h, 'content-type': 'application/json' },
        body: JSON.stringify({ bellSchedule: schedule }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return void ($('#bellMsg').textContent = data.details?.[0] || data.message || 'Could not save the bell schedule.');
      defaults = { ...DEFAULT_SETTINGS, ...data };
      closeBells();
      toast(schedule.length ? 'Bell schedule saved.' : 'Bell schedule cleared.', 'ok');
      if (!$('#startScreen').hidden) renderEnds('open', chooseOpen);
    } catch {
      $('#bellMsg').textContent = 'Could not reach RoomDJ. Try again.';
    } finally {
      $('#bellSave').disabled = false;
    }
  });

  return { prepareOpen, readOpen: () => readTimes('open'), render, onTimes, reset };
}

// ---- Settings: Songs (Max song length, Instrumentals only) ----
const FIRST_MAX_LEN = DEFAULT_SETTINGS.maxSongMinutes; // what the box shows when the switch first goes on

export function fillSongSettings(s) {
  const [lo, hi] = SETTINGS_LIMITS.maxSongMinutes;
  $('#setMaxLen').min = lo;
  $('#setMaxLen').max = hi;
  const on = Number.isInteger(s.maxSongMinutes);
  $('#setMaxLenOn').checked = on;
  $('#setMaxLen').value = on ? s.maxSongMinutes : '';
  $('#setInstrumental').checked = s.instrumentalsOnly === true;
  showMaxLen();
}
function showMaxLen() {
  const on = $('#setMaxLenOn').checked;
  $('#maxLenRow').hidden = !on;
  $('#setMaxLen').disabled = !on;
}
$('#setMaxLenOn').addEventListener('change', () => {
  if ($('#setMaxLenOn').checked && $('#setMaxLen').value === '') $('#setMaxLen').value = String(FIRST_MAX_LEN);
  showMaxLen();
});

/** { maxSongMinutes, instrumentalsOnly }, or { error } (the server checks again). */
export function readSongSettings() {
  const [lo, hi] = SETTINGS_LIMITS.maxSongMinutes;
  const on = $('#setMaxLenOn').checked;
  const n = Number($('#setMaxLen').value);
  if (on && ($('#setMaxLen').value === '' || !Number.isInteger(n) || n < lo || n > hi)) {
    return { error: `Max song length must be a whole number of minutes from ${lo} to ${hi}, or turn it off.` };
  }
  return { maxSongMinutes: on ? n : null, instrumentalsOnly: $('#setInstrumental').checked };
}
