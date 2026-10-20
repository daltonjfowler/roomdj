// The theme button: Dark, Light, System, and round again. public/theme-boot.js has already set
// data-theme before the first paint; this keeps it right afterwards (including a Chromebook that
// flips light/dark while the page is open on System). Nothing saved = Dark (Dalton, 2026-10-14:
// dark for first-time visitors), so every choice is saved, System too.

const KEY = 'cq.theme';
const ORDER = ['dark', 'light', 'system'];
const LABELS = { system: '🖥️ System', light: '☀️ Light', dark: '🌙 Dark' };

function load() {
  try {
    const v = localStorage.getItem(KEY);
    return ORDER.includes(v) ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export function initThemeButton(button) {
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  let pref = load();

  function apply() {
    const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    button.textContent = LABELS[pref];
    button.title = `Theme: ${pref}. Click for ${next}.`;
    button.setAttribute('aria-label', button.title);
  }

  button.addEventListener('click', () => {
    pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    try {
      localStorage.setItem(KEY, pref);
    } catch { /* storage blocked: still works for this page */ }
    apply();
  });
  darkQuery.addEventListener('change', apply);
  apply();
}

/** Call `fn` whenever the theme attribute changes (the 3D view redraws with its own colours). */
export function onThemeChange(fn) {
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}
