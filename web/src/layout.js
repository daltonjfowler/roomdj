// ✏️ Edit layout: the teacher arranges the room screen (host page, its big screen, the board).
// The rules live in shared/layout.js; this file draws the edit tools and applies a layout:
//   - the stage's grid from CSS variables --cols / --areas (host.css), so the narrow-screen layouts
//     still win on small windows, and no element is ever moved in the DOM (a YouTube iframe would reload);
//   - each panel's --scale, which zooms the panel's content (host.css: real re-layout, crisp text,
//     never a transform), so bigger text wraps or scrolls inside its own panel;
//   - .layout-off / .layout-col-off for hidden panels and emptied columns.
// Outside edit mode nothing here listens to the mouse: nothing can be dragged during class.
// Edit mode: a frame over each panel (⠿ move handle, ← →, A− / A+, 👁 Hide, ↺ Reset, the ⤡ corner
// grip), a separator between columns (drag, or arrow keys), Ctrl + mouse wheel over a panel, and a
// floating bar (Hidden: … show, ↺ Reset all, Done ✓). Esc or Done leaves. Pointer Events (mouse,
// pen and touch; touch-action: none on the handles only), one update per animation frame.

import { announce, esc } from './dom.js';
import {
  COLUMNS, PANEL_NAMES, SCALE_MAX, SCALE_MIN, VIEWS, bumpScale, canHide, columnOf, columnShown, gridFor, hidePanel, isColumnPanel,
  isHidden, moveColumn, repairLayout, resetPanel, resizeColumns, saveLayout, scaleOf, setScale, sharePercent,
  showPanel, swapColumns, visibleColumns, defaultLayout,
} from '../../shared/layout.js';

const ALL_PANELS = Object.keys(PANEL_NAMES);
const NESTED = new Set(['top5', 'cleanup']); // inside Now playing: their tools sit at the bottom
const name = (p) => PANEL_NAMES[p] ?? p;
const pct = (s) => `${Math.round(s * 100)}%`;

/**
 * @param {{ stage: HTMLElement, view: () => 'normal'|'big'|'board', storageKey: (view: string) => string,
 *   returnFocus?: () => HTMLElement|null, onToggle?: (on: boolean) => void, canEdit?: () => boolean }} options
 */
export function initLayout({ stage, view, storageKey, returnFocus = () => null, onToggle = () => {}, canEdit = () => true }) {
  const layouts = new Map(); // view → layout (read from storage once)
  let editing = false;
  let shownView = null;
  let drag = null;
  let frame = 0;
  let observer = null;

  const panelEl = (p) => stage.querySelector(`[data-panel="${p}"]`);
  const colEl = (c) => stage.querySelector(`[data-col="${c}"]`);
  const panelsHere = () => VIEWS[view()].panels.filter((p) => panelEl(p));

  function load(v) {
    if (!layouts.has(v)) {
      let text = null;
      try { text = localStorage.getItem(storageKey(v)); } catch { /* blocked: the default */ }
      layouts.set(v, repairLayout(text, v));
    }
    return layouts.get(v);
  }
  const current = () => load(view());

  function save() {
    const v = view();
    const text = saveLayout(current());
    try {
      if (text) localStorage.setItem(storageKey(v), text);
      else localStorage.removeItem(storageKey(v));
    } catch { /* blocked: this page only */ }
  }

  // ---- Applying a layout (always, also outside edit mode) ----
  function apply() {
    const v = view();
    const l = current();
    const grid = gridFor(l, v);
    if (grid) {
      stage.style.setProperty('--cols', grid.cols);
      stage.style.setProperty('--areas', grid.areas);
    } else {
      stage.style.removeProperty('--cols');
      stage.style.removeProperty('--areas');
    }
    for (const p of ALL_PANELS) {
      const el = panelEl(p);
      if (!el) continue;
      const here = VIEWS[v].panels.includes(p);
      el.style.setProperty('--scale', String(here ? scaleOf(l, p) : 1));
      el.classList.toggle('layout-off', here && isHidden(l, p));
      el.classList.toggle('layout-scaled', here && scaleOf(l, p) > 1);
    }
    for (const c of COLUMNS) colEl(c)?.classList.toggle('layout-col-off', !columnShown(l, v, c));
  }

  function change(next, say) {
    layouts.set(view(), next);
    apply();
    save();
    if (editing) {
      syncTools();
      schedule();
    }
    if (say) announce(say);
  }

  // ---- The edit tools ----
  const layer = document.createElement('div');
  layer.className = 'layout-layer';
  layer.hidden = true;
  stage.prepend(layer); // first in the stage: the tools come first when tabbing in edit mode

  const bar = document.createElement('div');
  bar.className = 'layout-editbar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Edit layout');
  bar.hidden = true;
  bar.innerHTML = `<p class="layout-editbar-text"><b>✏️ Edit layout</b> <span>Drag ⠿ to move a panel, the bars between panels to resize, the corner ⤡ to make text bigger. Esc or Done when finished.</span></p>
    <p class="layout-narrow note" hidden>Make the window wider to move panels and resize columns.</p>
    <span class="layout-hidden-list"></span>
    <button type="button" data-do="resetAll">↺ Reset all</button>
    <button type="button" class="primary" data-do="done">Done ✓</button>`;
  document.body.append(bar);

  function toolsHtml(p) {
    const n = esc(name(p));
    const move = isColumnPanel(p)
      ? `<button type="button" class="layout-move" data-do="drag" aria-label="Move ${n}" title="Drag to another column">⠿<span class="layout-label"> ${n}</span></button>
        <button type="button" data-do="left" aria-label="Move ${n} left" title="Move left">←</button>
        <button type="button" data-do="right" aria-label="Move ${n} right" title="Move right">→</button>`
      : `<span class="layout-name">${n}</span>`;
    return `<div class="layout-tools" role="group" aria-label="${n}">${move}
        <button type="button" data-do="smaller" aria-label="Make ${n} text smaller" title="Smaller">A−</button>
        <span class="layout-pct" aria-hidden="true"></span>
        <button type="button" data-do="bigger" aria-label="Make ${n} text bigger" title="Bigger">A+</button>
        ${canHide(view(), p) ? `<button type="button" data-do="hide" aria-label="Hide ${n}" title="Hide">👁</button>` : ''}
        <button type="button" data-do="reset" aria-label="Reset ${n}" title="Usual size">↺</button>
      </div>
      <button type="button" class="layout-grip" data-do="grip" aria-label="Make ${n} text bigger or smaller: drag, or press the arrow keys" title="Drag to scale">⤡</button>`;
  }

  /** The frames for this view's panels (made again when the view changes). */
  function build() {
    shownView = view();
    layer.innerHTML = panelsHere().map((p) => `<div class="layout-frame${NESTED.has(p) ? ' nested' : ''}" data-for="${p}" hidden>${toolsHtml(p)}</div>`).join('')
      + '<div class="layout-gutters"></div>';
    syncTools();
  }

  /** Readouts, disabled buttons, the Hidden list and the separators (no layout reads). */
  function syncTools() {
    const v = view();
    const l = current();
    const shown = visibleColumns(l, v);
    for (const f of layer.querySelectorAll('.layout-frame')) {
      const p = f.dataset.for;
      const s = scaleOf(l, p);
      f.querySelector('.layout-pct').textContent = pct(s);
      f.querySelector('[data-do="smaller"]').disabled = s <= SCALE_MIN;
      f.querySelector('[data-do="bigger"]').disabled = s >= SCALE_MAX;
      const col = columnOf(p);
      const left = f.querySelector('[data-do="left"]');
      const right = f.querySelector('[data-do="right"]');
      if (left) left.disabled = shown.indexOf(col) <= 0;
      if (right) right.disabled = shown.indexOf(col) === shown.length - 1;
    }
    const hidden = l.hidden.filter((p) => VIEWS[v].panels.includes(p) && panelEl(p));
    bar.querySelector('.layout-hidden-list').innerHTML = hidden.length
      ? `Hidden: ${hidden.map((p) => `<button type="button" class="layout-chip" data-show="${p}" aria-label="Show ${esc(name(p))}">${esc(name(p))} (show)</button>`).join(' ')}`
      : '';
    // Separators between neighbouring columns on screen; the focused one is kept.
    const box = layer.querySelector('.layout-gutters');
    if (!box) return;
    const pairs = shown.slice(1).map((c, i) => `${shown[i]}|${c}`);
    const have = [...box.children].map((g) => g.dataset.pair);
    if (have.join() !== pairs.join()) {
      const focused = document.activeElement?.closest?.('.layout-gutter')?.dataset.pair;
      box.innerHTML = pairs.map((pair) => {
        const [a, b] = pair.split('|');
        return `<div class="layout-gutter" data-pair="${pair}" role="separator" tabindex="0" aria-orientation="vertical"
          aria-label="Resize ${esc(name(a))} and ${esc(name(b))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div>`;
      }).join('');
      if (focused) box.querySelector(`[data-pair="${focused}"]`)?.focus();
    }
  }

  /** Put the frames and separators over the panels: all reads first, then all writes. */
  function position() {
    frame = 0;
    if (!editing) return;
    const v = view();
    const l = current();
    const base = stage.getBoundingClientRect();
    const frames = [...layer.querySelectorAll('.layout-frame')].map((f) => {
      const el = panelEl(f.dataset.for);
      const r = el && el.getClientRects().length ? el.getBoundingClientRect() : null;
      return { f, r: r && r.width > 0 && r.height > 0 ? r : null };
    });
    const shown = visibleColumns(l, v);
    const cols = Object.fromEntries(shown.map((c) => [c, colEl(c)?.getBoundingClientRect()]));
    // Side by side (a wide window): the separators and moves make sense.
    const side = shown.every((c, i) => cols[c] && (i === 0 || cols[c].left >= cols[shown[i - 1]].right - 2));
    const px = Object.fromEntries(shown.map((c) => [c, cols[c]?.width ?? 0]));
    for (const { f, r } of frames) {
      f.hidden = !r;
      if (!r) continue;
      f.style.left = `${r.left - base.left}px`;
      f.style.top = `${r.top - base.top}px`;
      f.style.width = `${r.width}px`;
      f.style.height = `${r.height}px`;
    }
    bar.querySelector('.layout-narrow').hidden = side;
    for (const g of layer.querySelectorAll('.layout-gutter')) {
      const [a, b] = g.dataset.pair.split('|');
      const ra = cols[a];
      const rb = cols[b];
      g.hidden = !side || !ra || !rb;
      if (g.hidden) continue;
      const top = Math.min(ra.top, rb.top);
      g.style.left = `${(ra.right + rb.left) / 2 - base.left}px`;
      g.style.top = `${top - base.top}px`;
      g.style.height = `${Math.max(ra.bottom, rb.bottom) - top}px`;
      const share = sharePercent(l, v, px, a);
      g.setAttribute('aria-valuenow', String(share));
      g.setAttribute('aria-valuetext', `${name(a)} ${share}% of the width`);
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };

  // ---- Entering and leaving ----
  function enter() {
    if (editing || !canEdit()) return false;
    editing = true;
    document.body.classList.add('layout-edit');
    if (shownView !== view()) build();
    else syncTools();
    layer.hidden = false;
    bar.hidden = false;
    observer = new ResizeObserver(schedule);
    observer.observe(stage);
    for (const p of ALL_PANELS) if (panelEl(p)) observer.observe(panelEl(p));
    addEventListener('resize', schedule);
    position();
    onToggle(true);
    bar.querySelector('[data-do="done"]').focus({ preventScroll: true });
    announce('Edit layout on. Each panel has a move handle, text size buttons, Hide and Reset. Esc or Done when finished.');
    return true;
  }

  function leave({ focus = true } = {}) {
    if (!editing) return;
    endDrag(false);
    editing = false;
    document.body.classList.remove('layout-edit');
    layer.hidden = true;
    bar.hidden = true;
    observer?.disconnect();
    observer = null;
    removeEventListener('resize', schedule);
    onToggle(false);
    if (focus) returnFocus()?.focus({ preventScroll: true });
    announce('Edit layout off. The layout is saved on this computer.');
  }

  const toggle = () => (editing ? leave() : enter());

  /** The view changed (big screen on or off): its own layout, and its own frames. */
  function refresh() {
    apply();
    if (editing && shownView !== view()) {
      build();
      schedule();
    }
  }

  // ---- Buttons ----
  function act(p, what) {
    const v = view();
    const l = current();
    const n = name(p);
    switch (what) {
      case 'bigger':
      case 'smaller': {
        const next = bumpScale(l, p, what === 'bigger' ? 1 : -1);
        return change(next, `${n} text ${pct(scaleOf(next, p))}.`);
      }
      case 'left':
      case 'right': {
        const next = moveColumn(l, v, columnOf(p), what === 'left' ? -1 : 1);
        if (next === l) return announce(`${n} is already at the ${what === 'left' ? 'left' : 'right'}.`);
        return change(next, `${n} moved ${what}. ${visibleColumns(next, v).map(name).join(', ')}.`);
      }
      case 'hide': {
        const next = hidePanel(l, v, p);
        if (next === l) return announce(`${n} cannot be hidden: it is the last panel on screen.`);
        change(next, `${n} hidden. Show it again from Hidden in the edit bar.`);
        return bar.querySelector(`[data-show="${p}"]`)?.focus();
      }
      case 'reset':
        return change(resetPanel(l, p), `${n} back to its usual size.`);
      case 'drag':
        return announce(`Drag ${n} to another column, or use the arrow buttons next to it.`);
      default:
    }
  }

  layer.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-do]');
    const f = btn?.closest('.layout-frame');
    if (!btn || !f || btn.dataset.do === 'grip') return;
    act(f.dataset.for, btn.dataset.do);
  });

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.show) {
      const p = btn.dataset.show;
      change(showPanel(current(), p), `${name(p)} shown.`);
      return bar.querySelector('[data-show]')?.focus() ?? bar.querySelector('[data-do="done"]').focus();
    }
    if (btn.dataset.do === 'done') return leave();
    if (btn.dataset.do === 'resetAll') {
      change(defaultLayout(), 'Every panel is back where it was, at its usual size.');
    }
  });

  // Keyboard: the grip (arrows scale) and the separators (arrows resize).
  layer.addEventListener('keydown', (e) => {
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, '+': 1, '=': 1, '-': -1 }[e.key];
    if (!dir) return;
    const grip = e.target.closest('.layout-grip');
    const gutter = e.target.closest('.layout-gutter');
    if (grip) {
      e.preventDefault();
      e.stopPropagation(); // not also the volume (shortcuts.js)
      act(grip.closest('.layout-frame').dataset.for, dir > 0 ? 'bigger' : 'smaller');
    } else if (gutter) {
      e.preventDefault();
      e.stopPropagation();
      if (!/^Arrow(Left|Right)$/.test(e.key)) return;
      const [a, b] = gutter.dataset.pair.split('|');
      const px = columnPx();
      const total = Object.values(px).reduce((x, y) => x + y, 0);
      const next = resizeColumns(current(), view(), px, a, b, dir * total * 0.02);
      change(next);
      requestAnimationFrame(() => announce(gutter.getAttribute('aria-valuetext') ?? ''));
    }
  });

  function columnPx() {
    return Object.fromEntries(visibleColumns(current(), view()).map((c) => [c, colEl(c)?.getBoundingClientRect().width ?? 0]));
  }

  // ---- Dragging (Pointer Events: mouse, pen, touch) ----
  layer.addEventListener('pointerdown', (e) => {
    if (!editing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.target.closest('.layout-move, .layout-grip, .layout-gutter');
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    const f = el.closest('.layout-frame');
    const kind = el.classList.contains('layout-gutter') ? 'gutter' : el.classList.contains('layout-grip') ? 'grip' : 'move';
    const p = f?.dataset.for;
    const r = p ? panelEl(p).getBoundingClientRect() : null;
    drag = {
      kind, el, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      base: current(), panel: p, pair: el.dataset.pair?.split('|'),
      px: kind === 'gutter' ? columnPx() : null,
      reach: r ? Math.max(120, Math.hypot(r.width, r.height) / 2) : 0,
      target: null,
    };
    document.body.classList.add('layout-dragging');
    el.classList.add('active');
  });
  layer.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.raf) drag.raf = requestAnimationFrame(dragStep);
  });
  const finish = (e) => { if (drag && e.pointerId === drag.id) endDrag(e.type === 'pointerup'); };
  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', finish);
  layer.addEventListener('lostpointercapture', finish);

  function dragStep() {
    if (!drag) return;
    drag.raf = 0;
    const dx = drag.x - drag.x0;
    const dy = drag.y - drag.y0;
    const v = view();
    if (drag.kind === 'grip') {
      // Down and right: bigger. Half the panel's diagonal doubles the size.
      const s = scaleOf(drag.base, drag.panel) * (1 + (dx + dy) / 2 / drag.reach);
      layouts.set(v, setScale(drag.base, drag.panel, s));
      apply();
      syncTools();
    } else if (drag.kind === 'gutter') {
      layouts.set(v, resizeColumns(drag.base, v, drag.px, drag.pair[0], drag.pair[1], dx));
      apply();
    } else {
      // Move: the column under the pointer is where it goes.
      const from = columnOf(drag.panel);
      const over = visibleColumns(current(), v).find((c) => {
        const r = colEl(c)?.getBoundingClientRect();
        return r && drag.x >= r.left && drag.x <= r.right;
      });
      const target = over && over !== from ? over : null;
      if (target !== drag.target) {
        if (drag.target) colEl(drag.target)?.classList.remove('layout-drop');
        if (target) colEl(target).classList.add('layout-drop');
        drag.target = target;
      }
      return;
    }
    position();
  }

  function endDrag(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.el.classList.remove('active');
    document.body.classList.remove('layout-dragging');
    if (d.target) colEl(d.target)?.classList.remove('layout-drop');
    if (d.kind === 'move') {
      if (commit && d.target) {
        const next = swapColumns(current(), columnOf(d.panel), d.target);
        change(next, `${name(d.panel)} moved. ${visibleColumns(next, view()).map(name).join(', ')}.`);
      }
      return;
    }
    if (commit) {
      drag = d;
      dragStep(); // the last position counts
      drag = null;
    }
    change(current(), d.kind === 'grip' ? `${name(d.panel)} text ${pct(scaleOf(current(), d.panel))}.` : 'Columns resized.');
  }

  // Ctrl + mouse wheel over a panel: its text size (the browser's own zoom stays off while editing).
  let wheelDir = 0;
  let wheelPanel = null;
  stage.addEventListener('wheel', (e) => {
    if (!editing || !e.ctrlKey) return;
    const el = e.target.closest?.('[data-panel]');
    const p = el?.dataset.panel;
    if (!p || !VIEWS[view()].panels.includes(p)) return;
    e.preventDefault();
    wheelDir = e.deltaY < 0 ? 1 : -1;
    wheelPanel = p;
    if (!drag && !wheel.raf) wheel.raf = requestAnimationFrame(wheel);
  }, { passive: false });
  function wheel() {
    wheel.raf = 0;
    if (!editing || !wheelPanel) return;
    act(wheelPanel, wheelDir > 0 ? 'bigger' : 'smaller');
  }

  // Esc leaves edit mode (after an open menu or dialog had its own Esc), and only that.
  document.addEventListener('keydown', (e) => {
    if (!editing || e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    e.stopPropagation();
    leave();
  }, true);

  apply();
  return { enter, leave, toggle, refresh, apply, isEditing: () => editing };
}
