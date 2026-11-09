import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { probeOneBotReady, waitForOneBot } from './wait-onebot-ready.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function socketFixture(failures, { failWithClose = false } = {}) {
  const sockets = [];
  class Socket extends EventTarget {
    readyState = 0;
    constructor() {
      super(); sockets.push(this);
      queueMicrotask(() => {
        if (sockets.length <= failures) {
          this.readyState = 3;
          this.dispatchEvent(new Event('error'));
          if (failWithClose) this.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }));
        } else {
          this.readyState = 1; this.dispatchEvent(new Event('open'));
        }
      });
    }
    close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
  }
  return { Socket, sockets };
}

for (const failures of [1, 3]) test(`SDK retries ${failures} initial error-only handshakes instead of hanging forever`, async () => {
  const fixture = socketFixture(failures);
  const bot = new SnowLumaWebSocketClient({ webSocket: fixture.Socket, reconnect: { minDelayMs: 5, maxDelayMs: 10, retries: 5 } });
  let firstSettled = false;
  try {
    bot.connect().then(() => { firstSettled = true; }, () => { firstSettled = true; });
    for (let attempt = 0; attempt < 40 && !bot.isConnected; attempt++) await pause(5);
    assert.equal(firstSettled, true, 'initial connect promise must settle on error without close');
    assert.equal(bot.isConnected, true, 'a later successful handshake must reconnect automatically');
    assert.equal(fixture.sockets.length, failures + 1);
  } finally { bot.close(); }
});

test('an error followed by close creates one retry and explicit shutdown prevents reconnect', async () => {
  const fixture = socketFixture(1, { failWithClose: true });
  const bot = new SnowLumaWebSocketClient({ webSocket: fixture.Socket, reconnect: { minDelayMs: 5, maxDelayMs: 10 } });
  try {
    bot.connect().catch(() => {});
    for (let attempt = 0; attempt < 40 && !bot.isConnected; attempt++) await pause(5);
    assert.equal(bot.isConnected, true); assert.equal(fixture.sockets.length, 2);
    bot.close(); await pause(30); assert.equal(fixture.sockets.length, 2);
  } finally { bot.close(); }
});

test('closing from the error callback cancels automatic retries', async () => {
  const fixture = socketFixture(10);
  const bot = new SnowLumaWebSocketClient({ webSocket: fixture.Socket, reconnect: { minDelayMs: 5 } });
  bot.on('error', () => bot.close());
  bot.connect().catch(() => {}); await pause(30);
  assert.equal(fixture.sockets.length, 1); assert.equal(bot.isConnected, false);
});

test('startup requires authenticated WebSocket status rather than an open TCP port or login identity', async () => {
  const cfg = { snowluma: { wsUrl: 'ws://127.0.0.1:1234' } };
  const discover = async () => ({ ok: true, token: 'http-fixture', wsToken: 'ws-fixture' });
  let online = false, good = true, acceptedToken = false;
  class StatusSocket extends EventTarget {
    constructor(url) {
      super(); acceptedToken = new URL(url).searchParams.get('access_token') === 'ws-fixture';
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(data) {
      const request = JSON.parse(data); assert.equal(request.action, 'get_status');
      queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { online, good } }) })));
    }
    close() {}
  }
  const options = { discover, WebSocketCtor: StatusSocket, timeoutMs: 30 };
  assert.equal(await probeOneBotReady(cfg, options), false); assert.equal(acceptedToken, true);
  online = true; good = false; assert.equal(await probeOneBotReady(cfg, options), false);
  good = true; assert.equal(await probeOneBotReady(cfg, options), true);
});

test('startup rejects error-only handshakes and honors explicitly pinned endpoints', async () => {
  const cfg = { snowluma: { wsUrl: 'ws://127.0.0.1:1234', followDiscoveredEndpoint: false } };
  const discover = async () => ({ ok: true, token: 'fixture', wsUrl: 'ws://127.0.0.1:5678' });
  class RefusingSocket extends EventTarget {
    constructor(url) { super(); assert.equal(new URL(url).port, '1234'); queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    close() {}
  }
  assert.equal(await probeOneBotReady(cfg, { discover, WebSocketCtor: RefusingSocket, timeoutMs: 30 }), false);
});

test('startup has a total deadline even when connection discovery hangs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ snowluma: { wsUrl: 'ws://127.0.0.1:1234' } }));
  const started = Date.now();
  assert.equal(await waitForOneBot({ root, waitMs: 30, retryMs: 1, discover: () => new Promise(() => {}) }), false);
  assert.ok(Date.now() - started < 500);
});
