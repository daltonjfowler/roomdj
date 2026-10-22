// Tabs (Settings): role="tablist" with role="tab" buttons, each aria-controls its role="tabpanel".
// Arrows, Home and End move and show (automatic activation); only the chosen tab is in the Tab order.
// The last tab is remembered on this computer (localStorage `storageKey`; blocked storage: the first tab).

/**
 * @param {HTMLElement} list the [role=tablist]
 * @param {{ storageKey?: string }} options
 * @returns {{ select: (tab: HTMLElement | string, focus?: boolean) => void, restore: () => void, tabFor: (el: Element) => HTMLElement | null }}
 */
export function initTabs(list, { storageKey = '' } = {}) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'));

  function select(tab, focus = false) {
    if (typeof tab === 'string') tab = tabs.find((t) => t.id === tab);
    if (!tab) return;
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panelOf(t).hidden = !on;
    }
    if (focus) tab.focus();
    if (storageKey) try { localStorage.setItem(storageKey, tab.id); } catch { /* blocked: this page only */ }
  }

  function restore() {
    let id = '';
    if (storageKey) try { id = localStorage.getItem(storageKey) ?? ''; } catch { /* blocked */ }
    select(tabs.find((t) => t.id === id) ?? tabs[0]);
  }

  list.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) select(tab);
  });
  list.addEventListener('keydown', (e) => {
    // Only the tabs on screen: Simple settings hide some (host.js setLevel).
    const shown = tabs.filter((t) => t.getClientRects().length);
    const at = shown.indexOf(document.activeElement);
    if (at < 0) return;
    const go = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: shown.length - 1 }[e.key];
    if (go === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    select(shown[(go + shown.length) % shown.length], true);
  });

  /** The tab whose panel holds `el` (to show a field that has a problem). */
  const tabFor = (el) => tabs.find((t) => panelOf(t).contains(el)) ?? null;

  restore();
  return { select, restore, tabFor };
}
