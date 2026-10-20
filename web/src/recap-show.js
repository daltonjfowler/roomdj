// "▶ Play recap": the end-of-class awards show on the big screen (Dalton, 2026-10-06; like the
// bonus stars at the end of Mario Party). A full-screen slideshow: a title card, the award slides
// picked at random from the stats pool (shared/stats.js; each one "And the … is…", a beat, then
// the name pops in with a small confetti burst), the Top 5 countdown (#5 → #1 with 👑), and the
// finale: 🎤 Top contributor vs 🗳 Top voter. Auto-advance; ← → or a click to move, Space to
// pause, Esc to leave. prefers-reduced-motion: no bounce and no confetti, plain fades. Plain
// CSS and JS: a few dozen short-lived elements, nothing that keeps running between slides.
// Sound (protocol.js RECAP MUSIC) is not made here: the hooks tell the host page (recap-audio.js)
// or, on the board, the room (its cues), when the show starts, reveals, finishes and closes.

import './recap-show.css';
import { $, artHtml, esc } from './dom.js';
import { pickStats } from '../../shared/stats.js';
import { byLabel } from '../../shared/protocol.js';

export const SLIDE_MS = 5500;
const TOP5_SLIDE_MS = 4000;
const REVEAL_MS = 1400;
const CONFETTI = 28;
const COLORS = ['#f472b6', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f87171'];

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Bars for a { rows: [{ label, n }] } chart, with the numbers as text too (screen readers read the list). */
function barsHtml(chart) {
  const max = Math.max(1, ...chart.rows.map((r) => r.n));
  return `<ul class="show-bars" aria-label="${esc(chart.label)}">${chart.rows.map((r) => `<li>
      <span class="show-bar-label">${esc(r.label)}</span>
      <span class="show-bar"><span style="width:${Math.round((r.n / max) * 100)}%"></span></span>
      <b class="show-bar-n">${r.n}</b></li>`).join('')}</ul>`;
}

/** The slides for one showing: [{ kind, ms, html, say }] ("say": what the screen reader hears after the reveal). */
export function buildSlides(recap, picks, versus) {
  const slides = [];
  slides.push({
    kind: 'title', ms: SLIDE_MS,
    html: `<p class="show-kicker">🎉</p><h2 class="show-title">🏆 Period recap!</h2>
      <p class="show-sub">${plural(recap.totals.songs, 'song')} · ${plural(recap.totals.votes, 'vote')}</p>`,
    say: `Period recap! ${plural(recap.totals.songs, 'song')}, ${plural(recap.totals.votes, 'vote')}.`,
  });
  for (const s of picks) {
    slides.push({
      kind: 'stat', id: s.id, ms: SLIDE_MS, confetti: true,
      html: `<p class="show-kicker">${esc(s.emoji)} ${esc(s.title)}</p>
        <p class="show-lead">${esc(s.lead)}</p>
        <div class="show-reveal">
          ${s.song ? artHtml(s.song, 300, { cls: 'show-art' }) : ''}
          <p class="show-name">${esc(s.name)}</p>
          ${s.detail ? `<p class="show-detail">${esc(s.detail)}</p>` : ''}
          ${s.chart ? barsHtml(s.chart) : ''}
        </div>`,
      say: s.text,
    });
  }
  const top = recap.top5 ?? [];
  for (let i = top.length - 1; i >= 0; i--) {
    const t = top[i];
    const first = i === 0;
    slides.push({
      kind: 'top5', rank: i + 1, ms: first ? SLIDE_MS : TOP5_SLIDE_MS, confetti: first,
      html: `<p class="show-kicker">🏆 Top 5</p>
        <p class="show-lead">${first ? 'And the number 1 song of the period is…' : `Number ${i + 1}…`}</p>
        <div class="show-reveal${first ? ' crown' : ''}">
          <p class="show-rank">${first ? '👑' : `#${i + 1}`}</p>
          ${artHtml(t.song, 300, { cls: 'show-art' })}
          <p class="show-name">${esc(t.song.title)}</p>
          <p class="show-detail">${esc(t.song.artist)} · ${(recap.downvoteMode ?? 'shown') === 'shown' ? `${t.score > 0 ? '+' : ''}${t.score}` : `👍 ${t.up}`} · suggested by ${esc(byLabel(t))}</p>
        </div>`,
      say: `Number ${i + 1}: ${t.song.title} by ${t.song.artist}, suggested by ${byLabel(t)}.`,
    });
  }
  if (versus) {
    const side = (who, emoji, title, unit) => `<div class="show-side">
        <p class="show-kicker">${emoji} ${title}</p>
        <p class="show-name">${who ? esc(who.nick) : 'Nobody yet'}</p>
        <p class="show-detail">${who ? esc(`${plural(who.n, unit[0])} ${unit[1]}`) : ''}</p></div>`;
    slides.push({
      kind: 'versus', ms: SLIDE_MS + 1500, confetti: true,
      html: `<p class="show-lead">And the finale… the class's biggest fans!</p>
        <div class="show-reveal show-versus">
          ${side(versus.contributor, '🎤', 'Top contributor', ['song', 'suggested'])}
          <p class="show-vs" aria-hidden="true">VS</p>
          ${side(versus.voter, '🗳', 'Top voter', ['vote', 'cast'])}
        </div>`,
      say: versus.text,
    });
  }
  return slides;
}

/**
 * @param {{ onStart?: (recap: object) => void, onEnd?: () => void, onReveal?: (slide: object) => void,
 *   onFinish?: () => void }} hooks onStart: the show starts (or starts again after the end); onReveal:
 *   a slide's reveal (shared/recap-music.js cueFor picks its sound); onFinish: the last slide is
 *   done (the show waits at "The end!"); onEnd: the show closed
 */
export function initRecapShow({ onStart = () => {}, onEnd = () => {}, onReveal = () => {}, onFinish = () => {} } = {}) {
  const dlg = $('#showDlg');
  const stage = $('#showStage');
  let slides = [];
  let recapNow = null;
  let index = 0;
  let paused = false;
  let timer = 0;
  let revealTimer = 0;

  function clearTimers() {
    clearTimeout(timer);
    clearTimeout(revealTimer);
    timer = 0;
    revealTimer = 0;
  }

  function confetti() {
    if (reducedMotion()) return;
    const box = document.createElement('div');
    box.className = 'show-confetti';
    box.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < CONFETTI; i++) {
      const bit = document.createElement('i');
      const angle = (Math.PI * 2 * i) / CONFETTI + Math.random() * 0.4;
      const dist = 180 + Math.random() * 220;
      bit.style.setProperty('--dx', `${Math.round(Math.cos(angle) * dist)}px`);
      bit.style.setProperty('--dy', `${Math.round(Math.sin(angle) * dist - 80)}px`);
      bit.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
      bit.style.background = COLORS[i % COLORS.length];
      box.append(bit);
    }
    stage.append(box);
    setTimeout(() => box.remove(), 1700);
  }

  function show(i) {
    clearTimers();
    index = Math.max(0, Math.min(slides.length - 1, i));
    const s = slides[index];
    stage.className = `show-stage show-${s.kind}`;
    stage.innerHTML = `<div class="show-slide">${s.html}</div>`;
    dlg.dataset.slide = String(index);
    dlg.dataset.kind = s.kind;
    $('#showCount').textContent = `${index + 1} / ${slides.length}`;
    $('#showPrev').disabled = index === 0;
    const reveal = stage.querySelector('.show-reveal');
    const done = () => {
      stage.classList.add('revealed');
      dlg.dataset.revealed = '1';
      $('#showSay').textContent = s.say ?? '';
      if (s.confetti) confetti();
      onReveal(s);
    };
    dlg.dataset.revealed = '';
    if (reveal) revealTimer = setTimeout(done, reducedMotion() ? 600 : REVEAL_MS);
    else done();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (paused) return;
    const s = slides[index];
    timer = setTimeout(() => {
      if (index < slides.length - 1) return show(index + 1);
      setPaused(true, 'The end! Press ← to go back or Esc to close.');
      onFinish();
    }, s.ms);
  }

  function setPaused(on, note = '') {
    paused = on;
    dlg.dataset.paused = on ? '1' : '';
    $('#showPause').textContent = on ? '▶ Play' : '⏸ Pause';
    $('#showPause').setAttribute('aria-pressed', String(on));
    $('#showNote').textContent = note || (on ? 'Paused. Space plays again.' : '');
    if (on) clearTimeout(timer);
    else if (index === slides.length - 1 && dlg.dataset.revealed) {
      onStart(recapNow); // from the top again
      show(0);
    }
    else schedule();
  }

  function close() {
    clearTimers();
    if (dlg.open) dlg.close();
  }

  dlg.addEventListener('close', () => {
    clearTimers();
    stage.innerHTML = '';
    document.body.classList.remove('show-on');
    onEnd();
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc: close ourselves (and leave full screen the same way)
    close();
  });
  dlg.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); }); // no button click from Space
  dlg.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(index + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(index - 1); }
    else if (e.key === ' ') { e.preventDefault(); setPaused(!paused); } // also on a focused button
  });
  // A click on the slide moves on; the left fifth goes back.
  stage.addEventListener('click', (e) => {
    const r = stage.getBoundingClientRect();
    show(e.clientX < r.left + r.width / 5 ? index - 1 : index + 1);
  });
  $('#showPrev').addEventListener('click', () => show(index - 1));
  $('#showNext').addEventListener('click', () => show(index + 1));
  $('#showPause').addEventListener('click', () => setPaused(!paused));
  $('#showClose').addEventListener('click', close);

  /** Play the show for this recap. `picks`/`versus` (optional): the stats already on the recap card. */
  function play(recap, chosen = null) {
    const { versus, picks } = chosen ?? pickStats(recap.stats ?? [], 4);
    slides = buildSlides(recap, picks, versus);
    recapNow = recap;
    paused = false;
    dlg.dataset.paused = '';
    $('#showPause').textContent = '⏸ Pause';
    $('#showPause').setAttribute('aria-pressed', 'false');
    $('#showNote').textContent = '';
    document.body.classList.add('show-on');
    if (!dlg.open) dlg.showModal();
    onStart(recap);
    show(0);
    $('#showNext').focus();
  }

  return { play, close, get open() { return dlg.open; } };
}
