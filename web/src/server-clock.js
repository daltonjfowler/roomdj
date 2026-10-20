// The server's clock for this page (protocol.js SERVER CLOCK; shared/servertime.js): every State's
// serverNow is one sample, taken when the message ARRIVES (not when it is drawn). Countdowns and
// "in 12 min" use serverClock.now(), so a Chromebook with a wrong clock still counts down right.
import { createServerClock } from '../../shared/servertime.js';

export const serverClock = createServerClock();

/** Call with each State as it arrives. */
export function noteServerTime(state) {
  if (Number.isFinite(state?.serverNow)) serverClock.sample(state.serverNow);
}
