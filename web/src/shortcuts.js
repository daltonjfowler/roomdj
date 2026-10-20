// Keyboard shortcuts on the host page, and the help dialog where the teacher changes them (press
// Change, then the new key). The keys and their rules are shared/keys.js; the teacher's own keys
// are kept on this computer, per teacher (localStorage cq.keys:<profile>, profile.js). host.js hands over what each action does.
//
// A shortcut never fires while the teacher types in a box, while another dialog is open (only the
// shortcuts dialog itself allows them), or with Ctrl, Alt or Meta held. Space and Enter on a
// focused button, and the arrows on a slider, keep doing what they normally do.

import { $, announce, esc } from './dom.js';
import { prefKey } from './profile.js';
import { KEY_ACTIONS, actionLabel, keyLabel, keyName, loadKeys, matchKey, saveKeys, setKey } from '../../shared/keys.js';

const SAVED = 'cq.keys';
const HELP = 'keysDlg';

function readKeys() { try { return loadKeys(localStorage.getItem(prefKey(SAVED))); } catch { return loadKeys(null); } }
function writeKeys(keys) {
  try {
    const text = saveKeys(keys);
    if (text) localStorage.setItem(prefKey(SAVED), text);
    else localStorage.removeItem(prefKey(SAVED));
  } catch { /* blocked: works until the page closes */ }
}

const TEXT_INPUTS = /^(text|search|url|email|password|number|tel|date|time|datetime-local|month|week)$/;

/** Is this key press meant for the focused element itself (typing, a button, a slider)? */
function forTheElement(e) {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return false;
  if (el.isContentEditable || el.closest('textarea, select, [contenteditable="true"]')) return true;
  if (el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (TEXT_INPUTS.test(type)) return true;
    if (type === 'range') return /^Arrow|^Page|^Home$|^End$/.test(e.key);
    return e.key === ' ' || e.key === 'Enter'; // checkbox, radio, button
  }
  if (el.closest('button, a[href], summary, [role="button"], [role="switch"]')) return e.key === ' ' || e.key === 'Enter';
  return false;
}

/**
 * @param {{ actions: Record<string, () => void>, enabled: () => boolean }} options
 *   actions: what each KEY_ACTIONS id does; enabled(): false while no room is open (help still works).
 */
export function initShortcuts({ actions, enabled }) {
  let keys = readKeys();
  let recording = null; // the action waiting for its new key

  function showHint() {
    $('#keysHint').textContent = `⌨ Press ${keyLabel(keys.help)} for shortcuts`;
  }

  function renderList() {
    $('#keysList').innerHTML = KEY_ACTIONS.map((a) => `<tr data-id="${a.id}">
      <td><kbd>${esc(recording === a.id ? '…' : keyLabel(keys[a.id]))}</kbd></td>
      <td>${esc(a.label)}</td>
      <td><button type="button" data-act="change" aria-label="${esc(`Change the key for ${a.label}`)}">${recording === a.id ? 'Press a key…' : 'Change'}</button></td>
    </tr>`).join('');
  }

  function openHelp() {
    recording = null;
    $('#keysMsg').textContent = '';
    renderList();
    if (!$(`#${HELP}`).open) $(`#${HELP}`).showModal();
  }

  function stopRecording(focus = true) {
    const was = recording;
    recording = null;
    renderList();
    if (focus && was) $(`#keysList [data-id="${was}"] button`)?.focus();
  }

  $('#keysList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="change"]');
    if (!btn) return;
    recording = btn.closest('[data-id]').dataset.id;
    $('#keysMsg').textContent = `Press the new key for "${actionLabel(recording)}". Esc cancels.`;
    renderList();
    $(`#keysList [data-id="${recording}"] button`)?.focus();
  });
  $('#keysReset').addEventListener('click', () => {
    keys = loadKeys(null);
    writeKeys(keys);
    recording = null;
    renderList();
    showHint();
    $('#keysMsg').textContent = 'Back to the usual keys.';
  });
  $(`#${HELP}`).addEventListener('cancel', (e) => {
    if (!recording) return;
    e.preventDefault(); // Esc while waiting for a key: stop waiting, keep the dialog open
    $('#keysMsg').textContent = '';
    stopRecording();
  });
  $(`#${HELP}`).addEventListener('close', () => { recording = null; });

  // Recording a new key comes first (capture), so the key does not also do its old job.
  document.addEventListener('keydown', (e) => {
    if (!recording) return;
    if (e.key === 'Tab') return stopRecording(false);
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      $('#keysMsg').textContent = '';
      return stopRecording();
    }
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return; // wait for the real key
    const name = e.ctrlKey || e.altKey || e.metaKey ? null : keyName(e);
    if (!name) {
      $('#keysMsg').textContent = 'That key cannot be a shortcut (Esc, Tab, Enter and Ctrl or Alt keys are kept for the browser). Try another.';
      return;
    }
    const r = setKey(keys, recording, name);
    if (!r.ok) {
      $('#keysMsg').textContent = r.error === 'taken'
        ? `${keyLabel(name)} already does "${actionLabel(r.other)}". Change that one first, or press another key.`
        : 'That key cannot be a shortcut. Try another.';
      return;
    }
    keys = r.keys;
    writeKeys(keys);
    const done = recording;
    $('#keysMsg').textContent = `"${actionLabel(done)}" is now ${keyLabel(name)}.`;
    announce(`${actionLabel(done)}: ${keyLabel(name)}.`);
    stopRecording();
    showHint();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (recording || e.defaultPrevented || (e.repeat && !/^Arrow/.test(e.key))) return;
    const open = document.querySelector('dialog[open]');
    if (open && open.id !== HELP) return;
    if (forTheElement(e)) return;
    const action = matchKey(keys, e);
    if (!action) return;
    if (action !== 'help' && !enabled()) return;
    if (action === 'help' && open) {
      e.preventDefault();
      return open.close();
    }
    e.preventDefault();
    if (action === 'help') return openHelp();
    open?.close(); // from the shortcuts dialog: close it, then do it
    actions[action]?.();
  });

  $('#keysHint').addEventListener('click', openHelp);
  showHint();
  return { openHelp, keyFor: (id) => keyLabel(keys[id]) };
}
