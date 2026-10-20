// One dropdown menu for the host page (toolbar menus, the ⋯ on each queue row and on now playing).
// Markup (no JS per menu; it works for rows rendered later too):
//   <span class="menu">
//     <button class="menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="X" id="XBtn">…</button>
//     <div class="menu-pop" role="menu" id="X" aria-labelledby="XBtn" hidden>
//       <button type="button" role="menuitem" tabindex="-1">…</button> <div role="separator"></div> …
//     </div>
//   </span>
// The popup is position: fixed next to its button, so a scrolling card (the queue) never clips it.
// Click or Enter opens it and focuses the first item; arrows, Home and End move; Esc closes and
// goes back to the button; Tab or a click outside closes it. Choosing an item
// closes the menu and focuses its button FIRST, so a dialog the item opens gives focus back there.

let current = null; // { btn, pop }

const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
const shown = (el) => !el.hidden && !el.disabled && el.getClientRects().length > 0;
const items = (pop) => [...pop.querySelectorAll(ITEM)].filter(shown);
const popFor = (btn) => document.getElementById(btn.getAttribute('aria-controls'));

function place(btn, pop) {
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  pop.style.left = '0px';
  pop.style.top = '0px';
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = pop.classList.contains('menu-end') ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  let top = r.bottom + 4;
  if (top + h > vh - 8 && r.top - h - 4 >= 8) top = r.top - h - 4; // no room below: open upwards
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.max(8, top))}px`;
}

/** Open the menu of trigger `btn`. focus: put focus on its first item. */
export function openMenu(btn, { focus = true } = {}) {
  const pop = btn && popFor(btn);
  if (!pop) return;
  if (current && current.btn !== btn) closeMenu();
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  current = { btn, pop };
  place(btn, pop);
  if (focus) items(pop)[0]?.focus({ preventScroll: true });
}

/** Close the open menu (if any). back: focus its button. */
export function closeMenu(back = false) {
  if (!current) return;
  const { btn, pop } = current;
  current = null;
  pop.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  if (back && btn.isConnected) btn.focus({ preventScroll: true });
}

/** The trigger of the open menu inside `root` (a re-rendered list uses it to open it again). */
export const openMenuIn = (root) => (current && root.contains(current.btn) ? current.btn : null);

/** The menu button an item belongs to (for focus after a dialog), else the element itself. */
export const menuButtonOf = (el) => el?.closest('.menu')?.querySelector(':scope > .menu-btn') ?? el;

// Choosing an item, or clicking outside: in the capture phase, before the item's own handlers.
document.addEventListener('click', (e) => {
  if (!current) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t && current.pop.contains(t)) {
    if (t.closest(ITEM)) closeMenu(true);
    return;
  }
  if (t && current.btn.contains(t)) return; // the toggle below
  closeMenu();
}, true);

document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('.menu-btn[aria-haspopup="menu"]') : null;
  if (!btn || btn.disabled) return;
  if (current?.btn === btn) closeMenu(true);
  else openMenu(btn);
});

// Keys first (capture), so arrows do not also turn the volume up (shortcuts.js) and Esc does not
// also leave big screen.
document.addEventListener('keydown', (e) => {
  if (!current) {
    const btn = e.target instanceof Element ? e.target.closest('.menu-btn[aria-haspopup="menu"]') : null;
    if (btn && !btn.disabled && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      e.stopPropagation();
      openMenu(btn, { focus: false });
      const list = items(popFor(btn));
      (e.key === 'ArrowUp' ? list.at(-1) : list[0])?.focus({ preventScroll: true });
    }
    return;
  }
  const { pop } = current;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    return closeMenu(true);
  }
  if (e.key === 'Tab') return closeMenu(true); // focus moves on from the button
  const list = items(pop);
  const at = list.indexOf(document.activeElement);
  const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
  if (go === undefined || !list.length) return;
  e.preventDefault();
  e.stopPropagation();
  list[(go + list.length) % list.length].focus({ preventScroll: true });
}, true);

// Scrolling or resizing moves the menu with its button (a page that settles after big screen, or a
// queue that scrolls); a button scrolled out of sight closes it.
function follow(e) {
  if (!current || (e?.target instanceof Node && current.pop.contains(e.target))) return;
  if (!current.btn.isConnected || !current.btn.getClientRects().length) return closeMenu();
  place(current.btn, current.pop);
}
addEventListener('resize', follow);
document.addEventListener('scroll', follow, true);
