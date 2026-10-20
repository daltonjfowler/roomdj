import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_CATEGORIES, BLOCKED_MAX, DEFAULT_SETTINGS, NOTE_MAX, REASONS, TEACHER_REASONS, whyText,
} from '../shared/protocol.js';
import {
  LEGACY_VERDICT_VERSION, PROMPT_VERSION, aiThemeCheck, buildThemePrompt, cleanEvidence, filterSong, parseThemeVerdict,
  readVerdict, themeCategory, verdictKey,
} from '../shared/filter.js';
import {
  BLOCKED_WORD_EVIDENCE, THEME_FALLBACK, UNKNOWN_EVIDENCE, blockedView, canAllow, canBan, filterWhy, kidEvidence,
  logBlocked, screenNote, teacherWhy,
} from '../shared/reasons.js';
import { nickAllowed, wordsAllowed } from '../shared/nick.js';
import { addSuggestion, addToReview, allowBlocked, applyBlocklist, newRoomState } from '../shared/queue.js';

const song = (over = {}) => ({
  id: 'it:42', title: 'Happy', artist: 'Pharrell Williams', album: 'G I R L', artwork: 'a', durationMs: 1,
  explicit: 'notExplicit', previewUrl: 'https://x', ...over,
});

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(k, type) {
      const v = map.get(k);
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      map.set(k, v);
    },
  };
}
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

test('REASONS: every preset has an emoji (but other), both labels; categories and picks are presets', () => {
  for (const id of ['explicit', 'drugs', 'alcohol', 'sexual', 'violence', 'selfharm', 'hate', 'swearing', 'blocked_word', 'banned', 'unknown', 'teacher', 'other']) {
    assert.ok(REASONS[id], id);
    assert.ok(REASONS[id].student && REASONS[id].teacher, id);
    if (id !== 'other') assert.ok(REASONS[id].emoji, id);
  }
  for (const id of [...AI_CATEGORIES, ...TEACHER_REASONS]) assert.ok(REASONS[id], id);
  assert.equal(whyText({ id: 'drugs', evidence: 'Mentions getting high' }), '💊 Drug references: Mentions getting high');
  assert.equal(whyText({ id: 'banned' }), '⛔ Banned by your teacher');
  assert.equal(whyText({ id: 'banned' }, 'teacher'), '⛔ Banned');
  assert.equal(whyText({ id: 'other', evidence: 'x' }), 'Other: x');
  assert.equal(whyText({ id: 'nonsense' }), 'Other', 'an unknown id reads as other');
  assert.equal(whyText(null), '');
});

test('theme prompt v5 asks for category, evidence and instrumental, never lyrics', () => {
  assert.equal(PROMPT_VERSION, 5);
  const [system] = buildThemePrompt(song());
  for (const part of ['"category"', '"evidence"', '"instrumental"', 'never quote lyrics', 'at most 15 words', 'selfharm', 'swearing', 'alcohol']) {
    assert.ok(system.content.includes(part), part);
  }
  assert.equal(verdictKey('it:42'), 'verdict:v5:42');
  assert.equal(verdictKey('it:42', LEGACY_VERDICT_VERSION), 'verdict:v3:42');
});

test('parser: categories (exact, synonyms, unknown → other), only for INAPPROPRIATE', () => {
  const p = (o) => parseThemeVerdict(JSON.stringify(o));
  assert.equal(p({ verdict: 'INAPPROPRIATE', category: 'drugs', evidence: 'x' }).category, 'drugs');
  assert.equal(p({ verdict: 'INAPPROPRIATE', category: 'Self-harm', evidence: 'x' }).category, 'selfharm');
  assert.equal(p({ verdict: 'INAPPROPRIATE', category: 'self_harm', evidence: 'x' }).category, 'selfharm');
  assert.equal(p({ verdict: 'INAPPROPRIATE', category: 'profanity', evidence: 'x' }).category, 'swearing');
  assert.equal(p({ verdict: 'INAPPROPRIATE', category: 'school shootings', evidence: 'x' }).category, 'violence');
  assert.equal(p({ verdict: 'INAPPROPRIATE', category: 'tax evasion', evidence: 'x' }).category, 'other');
  assert.equal(p({ verdict: 'INAPPROPRIATE', category: 7 }).category, 'other');
  assert.equal(p({ verdict: 'INAPPROPRIATE' }).category, 'other');
  assert.equal(p({ verdict: 'OK', category: 'drugs' }).category, null);
  assert.equal(p({ verdict: 'UNKNOWN', category: 'other' }).category, null);
  assert.equal(themeCategory('ALCOHOL'), 'alcohol');
  assert.equal(parseThemeVerdict('not json').verdict, 'unknown');
});

test('evidence: quotes (lyrics) dropped, at most 15 words and 120 letters, control characters gone', () => {
  assert.equal(cleanEvidence('Sings "a quoted lyric line" about partying'), 'Sings about partying');
  assert.equal(cleanEvidence('Mentions “curly quoted words” twice'), 'Mentions twice');
  assert.equal(cleanEvidence("The line 'single quoted lyric' is about drugs"), 'The line is about drugs');
  assert.equal(cleanEvidence("It's about the singer's ex"), "It's about the singer's ex", 'apostrophes stay');
  assert.equal(cleanEvidence('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen'),
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen');
  assert.ok(cleanEvidence('x'.repeat(300)).length <= 120);
  assert.equal(cleanEvidence('About\u0000 drugs\n'), 'About drugs');
  assert.equal(cleanEvidence(42), '42');
  assert.equal(cleanEvidence(null), '');
  const v = parseThemeVerdict('{"verdict":"INAPPROPRIATE","category":"drugs","evidence":"Quotes \\"lyric here\\" about getting high"}');
  assert.equal(v.evidence, 'Quotes about getting high');
});

test('kid screen: swearing, sexual words and slurs drop the evidence; topic words and staff words stay', () => {
  assert.equal(kidEvidence('About getting drunk at a party'), 'About getting drunk at a party');
  assert.equal(kidEvidence('Glorifies killing with guns'), 'Glorifies killing with guns');
  assert.equal(kidEvidence('A student thinks about suicide'), 'A student thinks about suicide');
  assert.equal(kidEvidence('References cocaine use'), 'References cocaine use');
  assert.equal(kidEvidence('Ask your teacher about it'), 'Ask your teacher about it');
  // Real evidence from the 70B run (scripts/ai-test.mjs, 2026-10-05).
  for (const e of ['School shooting themes present', 'References to suicide and self harm', 'References to crystal meth use',
    'drinking and getting drunk', 'Sexual implications and suggestive content', 'Domestic violence themes present', 'Song about shooting someone']) {
    assert.equal(kidEvidence(e), e, e);
  }
  assert.equal(kidEvidence('Tells you to kill yourself'), '', 'a threat is never shown');
  assert.equal(kidEvidence('Lots of f*ck and sh1t'), '');
  assert.equal(kidEvidence('Describes sex in detail'), '');
  assert.equal(kidEvidence('Uses the n word: nigga'), '');
  assert.equal(kidEvidence(''), '');
  // The nickname check itself is unchanged: staff words still refused there.
  assert.equal(nickAllowed('Teacher Bob'), false);
  assert.equal(wordsAllowed('Teacher Bob'), true);
  assert.equal(nickAllowed('Mr Lee'), false);
  assert.equal(wordsAllowed('Mr Lee says not today'), true);
});

test('reason mapping: every filter path', () => {
  assert.deepEqual(filterWhy(song({ explicit: 'explicit' }), { reason: 'explicit' }).why, { id: 'explicit', evidence: 'Apple marks this song explicit.' });
  const bw = filterWhy(song(), { reason: 'blocklist', word: 'happy' });
  assert.deepEqual(bw.why, { id: 'blocked_word', evidence: BLOCKED_WORD_EVIDENCE });
  assert.ok(!JSON.stringify(bw.why).toLowerCase().includes('happy'), 'students never get the word');
  assert.equal(bw.detail, 'Blocked word: "happy"');
  assert.deepEqual(filterWhy(song(), { reason: 'banned' }).why, { id: 'banned' });
  assert.deepEqual(filterWhy(song(), { reason: 'banned' }, { banNote: 'Too sad' }).why, { id: 'banned', evidence: 'Too sad' });
  const theme = filterWhy(song(), { reason: 'theme', ai: { category: 'drugs', evidence: 'Mentions getting high', reason: 'Mentions getting high' } });
  assert.deepEqual(theme.why, { id: 'drugs', evidence: 'Mentions getting high' });
  assert.equal(theme.detail, 'AI checker: Mentions getting high');
  const rude = filterWhy(song(), { reason: 'theme', ai: { category: 'sexual', evidence: 'Talks about sex a lot' } });
  assert.deepEqual(rude.why, { id: 'sexual', evidence: THEME_FALLBACK }, 'evidence that fails the screen: a plain sentence for students');
  assert.equal(rude.detail, 'AI checker: Talks about sex a lot', 'the teacher still sees it');
  const legacy = filterWhy(song(), { reason: 'theme', ai: readVerdict({ verdict: 'inappropriate', reason: 'old prompt reason' }) });
  assert.deepEqual(legacy.why, { id: 'other', evidence: THEME_FALLBACK }, 'old verdicts: other, reason only for the teacher');
  assert.ok(legacy.detail.includes('old prompt reason'));
  assert.deepEqual(filterWhy(song(), { reason: 'review', ai: { reason: 'never heard of it' } }).why, { id: 'unknown', evidence: UNKNOWN_EVIDENCE });
});

test('old cached verdicts: OK/UNKNOWN from v3 are used with no AI call; v3 INAPPROPRIATE is asked again once', async () => {
  const kv = fakeKv();
  let calls = 0;
  const env = { CLASS_KV: kv, AI: { run: async () => (calls++, { response: '{"verdict":"INAPPROPRIATE","category":"alcohol","evidence":"About getting drunk"}' }) } };
  kv.map.set('verdict:v3:42', JSON.stringify({ verdict: 'ok', reason: 'fine' }));
  const ok = await aiThemeCheck(song(), env);
  assert.deepEqual([ok.verdict, ok.legacy, calls], ['ok', true, 0]);
  kv.map.set('verdict:v3:42', JSON.stringify({ verdict: 'inappropriate', reason: 'party song' }));
  const again = await aiThemeCheck(song(), env);
  assert.deepEqual([again.verdict, again.category, again.evidence, calls], ['inappropriate', 'alcohol', 'About getting drunk', 1]);
  assert.deepEqual(JSON.parse(kv.map.get('verdict:v5:42')), { verdict: 'inappropriate', category: 'alcohol', evidence: 'About getting drunk', instrumental: 'unknown' });
  const cached = await aiThemeCheck(song(), env);
  assert.deepEqual([cached.category, cached.cached, calls], ['alcohol', true, 1]);
  // A v3 "no" still blocks when the AI is down (fail closed), as category other.
  const kv2 = fakeKv();
  kv2.map.set('verdict:v3:42', JSON.stringify({ verdict: 'inappropriate', reason: 'party song' }));
  const down = await quiet(() => aiThemeCheck(song(), { CLASS_KV: kv2, AI: { run: async () => { throw new Error('down'); } } }));
  assert.deepEqual([down.verdict, down.category, down.reason, down.failed], ['inappropriate', 'other', 'party song', true]);
  // A v4 entry without a category (a test seed) reads as other.
  const kv3 = fakeKv();
  kv3.map.set('verdict:v4:42', JSON.stringify({ verdict: 'inappropriate', reason: 'seeded' }));
  const seeded = await aiThemeCheck(song(), { CLASS_KV: kv3, AI: { run: async () => assert.fail('no AI call') } });
  assert.deepEqual([seeded.category, seeded.evidence, seeded.reason], ['other', '', 'seeded']);
  assert.equal(readVerdict({ verdict: 'maybe' }), null);
  assert.equal(readVerdict(null), null);
});

test('filterSong gives the blocked word to the room (teacher only)', async () => {
  const r = await filterSong(song({ title: 'Beer Song' }), { settings: { ...DEFAULT_SETTINGS, blocklist: ['beer'] }, env: {} });
  assert.deepEqual([r.reason, r.word], ['blocklist', 'beer']);
});

test('teacher reason + note: default, picked, unknown id, note screened, trimmed and capped', () => {
  assert.deepEqual(teacherWhy({}, 'teacher'), { why: { id: 'teacher' }, detail: "Teacher's choice", refused: false });
  assert.deepEqual(teacherWhy({}, 'banned').why, { id: 'banned' });
  assert.deepEqual(teacherWhy({ reason: 'alcohol', note: '  Too much   about parties ' }).why, { id: 'alcohol', evidence: 'Too much about parties' });
  assert.equal(teacherWhy({ reason: 'alcohol', note: 'Too much about parties' }).detail, 'Alcohol or partying: Too much about parties');
  assert.deepEqual(teacherWhy({ reason: 'blocked_word' }).why, { id: 'teacher' }, 'system reasons are not the teacher\'s to pick');
  assert.deepEqual(teacherWhy({ reason: { evil: 1 }, note: 5 }).why, { id: 'teacher' });
  const typo = teacherWhy({ reason: 'other', note: 'this is sh1t' });
  assert.deepEqual([typo.why, typo.refused], [{ id: 'other' }, true], 'a nasty note is dropped, the action still happens');
  assert.equal(screenNote('a'.repeat(200)).note.length, NOTE_MAX);
  assert.equal(screenNote('line\nbreak\u0007here').note, 'line break here');
  assert.deepEqual(screenNote('<script>alert(1)</script>'), { note: '<script>alert(1)</script>', refused: false }, 'kept as text; the pages escape it');
  assert.deepEqual(screenNote('   '), { note: '', refused: false });
});

test('Blocked today: capped log, newest first, which actions fit', () => {
  const log = [];
  for (let i = 0; i < BLOCKED_MAX + 5; i++) {
    logBlocked(log, { song: song({ id: `it:${i}` }), device: 'd', by: 'Ava', why: { id: 'drugs' }, detail: 'x', source: 'filter', action: 'suggest', now: i });
  }
  assert.equal(log.length, BLOCKED_MAX);
  assert.equal(log[0].song.id, 'it:5');
  assert.equal(log.at(-1).id, `b${BLOCKED_MAX + 5}`);
  const view = blockedView(log);
  assert.equal(view[0].song.id, `it:${BLOCKED_MAX + 4}`, 'newest first');
  assert.deepEqual(Object.keys(view[0].song).sort(), ['artist', 'artwork', 'id', 'title']);
  assert.equal(view[0].device, undefined, 'no device ids to the page');
  const e = (why, source = 'filter', status = null) => ({ why: { id: why }, source, status });
  assert.equal(canAllow(e('drugs')), true);
  assert.equal(canAllow(e('blocked_word')), true);
  assert.equal(canAllow(e('explicit')), false);
  assert.equal(canAllow(e('banned')), false);
  assert.equal(canAllow(e('teacher', 'teacher')), false);
  assert.equal(canAllow(e('drugs', 'filter', 'allowed')), false);
  assert.equal(canBan(e('teacher', 'teacher')), true);
  assert.equal(canBan(e('drugs')), true);
  assert.equal(canBan(e('explicit')), false);
  assert.equal(canBan(e('banned')), false);
  assert.equal(canBan(e('drugs', 'filter', 'banned')), false);
});

test('Allow anyway: into the queue for that student, nothing paid; refused for a gone student or a duplicate', () => {
  const s = newRoomState('r', { ...DEFAULT_SETTINGS, startingCredits: 3 });
  s.students.dev1 = { nick: 'Ava', joinedAt: 1 };
  const done = allowBlocked(s, { song: song(), device: 'dev1', by: 'Ava' });
  assert.equal(done.ok, true);
  assert.equal(s.queue[0].by, 'Ava');
  assert.equal(s.queue[0].paid, undefined);
  assert.equal(s.credits.dev1, undefined, 'no charge');
  assert.deepEqual(allowBlocked(s, { song: song(), device: 'dev1', by: 'Ava' }), { ok: false, reason: 'duplicate' });
  assert.deepEqual(allowBlocked(s, { song: song({ id: 'it:7' }), device: 'gone', by: 'Ben' }), { ok: false, reason: 'gone' });
});

test('a new blocked word: queued and review songs that match are reported with the word', () => {
  const s = newRoomState('r', { ...DEFAULT_SETTINGS, maxWaitingPerStudent: 5 });
  addSuggestion(s, { device: 'd1', nick: 'Ava', song: song() });
  addSuggestion(s, { device: 'd1', nick: 'Ava', song: song({ id: 'it:2', title: 'Other' }) });
  addToReview(s, { device: 'd1', nick: 'Ava', song: song({ id: 'it:3', title: 'Happy Again' }) });
  s.settings.blocklist = ['happy'];
  const out = {};
  const review = applyBlocklist(s, out);
  assert.deepEqual(review.map((i) => i.song.id), ['it:3']);
  assert.deepEqual(out.queue.map((i) => i.song.id), ['it:42']);
  assert.deepEqual([...out.words.values()], ['happy', 'happy']);
  assert.deepEqual(s.queue.map((i) => i.song.id), ['it:2']);
});
