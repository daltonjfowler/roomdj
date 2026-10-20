// web/src/room-socket.js in Node with a fake WebSocket and fake timers: the dead-socket watchdog,
// and no reconnect after the server's final close codes.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

class FakeSocket {
  static all = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.l = {};
    FakeSocket.all.push(this);
  }
  addEventListener(e, f) { (this.l[e] ??= []).push(f); }
  emit(e, data = {}) { for (const f of this.l[e] ?? []) f(data); }
  send(text) { this.sent.push(text); }
  close() { this.closed = true; }
  // test helpers
  opened() { this.readyState = 1; this.emit('open'); }
  message(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
  serverClose(code) { this.readyState = 3; this.emit('close', { code }); }
}

globalThis.WebSocket = FakeSocket;
globalThis.location = { protocol: 'http:', host: 'test' };
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const { connectRoom } = await import('../web/src/room-socket.js');

function setup() {
  FakeSocket.all = [];
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const statuses = [], msgs = [];
  const conn = connectRoom('ws://test/x', { onMessage: (m) => msgs.push(m), onStatus: (s, n) => statuses.push([s, n]) });
  return { conn, statuses, msgs };
}

test('pongs keep the socket; two unanswered pings drop it and reconnect', () => {
  const { conn, statuses } = setup();
  try {
    const a = FakeSocket.all[0];
    a.opened();
    for (let i = 0; i < 5; i++) {
      mock.timers.tick(25_000);
      a.message({ t: 'pong' });
    }
    assert.equal(FakeSocket.all.length, 1, 'answered pings: still one socket');
    assert.equal(a.sent.filter((t) => t === '{"t":"ping"}').length, 5);

    mock.timers.tick(25_000); // ping, no answer
    mock.timers.tick(25_000); // ping, no answer
    assert.ok(!a.closed, 'one missed answer is not enough');
    mock.timers.tick(25_000); // second ping still unanswered: dead
    assert.ok(a.closed, 'dead socket closed');
    assert.deepEqual(statuses.at(-1), ['retrying', 1]);
    mock.timers.tick(2_000); // backoff (at most 1.25 s on the first try)
    assert.equal(FakeSocket.all.length, 2, 'reconnected');

    a.serverClose(1006); // the old socket's late close event changes nothing
    assert.deepEqual(statuses.at(-1), ['retrying', 1]);
    FakeSocket.all[1].opened();
    assert.deepEqual(statuses.at(-1), ['open', 0]);
  } finally {
    conn.stop();
    mock.timers.reset();
  }
});

test('any message counts as alive', () => {
  const { conn } = setup();
  try {
    const a = FakeSocket.all[0];
    a.opened();
    for (let i = 0; i < 6; i++) {
      mock.timers.tick(25_000);
      a.message({ t: 'state', state: {} });
    }
    assert.ok(!a.closed);
    assert.equal(FakeSocket.all.length, 1);
  } finally {
    conn.stop();
    mock.timers.reset();
  }
});

for (const code of [4000, 4001, 4002]) {
  test(`close code ${code}: ended, never reconnects`, () => {
    const { conn, statuses } = setup();
    try {
      FakeSocket.all[0].opened();
      FakeSocket.all[0].serverClose(code);
      assert.deepEqual(statuses.at(-1), ['ended', code]);
      mock.timers.tick(200_000);
      assert.equal(FakeSocket.all.length, 1);
    } finally {
      conn.stop();
      mock.timers.reset();
    }
  });
}

test('an ordinary drop reconnects with backoff', () => {
  const { conn, statuses } = setup();
  try {
    FakeSocket.all[0].opened();
    FakeSocket.all[0].serverClose(1006);
    assert.deepEqual(statuses.at(-1), ['retrying', 1]);
    mock.timers.tick(2_000);
    assert.equal(FakeSocket.all.length, 2);
  } finally {
    conn.stop();
    mock.timers.reset();
  }
});
