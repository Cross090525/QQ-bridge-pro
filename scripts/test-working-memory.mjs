import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { WorkingMemory, ObservationQueue, observationServices } from '../src/core/working-memory.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
const KEY = 'group:456';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
const baseConfig = { dualMode: { enabled: true, ownerPreset: 'standard' }, allow: { groups: ['456', '789'], private: ['123'] },
  socialV2: { workingMemory: { enabled: true }, wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false } } };
function source(id, text, extra = {}) { return { id, seq: Number(id.replace(/\D/g, '')) || 1, sender: '小王', plain: text, ...extra }; }
function item(text, sources) { return { text, sources, status: 'active', certainty: 'reported' }; }

test('durable raw context, distinct groups, explicit truncation, dormancy and corrupt-file recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'working-test-')); let now = 1000;
  try {
    const wm = new WorkingMemory(dir, { now: () => now, maxMessages: 30 });
    wm.record(KEY, source('m1', '原文'.repeat(400))); const packet = wm.snapshot(KEY); wm.offered(KEY, packet);
    wm.update(KEY, { revision: 0, topics: [item('周末安排', ['m1'])] });
    now += 3600001;
    assert.equal(wm.snapshot(KEY).topics[0].status, 'dormant');
    const restored = new WorkingMemory(dir);
    assert.equal(restored.get(KEY).messages[0].text.length, 800);
    assert.equal(restored.get('group:789').messages.length, 0);
    assert.throws(() => restored.update(KEY, { revision: 1, facts: [item('未提供证据', ['m1'])] }), /实际展示/);
    for (let n = 2; n < 45; n++) wm.record(KEY, source('m' + n, '长文'.repeat(1000)));
    assert.equal(wm.get(KEY).messages.length, 30);
    assert.ok(JSON.stringify(wm.snapshot(KEY)).length <= 10000);
    fs.writeFileSync(wm.file(KEY), '{bad');
    assert.throws(() => new WorkingMemory(dir).get(KEY), /保留原文件/);
    assert.equal(fs.readFileSync(wm.file(KEY), 'utf8'), '{bad');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('optimistic updates require seen provenance; media preparation is separate from comprehension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'working-test-'));
  try {
    const wm = new WorkingMemory(dir);
    wm.record(KEY, source('m1', '看视频', { content: [{ type: 'video', sourceId: 'src1' }] }));
    wm.media(KEY, 'src1', { status: 'pending' }); wm.offered(KEY, wm.snapshot(KEY));
    assert.throws(() => wm.update(KEY, { revision: 0, media: [{ sourceId: 'src1', summary: '瞎猜' }] }), /证据/);
    wm.media(KEY, 'src1', { status: 'prepared' }); wm.offered(KEY, wm.snapshot(KEY));
    assert.throws(() => wm.update(KEY, { revision: 0, media: [{ sourceId: 'src1', summary: '未展示图片' }] }), /证据/);
    wm.offered(KEY, wm.snapshot(KEY), ['src1']);
    wm.update(KEY, { revision: 0, topics: [item('角色翻车', ['m1'])], media: [{ sourceId: 'src1', summary: '前30秒是角色翻车，后文未知' }],
      decision: { action: 'observe', note: '看懂后选择观察', sources: ['m1'] } });
    assert.equal(wm.get(KEY).media[0].status, 'understood');
    assert.equal(wm.get(KEY).messages.length, 1);
    assert.throws(() => wm.update(KEY, { revision: 0, topics: [] }), /版本/);
    assert.throws(() => wm.update(KEY, { revision: 1, facts: [item('串群', ['other'])] }), /来源/);
    assert.throws(() => wm.update(KEY, { revision: 1, decision: { action: 'ignore', note: '', sources: ['m1'] } }), /参与决策/);
    assert.equal(wm.get(KEY).revision, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validated unresolved context remains editable after raw retention expires, without fabricating raw evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'working-test-'));
  try {
    const wm = new WorkingMemory(dir, { maxMessages: 2 });
    wm.record(KEY, source('m1', '集合时间尚未确认')); wm.offered(KEY, wm.snapshot(KEY));
    wm.update(KEY, { revision: 0, questions: [item('等待集合时间', ['m1'])] });
    wm.record(KEY, source('m2', '新话题')); wm.record(KEY, source('m3', '新消息'));
    assert.ok(!wm.get(KEY).messages.some(m => m.id === 'm1'));
    const restored = new WorkingMemory(dir, { maxMessages: 2 }); restored.offered(KEY, restored.snapshot(KEY));
    restored.update(KEY, { revision: 1, questions: [item('仍等待集合时间（依据已有摘要）', ['m1'])] });
    assert.equal(restored.get(KEY).questions.length, 1);
    assert.equal(restored.snapshot(KEY, { messageId: 'm1' }).messages.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('observation queue limits concurrency and service choice never selects ask, deny or side effects', async () => {
  const queue = new ObservationQueue(); let active = 0, max = 0;
  await Promise.all(Array.from({ length: 9 }, () => queue.run(async () => {
    active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active--;
  })));
  assert.equal(max, 2);
  assert.deepEqual(observationServices({ type: 'link' }, [
    { id: 'bilibili.storyboard', effect: 'read', permission: 'ask' },
    { id: 'bilibili.frames', effect: 'read', permission: 'allow' },
    { id: 'bilibili.transcript', effect: 'execute', permission: 'allow' },
  ]), ['bilibili.frames']);
});

async function fixture(run, extra = {}, globals = {}) {
  const h = await bridgeHarness({ config: { ...baseConfig, ...extra }, globals });
  await h.ensureSession(KEY); const st = h.getSocialV2State(KEY);
  st.bootstrapSent = true; st.wakeConfig.triggers = { atMention: true, probability: 0 };
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new QQBridgeClient({ baseUrl, key: KEY, token: st.agentToken });
  const receive = async (text, id = 100) => h.handleIncoming('group', 456, { self_id: 999, message_id: id, user_id: 321,
    group_id: 456, sender: { nickname: '小王' }, message: [{ type: 'text', data: { text } }] }, h.cfg);
  try { await run({ h, st, client, receive, baseUrl }); }
  finally {
    for (const job of h.observationJobs.values()) await job.promise;
    server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close();
  }
}

test('ordinary chat wakes observation, full text is injected automatically, ack and silence retain context', () => fixture(async ({ h, st, receive, client }) => {
  await receive('前面讨论周末去哪里，后文'.repeat(30));
  assert.equal(st.pendingWakeReason, 'observation');
  assert.ok(h.workingMemory.get(KEY).messages[0].text.length > 200);
  await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
  const content = h.calls.prompts.at(-1).content[0].text;
  assert.match(content, /实时工作记忆/); assert.match(content, /周末去哪里/);
  const packet = (await client.workingContext()).snapshot;
  await client.updateWorkingContext({ revision: packet.revision, topics: [item('讨论周末去哪里', [packet.messages[0].id])],
    decision: { action: 'observe', note: '先观察后续安排', sources: [packet.messages[0].id] } });
  await client.acknowledge(1);
  assert.equal(st.unread.length, 0); assert.equal(h.workingMemory.get(KEY).topics.length, 1);
  h.recordSentMessagesV2(KEY, ['我刚问了集合时间']);
  assert.equal(h.workingMemory.get(KEY).messages.at(-1).isSelf, true);
  assert.equal(h.calls.sent.length, 0, 'decisions do not send QQ messages');
}));

test('working API rejects cross-group tokens, owner mode, paused writes and tool/config disable', () => fixture(async ({ h, st, client, receive, baseUrl }) => {
  await receive('背景'); const snapshot = (await client.workingContext()).snapshot;
  const other = new QQBridgeClient({ baseUrl, key: 'group:789', token: st.agentToken });
  await assert.rejects(other.workingContext(), /绑定|令牌|会话/);
  await assert.rejects(client.updateWorkingContext({ revision: 0, topics: [item('假引用', ['unknown'])] }), /来源/);
  h.socialV2.paused = true;
  await assert.rejects(client.updateWorkingContext({ revision: 0, topics: [] }), /不可用|暂停/);
  h.socialV2.paused = false; h.cfg.socialV2.tools.contextQuery = false;
  await assert.rejects(client.workingContext(), /启用|不可用/);
  h.cfg.socialV2.tools.contextQuery = true; h.cfg.socialV2.workingMemory.enabled = false;
  await assert.rejects(client.workingContext(), /不可用/);
  assert.equal(snapshot.messages.length, 1);
}));

test('a previous unmentioned image reaches the visual prompt before the next text-only remark', () => fixture(async ({ h, receive, client }) => {
  await h.handleIncoming('group', 456, { self_id: 999, message_id: 80, user_id: 321, group_id: 456, sender: { nickname: '小王' },
    message: [{ type: 'image', data: { url: 'https://example.com/fixture.png' } }] }, h.cfg);
  await receive('这也太像你了', 81);
  await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
  const content = h.calls.prompts.at(-1).content;
  assert.ok(content.some(c => c.type === 'image' && c.data === png));
  assert.ok(content[0].text.includes('这也太像你了'));
  const packet = (await client.workingContext()).snapshot;
  assert.equal(packet.messages.length, 2); assert.equal(packet.media[0].status, 'prepared');
  assert.equal(h.calls.sent.length, 0);
}, {}, { safeFetchBuffer: async () => ({ buffer: Buffer.from(png, 'base64') }) }));

test('decisions advance a separate observation cursor and continue queued context even after unread was cleared', () => fixture(async ({ h, client }) => {
  for (let n = 1; n <= 60; n++) h.appendSocialV2Message(KEY, '小王', `聊天${n}`, `聊天${n}`, false, false, String(n));
  const packet = (await client.workingContext()).snapshot;
  assert.equal(packet.messages[0].text, '聊天1'); assert.equal(packet.pendingCount, 60);
  h.getSocialV2State(KEY).unread = [];
  await client.updateWorkingContext({ revision: 0, decision: { action: 'observe', note: '理解这批后继续看', sources: [packet.messages[0].id] } });
  assert.equal(h.workingMemory.snapshot(KEY).pendingCount, 40);
  assert.equal(h.workingMemory.snapshot(KEY).messages[0].text, '聊天13');
  assert.equal(h.getSocialV2State(KEY).pendingWakeReason, 'observationContinuation');
}));

test('manual image recovery can replace a failed automatic read and save a verified summary', async () => {
  let available = false;
  await fixture(async ({ h, client, baseUrl, st }) => {
    await h.handleIncoming('group', 456, { self_id: 999, message_id: 80, user_id: 321, group_id: 456, sender: { nickname: '小王' },
      message: [{ type: 'image', data: { url: 'https://example.com/fixture.png' } }] }, h.cfg);
    await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
    assert.equal(h.workingMemory.get(KEY).media[0].status, 'failed');
    available = true;
    const response = await fetch(baseUrl + '/api/images/message?key=' + KEY + '&messageId=80', {
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken } });
    assert.equal(response.status, 200); assert.ok((await response.json()).images[0].data);
    const packet = (await client.workingContext()).snapshot;
    await client.updateWorkingContext({ revision: packet.revision, media: [{ sourceId: packet.media[0].sourceId, summary: '通过实际图片证据确认内容' }] });
    assert.equal(h.workingMemory.get(KEY).media[0].status, 'understood');
  }, {}, { safeFetchBuffer: async () => { if (!available) throw Error('fixture unavailable'); return { buffer: Buffer.from(png, 'base64') }; } });
});

test('bounded recent context cannot acknowledge unseen earlier messages; source recall survives read marks', () => fixture(async ({ h, st, client }) => {
  for (let n = 1; n <= 35; n++) h.appendSocialV2Message(KEY, '小王', `第${n}条原文`, `第${n}条原文`, false, false, String(n));
  const recent = (await client.workingContext()).snapshot;
  assert.equal(recent.messages.length, 20); assert.equal(recent.truncated, true);
  await assert.rejects(client.acknowledge(35), /水位|展示/);
  const older = (await client.workingContext({ query: '第6条原文' })).snapshot;
  assert.equal(older.messages[0].text, '第6条原文');
  const exact = (await client.workingContext({ messageId: older.messages[0].id })).snapshot;
  assert.equal(exact.messages.length, 1);
  assert.equal(st.unread.length, 30);
  h.recordSentMessagesV2(KEY, ['已经实际发送']);
  assert.equal((await client.workingContext()).snapshot.messages.at(-1).text, '已经实际发送');
}));

test('late media cannot enter prompts or update comprehension after pause or permission revocation', async () => {
  let release, called;
  const started = new Promise(r => called = r);
  const provider = http.createServer(async (req, res) => {
    req.resume(); called(); await new Promise(r => release = r);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: png }] }));
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  try {
    await fixture(async ({ h, receive }) => {
      await receive('https://www.bilibili.com/video/BV1234567890');
      const pending = h.prepareObservationV2(KEY);
      await started; h.extensionPermissions.replacePolicy({ rules: [] }); release();
      await assert.rejects(pending, /失效/);
      assert.ok([...h.observationJobs.values()].every(j => j.parts.length === 0));
      assert.ok(h.workingMemory.get(KEY).media.every(m => m.status !== 'understood'));
      assert.equal(h.calls.prompts.length, 0);
    }, { framework: { services: [{ id: 'bilibili.storyboard', effect: 'read', accepts: ['link'],
      transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }],
      permissions: { rules: [{ key: KEY, capability: 'bilibili.storyboard', decision: 'allow', dataScopes: ['source-reference'] }] } } });
  } finally { release?.(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
});

test('real authorized video service prepares visual evidence before decision; recognition is deduplicated', async () => {
  let calls = 0;
  const provider = http.createServer((req, res) => { calls++; req.resume(); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'coverage=0-30s; sampled frames only' }, { type: 'image', mimeType: 'image/png', data: png }] })); });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const services = [{ id: 'bilibili.storyboard', effect: 'read', accepts: ['link'], hosts: ['bilibili.com'],
    transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }];
  try {
    await fixture(async ({ h, receive, client }) => {
      await receive('看看 https://www.bilibili.com/video/BV1234567890');
      await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
      const content = h.calls.prompts.at(-1).content;
      assert.ok(content.some(c => c.type === 'image' && c.mediaType === 'image/png'));
      assert.ok(content.some(c => c.text?.includes('coverage=0-30s')));
      const packet = (await client.workingContext()).snapshot;
      assert.equal(packet.media[0].status, 'prepared');
      await client.updateWorkingContext({ revision: 0, media: [{ sourceId: packet.media[0].sourceId, summary: '已看抽样画面，0-30秒，非全片' }] });
      await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
      assert.equal(calls, 1); assert.equal(h.workingMemory.get(KEY).media[0].status, 'understood');
    }, { framework: { services, permissions: { rules: [{ key: KEY, capability: 'bilibili.storyboard', decision: 'allow', dataScopes: ['source-reference'] }] } } });
    await fixture(async ({ h, receive }) => {
      await receive('https://www.bilibili.com/video/BV1234567890'); await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
      assert.equal(h.workingMemory.get(KEY).media[0].status, 'unavailable'); assert.equal(calls, 1);
      assert.equal(h.extensionPermissions.listRequests().length, 0, 'background preparation does not create approval spam');
    }, { framework: { services, permissions: { rules: [{ key: KEY, capability: 'bilibili.storyboard', decision: 'ask', dataScopes: ['source-reference'] }] } } });
  } finally { provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
});

test('main frames/transcript fallback preserves visual evidence when audio recognition fails', async () => {
  const provider = http.createServer((req, res) => {
    const frames = req.url === '/frames'; req.resume(); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(frames ? { content: [{ type: 'image', mimeType: 'image/png', data: png }] }
      : { isError: true, content: [{ type: 'text', text: 'audio unavailable' }] }));
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  try {
    await fixture(async ({ h, receive }) => {
      await receive('https://www.bilibili.com/video/BV1234567890');
      await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
      const content = h.calls.prompts.at(-1).content;
      assert.ok(content.some(c => c.type === 'image'));
      assert.ok(content.some(c => c.text?.includes('不能推断静音')));
      assert.equal(h.workingMemory.get(KEY).media[0].status, 'prepared');
    }, { framework: { services: ['frames', 'transcript'].map(name => ({ id: 'bilibili.' + name, effect: 'read', accepts: ['link'],
      transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}/${name}` } })),
      permissions: { rules: ['frames', 'transcript'].map(name => ({ key: KEY, capability: 'bilibili.' + name, decision: 'allow', dataScopes: ['source-reference'] })) } } });
  } finally { provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
});
