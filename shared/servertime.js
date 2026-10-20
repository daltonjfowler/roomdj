// The server's clock on a page (protocol.js BELL OFFSET, SERVER CLOCK). Every State carries
// serverNow; a page keeps the difference to its own clock, so a countdown is right even when the
// Chromebook's clock is minutes off. Pure JS, no DOM: the pages and the Node tests use it.
//
// One sample = serverNow - the page's Date.now() when the State arrived (it is low by the time the
// message took to arrive: tens of ms). The estimate is the median of the last CLOCK_SAMPLES samples,
// then the mean of the samples within CLOCK_OUTLIER_MS of that median (a message that sat in a slow
// network or a sleeping tab is ignored).

export const CLOCK_SAMPLES = 9;
export const CLOCK_OUTLIER_MS = 1000;

/** The clock offset (ms to add to the page's clock) from samples, or 0 with none. */
export function estimateOffset(samples) {
  const xs = (samples ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = xs.length >> 1;
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  const near = xs.filter((x) => Math.abs(x - median) <= CLOCK_OUTLIER_MS);
  return Math.round(near.reduce((a, b) => a + b, 0) / near.length);
}

/**
 * A server clock: sample(serverNow) on every State, now() for the server's time.
 * @param {() => number} [localNow] the page's own clock (tests pass a fake one)
 */
export function createServerClock(localNow = () => Date.now()) {
  let samples = [];
  let offset = 0;
  return {
    /** One State arrived (serverNow ms). Returns the new offset. */
    sample(serverNow, at = localNow()) {
      if (!Number.isFinite(serverNow) || !Number.isFinite(at)) return offset;
      samples = [...samples, serverNow - at].slice(-CLOCK_SAMPLES);
      offset = estimateOffset(samples);
      return offset;
    },
    get offset() { return offset; },
    get samples() { return samples.length; },
    /** The server's time now (the page's clock until the first sample). */
    now() { return localNow() + offset; },
    reset() { samples = []; offset = 0; },
  };
}
