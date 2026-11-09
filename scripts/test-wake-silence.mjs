import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { UsageQuotas } from '../src/core/usage-quotas.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const KEY = 'group:456';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, quotas = false) {
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, allow: { groups: ['456'] },
    quotas: { enabled: quotas, rules: [{ id: 'wake', resource: 'model.wake', scope: 'global', limit: 1, windowMinutes: 60 }] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, sticker: { enabled: false } } },
    globals: { UsageQuotas: class extends UsageQuotas { constructor(options) { super({ ...options, waitMs: 500 }); } } } });
  t.after(() => h.close()); await h.ensureSession(KEY);
  const st = h.getSocialV2State(KEY); st.bootstrapSent = true;
  return { h, st };
}

test('passive observations are batched after recent model activity while raw messages remain stored', async t => {
  const { h, st } = await fixture(t);
  st.wakeConfig.lastWakeAt = Date.now();
  const before = Date.now(); h.scheduleWakeV2(KEY, 'observation');
  assert.ok(st.pendingWakeAt >= before + 59000, 'ordinary observation should wait for the 60-second interval');
  h.appendSocialV2Message(KEY, '成员', '新的合成消息', '新的合成消息', false, false, 1, [], '234');
  assert.equal(h.workingMemory.get(KEY).messages.length, 1);
  assert.equal(h.usageQuotas.list().length, 0, 'merging messages must not consume model quota');
});

test('a direct mention preempts the passive batching timer', async t => {
  const { h, st } = await fixture(t);
  st.wakeConfig.lastWakeAt = Date.now(); h.scheduleWakeV2(KEY, 'observation');
  const passiveAt = st.pendingWakeAt;
  h.scheduleWakeV2(KEY, 'atMention');
  assert.equal(st.pendingWakeReason, 'atMention');
  assert.ok(st.pendingWakeAt < passiveAt, 'direct address must shorten an existing observation timer');
  assert.ok(st.pendingWakeAt < Date.now() + 10000);
});

test('quota waiting is finite, visible as quotaWait and clears without a process restart', async t => {
  const { h, st } = await fixture(t, true);
  h.usageQuotas.consume(KEY, 'model.wake');
  const pending = h.sendWakePromptV2(KEY, 'observation');
  try {
    await pause(5); assert.equal(st.wakeQuotaWaiting, true);
    h.scheduleWakeV2(KEY, 'observation');
    const log = fs.readFileSync(path.join(h.temp, 'state/bridge.log'), 'utf8');
    assert.match(log, /原因=quotaWait/);
    assert.ok(st.wakeQuotaWait.deadline > st.wakeQuotaWait.startedAt);
    assert.ok(st.wakeQuotaWait.resetsAt > st.wakeQuotaWait.deadline);
  } finally { await pending; }
  assert.equal(st.wakeQuotaWaiting, false); assert.equal(st.wakeQuotaWait, null);
  assert.equal(h.usageQuotas.waiters.size, 0);
});

test('multiple passive arrivals share one deadline and a completed batch spends no model allowance', async t => {
  const callbacks = new Map();
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, allow: { groups: ['456'] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false } } },
    globals: { setTimeout: (fn, ms, ...args) => { const timer = setTimeout(fn, ms, ...args); callbacks.set(timer, fn); return timer; } } });
  t.after(() => h.close()); await h.ensureSession(KEY);
  const st = h.getSocialV2State(KEY); st.wakeConfig.lastWakeAt = Date.now();
  h.appendSocialV2Message(KEY, '成员', '第一条合成消息', '第一条合成消息', false, false, 1, [], '234');
  h.scheduleWakeV2(KEY, 'observation'); const timer = st.pendingWakeTimer, at = st.pendingWakeAt;
  h.appendSocialV2Message(KEY, '成员', '第二条合成消息', '第二条合成消息', false, false, 2, [], '234');
  h.scheduleWakeV2(KEY, 'observation'); assert.equal(st.pendingWakeTimer, timer); assert.equal(st.pendingWakeAt, at);
  const snapshot = h.workingMemory.snapshot(KEY); h.workingMemory.offered(KEY, snapshot);
  h.workingMemory.update(KEY, { revision: snapshot.revision, decision: { action: 'observe', note: '本轮已处理', sources: snapshot.messages.map(message => message.id) } });
  assert.equal(h.workingMemory.snapshot(KEY).pendingCount, 0);
  clearTimeout(timer); callbacks.get(timer)(); await pause(5);
  assert.equal(st.pendingWakeAt, null); assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.usageQuotas.list().length, 0);
});

test('a silent model observation spends one wake allowance and no outgoing message allowance', async t => {
  const { h } = await fixture(t, true); h.setReady(true);
  h.appendSocialV2Message(KEY, '成员', '合成群聊消息', '合成群聊消息', false, false, 1, [], '234');
  await h.sendWakePromptV2(KEY, 'observation');
  assert.equal(h.calls.prompts.length, 1); assert.equal(h.calls.sent.length, 0);
  assert.equal(h.usageQuotas.list().find(bucket => bucket.resource === 'model.wake').used, 1);
  assert.equal(h.usageQuotas.list().some(bucket => bucket.resource === 'send.message'), false);
});

test('administrator wake also preempts a delayed passive batch', async t => {
  const { h, st } = await fixture(t); h.setReady(true);
  st.wakeConfig.lastWakeAt = Date.now(); h.scheduleWakeV2(KEY, 'observation');
  await h.sendWakePromptV2(KEY, 'admin');
  assert.equal(st.pendingWakeTimer, null); assert.equal(st.pendingWakeAt, null); assert.equal(h.calls.prompts.length, 1);
});

test('console reports quota waits and validates the observation interval without changing quota rules', async t => {
  const { h, st } = await fixture(t, true);
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = (route, body) => fetch(base + route, { headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const before = JSON.stringify(h.cfg.quotas);
  assert.equal((await admin('/api/socialV2/config', { workingMemory: { enabled: true, observationIntervalMs: -1 } })).status, 400);
  assert.equal((await admin('/api/socialV2/config', { workingMemory: { enabled: true, observationIntervalMs: 120000 } })).status, 200);
  assert.equal(h.cfg.socialV2.workingMemory.observationIntervalMs, 120000); assert.equal(JSON.stringify(h.cfg.quotas), before);
  h.usageQuotas.consume(KEY, 'model.wake'); const pending = h.sendWakePromptV2(KEY, 'observation');
  try {
    await pause(5);
    const status = await (await admin('/api/socialV2/state?key=' + KEY)).json();
    assert.equal(status.busyReason, 'quotaWait'); assert.ok(status.wakeQuotaWait.deadline);
  } finally { await pending; }
  assert.equal(st.wakeQuotaWaiting, false);
});
