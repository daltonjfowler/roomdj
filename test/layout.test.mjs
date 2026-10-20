import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLUMNS, COLUMN_MIN_PX, LAYOUT_VERSION, SCALE_MAX, SCALE_MIN, SHARE_MAX, SHARE_MIN, VIEWS,
  bumpScale, canHide, clampScale, cleanWidths, columnOf, defaultLayout, gridFor, hidePanel, moveColumn,
  repairLayout, resetPanel, resizeColumns, saveLayout, scaleOf, setScale, sharePercent, showPanel, swapColumns,
  visibleColumns,
} from '../shared/layout.js';

const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);

test('defaults: the usual order, nothing scaled or hidden, nothing to store, the CSS grid', () => {
  const d = defaultLayout();
  assert.deepEqual(d, { v: LAYOUT_VERSION, order: ['join', 'now', 'queue'], widths: null, scale: {}, hidden: [] });
  assert.equal(saveLayout(d), '');
  for (const view of Object.keys(VIEWS)) assert.equal(gridFor(d, view), null, view);
});

test('clampScale: 0.6 to 2.5, two decimals, junk → 1', () => {
  assert.equal(clampScale(0.1), SCALE_MIN);
  assert.equal(clampScale(9), SCALE_MAX);
  assert.equal(clampScale(1.23456), 1.23);
  for (const junk of [NaN, 'x', undefined, Infinity, {}]) assert.equal(clampScale(junk), 1, String(junk));
});

test('setScale / bumpScale: clamped steps, 1 is not stored', () => {
  let l = setScale(defaultLayout(), 'queue', 1.5);
  assert.equal(scaleOf(l, 'queue'), 1.5);
  l = bumpScale(l, 'queue', 1);
  assert.equal(scaleOf(l, 'queue'), 1.6);
  for (let i = 0; i < 30; i++) l = bumpScale(l, 'queue', 1);
  assert.equal(scaleOf(l, 'queue'), SCALE_MAX);
  for (let i = 0; i < 40; i++) l = bumpScale(l, 'queue', -1);
  assert.equal(scaleOf(l, 'queue'), SCALE_MIN);
  l = setScale(l, 'queue', 1);
  assert.deepEqual(l.scale, {});
  assert.equal(scaleOf(defaultLayout(), 'join'), 1);
});

test('swap and move: columns trade places; move skips hidden columns and stops at the ends', () => {
  const d = defaultLayout();
  assert.deepEqual(swapColumns(d, 'join', 'queue').order, ['queue', 'now', 'join']);
  assert.equal(swapColumns(d, 'join', 'join'), d);
  assert.equal(swapColumns(d, 'join', 'nope'), d);
  assert.deepEqual(moveColumn(d, 'normal', 'now', -1).order, ['now', 'join', 'queue']);
  assert.deepEqual(moveColumn(d, 'normal', 'now', 1).order, ['join', 'queue', 'now']);
  assert.equal(moveColumn(d, 'normal', 'join', -1), d);
  assert.equal(moveColumn(d, 'normal', 'queue', 1), d);
  const noNow = hidePanel(d, 'board', 'now');
  assert.deepEqual(moveColumn(noNow, 'board', 'join', 1).order, ['queue', 'now', 'join']);
  const g = gridFor(swapColumns(d, 'join', 'now'), 'normal');
  assert.equal(g.areas, '"warn warn warn" "now join queue"');
  assert.equal(g.cols, 'minmax(0, 1.15fr) minmax(230px, 300px) minmax(0, 1fr)');
});

test('hide / show: locked panels on the host stay, a column empties only with all its panels, never the last column', () => {
  const d = defaultLayout();
  for (const p of ['now', 'review', 'cleanup']) {
    assert.equal(canHide('normal', p), false, p);
    assert.equal(hidePanel(d, 'normal', p), d, p);
  }
  assert.equal(canHide('big', 'now'), true);
  assert.equal(canHide('big', 'review'), false); // not on the big screen at all
  // Host: hiding Up next keeps the column (Needs a look lives there).
  const noQueue = hidePanel(d, 'normal', 'queue');
  assert.deepEqual(noQueue.hidden, ['queue']);
  assert.deepEqual(visibleColumns(noQueue, 'normal'), ['join', 'now', 'queue']);
  // Board: hiding Up next empties its column.
  const b = hidePanel(d, 'board', 'queue');
  assert.deepEqual(visibleColumns(b, 'board'), ['join', 'now']);
  assert.deepEqual(gridFor(b, 'board'), { cols: 'minmax(280px, 26vw) minmax(0, 1fr)', areas: '"warn warn" "join now"' });
  // Top 5 is inside Now playing: the column stays.
  assert.deepEqual(visibleColumns(hidePanel(d, 'board', 'top5'), 'board'), COLUMNS);
  // The last column on screen cannot go.
  const one = hidePanel(hidePanel(b, 'board', 'join'), 'board', 'now');
  assert.deepEqual(visibleColumns(one, 'board'), ['now']);
  assert.deepEqual(showPanel(b, 'queue').hidden, []);
  assert.equal(hidePanel(b, 'board', 'queue'), b, 'already hidden');
});

test('resetPanel: usual size and shown; the rest stays', () => {
  let l = setScale(hidePanel(swapColumns(defaultLayout(), 'join', 'now'), 'big', 'top5'), 'top5', 2);
  l = setScale(l, 'join', 0.8);
  l = resetPanel(l, 'top5');
  assert.deepEqual(l.hidden, []);
  assert.deepEqual(l.scale, { join: 0.8 });
  assert.deepEqual(l.order, ['now', 'join', 'queue']);
});

test('cleanWidths: shares add to 1 and stay between the limits; junk → null', () => {
  const w = cleanWidths({ join: 1, now: 1, queue: 1 });
  assert.ok(Math.abs(sum(w) - 1) < 0.01);
  const lop = cleanWidths({ join: 0.01, now: 0.98, queue: 0.01 });
  for (const c of COLUMNS) assert.ok(lop[c] >= SHARE_MIN - 0.001 && lop[c] <= SHARE_MAX + 0.001, `${c} ${lop[c]}`);
  assert.ok(Math.abs(sum(lop) - 1) < 0.01, String(sum(lop)));
  for (const junk of [null, [], 'x', { join: 1, now: 1 }, { join: -1, now: 1, queue: 1 }, { join: 'a', now: 1, queue: 1 }]) {
    assert.equal(cleanWidths(junk), null, JSON.stringify(junk));
  }
});

test('resizeColumns: the edge moves, nothing narrower than the minimum, and the grid uses the shares', () => {
  const px = { join: 300, now: 600, queue: 500 };
  const l = resizeColumns(defaultLayout(), 'normal', px, 'now', 'queue', 100);
  assert.ok(Math.abs(l.widths.now - 700 / 1400) < 0.01, JSON.stringify(l.widths));
  assert.ok(Math.abs(l.widths.queue - 400 / 1400) < 0.01);
  assert.equal(sharePercent(l, 'normal', { join: 300, now: 700, queue: 400 }, 'now'), 50);
  // Far past the edge: the right column keeps the minimum.
  const far = resizeColumns(defaultLayout(), 'normal', px, 'now', 'queue', 5000);
  assert.ok(far.widths.queue * 1400 >= COLUMN_MIN_PX - 2, JSON.stringify(far.widths));
  assert.ok(far.widths.now <= SHARE_MAX + 0.001);
  const g = gridFor(l, 'normal');
  assert.match(g.cols, /^minmax\(200px, [\d.]+fr\) minmax\(200px, [\d.]+fr\) minmax\(200px, [\d.]+fr\)$/);
  // A hidden column keeps its share for later.
  const b = hidePanel(defaultLayout(), 'board', 'join');
  const r = resizeColumns(b, 'board', { now: 700, queue: 700 }, 'now', 'queue', -100);
  assert.ok(r.widths.now < r.widths.queue);
  assert.equal(resizeColumns(b, 'board', { now: 700, queue: 700 }, 'join', 'now', 50), b, 'hidden column: nothing');
});

test('repairLayout: good layouts survive a round trip; bad parts are dropped or fixed', () => {
  let l = swapColumns(defaultLayout(), 'join', 'queue');
  l = setScale(l, 'queue', 1.8);
  l = hidePanel(l, 'big', 'top5');
  l = resizeColumns(l, 'big', { join: 300, now: 600, queue: 500 }, 'now', 'join', 50);
  assert.deepEqual(repairLayout(saveLayout(l), 'big'), l);
  // Not JSON, another version, not an object: the default.
  for (const junk of ['{', 'null', '[]', '"x"', JSON.stringify({ ...l, v: 99 }), JSON.stringify({ order: l.order })]) {
    assert.deepEqual(repairLayout(junk, 'big'), defaultLayout(), junk);
  }
  const fixed = repairLayout({
    v: LAYOUT_VERSION,
    order: ['join', 'join', 'now'],
    widths: { join: 'wide' },
    scale: { queue: 99, join: -3, now: 'big', nope: 2, review: 2 },
    hidden: ['now', 'review', 'nope', 'top5', 'top5', 5],
  }, 'normal');
  assert.deepEqual(fixed.order, COLUMNS);
  assert.equal(fixed.widths, null);
  assert.deepEqual(fixed.scale, { queue: SCALE_MAX, join: SCALE_MIN, review: 2 });
  assert.deepEqual(fixed.hidden, ['top5'], 'locked and unknown panels are never hidden on the host');
  // Every column hidden (a hand-edited value): shown again.
  assert.deepEqual(repairLayout({ v: LAYOUT_VERSION, hidden: ['join', 'now', 'queue'] }, 'board').hidden, []);
  // Widths out of range are clamped.
  const w = repairLayout({ v: LAYOUT_VERSION, widths: { join: 1, now: 100, queue: 1 } }, 'board').widths;
  assert.ok(w.now <= SHARE_MAX + 0.001 && w.join >= SHARE_MIN - 0.001);
});

test('columnOf: Top 5 and cleanup move with Now playing, Needs a look with Up next', () => {
  assert.equal(columnOf('top5'), 'now');
  assert.equal(columnOf('cleanup'), 'now');
  assert.equal(columnOf('review'), 'queue');
  assert.equal(columnOf('join'), 'join');
});
