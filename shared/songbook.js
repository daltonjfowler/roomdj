// Search filters on a page (protocol.js SONGBOOK; Dalton, 2026-10-29: "only include pre-screened
// songs", "sort by genre or popularity"). Pure, no DOM: the student page and the teacher's search use
// the same rules. Display only: a suggestion is still checked for real on the server.

import { RESULT_SORTS } from './protocol.js';

export const DEFAULT_VIEW = Object.freeze({ checked: false, genre: '', sort: 'popular' });

/** The genres in these results (the catalog's genre names), most common first. */
export function resultGenres(results) {
  const n = new Map();
  for (const s of results) if (s?.genre) n.set(s.genre, (n.get(s.genre) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
}

/** A saved or typed view, made safe (unknown sort → 'popular'). */
export function cleanView(v) {
  return {
    checked: v?.checked === true,
    genre: typeof v?.genre === 'string' ? v.genre.slice(0, 40) : '',
    sort: RESULT_SORTS.includes(v?.sort) ? v.sort : 'popular',
  };
}

const byYear = (dir) => (a, b) => {
  const x = a.year || 0, y = b.year || 0;
  if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1); // year not known: last either way
  return dir * (x - y);
};

/**
 * The results the filters let through, in the chosen order. 'popular' keeps the server's order:
 * ✓ Checked first, then the catalog's (most popular matches first) or the shelf's rank. A genre
 * the results no longer have is ignored, so a new search never shows an empty list for it.
 */
export function viewResults(results, view = DEFAULT_VIEW) {
  const { checked, genre, sort } = cleanView(view);
  const g = genre && results.some((s) => s.genre === genre) ? genre : '';
  const out = results.filter((s) => (!checked || s.check === 'ready') && (!g || s.genre === g));
  if (sort === 'newest') return out.sort(byYear(-1));
  if (sort === 'oldest') return out.sort(byYear(1));
  if (sort === 'title') return out.sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }));
  return out;
}
