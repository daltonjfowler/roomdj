/*
 * Stamp data-theme="light" or "dark" on <html> before the first paint, so a student who picked
 * Light never sees a flash. A file, not an inline script, because the CSP is script-src 'self'.
 * The key and rule must match src/theme.js: nothing saved = Dark (Dalton, 2026-10-14: dark for
 * first-time visitors); 'system' follows the device.
 */
(function () {
  var pref = null;
  try {
    pref = window.localStorage.getItem('cq.theme');
  } catch (e) {
    // site data blocked: Dark
  }
  var dark = pref === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : pref !== 'light';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
