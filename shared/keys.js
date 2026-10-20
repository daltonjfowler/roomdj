// Keyboard shortcuts on the host page (web/src/shortcuts.js): the actions, their default keys, and
// the teacher's own keys (localStorage `cq.keys`, per computer). Pure: no DOM, so Node tests run it.
//
// A key is stored by name: a letter or digit in lower case ('n', '7'), 'Space', an arrow
// ('ArrowUp'), or one punctuation character ('?', '/'). Shift is part of the character ('?' is
// Shift + /); Ctrl, Alt and Meta never fire a shortcut (the browser's own shortcuts stay).

/** The actions, in the order the help dialog lists them. */
export const KEY_ACTIONS = Object.freeze([
  { id: 'playPause', label: 'Play / pause', key: 'Space' },
  { id: 'skip', label: 'Skip the song', key: 'n' },
  { id: 'big', label: 'Big screen on / off', key: 'b' },
  { id: 'full', label: 'Full screen on / off (with big screen)', key: 'f' },
  { id: 'lock', label: 'Lock / unlock suggestions', key: 'l' },
  { id: 'mute', label: 'Mute / unmute', key: 'm' },
  { id: 'volUp', label: 'Volume up', key: 'ArrowUp' },
  { id: 'volDown', label: 'Volume down', key: 'ArrowDown' },
  { id: 'filler', label: 'Background music play / pause', key: 'g' },
  { id: 'add', label: 'Suggest a song (teacher pick)', key: 'a' },
  { id: 'settings', label: 'Open Settings', key: 's' },
  { id: 'layout', label: 'Edit layout on / off', key: 'e' },
  { id: 'help', label: 'Show these shortcuts', key: '?' },
]);

export const DEFAULT_KEYS = Object.freeze(Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a.key])));

/** Keys a shortcut may never take: they move around the page, close dialogs, or press buttons. */
const RESERVED = new Set(['Escape', 'Tab', 'Enter', 'Backspace', 'Delete']);
const NAMED = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * The stored name of a key from a KeyboardEvent-like { key }, or null for keys a shortcut cannot
 * use (Shift, Ctrl, F5, Escape, a dead key ...).
 */
export function keyName(e) {
  const key = e?.key;
  if (typeof key !== 'string' || !key) return null;
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (NAMED.has(key)) return key;
  if (RESERVED.has(key)) return null;
  if ([...key].length !== 1) return null; // Shift, Control, F5, Dead, Unidentified ...
  if (/\s/.test(key)) return null;
  return key.toLowerCase();
}

/** A stored key name is one we could have made. */
export function validKey(name) {
  return typeof name === 'string' && keyName({ key: name === 'Space' ? ' ' : name }) === name;
}

/** How a key looks in the help dialog. */
export function keyLabel(name) {
  const arrows = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (arrows[name]) return arrows[name];
  if (name === 'PageUp') return 'Page Up';
  if (name === 'PageDown') return 'Page Down';
  if (typeof name === 'string' && name.length === 1) return name.toUpperCase();
  return String(name ?? '');
}

/**
 * The teacher's keys from storage text (JSON), checked: unknown actions dropped, a bad key or one
 * used twice falls back to the default (and so does anything that then clashes). Always a full map.
 */
export function loadKeys(text) {
  let saved = null;
  try { saved = JSON.parse(text); } catch { /* none, or broken */ }
  const keys = { ...DEFAULT_KEYS };
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return keys;
  const taken = new Map(); // key → action, among the saved ones that are kept
  for (const { id } of KEY_ACTIONS) {
    const k = saved[id];
    if (!validKey(k) || taken.has(k)) continue;
    taken.set(k, id);
    keys[id] = k;
  }
  // A default that now clashes with a saved key: back to all defaults (rare; keeps every action reachable).
  return new Set(Object.values(keys)).size === KEY_ACTIONS.length ? keys : { ...DEFAULT_KEYS };
}

/** Only the keys that differ from the defaults, as storage text ('' = all defaults). */
export function saveKeys(keys) {
  const diff = Object.fromEntries(KEY_ACTIONS.filter((a) => keys[a.id] && keys[a.id] !== a.key).map((a) => [a.id, keys[a.id]]));
  return Object.keys(diff).length ? JSON.stringify(diff) : '';
}

/**
 * Give `action` the key `name`. → { ok: true, keys } (a new map) | { ok: false, error, other? }
 * error: 'unknown' (no such action), 'bad' (a key a shortcut cannot use), 'taken' (`other` has it).
 */
export function setKey(keys, action, name) {
  if (!KEY_ACTIONS.some((a) => a.id === action)) return { ok: false, error: 'unknown' };
  if (!validKey(name)) return { ok: false, error: 'bad' };
  const other = KEY_ACTIONS.find((a) => a.id !== action && keys[a.id] === name);
  if (other) return { ok: false, error: 'taken', other: other.id };
  return { ok: true, keys: { ...keys, [action]: name } };
}

/** The action a key press asks for, or null. Ctrl, Alt or Meta held: never (the browser's own). */
export function matchKey(keys, e) {
  if (!e || e.ctrlKey || e.altKey || e.metaKey) return null;
  const name = keyName(e);
  if (!name) return null;
  return KEY_ACTIONS.find((a) => keys[a.id] === name)?.id ?? null;
}

/** The label of an action ("Skip the song"). */
export const actionLabel = (id) => KEY_ACTIONS.find((a) => a.id === id)?.label ?? id;
