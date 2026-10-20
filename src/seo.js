// Search engines (Dalton, 2026-10-14: "improve SEO"). The public pages (/, /about, /setup, /legal and
// their images) may be indexed on roomdj.com; the teacher page, the board, admin, the API and any
// other address (the workers.dev fallback: no duplicate site in search) never. web/public/robots.txt
// and sitemap.xml say the same; the pages carry canonical, Open Graph and JSON-LD tags.

export const CANONICAL_HOST = 'roomdj.com';
const PRIVATE_PATHS = /^\/(host|board|admin|api)(\/|$)/;

/** The x-robots-tag for a page, or null (indexable). */
export function robotsTag(requestUrl, path) {
  const host = new URL(requestUrl).hostname.toLowerCase();
  return host !== CANONICAL_HOST || PRIVATE_PATHS.test(path) ? 'noindex, nofollow' : null;
}
