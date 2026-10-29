// ⏳ My songs being checked (protocol.js MY CHECKS; Dalton, 2026-10-28: "If a kid queues a song and it
// needs to be checked can we show that for the kid? and show how long they're waiting"). The room
// builds each student's list (checksOf, through shared/queue.js checksFor); the student page words it
// (checkText). Small and import-free so the student page can use it.

/**
 * The student's own songs in Needs a look (protocol.js MY CHECKS), oldest first: when each was
 * suggested, its place in the teacher's line (`place` of `of`, oldest first) and, while the room is
 * still trying its lyrics by itself, when it tries next (`recheckAt`). Only counts of other
 * students' songs, never the songs.
 */
export function checksOf(review, device) {
  return review.flatMap((item, i) => (item.device !== device ? [] : [{
    id: item.id, song: item.song.id, title: item.song.title, since: item.addedAt, place: i + 1, of: review.length,
    ...(item.recheckAt ? { recheckAt: item.recheckAt } : {}),
  }]));
}

/** How long until `ms` from now, in words a student reads ("40 seconds", "4 minutes"). */
function waitWords(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} ${s === 1 ? 'second' : 'seconds'}`;
  const m = Math.round(s / 60);
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/**
 * One of checksOf's entries as the sentence the student sees (`now`: the server's clock). While
 * the room is still trying by itself (a recheckAt not long past), it says so; else it is the
 * teacher's turn, with the song's place in their line.
 */
export function checkText(check, now) {
  const auto = Number.isFinite(check.recheckAt) && check.recheckAt > now - 30_000;
  const what = !auto ? `Waiting for your teacher to check it (${check.place === 1 ? 'next in line' : `number ${check.place} in line`}).`
    : check.recheckAt > now ? `RoomDJ is double-checking the words. Next try in ${waitWords(check.recheckAt - now)}.`
      : 'RoomDJ is double-checking the words now.';
  const waited = Math.floor((now - check.since) / 60_000);
  return `${what} ${waited < 1 ? 'Suggested just now.' : `Waiting ${waited} ${waited === 1 ? 'minute' : 'minutes'} so far.`}`;
}

