// The footer's "Site details" (like teachChat): which build this page is, so a bug report's
// "Deploy #37" maps to a commit. web/vite.config.js defines the three values at build time.
/* global __BUILD__, __BUILD_NUM__, __BUILD_DATE__ */

for (const el of document.querySelectorAll('[data-build]')) {
  el.textContent = `Build ${__BUILD__} · Deploy #${__BUILD_NUM__} · ${__BUILD_DATE__}`;
}
