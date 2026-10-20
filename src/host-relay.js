// "The teacher's computer searches." From Cloudflare's shared addresses iTunes answers 429 to most
// calls, so a room hands each iTunes call (search, lookup, clean-version search) to its host page
// over the host socket: { t: 'lookup', id, url } → the teacher's browser fetches it from the
// school's own address → { t: 'lookupResult', id, status, results }. The room keeps only the raw
// fields toSong reads and maps and checks them itself (shared/itunes.js), so a student never
// supplies song details (invariant 2), and only the host socket (host token) can answer.
// Identical calls in flight are shared, at most `perMinute` a minute and `inFlightMax` at once go
// to the host, and with no host (or no answer within `timeoutMs`) the room tries its own fetch
// once, then says the teacher's computer is not answering. No I/O of its own: src/room.js wires it.

import { ITUNES_RESULTS_MAX, ITUNES_URL, trimResult } from '../shared/itunes.js';
import { CatalogError } from './catalog-base.js';

export const RELAY_TIMEOUT_MS = 6000;
export const RELAY_PER_MINUTE = 20;
export const RELAY_IN_FLIGHT_MAX = 8;
const OWN_FETCH_TIMEOUT_MS = 4000;
export const NO_HOST = 'Your teacher\'s computer is not answering searches right now. Try again in a moment.';
export const RELAY_BUSY = 'The song search is busy right now. Try again in a moment.';

export class HostRelay {
  /**
   * @param {{ host: () => object|null, send: (host: object, msg: object) => void,
   *   fetchImpl?: typeof fetch, timeoutMs?: number, perMinute?: number, inFlightMax?: number,
   *   now?: () => number, newId?: () => string, ownFetch?: boolean }} o
   *   ownFetch false: with no host, do not try the server's own fetch (tests: ITUNES_SERVER_FETCH=off)
   */
  constructor({ host, send, fetchImpl = (...a) => fetch(...a), timeoutMs = RELAY_TIMEOUT_MS, perMinute = RELAY_PER_MINUTE,
    inFlightMax = RELAY_IN_FLIGHT_MAX, now = Date.now, newId = () => crypto.randomUUID(), ownFetch = true }) {
    Object.assign(this, { host, send, fetchImpl, timeoutMs, perMinute, inFlightMax, now, newId, ownFetch });
    /** job id → { resolve, timer } */
    this.jobs = new Map();
    /** url → shared Promise<{ status, body }> */
    this.inFlight = new Map();
    this.asked = [];
    /** The fetch() the catalogs get. */
    this.fetch = (url, init) => this.get(url, init);
  }

  async get(url, init) {
    if (!ITUNES_URL.test(String(url))) return this.fetchImpl(url, init);
    url = String(url);
    let shared = this.inFlight.get(url);
    if (!shared) {
      shared = this.ask(url);
      this.inFlight.set(url, shared);
      shared.finally(() => { if (this.inFlight.get(url) === shared) this.inFlight.delete(url); }).catch(() => {});
    }
    const { status, body } = await shared;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }

  underLimit() {
    const t = this.now();
    this.asked = this.asked.filter((x) => t - x < 60_000);
    if (this.asked.length >= this.perMinute) return false;
    this.asked.push(t);
    return true;
  }

  async ask(url) {
    const host = this.host();
    if (!host) return this.own(url);
    if (this.jobs.size >= this.inFlightMax || !this.underLimit()) throw new CatalogError('busy', RELAY_BUSY);
    const id = this.newId();
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id);
        resolve(null);
      }, this.timeoutMs);
      this.jobs.set(id, { resolve, timer });
    });
    this.send(host, { t: 'lookup', id, url });
    const got = await answer;
    // No answer in time, or the teacher's computer could not reach iTunes itself.
    if (!got || got.unreachable) {
      console.error(JSON.stringify({ message: 'host lookup timed out' }));
      throw new CatalogError('nohost', NO_HOST);
    }
    return got;
  }

  /** No host page open: the Worker's own fetch, once (usually refused from Cloudflare's addresses). */
  async own(url) {
    if (!this.ownFetch) throw new CatalogError('nohost', NO_HOST);
    try {
      const res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(OWN_FETCH_TIMEOUT_MS) });
      if (res.ok) return { status: 200, body: await res.text() };
      console.error(JSON.stringify({ message: 'no host; own iTunes fetch refused', status: res.status }));
    } catch (e) {
      console.error(JSON.stringify({ message: 'no host; own iTunes fetch failed', error: String(e) }));
    }
    throw new CatalogError('nohost', NO_HOST);
  }

  /** The host page's { t: 'lookupResult' }. Unknown or late ids are ignored. */
  answer(msg) {
    const id = String(msg?.id ?? '');
    const job = this.jobs.get(id);
    if (!job) return false;
    this.jobs.delete(id);
    clearTimeout(job.timer);
    const status = Number.isInteger(msg.status) && msg.status >= 0 && msg.status <= 599 ? msg.status : 0;
    if (status === 0 || status === 504) {
      job.resolve({ unreachable: true });
      return true;
    }
    if (status !== 200) {
      job.resolve({ status: status === 429 || status === 403 ? 429 : 502, body: '' });
      return true;
    }
    const results = Array.isArray(msg.results) ? msg.results.slice(0, ITUNES_RESULTS_MAX).map(trimResult).filter(Boolean) : null;
    job.resolve(results ? { status: 200, body: JSON.stringify({ results }) } : { status: 502, body: '' });
    return true;
  }
}
