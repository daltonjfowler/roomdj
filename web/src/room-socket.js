// The room WebSocket for both pages: JSON messages, a keep-alive ping every 25 s, and reconnect
// with backoff (Chromebooks sleep, school Wi-Fi drops). Message shapes: shared/protocol.js.
// Watchdog: a socket can die without a close event (Wi-Fi switch, sleeping proxy). If two pings in
// a row get no answer (no pong and no other message), drop it and reconnect.

const PING_MS = 25_000;
const MISSED_MAX = 2;
const MAX_DELAY_MS = 15_000;
// Close codes the server uses when it is done with this page: room closed, kicked, refused.
const FINAL = new Set([4000, 4001, 4002]);

/** ws(s)://<this host>/api/rooms/<room id>/ws?<params> */
export function roomSocketUrl(id, params) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/rooms/${encodeURIComponent(id)}/ws?${new URLSearchParams(params)}`;
}

/**
 * Open the socket and keep it open until stop().
 *   onMessage(msg)        every message except pong
 *   onStatus(status, n)   'open'; 'retrying' with the number of failed tries in a row; or 'ended'
 *                         with the close code (4000 closed, 4001 kicked, 4002 refused: no retry)
 */
export function connectRoom(url, { onMessage, onStatus = () => {} }) {
  let ws = null, retry = null, ping = null, fails = 0, stopped = false, missed = 0;

  function open() {
    clearTimeout(retry);
    retry = null;
    const sock = (ws = new WebSocket(url));
    sock.addEventListener('open', () => {
      if (sock !== ws) return;
      fails = 0;
      missed = 0;
      onStatus('open', 0);
      clearInterval(ping);
      ping = setInterval(tick, PING_MS);
    });
    sock.addEventListener('message', (e) => {
      if (sock !== ws) return;
      missed = 0; // any message shows the socket is alive
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && msg.t !== 'pong') onMessage(msg);
    });
    sock.addEventListener('close', (e) => {
      if (sock !== ws) return; // the watchdog already gave up on this one
      lost(e.code);
    });
  }

  function lost(code) {
    clearInterval(ping);
    if (stopped) return;
    if (FINAL.has(code)) {
      stop();
      return onStatus('ended', code);
    }
    fails++;
    onStatus('retrying', fails);
    if (stopped) return; // onStatus may have stopped us
    const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** (fails - 1)) * (0.75 + Math.random() * 0.5);
    retry = setTimeout(open, delay);
  }

  // Counted in pings, not seconds: a hidden tab's timers can run late, and that is not a dead socket.
  function tick() {
    if (missed >= MISSED_MAX) {
      const dead = ws;
      ws = null; // its close event (which may come much later) is ignored
      try { dead?.close(1000); } catch { /* already closed */ }
      return lost(1006);
    }
    if (send({ t: 'ping' })) missed++;
  }

  // Back from sleep or offline: try now instead of waiting out the backoff.
  const now = () => { if (!stopped && retry) open(); };
  const onVisible = () => { if (document.visibilityState === 'visible') now(); };
  addEventListener('online', now);
  document.addEventListener('visibilitychange', onVisible);

  function send(msg) {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function stop() {
    stopped = true;
    clearTimeout(retry);
    clearInterval(ping);
    removeEventListener('online', now);
    document.removeEventListener('visibilitychange', onVisible);
    try { ws?.close(1000); } catch { /* already closed */ }
  }

  open();
  return { send, stop, get isOpen() { return ws?.readyState === WebSocket.OPEN; } };
}

/** GET /api/rooms/:room → true (open), false (no such room), null (could not tell). */
export async function roomExists(id) {
  try {
    const r = await fetch(`/api/rooms/${encodeURIComponent(id)}`);
    if (r.status === 404) return false;
    return r.ok ? true : null;
  } catch {
    return null;
  }
}
