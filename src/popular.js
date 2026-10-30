// 🔥 Popular on RoomDJ (Dalton, 2026-10-29: "most popular requests amongst ALL teachers using the app",
// "when you click search it shows", "base on student favorites"; protocol.js SONGBOOK, CLAUDE.md
// invariant 40). Two steps:
//   1. When a room closes (Room.closeRoom), its STUDENTS' requests that played to the end (teacher
//      picks left out) go into that teacher's KV `asks` (teacherKvKey; noteAsks): per song, how often
//      students asked for it and the 👍 it got. Songs only, at most ASKS_MAX, older ones fade.
//   2. Once a day the cron merges every teacher's `asks` into KV POPULAR_KEY (refreshPopular). A song
//      is listed only when the students of at least POPULAR_MIN_TEACHERS teachers asked for it, so the
//      list never shows what one class plays. Never a student, nickname, room or teacher.
// A room shows it like a songbook shelf (Room.songbook 'popular'): its own quickCheck, then ✓ Checked only.

import { FAVORITE_HALF_LIFE_DAYS, POPULAR_MAX, POPULAR_MIN_TEACHERS } from '../shared/protocol.js';
import { banKey } from '../shared/filter.js';
import { favoriteSong } from '../shared/highlights.js';

export const POPULAR_KEY = 'popular:v1';
export const ASKS_KV = 'asks';
export const ASKS_MAX = 300;
/** One student request counts as much as this many 👍. */
const ASK_WEIGHT = 3;
const POPULAR_EVERY_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/** A teacher's `asks` value as a clean list: { song, asks, up, lastAt }, one per song (banKey). */
export function readAsks(raw) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(raw?.list) ? raw.list : []) {
    const song = favoriteSong(e?.song);
    const key = song && banKey(song);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ song, asks: num(e.asks), up: num(e.up), lastAt: num(e.lastAt) });
  }
  return out;
}

/** (ASK_WEIGHT x requests + 👍), halved every FAVORITE_HALF_LIFE_DAYS since it was last asked for. */
export function askScore(e, now = Date.now()) {
  const days = Math.max(0, now - (e.lastAt || now)) / DAY_MS;
  return (ASK_WEIGHT * e.asks + e.up) * 0.5 ** (days / FAVORITE_HALF_LIFE_DAYS);
}

/**
 * A closing room's history into the teacher's asks list (in place; returns it): every student request
 * that played to the end. Teacher picks do not count. At most ASKS_MAX: the lowest scores drop off.
 */
export function noteAsks(list, history = [], now = Date.now()) {
  for (const h of history) {
    if (h?.teacher === true || h?.status !== 'finished') continue;
    const song = favoriteSong(h.song);
    const key = song && banKey(song);
    if (!key) continue;
    let e = list.find((x) => banKey(x.song) === key);
    if (!e) list.push((e = { song, asks: 0, up: 0, lastAt: now }));
    e.song = song;
    e.asks += 1;
    e.up += num(h.up);
    e.lastAt = now;
  }
  list.sort((a, b) => askScore(b, now) - askScore(a, now));
  if (list.length > ASKS_MAX) list.length = ASKS_MAX;
  return list;
}

/** Every teacher's asks key: the legacy plain one and each profile's. */
async function asksKeys(env) {
  const names = [ASKS_KV];
  let cursor;
  do {
    const page = await env.CLASS_KV.list({ prefix: 'p:', limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const k of page.keys ?? []) if (/^p:[^:]+:asks$/.test(k.name)) names.push(k.name);
    cursor = page.list_complete === false ? page.cursor : undefined;
  } while (cursor);
  return names;
}

/**
 * Teachers' asks lists (one per teacher) merged: one entry per song, listed by how many teachers'
 * students asked for it, then the summed score. Pure (tests).
 */
export function mergePopular(lists, now = Date.now()) {
  const songs = new Map(); // banKey → { song, teachers, score }
  for (const raw of lists) {
    for (const e of readAsks(raw)) {
      const score = askScore(e, now);
      if (!e.asks || score <= 0) continue;
      const key = banKey(e.song);
      const hit = songs.get(key) ?? { song: e.song, teachers: 0, score: 0 };
      hit.teachers++;
      hit.score += score;
      songs.set(key, hit);
    }
  }
  return [...songs.values()]
    .filter((x) => x.teachers >= POPULAR_MIN_TEACHERS)
    .sort((a, b) => b.teachers - a.teachers || b.score - a.score)
    .slice(0, POPULAR_MAX)
    .map((x) => x.song);
}

/** Once a day (from the cron): read every asks list and write POPULAR_KEY. → songs listed, or null (not due). */
export async function refreshPopular(env, { now = Date.now() } = {}) {
  if (!env.CLASS_KV) return null;
  const kept = await env.CLASS_KV.get(POPULAR_KEY, 'json');
  if (kept && now - Number(kept.at) < POPULAR_EVERY_MS) return null;
  const lists = [];
  for (const name of await asksKeys(env)) lists.push(await env.CLASS_KV.get(name, 'json'));
  const list = mergePopular(lists, now);
  await env.CLASS_KV.put(POPULAR_KEY, JSON.stringify({ at: now, list }));
  console.log(JSON.stringify({ message: 'popular', teachers: lists.filter(Boolean).length, songs: list.length }));
  return list.length;
}

/** The listed songs (empty when none yet). Never throws. */
export async function readPopular(env) {
  try {
    const v = await env.CLASS_KV?.get(POPULAR_KEY, 'json');
    return Array.isArray(v?.list) ? v.list.map(favoriteSong).filter(Boolean) : [];
  } catch (e) {
    console.error(JSON.stringify({ message: 'popular read failed', error: String(e) }));
    return [];
  }
}
