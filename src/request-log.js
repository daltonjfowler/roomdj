// The request log's Durable Object (REQUEST_LOG, one object 'all', SQLite): one row per student
// request, appended when a room closes (shared/requests.js says what a row is and what is never in it).

import { DurableObject } from 'cloudflare:workers';
import { ADD_MAX, PAGE_MAX } from '../shared/requests.js';

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

export class RequestLog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS asks (
      hour TEXT NOT NULL, song TEXT, title TEXT, artist TEXT, album TEXT, genre TEXT, year INTEGER, seconds INTEGER,
      clean INTEGER, outcome TEXT, reason TEXT, why TEXT, fate TEXT, up INTEGER, down INTEGER)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS asks_hour ON asks(hour)');
  }

  /** Append a closed room's rows (finishAsks). → how many were kept */
  async add(rows) {
    let n = 0;
    for (const r of (Array.isArray(rows) ? rows : []).slice(0, ADD_MAX)) {
      if (!/^\d{4}-\d\d-\d\dT\d\d$/.test(r?.hour) || !str(r.title)) continue;
      this.sql.exec('INSERT INTO asks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        r.hour, str(r.song, 80), str(r.title), str(r.artist), str(r.album), str(r.genre, 40), int(r.year), int(r.seconds),
        r.clean ? 1 : 0, str(r.outcome, 20), str(r.reason, 40), str(r.why, 40), str(r.fate, 20), int(r.up), int(r.down));
      n++;
    }
    return n;
  }

  /** Rows after `after` (a rowid), oldest first. → { rows, last } (last: the rowid to ask after next) */
  async page(after = 0, limit = PAGE_MAX) {
    const rows = this.sql.exec('SELECT rowid AS rid, * FROM asks WHERE rowid > ? ORDER BY rowid LIMIT ?', int(after), Math.min(int(limit) || PAGE_MAX, PAGE_MAX)).toArray();
    return { rows, last: rows.length ? rows[rows.length - 1].rid : null };
  }

  /** → { total, first, last } (hours, UTC) */
  async summary() {
    const r = this.sql.exec('SELECT COUNT(*) AS total, MIN(hour) AS first, MAX(hour) AS last FROM asks').one();
    return { total: r.total, first: r.first ?? null, last: r.last ?? null };
  }
}
