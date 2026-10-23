// Why a song was turned down (protocol.js REASONS): the `why` object students see, the `detail`
// the teacher sees, the teacher's own reason + note (word-screened), and the "Blocked today" log
// (protocol.js BLOCKED). Pure functions; the Room (src/room.js) calls them.

import { BLOCKED_MAX, NOTE_MAX, REASONS, TEACHER_DEVICE, TEACHER_REASONS } from './protocol.js';
import { SPOTIFY, catalogOf } from './catalog.js';
import { wordsAllowed } from './nick.js';
import { stripQuoted } from './filter.js';

// Plain words that only name what a song is about; the label already says as much, so evidence
// or a note may use them ("About getting drunk at a party"). Everything else on the nickname word
// lists (swearing, sexual words, slurs, hate figures) drops the evidence or the note.
const TOPIC_WORDS = [
  'drunk', 'kill', 'kills', 'killer', 'killers', 'killing', 'killed', 'murder', 'murders', 'murdered', 'murderer',
  'suicide', 'suicidal', 'massacre', 'genocide', 'terrorist', 'terrorists', 'stab', 'stabbed', 'stabbing',
  'weed', 'meth', 'cocaine', 'heroin', 'fentanyl', 'stoned', 'stoner',
];

// Phrases from the nickname list that, in a sentence, only name the topic ("School shooting
// theme", "References to self harm"). Threats like "kill yourself" stay refused.
const TOPIC_PHRASES = ['selfharm', 'schoolshoot'];

/** Student text when the AI's evidence is missing or does not pass the word screen. */
export const THEME_FALLBACK = 'It does not seem right for school.';
export const UNKNOWN_EVIDENCE = 'Your teacher will check it.';
export const BLOCKED_WORD_EVIDENCE = 'It has a word your teacher blocked.';
export const SINGING_EVIDENCE = 'This song has singing.';

/**
 * Plain sentences per AI category, for a song judged from its lyrics whose evidence was dropped
 * (it copied lyric words: src/lyrics.js). Never a lyric, never a word students may not read.
 */
const CATEGORY_EVIDENCE = {
  drugs: 'The lyrics talk about drugs or smoking.',
  alcohol: 'The lyrics are about drinking.',
  sexual: 'The lyrics have sexual content.',
  violence: 'The lyrics make violence look good.',
  selfharm: 'The lyrics are about self-harm.',
  hate: 'The lyrics have hateful words.',
  swearing: 'The lyrics have a lot of swearing.',
  notmusic: 'Memes, noise and sound effects are not on the playlist.',
};
export function categoryEvidence(category) {
  return CATEGORY_EVIDENCE[category] ?? THEME_FALLBACK;
}

/** True when students may read this text (the nickname lists, minus staff words and TOPIC_WORDS). */
export function kidSafe(text) {
  return wordsAllowed(text, { except: TOPIC_WORDS, exceptPhrases: TOPIC_PHRASES });
}

/**
 * The AI's evidence as students may see it: anything in quotes dropped (it may be a lyric), and ''
 * when it does not pass the word screen.
 */
export function kidEvidence(evidence) {
  const s = stripQuoted(evidence);
  return s && kidSafe(s) ? s : '';
}

/** The teacher's words for a verdict the AI made from the song's lyrics (src/lyrics.js). */
export const JUDGED_FROM_LYRICS = 'judged from lyrics';

/** Needs a look, for the teacher: why the checker could not decide. '' = nothing to add. */
export function reviewDetail(ai) {
  if (ai?.lyrics === 'found' && ai.verdict === 'unknown') return `AI checker, ${JUDGED_FROM_LYRICS}: still not sure`;
  return ai?.reason ? `AI checker: ${ai.reason}` : '';
}

function explicitEvidence(song) {
  return catalogOf(song?.id) === SPOTIFY ? 'Spotify marks this song explicit.' : 'Apple marks this song explicit.';
}

/**
 * A filter "no" (shared/filter.js filterSong) → { why, detail }.
 * why: what the student sees (protocol.js REASONS); detail: what the teacher sees in Blocked today.
 * @param {object} song
 * @param {{ reason: string, ai?: object|null, word?: string|null }} verdict
 * @param {{ banNote?: string }} [extra] banNote: the teacher's note from the ban list
 */
export function filterWhy(song, verdict, { banNote = '' } = {}) {
  switch (verdict.reason) {
    case 'explicit': {
      const evidence = explicitEvidence(song);
      return { why: { id: 'explicit', evidence }, detail: evidence };
    }
    case 'blocklist':
      return {
        why: { id: 'blocked_word', evidence: BLOCKED_WORD_EVIDENCE },
        detail: verdict.word ? `Blocked word: "${verdict.word}"` : 'A blocked word',
      };
    case 'notmusic': // the built-in word list (shared/filter.js notMusicHit)
      return {
        why: { id: 'notmusic', evidence: CATEGORY_EVIDENCE.notmusic },
        detail: verdict.word ? `Not music for class: "${verdict.word}"` : 'Not music for class',
      };
    case 'banned':
      return { why: banNote ? { id: 'banned', evidence: banNote } : { id: 'banned' }, detail: banNote ? `Your ban note: ${banNote}` : 'On your ban list' };
    case 'theme': {
      const ai = verdict.ai ?? {};
      const id = REASONS[ai.category] ? ai.category : 'other';
      const full = ai.evidence || ai.reason || '';
      const lyrics = ai.source === 'lyrics';
      const who = lyrics ? `AI checker, ${JUDGED_FROM_LYRICS}` : 'AI checker';
      return {
        why: { id, evidence: kidEvidence(ai.evidence) || (lyrics ? categoryEvidence(id) : THEME_FALLBACK) },
        detail: full ? `${who}: ${full}${ai.legacy ? ' (checked before categories)' : ''}` : `${who} (no details)`,
      };
    }
    case 'not_instrumental': {
      const ai = verdict.ai ?? {};
      const by = ai.instrumental !== false ? 'its title says it has singing'
        : ai.lyrics === 'found' ? `it has lyrics, so it has singing (${JUDGED_FROM_LYRICS})` : 'the AI checker says it has singing';
      return { why: { id: 'not_instrumental', evidence: SINGING_EVIDENCE }, detail: `Instrumentals only: ${by}` };
    }
    case 'review':
      if (verdict.instrumental === 'unknown') {
        return { why: { id: 'unknown', evidence: UNKNOWN_EVIDENCE }, detail: 'Instrumentals only: the checker is not sure whether it has singing' };
      }
      return { why: { id: 'unknown', evidence: UNKNOWN_EVIDENCE }, detail: reviewDetail(verdict.ai) };
    default:
      return { why: { id: 'other' }, detail: '' };
  }
}

/**
 * A teacher's note: one line, no control characters, at most NOTE_MAX letters.
 * @returns {{ note: string, refused: boolean }} refused: it had words students must not see (dropped)
 */
export function screenNote(raw) {
  if (typeof raw !== 'string') return { note: '', refused: false };
  const note = [...raw.normalize('NFKC').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, NOTE_MAX).join('').trim();
  if (!note) return { note: '', refused: false };
  return kidSafe(note) ? { note, refused: false } : { note: '', refused: true };
}

/**
 * The host's optional { reason, note } on veto / remove / ban → { why, detail, refused }.
 * An unknown or missing reason is `fallback` ('teacher' for veto and remove, 'banned' for ban).
 */
export function teacherWhy(msg, fallback = 'teacher') {
  const id = TEACHER_REASONS.includes(msg?.reason) ? msg.reason : fallback;
  const { note, refused } = screenNote(msg?.note);
  const why = note ? { id, evidence: note } : { id };
  const label = REASONS[id]?.teacher ?? id;
  return { why, detail: note ? `${label}: ${note}` : label, refused };
}

// ---- Blocked today (protocol.js BLOCKED) --------------------------------------------------------

/**
 * Add one entry to the log (oldest first in storage; at most BLOCKED_MAX). Changes `log` in place
 * and returns the entry. `filter` entries from the AI theme check or a blocked word can be allowed
 * anyway; explicit and banned songs cannot.
 */
export function logBlocked(log, { song, device, by, why, detail = '', source, action, now = Date.now() }) {
  const last = log.length ? Number(String(log[log.length - 1].id).slice(1)) || log.length : 0;
  const entry = {
    id: `b${last + 1}`, at: now, song, device, by, why, detail: String(detail).slice(0, 200), source, action, status: null,
  };
  if (device === TEACHER_DEVICE) entry.teacher = true; // a teacher pick (protocol.js TEACHER PICKS)
  log.push(entry);
  if (log.length > BLOCKED_MAX) log.splice(0, log.length - BLOCKED_MAX);
  return entry;
}

/** "Allow anyway" fits: a filter "no" from the AI theme check, a blocked word or Instrumentals only, not done yet. */
export function canAllow(entry) {
  return entry.source === 'filter' && !entry.status && !['explicit', 'banned', 'unknown'].includes(entry.why?.id);
}

/** "Ban" fits: not banned (now or before), and not an explicit song (always blocked anyway). */
export function canBan(entry) {
  return entry.status !== 'banned' && entry.why?.id !== 'banned' && entry.why?.id !== 'explicit';
}

/** What the host gets: newest first, songs trimmed, with the actions that fit. */
export function blockedView(log) {
  return [...log].reverse().map((e) => ({
    id: e.id, at: e.at, by: e.by, why: e.why, detail: e.detail, source: e.source, action: e.action, status: e.status,
    song: { id: e.song.id, title: e.song.title, artist: e.song.artist, artwork: e.song.artwork },
    canAllow: canAllow(e), canBan: canBan(e), ...(e.teacher ? { teacher: true } : {}),
  }));
}
