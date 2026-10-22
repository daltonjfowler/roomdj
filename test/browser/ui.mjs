// The host page keeps many tools inside menus (web/src/menu.js: 📺 Screen, 🏠 Room, 📋 Lists, each
// queue row's ⋯, now playing's ⋯) and the Settings fields inside tabs (web/src/tabs.js). The ids
// stayed the same; a test first makes the element reachable, the way a teacher would:
//   await page.click(await reveal(page, '#lockBtn'));       // opens 🏠 Room, then clicks
//   await page.fill(await reveal(page, '#setCredits'), '3'); // shows the Credits tab
// reveal() returns the selector, so it drops into any Playwright call.

/**
 * Open the menu or show the tab that holds `sel` when it is not visible yet. Visible already, or
 * not inside a menu or tab: nothing happens. Returns `sel`.
 */
export async function reveal(page, sel) {
  await page.waitForSelector(sel, { state: 'attached', timeout: 15_000 });
  // Simple settings hide the [data-adv] rows (web/src/host.js setLevel): All settings first, like a teacher.
  const adv = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const all = document.querySelector('#levelAll');
    const panel = el?.closest('[role="tabpanel"]');
    const advTab = panel && document.querySelector(`[role="tab"][aria-controls="${CSS.escape(panel.id)}"]`)?.hasAttribute('data-adv');
    return Boolean((el?.closest('[data-adv]') || advTab) && !el.closest('.show-all') && all?.getClientRects().length);
  }, sel);
  if (adv) await page.click('#levelAll');
  const opener = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || el.getClientRects().length) return null;
    const pop = el.closest('.menu-pop');
    const panel = el.closest('[role="tabpanel"]');
    const btn = pop ? document.querySelector(`[aria-controls="${CSS.escape(pop.id)}"]`)
      : panel ? document.querySelector(`[role="tab"][aria-controls="${CSS.escape(panel.id)}"]`) : null;
    if (!btn) return null;
    document.querySelectorAll('[data-reveal]').forEach((x) => x.removeAttribute('data-reveal'));
    btn.setAttribute('data-reveal', '1');
    return '[data-reveal="1"]';
  }, sel);
  if (opener) {
    await page.click(opener);
    await page.evaluate(() => document.querySelector('[data-reveal]')?.removeAttribute('data-reveal'));
    await page.waitForSelector(sel, { state: 'visible', timeout: 5_000 });
  }
  return sel;
}

/** reveal(), then click. */
export async function tap(page, sel, options) {
  await page.click(await reveal(page, sel), options);
}

/** Open a menu by its button (e.g. '#roomMenuBtn'); already open: left open. */
export async function openMenu(page, btnSel) {
  if ((await page.getAttribute(btnSel, 'aria-expanded')) !== 'true') await page.click(btnSel);
}
