// The admin page (/admin/; src/admin.js on the server). Uses the Spotify sign-in from the host page
// (account.js: same storage); the server decides who is an admin on every call (ADMIN_PROFILES), so
// this page only shows what it is given. Read-mostly: hide / show / rename a teacher on the list and
// link a Spotify email. Every name goes in with textContent (never as HTML).

import './style.css';
import './admin.css';
import { initThemeButton } from './theme.js';
import { $, toast } from './dom.js';
import { sessionHeaders } from './account.js';

initThemeButton($('#theme'));

function gate(text) {
  $('#dash').hidden = true;
  $('#gate').hidden = false;
  if (text) $('#gateText').textContent = text;
}

async function call(method, path, body) {
  const headers = sessionHeaders();
  if (!headers) return { status: 401, data: {} };
  try {
    const r = await fetch(path, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: { message: 'Could not reach RoomDJ. Check the internet and try again.' } };
  }
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

const STATUS = { 'signed in': '✅ signed in', linked: '🔗 linked, not signed in yet', 'not linked': '⚪ not linked', hidden: '⏸️ turned off' };

/** One teacher's row: name, a note, Rename and Turn off / Turn back on. */
function teacherRow(t, note, isOff) {
  const li = el('li');
  li.append(el('b', t.name || 'Teacher'), el('span', note, 'note'));
  const rename = el('button', 'Rename');
  rename.type = 'button';
  rename.addEventListener('click', () => {
    const name = window.prompt(`New name for ${t.name}:`, t.name);
    if (name && name !== t.name) change(t, { name });
  });
  const toggle = el('button', isOff ? 'Turn back on' : 'Turn off');
  toggle.type = 'button';
  toggle.addEventListener('click', () => change(t, { archived: !isOff }));
  const acts = el('span', undefined, 'acts');
  acts.append(rename, toggle);
  li.append(acts);
  const stats = actText(t.act);
  if (stats) li.append(el('span', stats, 'note act'));
  return li;
}

const n = (x, one, many) => `${(x ?? 0).toLocaleString()} ${x === 1 ? one : many}`;
const day = (at) => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });

const clock = (at) => `${day(at)} ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

/** LRCLIB, the lyrics site the song check reads (src/lyrics-gate.js status). */
function lyricsLine(h) {
  if (!h) return 'Lyrics check (LRCLIB): no lookups yet since the last deploy';
  if (h.since) return `⚠️ Lyrics check (LRCLIB) down since ${clock(h.since)} (${h.why || 'no answer'}). Songs wait as AI-ok and are checked again when it is back.${h.okAt ? ` Last good answer ${clock(h.okAt)}.` : ''}`;
  return `✅ Lyrics check (LRCLIB) working, last answer ${clock(h.okAt)}`;
}

/** A teacher's tally line (src/teacher-activity.js; rooms closed since 2026-11-01), or ''. */
function actText(a) {
  if (!a) return '';
  return [
    a.openUntil ? `🟢 room open until ${new Date(a.openUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '',
    a.rooms ? `${n(a.rooms, 'room', 'rooms')}, ${n(a.plays, 'song', 'songs')} played, ${n(a.asks, 'request', 'requests')}, ${n(a.students, 'student', 'students')}` : 'no rooms closed yet',
    a.lastAt ? `last room ${day(a.lastAt)}` : '',
    a.allows ? n(a.allows, 'Allow', 'Allows') : '',
  ].filter(Boolean).join(' · ');
}

/** A list and its "Turned off" section (`kind`: 'teacher' | 'free'). */
function fillTeachers(kind, on, offList, noteOf, isOff) {
  $(`#${kind}List`).replaceChildren(...on.map((t) => teacherRow(t, noteOf(t), false)));
  $(`#${kind}OffList`).replaceChildren(...offList.map((t) => teacherRow(t, noteOf(t), isOff(t))));
  $(`#${kind}Off`).hidden = offList.length === 0;
  $(`#${kind}OffCount`).textContent = `(${offList.length})`;
}

function render(s) {
  $('#gate').hidden = true;
  $('#dash').hidden = false;
  $('#updated').textContent = `Updated ${new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('#nTeachers').textContent = s.teachers.filter((t) => t.status !== 'hidden').length;
  $('#nFree').textContent = s.free.total;
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  $('#nWeek').textContent = days.slice(0, 7).reduce((n, d) => n + (s.free.perDay[d] ?? 0), 0);
  $('#nSessions').textContent = s.sessions;
  $('#nSongs').textContent = s.songs;
  // ✓ Checked songs (src/checked-count.js): the cron's last full count, or its count so far.
  $('#nChecked').textContent = s.checked ? `${s.checked.ready.toLocaleString()}${s.checked.counting ? '+' : ''}` : '…';
  $('#lChecked').textContent = !s.checked ? '✓ Checked songs: first count runs over the next few hours'
    : s.checked.counting ? '✓ Checked songs so far (first count still running)'
      : `✓ Checked songs, OK to play (of ${s.checked.seen.toLocaleString()} checked, counted ${new Date(s.checked.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})`;

  const off = (t) => t.status === 'hidden';
  fillTeachers('teacher', s.teachers.filter((t) => !off(t)), s.teachers.filter(off), (t) => STATUS[t.status] ?? t.status, off);
  $('#linkTeacher').replaceChildren(...s.teachers.filter((t) => t.status !== 'hidden').map((t) => {
    const o = el('option', t.name);
    o.value = t.id;
    return o;
  }));

  const max = Math.max(1, ...days.map((d) => s.free.perDay[d] ?? 0));
  $('#perDay').replaceChildren(...days.map((d) => {
    const n = s.free.perDay[d] ?? 0;
    const li = el('li');
    const bar = el('span', '', 'bar');
    bar.style.setProperty('--w', `${(n / max) * 100}%`);
    li.append(el('span', d.slice(5), 'bar-day'), bar, el('span', String(n), 'bar-n'));
    return li;
  }));
  const freeNote = (f) => {
    const u = f.today ?? {};
    const n = (x, one, many) => (x ? `${x} ${x === 1 ? one : many}` : '');
    const used = [n(u.rooms, 'room', 'rooms'), n(u.ai, 'song check', 'song checks'), n(u.art, 'cover', 'covers')].filter(Boolean).join(', ');
    return `joined ${new Date(f.createdAt).toLocaleDateString()}${used ? ` · today: ${used}` : ''}`;
  };
  const isOff = (f) => f.archived === true;
  fillTeachers('free', s.free.list.filter((f) => !isOff(f)), s.free.list.filter(isOff), freeNote, isOff);
  if (!s.free.list.length) $('#freeList').replaceChildren(el('li', 'No free teachers yet.', 'note'));

  const t = s.today;
  $('#todayList').replaceChildren(...[
    `Free teachers active: ${t.teachers}`,
    `Rooms opened by free teachers: ${t.rooms}`,
    `New-song AI checks (free teachers): ${t.ai} (each has ${t.caps.ai} a day)`,
    `Cover checks (free teachers): ${t.art} (each has ${t.caps.art} a day)`,
    s.prewarm ? `Chart pre-check: ${s.prewarm.used} AI checks, at song ${s.prewarm.cursor}` : 'Chart pre-check: not run yet today',
    lyricsLine(s.lyrics),
  ].map((x) => el('li', x)));

  // 🎵 The song checker (src/checked-count.js) and the Allows on this page's teachers.
  const c = s.checked;
  const allows = [...s.teachers, ...s.free.list].reduce((sum, t) => sum + (t.act?.allows ?? 0), 0);
  $('#checkerList').replaceChildren(...(c ? [
    `✓ Checked, OK to play: ${c.ready.toLocaleString()}`,
    `Waiting on the lyrics check (asked again when it works): ${c.waiting.toLocaleString()}`,
    `Blocked, not appropriate: ${c.blocked.toLocaleString()}`,
    `Not sure even with the lyrics, a teacher decides: ${(c.unsure ?? 0).toLocaleString()}`,
    `Looked at in all: ${c.seen.toLocaleString()}${c.counting ? ' so far (first count still running)' : `, counted ${day(c.at)} ${new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}`,
  ] : ['The first count runs over the next few hours.']).concat(`Teacher Allows: ${allows.toLocaleString()}`).map((x) => el('li', x)));

  const q = s.requests;
  $('#requestsText').textContent = !q ? 'The request log did not answer.'
    : q.total ? `${q.total.toLocaleString()} requests, ${q.first.slice(0, 10)} to ${q.last.slice(0, 10)}${q.week !== undefined ? ` (${q.week.toLocaleString()} in the last 7 days)` : ''}.` : 'No requests yet. Rooms add theirs when they close.';
  const o = q?.outcomes ?? {}, f = q?.fates ?? {};
  $('#requestsList').replaceChildren(...(q?.total ? [
    `Went in the queue: ${(o.queued ?? 0).toLocaleString()} · waited for the teacher: ${(o.review ?? 0).toLocaleString()}`,
    `Blocked by the filter: ${(o.blocked ?? 0).toLocaleString()} · refused by a room rule: ${(o.refused ?? 0).toLocaleString()}`,
    `Played to the end: ${(f.played ?? 0).toLocaleString()} · skipped: ${(f.skipped ?? 0).toLocaleString()} · never got a turn: ${(f['not played'] ?? 0).toLocaleString()}`,
  ] : []).map((x) => el('li', x)));
  $('#topList').replaceChildren(...(q?.top ?? []).map((t) => el('li', `${t.title} · ${t.artist} (${n(t.n, 'play', 'plays')})`)));
  $('#topWrap').hidden = !q?.top?.length;
}

/** The CSV comes with the sign-in header, so it is fetched, then saved from memory. */
async function downloadRequests() {
  const headers = sessionHeaders();
  if (!headers) return gate();
  $('#requestsCsv').disabled = true;
  try {
    const r = await fetch('/api/admin/requests.csv', { headers });
    if (!r.ok) return void toast('Could not download the requests.', 'bad');
    const url = URL.createObjectURL(await r.blob());
    const a = el('a');
    a.href = url;
    a.download = `roomdj-requests-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    toast('Could not reach RoomDJ. Check the internet and try again.', 'bad');
  } finally {
    $('#requestsCsv').disabled = false;
  }
}

async function load() {
  if (!sessionHeaders()) return gate();
  $('#refresh').disabled = true;
  const r = await call('GET', '/api/admin/stats');
  $('#refresh').disabled = false;
  if (r.status === 401) return gate('Your sign-in ended. Sign in with Spotify on the teacher page again.');
  if (r.status === 404) return gate('This Spotify account is not an admin of RoomDJ.');
  if (!r.ok) return void ($('#dashMsg').textContent = r.data.message || 'Could not load the numbers.');
  $('#dashMsg').textContent = '';
  render(r.data);
}

async function change(t, body) {
  const r = await call('PATCH', `/api/admin/teachers/${encodeURIComponent(t.id)}`, body);
  if (!r.ok) return toast(r.data.message || 'That did not work.', 'bad');
  toast(body.archived === true ? `${t.name} is turned off and signed out.` : body.archived === false ? `${t.name} is turned back on.` : `Renamed to ${r.data.profile.name}.`, 'ok');
  load();
}

$('#linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await call('POST', '/api/admin/link', { email: $('#linkEmail').value, profile: $('#linkTeacher').value });
  $('#linkMsg').textContent = r.ok ? `Linked: that Spotify account signs in as ${r.data.profile.name}.` : r.data.message || 'That did not work.';
  if (r.ok) {
    $('#linkEmail').value = '';
    load();
  }
});
$('#refresh').addEventListener('click', load);
$('#requestsCsv').addEventListener('click', downloadRequests);
load();
