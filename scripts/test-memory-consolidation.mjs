import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { MemoryConsolidation } from '../src/core/memory-consolidation.mjs';
import { WorkingMemory } from '../src/core/working-memory.mjs';
import { memoryRecordHash } from '../src/core/consolidated-memory.mjs';
import { MEMORY_PROTOCOL } from '../src/framework/memory-providers.mjs';
import { ExampleMemoryStore, startMemoryProvider } from '../examples/memory-provider.mjs';
import { HaitangMemoryProvider, DEFAULT_SOURCE } from '../integrations/haitang-memory.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
const KEY = 'group:456';
const message = (id = 'qq:1', more = {}) => ({ id, userId: '234', text: '我喜欢清淡饮食', receivedAt: Date.now(), eventAt: null, ...more });
const input = (more = {}) => ({ text: '偏好清淡饮食', category: 'preference', subject: '234', assertion: 'self_report', providerId: 'local', sources: [{ id: 'qq:1', quote: '喜欢清淡' }], ...more });
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-candidates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
const request = (operation, input) => ({ protocol: MEMORY_PROTOCOL, namespace: 'a'.repeat(64), operation, input,
  requestId: crypto.randomBytes(32).toString('hex') });
const action = (store, item, operation, execute) => store.act(KEY, { id: item.id, revision: item.revision, operation }, execute);

test('candidates retain verified local evidence after raw eviction and restart, deduplicate and remain reference-only', t => {
  const dir = directory(t), wm = new WorkingMemory(path.join(dir, 'working'), { maxMessages: 1 });
  const store = new MemoryConsolidation(path.join(dir, 'candidates'));
  wm.record(KEY, message()); wm.offered(KEY, wm.snapshot(KEY));
  const created = store.stage(KEY, input(), wm.requireEvidence(KEY, ['qq:1'])).item;
  wm.record(KEY, message('qq:2')); assert.equal(wm.get(KEY).messages[0].id, 'qq:2');
  const restarted = new MemoryConsolidation(store.directory);
  assert.equal(restarted.list(KEY).items[0].evidence[0].quote, '喜欢清淡');
  assert.equal(restarted.stage(KEY, input(), [message()]).item.id, created.id);
  assert.equal(restarted.list('group:789').total, 0);
  const context = restarted.context(KEY);
  assert.equal(context.historical, true); assert.equal(context.replyEligible, false);
  assert.equal(context.contextRole, 'reference-only'); assert.ok(!JSON.stringify(created.record).includes('quote'));
});

test('candidate staging rejects fabricated excerpts, bot evidence, wrong subjects, credentials and half-corrections', t => {
  const store = new MemoryConsolidation(directory(t));
  for (const evidence of [[], [message('qq:1', { isSelf: true })], [message('qq:1', { userId: '345' })], [message('qq:1', { retainedSummary: true })]]) {
    assert.throws(() => store.stage(KEY, input(), evidence), /依据|发言人|主体/);
  }
  assert.throws(() => store.stage(KEY, input({ sources: [{ id: 'qq:1', quote: '从未说过' }] }), [message()]), /原文/);
  assert.throws(() => store.stage(KEY, input({ text: 'password=synthetic-secret-value' }), [message()]), /敏感/);
  assert.throws(() => store.stage(KEY, input({ expectedHash: 'a'.repeat(64) }), [message()]), /同时/);
  assert.throws(() => store.stage(KEY, input({ assertion: 'third_party' }), [message()]), /类型/);
});

test('interrupted writes become unknown, require exact verification and never blindly retry', async t => {
  const dir = directory(t), store = new MemoryConsolidation(dir);
  const original = store.stage(KEY, input(), [message()]).item;
  const writing = store.change(KEY, original.id, original.revision, { status: 'writing' });
  const restarted = new MemoryConsolidation(dir), item = restarted.list(KEY).items[0];
  assert.equal(item.status, 'unknown'); assert.ok(item.revision > writing.revision);
  await assert.rejects(action(restarted, item, 'commit', () => { throw Error('must not dispatch'); }), /先核验/);
  const verified = await action(restarted, item, 'verify', async (_p, op, payload) => {
    assert.equal(op, 'query'); assert.equal(payload.options.consolidation.id, item.record.id);
    return { items: [structuredClone(item.record)], nextCursor: null };
  });
  assert.equal(verified.item.status, 'applied');
  restarted.invalidateReceipts(KEY, 'local', 'clear');
  const absent = await action(restarted, restarted.list(KEY).items[0], 'verify', async () => ({ items: [], nextCursor: null }));
  assert.equal(absent.item.status, 'pending');
});

test('approvals do not claim success and timeout results remain verifiable without duplicate records', async t => {
  const store = new MemoryConsolidation(directory(t)), backend = new ExampleMemoryStore();
  let item = store.stage(KEY, input(), [message()]).item;
  const approval = await action(store, item, 'commit', async () => ({ status: 'approval_required', approval: { requestId: 'approval-fixture' } }));
  assert.equal(approval.item.status, 'approval_required'); assert.equal(approval.approval.approval.requestId, 'approval-fixture');
  await assert.rejects(action(store, approval.item, 'commit', async (_p, _op, record) => { backend.handle(request('write', record)); throw Error('transport timed out'); }), /timed out/);
  item = store.list(KEY).items[0]; assert.equal(item.status, 'unknown');
  const verified = await action(store, item, 'verify', async (_p, op, payload) => backend.handle(request(op, payload)));
  assert.equal(verified.item.status, 'applied'); assert.equal(backend.namespaces['a'.repeat(64)].length, 1);
});

test('concurrent actions and stale revisions fail, incomplete verification never means absent', async t => {
  const store = new MemoryConsolidation(directory(t)), item = store.stage(KEY, input(), [message()]).item;
  let resolve;
  const pending = action(store, item, 'commit', () => new Promise(done => { resolve = done; }));
  await assert.rejects(action(store, item, 'commit', async () => ({})), /正在处理/);
  resolve({ affectedIds: [item.record.id] }); await pending;
  const unknown = store.list(KEY).items[0];
  await assert.rejects(action(store, unknown, 'verify', async () => ({ items: [], truncated: true })), /完整/);
  assert.equal(store.list(KEY).items[0].status, 'unknown');
  await assert.rejects(action(store, item, 'verify', async () => ({})), /版本/);
});

test('provenance deletion scrubs local excerpts and content and revokes an in-flight result', async t => {
  const deleted = new Set(), dir = directory(t), store = new MemoryConsolidation(dir, { isSourceDeleted: (_k, id) => deleted.has(id) });
  const item = store.stage(KEY, input(), [message()]).item;
  let resolve;
  const pending = action(store, item, 'commit', () => new Promise(done => { resolve = done; }));
  deleted.add('qq:1'); resolve({ affectedIds: [item.record.id] });
  await assert.rejects(pending, /失效/);
  const invalid = store.list(KEY).items[0]; assert.equal(invalid.status, 'invalidated'); assert.deepEqual(invalid.evidence, []);
  assert.ok(!fs.readFileSync(store.file(KEY), 'utf8').includes('清淡'));
  assert.equal(new MemoryConsolidation(dir).list(KEY).items[0].status, 'invalidated');
});

test('capacity exhaustion is visible, terminal records can be explicitly cleaned, corrupt state is retained', async t => {
  const dir = directory(t), store = new MemoryConsolidation(dir);
  for (let n = 0; n < 100; n++) store.stage(KEY, input({ text: '稳定偏好' + n }), [message()]);
  assert.throws(() => store.stage(KEY, input({ text: '容量溢出' }), [message()]), /容量已满/);
  const item = store.list(KEY).items[0];
  const rejected = await action(store, item, 'reject');
  assert.equal(new MemoryConsolidation(dir).list(KEY).items[0].status, 'rejected');
  await action(store, rejected.item, 'remove');
  assert.equal(store.list(KEY).total, 99);
  fs.writeFileSync(store.file(KEY), '{broken');
  assert.throws(() => new MemoryConsolidation(dir).get(KEY), /保留原文件/);
  assert.equal(fs.readFileSync(store.file(KEY), 'utf8'), '{broken');
});

async function providerLifecycle(provider, t) {
  const store = new MemoryConsolidation(directory(t));
  const first = store.stage(KEY, input(), [message()]).item;
  await provider.handle(request('write', first.record));
  const initial = (await provider.handle(request('query', {}))).items[0];
  assert.equal(memoryRecordHash(initial), memoryRecordHash(first.record));
  const replacement = store.stage(KEY, input({ text: '饮食偏好已改为重口味', supersedes: initial.id, expectedHash: memoryRecordHash(initial) }), [message()]).item;
  await provider.handle(request('write', replacement.record));
  assert.deepEqual((await provider.handle(request('query', {}))).items.map(item => item.id), [replacement.record.id]);
  assert.equal((await provider.handle(request('query', { options: { consolidation: { history: true } } }))).items.length, 2);
  // Stable-ID no-op retries, protected against mutation through legacy operations.
  const retry = await provider.handle(request('write', replacement.record)); assert.equal(retry.affectedCount, 0);
  await assert.rejects(async () => provider.handle(request('write', { ...replacement.record, text: '篡改' })), /覆盖|immutable/);
  await assert.rejects(async () => provider.handle(request('update', { selector: { id: initial.id }, patch: { text: '篡改旧值' } })), /不可|不能|immutable/);
  const stale = store.stage(KEY, input({ text: '并发纠错', supersedes: initial.id, expectedHash: memoryRecordHash(initial) }), [message()]).item;
  await assert.rejects(async () => provider.handle(request('write', stale.record)), /变化/);
  await provider.handle(request('delete', { selector: { id: replacement.record.id } }));
  assert.equal((await provider.handle(request('query', {}))).items.length, 0);
  const exact = await provider.handle(request('query', { options: { consolidation: { id: initial.id, history: true } } }));
  assert.equal(exact.items.length, 1); assert.equal(exact.items[0].metadata.qqBridgeConsolidationState.supersededBy, replacement.record.id);
  // Existing custom metadata remains an opaque legacy field.
  const legacy = { id: 'legacy-custom', text: '既有偏好', subject: '234', category: 'preference', metadata: { consolidation: { custom: 'legacy-value' } } };
  await provider.handle(request('write', legacy));
  assert.equal(JSON.stringify((await provider.handle(request('query', {}))).items[0].metadata), JSON.stringify(legacy.metadata));
  const corrected = store.stage(KEY, input({ text: '既有偏好纠正', supersedes: legacy.id, expectedHash: memoryRecordHash(legacy) }), [message()]).item;
  await provider.handle(request('write', corrected.record));
  assert.deepEqual((await provider.handle(request('query', {}))).items.map(item => item.id), [corrected.record.id]);
}

test('example provider corrections preserve history, use compare-and-swap and never revive superseded values', t => providerLifecycle(new ExampleMemoryStore(), t));
test('a verification cannot apply a stale result after a concurrent provider mutation starts', async t => {
  const store = new MemoryConsolidation(directory(t));
  let item = store.stage(KEY, input(), [message()]).item;
  item = (await action(store, item, 'commit', async () => ({ affectedIds: [item.record.id] }))).item;
  let resolve;
  const pending = action(store, item, 'verify', () => new Promise(done => { resolve = done; }));
  store.invalidateReceipts(KEY, 'local', 'clear');
  resolve({ items: [item.record], nextCursor: null });
  await assert.rejects(pending, /失效/);
  assert.equal(store.list(KEY).items[0].status, 'unknown');
});
const source = process.env.HAITANG_SOURCE || DEFAULT_SOURCE;
test('real Haitang supports the same correction and exact verification contract', { skip: !fs.existsSync(path.join(source, 'lib/store.js')) }, async t => {
  const provider = new HaitangMemoryProvider({ source, directory: directory(t) });
  try { await providerLifecycle(provider, t); } finally { await provider.close(); }
});

async function fixture(t, approvalMode = 'automatic') {
  const plugin = await startMemoryProvider();
  const h = await bridgeHarness({ config: { dualMode: { enabled: true, ownerPreset: 'standard' }, allow: { groups: ['456','789'] },
    memory: { provider: 'local', providers: [{ id: 'local', approvalMode, features: ['consolidation-v1'], operations: ['query','write','update','delete','clear'], transport: { type: 'http', url: plugin.url } }] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, wake: { preSleepWaitEnabled: false }, sticker: { enabled: false } } } });
  await h.ensureSession(KEY); const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); await plugin.close(); });
  const client = new QQBridgeClient({ baseUrl, key: KEY, token: st.agentToken });
  h.appendSocialV2Message(KEY, '成员', '我喜欢清淡饮食', '我喜欢清淡饮食', false, false, 1, [], '234');
  return { h, plugin, st, client, baseUrl };
}

test('Agent HTTP/SDK entry points require observed evidence, enforce permissions and verify condensed facts without exporting quotes', async t => {
  const { h, plugin, client } = await fixture(t);
  const requests = [], handle = plugin.store.handle.bind(plugin.store);
  plugin.store.handle = request => { requests.push(request); return handle(request); };
  await assert.rejects(client.consolidateMemory('stage', input()), /展示/);
  await client.unread(); assert.equal(requests.length, 0);
  const staged = await client.consolidateMemory('stage', input());
  assert.equal((await client.memoryCandidates()).total, 1); assert.equal(requests.length, 0);
  await assert.rejects(client.memory('write', staged.item.record), /有效候选/);
  const committed = await client.consolidateMemory('commit', { id: staged.item.id, revision: staged.item.revision });
  assert.equal(committed.item.status, 'unknown');
  assert.equal(requests.length, 1); assert.ok(!JSON.stringify(requests[0]).includes('quote'));
  assert.ok(!JSON.stringify(requests[0]).includes('我喜欢清淡饮食'));
  const verified = await client.consolidateMemory('verify', { id: staged.item.id, revision: committed.item.revision });
  assert.equal(verified.item.status, 'applied');
  const record = (await client.memory('query')).items[0]; assert.equal(record.recordHash, memoryRecordHash(staged.item.record));
  h.appendSocialV2Message(KEY, '成员', '现在更喜欢重口味', '现在更喜欢重口味', false, false, 2, [], '234');
  await client.recent();
  const corrected = await client.consolidateMemory('stage', input({ text: '现在偏好重口味', sources: [{ id: 'qq:2', quote: '更喜欢重口味' }],
    supersedes: record.id, expectedHash: record.recordHash }));
  const correctedWrite = await client.consolidateMemory('commit', { id: corrected.item.id, revision: corrected.item.revision });
  const correctedRead = await client.consolidateMemory('verify', { id: corrected.item.id, revision: correctedWrite.item.revision });
  assert.equal(correctedRead.item.status, 'applied');
  assert.deepEqual((await client.memory('query')).items.map(item => item.id), [corrected.item.record.id]);
  assert.equal((await client.memory('query', { options: { consolidation: { history: true } } })).items.length, 2);
  const recent = await client.recent(); assert.equal(recent.memoryConsolidation.replyEligible, false);
  await client.memory('clear'); assert.equal((await client.memoryCandidates()).items[0].status, 'unknown');
  assert.equal(h.calls.sent.length, 0);
});

test('candidate endpoints deny cross-scope tokens, pauses, disabled tools, admin staging and Agent cleanup', async t => {
  const { h, client, baseUrl, st } = await fixture(t);
  const foreign = new QQBridgeClient({ baseUrl, key: 'group:789', token: st.agentToken });
  await assert.rejects(foreign.memoryCandidates(), /会话|令牌|目标/);
  h.socialV2.paused = true; await assert.rejects(client.memoryCandidates(), /暂停|无效/); h.socialV2.paused = false;
  h.cfg.socialV2.tools.memory = false; await assert.rejects(client.memoryCandidates(), /启用/); h.cfg.socialV2.tools.memory = true;
  const admin = await fetch(baseUrl + '/api/socialV2/memory-consolidation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
    body: JSON.stringify({ key: KEY, operation: 'stage', input: input() }) }); assert.equal(admin.status, 403);
  await client.unread(); const staged = await client.consolidateMemory('stage', input());
  await assert.rejects(client.consolidateMemory('remove', { id: staged.item.id, revision: staged.item.revision }), /管理员/);
  await client.updateWorkingContext({ revision: 0, discardMessageIds: ['qq:1'] });
  const invalid = (await client.memoryCandidates()).items[0]; assert.equal(invalid.status, 'invalidated'); assert.equal(invalid.evidence.length, 0);
  assert.equal(h.calls.sent.length, 0);
});

test('a provider ignoring exact query or marking truncation cannot turn unknown into a false absence', async t => {
  const { plugin, client } = await fixture(t);
  await client.unread(); let { item } = await client.consolidateMemory('stage', input());
  ({ item } = await client.consolidateMemory('commit', { id: item.id, revision: item.revision }));
  const original = plugin.store.handle.bind(plugin.store);
  plugin.store.handle = request => ({ ...original(request), items: [{ id: 'unrelated', text: '无关事实' }] });
  await assert.rejects(client.consolidateMemory('verify', { id: item.id, revision: item.revision }), /精确/);
  item = (await client.memoryCandidates()).items[0]; assert.equal(item.status, 'unknown');
  plugin.store.handle = request => ({ ...original(request), items: [], truncated: true });
  await assert.rejects(client.consolidateMemory('verify', { id: item.id, revision: item.revision }), /完整/);
  assert.equal((await client.memoryCandidates()).items[0].status, 'unknown');
});

test('one-time approvals survive candidate transitions and must be explicitly retried with the same fact', async t => {
  const { h, client } = await fixture(t, 'required');
  h.extensionPermissions.replacePolicy({ rules: ['query','write'].map(operation => ({ key: KEY, capability: `memory.local.${operation}`, decision: 'ask', dataScopes: [operation === 'query' ? 'memory-query' : 'memory-write'] })) });
  await client.unread(); let { item } = await client.consolidateMemory('stage', input());
  const waiting = await client.consolidateMemory('commit', { id: item.id, revision: item.revision });
  assert.equal(waiting.item.status, 'approval_required');
  const approvalId = waiting.approval.approval.requestId;
  h.extensionPermissions.resolve(approvalId, 'approve');
  const committed = await client.consolidateMemory('commit', { id: item.id, revision: waiting.item.revision, approvalId });
  assert.equal(committed.item.status, 'unknown');
  const queryApproval = await client.consolidateMemory('verify', { id: item.id, revision: committed.item.revision });
  assert.equal(queryApproval.item.status, 'unknown');
  const queryId = queryApproval.approval.approval.requestId; h.extensionPermissions.resolve(queryId, 'approve');
  const verified = await client.consolidateMemory('verify', { id: item.id, revision: queryApproval.item.revision, approvalId: queryId });
  assert.equal(verified.item.status, 'applied');
});
