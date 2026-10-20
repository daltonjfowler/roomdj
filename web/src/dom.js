// Tiny DOM helpers. No framework: the pages must stay light for slow Chromebooks.

import { spotifyLink } from '../../shared/catalog.js';
import { showArt } from '../../shared/art.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for innerHTML. Anything a student typed or a song name must go through this. */
export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function $(selector) {
  return document.querySelector(selector);
}

// The Spotify icon (monochrome: Spotify's brand rules allow the green one only on black or white).
const SPOTIFY_ICON = '<svg class="sp-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>';
export const spotifyIcon = () => SPOTIFY_ICON;

/**
 * For a song from Spotify's catalog: the Spotify icon, linking to the song on Spotify (Spotify's
 * attribution rule for its metadata and cover art). '' for other songs.
 */
export function spotifyMark(song) {
  const url = spotifyLink(song?.id);
  if (!url) return '';
  return `<a class="sp-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Listen on Spotify"
    aria-label="${esc(`Listen on Spotify: ${song.title}`)}">${SPOTIFY_ICON}</a>`;
}

/** iTunes artwork URLs carry their size ("100x100bb"); ask for a bigger one for the big cards. */
export function artwork(url, size = 100) {
  return String(url || '').replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
}

/**
 * A song's cover, as the server allows (protocol.js ALBUM ART): the image only when song.art is
 * 'ok'. Otherwise a plain 🎵 tile; with `blur` (search results, favorites to suggest from) a cover
 * not checked yet shows blurred under a 🎵. Pages never decide on their own.
 */
export function artHtml(song, size = 100, { cls = 'art', blur = false, lazy = false } = {}) {
  const l = lazy ? ' loading="lazy"' : '';
  if (showArt(song)) return `<img class="${cls}" src="${esc(artwork(song.artwork, size))}" alt=""${l}>`;
  if (blur && song?.art === 'unchecked' && song.artwork) {
    return `<span class="${cls} art-blur" title="Cover not checked yet" aria-hidden="true"><img src="${esc(artwork(song.artwork, size))}" alt=""${l}><span class="art-mark">🎵</span></span>`;
  }
  return `<span class="${cls} art-tile" aria-hidden="true"><span class="art-mark">🎵</span></span>`;
}

/** Show a short message in the #toasts area for a few seconds. */
export function toast(text, kind = '', ms = 5000) {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Say something to screen readers (the #announce live region) without showing it. */
export function announce(text) {
  const box = $('#announce');
  if (!box) return;
  // Clear first, so the same sentence twice is still read out.
  box.textContent = '';
  setTimeout(() => { box.textContent = text; }, 50);
}

/**
 * Ask a yes/no question in the page's <dialog id="confirm">. Resolves true for the OK button.
 * Not window.confirm: that one blocks the music and looks wrong on a projector.
 */
export function ask(question, okLabel = 'OK', detail = '') {
  const dlg = $('#confirm');
  dlg.querySelector('[data-q]').textContent = question;
  dlg.querySelector('[data-detail]').textContent = detail;
  dlg.querySelector('[value="ok"]').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((done) => dlg.addEventListener('close', () => done(dlg.returnValue === 'ok'), { once: true }));
}

/**
 * Re-render a list without losing keyboard focus: remember which [data-id][data-act] button had
 * focus and focus the same one afterwards.
 */
export function keepFocus(render) {
  const a = document.activeElement;
  const key = a?.dataset?.act && a.closest('[data-id]') ? [a.closest('[data-id]').dataset.id, a.dataset.act] : null;
  render();
  if (!key) return;
  const again = document.querySelector(`[data-id="${CSS.escape(key[0])}"] [data-act="${CSS.escape(key[1])}"]`);
  again?.focus();
}
