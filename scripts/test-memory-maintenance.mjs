import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { MemoryConsolidation } from '../src/core/memory-consolidation.mjs';
import { WorkingMemory } from '../src/core/working-memory.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { startMemoryProvider } from '../examples/memory-provider.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
const KEY = 'group:456';
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-maintenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
const message = n => ({ id: `qq:${n}`, userId: '234', text: `合成来源${n}`, time: Date.now(), receivedAt: Date.now(), eventAt: null });
function stage(store, n, extra = {}) {
  return store.stage(KEY, { text: `合成事实${n}`, subject: '234', category: 'preference', assertion: 'self_report', providerId: 'local',
    sources: [{ id: `qq:${n}`, quote: `合成来源${n}` }], ...extra }, [message(n)]).item;
}
const applied = (store, item) => store.change(KEY, item.id, item.revision, { status: 'applied' });
const act = (store, item, operation, execute) => store.act(KEY, { id: item.id, revision: item.revision, operation }, execute);
const all = store => store.all(store.get(KEY));

test('mutations invalidate only matching IDs, correction targets, selectors and categories', t => {
  const store = new MemoryConsolidation(directory(t));
  const first = applied(store, stage(store, 1)), second = applied(store, stage(store, 2, { category: 'fact' }));
  const third = applied(store, stage(store, 3, { providerId: 'other' }));
  const revision = store.get(KEY).revision;
  store.invalidateReceipts(KEY, 'local', 'write', { id: 'unrelated', subject: '234', category: 'preference' });
  assert.equal(store.get(KEY).revision, revision);
  store.invalidateReceipts(KEY, 'local', 'write', { id: 'new-version', metadata: { qqBridgeConsolidation: { supersedes: first.record.id } } });
  assert.equal(all(store).find(item => item.id === first.id).status, 'unknown');
  assert.equal(all(store).find(item => item.id === second.id).status, 'applied');
  store.invalidateReceipts(KEY, 'local', 'delete', { selector: { category: 'fact', text: '事实2' } });
  assert.equal(all(store).find(item => item.id === second.id).status, 'unknown');
  assert.equal(all(store).find(item => item.id === third.id).status, 'applied');
});

test('ambiguous writes remain conservative within their subject and category; clear and ingest preserve broad invalidation', t => {
  const store = new MemoryConsolidation(directory(t));
  applied(store, stage(store, 1)); applied(store, stage(store, 2, { category: 'fact' }));
  store.invalidateReceipts(KEY, 'local', 'write', { subject: '234', category: 'preference', text: '同类别新内容' });
  assert.deepEqual(all(store).map(item => item.status), ['unknown','applied']);
  store.invalidateReceipts(KEY, 'local', 'clear', { category: 'fact' });
  assert.ok(all(store).every(item => item.status === 'unknown'));
  for (const item of all(store)) applied(store, item);
  store.invalidateReceipts(KEY, 'local', 'ingest', { messageSeqs: [1] });
  assert.ok(all(store).every(item => item.status === 'unknown'));
});

test('unrelated writes do not invalidate an in-flight exact verification, matching writes do', async t => {
  const store = new MemoryConsolidation(directory(t));
  let item = applied(store, stage(store, 1));
  let resolve;
  const pending = act(store, item, 'verify', () => new Promise(done => { resolve = done; }));
  store.invalidateReceipts(KEY, 'local', 'write', { id: 'unrelated' });
  resolve({ items: [item.record], nextCursor: null });
  item = (await pending).item; assert.equal(item.status, 'applied');
  const stale = act(store, item, 'verify', () => new Promise(done => { resolve = done; }));
  store.invalidateReceipts(KEY, 'local', 'delete', { selector: { id: item.record.id } });
  resolve({ items: [item.record], nextCursor: null });
  await assert.rejects(stale, /失效/); assert.equal(all(store)[0].status, 'unknown');
});

test('a verified memory disappearing later requires review instead of automatic recreation', async t => {
  const store = new MemoryConsolidation(directory(t));
  let item = applied(store, stage(store, 1));
  store.invalidateReceipts(KEY, 'local', 'clear', {});
  item = (await act(store, all(store)[0], 'verify', async () => ({ items: [], nextCursor: null }))).item;
  assert.equal(item.status, 'conflict');
  await assert.rejects(act(store, item, 'commit', async () => { throw Error('must not write'); }), /不可直接提交/);
  let fresh = stage(store, 2);
  fresh = (await act(store, fresh, 'commit', async () => ({ affectedIds: [] }))).item;
  fresh = (await act(store, fresh, 'verify', async () => ({ items: [], nextCursor: null }))).item;
  assert.equal(fresh.status, 'pending');
  const state = structuredClone(store.get(KEY));
  delete state.items.find(candidate => candidate.id === fresh.id).wasVerified;
  state.items.find(candidate => candidate.id === fresh.id).status = 'unknown';
  store.save(KEY, state);
  const legacy = new MemoryConsolidation(store.directory);
  const checked = await act(legacy, all(legacy).find(candidate => candidate.id === fresh.id), 'verify', async () => ({ items: [], nextCursor: null }));
  assert.equal(checked.item.status, 'conflict');
});

test('maintenance context rotates across pending candidates without changing review or source receipts', t => {
  const store = new MemoryConsolidation(directory(t));
  for (let n = 1; n <= 7; n++) stage(store, n);
  const revision = store.get(KEY).revision, selected = [];
  for (let n = 0; n < 3; n++) {
    const context = store.context(KEY); assert.equal(context.replyEligible, false); assert.equal(context.historical, true);
    assert.deepEqual(store.context(KEY).items, context.items, 'rendering another preview does not advance the queue');
    selected.push(...context.items.map(item => item.id));
    store.offered(KEY, context.items.map(item => item.id));
  }
  assert.equal(new Set(selected).size, 7); assert.equal(store.get(KEY).revision, revision);
});

test('rejected wake delivery cannot advance maintenance context past candidates the model never saw', async t => {
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, allow: { groups: ['456'] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false } } } });
  t.after(() => h.close()); await h.ensureSession(KEY); h.setReady(true);
  for (let n = 1; n <= 6; n++) stage(h.memoryConsolidation, n);
  const first = h.memoryConsolidation.context(KEY).items.map(item => item.id);
  const original = h.api.sessions.prompt;
  h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'fixture', message: 'not accepted' } } });
  assert.equal((await h.deliverPrompt(KEY, '', { wakeReason: 'observation', silent: true })).ok, false);
  assert.deepEqual(h.memoryConsolidation.context(KEY).items.map(item => item.id), first);
  h.api.sessions.prompt = original;
  await h.deliverPrompt(KEY, '', { wakeReason: 'observation', silent: true });
  assert.ok(h.memoryConsolidation.context(KEY).items.every(item => !first.includes(item.id)));
  assert.equal(h.calls.sent.length, 0);
});

test('archived candidates retain deduplication and verification while dropping local quotes, and follow source deletion', async t => {
  const dir = directory(t), deleted = new Set();
  let store = new MemoryConsolidation(dir, { isSourceDeleted: (_key, id) => deleted.has(id) });
  let item = applied(store, stage(store, 1));
  item = (await act(store, item, 'archive')).item;
  assert.equal(store.list(KEY).total, 0); assert.equal(store.list(KEY).archiveTotal, 1);
  assert.equal(store.list(KEY, { archived: true }).items[0].archived, true); assert.deepEqual(item.evidence, []);
  store = new MemoryConsolidation(dir, { isSourceDeleted: (_key, id) => deleted.has(id) });
  assert.equal(stage(store, 1).id, item.id);
  store.invalidateReceipts(KEY, 'local', 'delete', { selector: { id: item.record.id } });
  item = (await act(store, all(store)[0], 'verify', async () => ({ items: [item.record], nextCursor: null }))).item;
  assert.equal(item.status, 'applied'); assert.equal(store.sourceProgress(KEY, ['qq:1'])['qq:1'].verifiedCount, 1);
  deleted.add('qq:1'); item = all(store)[0]; assert.equal(item.status, 'invalidated');
  assert.equal(item.record.text, '[来源已删除]'); assert.equal(store.sourceProgress(KEY, ['qq:1'])['qq:1'].candidateCount, 0);
});

test('completed active records automatically archive at capacity without dropping pending work', t => {
  const store = new MemoryConsolidation(directory(t));
  let first;
  for (let n = 1; n <= 200; n++) { const item = applied(store, stage(store, n)); first ??= item; }
  const newItem = stage(store, 201);
  assert.equal(newItem.status, 'pending'); assert.equal(store.list(KEY).total, 200); assert.equal(store.list(KEY).archiveTotal, 1);
  assert.equal(stage(store, 1).id, first.id);
});

test('archive capacity is bounded and explicit cleanup makes room without dropping active work', async t => {
  const dir = directory(t), store = new MemoryConsolidation(dir);
  const item = applied(store, stage(store, 1));
  const archive = Array.from({ length: 1000 }, (_, n) => {
    const suffix = (n + 1).toString(16).padStart(24, '0'), id = 'candidate-' + suffix;
    return { ...structuredClone(item), id, archived: true, evidence: [], fingerprint: (n + 1).toString(16).padStart(64, '0'),
      record: { ...structuredClone(item.record), id: 'fact-' + suffix, metadata: { qqBridgeConsolidation: { ...item.record.metadata.qqBridgeConsolidation, candidateId: id } } } };
  });
  store.save(KEY, { ...store.get(KEY), archive });
  const restarted = new MemoryConsolidation(dir);
  await assert.rejects(act(restarted, item, 'archive'), /1000/);
  assert.equal(restarted.list(KEY).total, 1); assert.equal(restarted.list(KEY).archiveTotal, 1000);
  await act(restarted, archive[0], 'remove'); await act(restarted, item, 'archive');
  assert.equal(restarted.list(KEY).total, 0); assert.equal(restarted.list(KEY).archiveTotal, 1000);
});

test('review progress separates visibility, decisions, extraction and verified storage, including archives', async t => {
  const dir = directory(t); let wm;
  const store = new MemoryConsolidation(path.join(dir, 'candidates'), { isSourceDeleted: (_k, id) => wm.get(KEY).deletedIds.includes(id) });
  wm = new WorkingMemory(path.join(dir, 'working'), { maxMessages: 3, getMemoryProgress: (key, ids) => store.sourceProgress(key, ids) });
  wm.record(KEY, message(1)); let packet = wm.snapshot(KEY); assert.equal(packet.memoryProgress.seenSources, 0);
  assert.throws(() => wm.update(KEY, { revision: 0, memoryReview: { sources: ['qq:1'], outcome: 'no_memory' } }), /展示/);
  wm.offered(KEY, packet); wm.update(KEY, { revision: 0, decision: { action: 'observe', note: '已判断', sources: ['qq:1'] } });
  packet = wm.snapshot(KEY); assert.equal(packet.memoryProgress.consideredSources, 1); assert.equal(packet.memoryProgress.reviewedSources, 0);
  assert.throws(() => wm.update(KEY, { revision: 1, memoryReview: { sources: ['qq:1'], outcome: 'candidates_staged' } }), /不一致/);
  let item = stage(store, 1);
  assert.throws(() => wm.update(KEY, { revision: 1, memoryReview: { sources: ['qq:1'], outcome: 'no_memory' } }), /不一致/);
  wm.update(KEY, { revision: 1, memoryReview: { sources: ['qq:1'], outcome: 'candidates_staged' } });
  assert.equal(wm.snapshot(KEY).memoryProgress.reviewedSources, 1); assert.equal(wm.snapshot(KEY).memoryProgress.verifiedSources, 0);
  let second = store.stage(KEY, { text: '同一来信中的第二条事实', subject: '234', category: 'fact', assertion: 'self_report', providerId: 'local',
    sources: [{ id: 'qq:1', quote: '合成来源1' }] }, [message(1)]).item;
  item = applied(store, item); assert.equal(wm.snapshot(KEY).memoryProgress.verifiedSources, 0);
  second = applied(store, second); await act(store, item, 'archive');
  assert.equal(wm.snapshot(KEY).memoryProgress.verifiedSources, 1);
  wm.update(KEY, { revision: 2, discardMessageIds: ['qq:1'] });
  assert.equal(wm.snapshot(KEY).memoryProgress.totalSources, 0); assert.equal(all(store)[0].status, 'invalidated');
});

test('unreviewed eviction is counted independently of observation, while completed no-memory review survives restart', t => {
  const dir = directory(t), wm = new WorkingMemory(dir, { maxMessages: 1 });
  wm.record(KEY, message(1)); wm.offered(KEY, wm.snapshot(KEY));
  wm.update(KEY, { revision: 0, decision: { action: 'observe', note: '已判断', sources: ['qq:1'] } });
  wm.record(KEY, message(2));
  assert.equal(wm.get(KEY).evictedPending, 0); assert.equal(wm.snapshot(KEY).memoryProgress.evictedUnreviewed, 1);
  assert.equal(wm.snapshot(KEY).memoryProgress.atRisk, 1);
  wm.offered(KEY, wm.snapshot(KEY)); wm.update(KEY, { revision: 1, memoryReview: { sources: ['qq:2'], outcome: 'no_memory' } });
  const restarted = new WorkingMemory(dir, { maxMessages: 1 });
  assert.equal(restarted.snapshot(KEY).memoryProgress.noMemorySources, 1); assert.equal(restarted.snapshot(KEY).memoryProgress.seenSources, 1);
  assert.throws(() => restarted.requireEvidence(KEY, ['qq:2']), /展示/);
  restarted.record(KEY, message(3)); assert.equal(restarted.snapshot(KEY).memoryProgress.evictedUnreviewed, 1);
});

test('legacy files preserve unknown review state and historical review queues never reintroduce old raw text', t => {
  const dir = directory(t), wm = new WorkingMemory(dir);
  wm.record(KEY, { ...message(1), time: Date.now() - 172800000, receivedAt: Date.now() - 172800000 });
  const file = wm.file(KEY), legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const field of ['memoryReviews','modelSeenIds','evictedUnreviewed','reviewTrackingStartedAt']) delete legacy[field];
  legacy.consideredIds = ['qq:1']; fs.writeFileSync(file, JSON.stringify(legacy));
  const before = fs.readFileSync(file, 'utf8'), restarted = new WorkingMemory(dir), packet = restarted.snapshot(KEY);
  assert.equal(packet.memoryProgress.reviewedSources, 0); assert.equal(packet.memoryProgress.consideredSources, 1);
  assert.ok(!packet.messages.length); assert.ok(!JSON.stringify(packet).includes('合成来源1'));
  assert.deepEqual(packet.memoryReviewQueue.sourceIds, ['qq:1']); assert.equal(packet.memoryReviewQueue.replyEligible, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('unavailable candidate storage cannot block raw message retention or falsely confirm a review', t => {
  const dir = directory(t), store = new MemoryConsolidation(path.join(dir, 'candidates'));
  const wm = new WorkingMemory(path.join(dir, 'working'), { maxMessages: 1, getMemoryProgress: (key, ids) => store.sourceProgress(key, ids) });
  fs.mkdirSync(store.directory); fs.writeFileSync(store.file(KEY), '{broken');
  wm.record(KEY, message(1)); wm.record(KEY, message(2));
  const packet = wm.snapshot(KEY); assert.equal(packet.memoryProgress.candidateStateAvailable, false);
  assert.equal(packet.messages[0].id, 'qq:2'); assert.equal(packet.memoryProgress.reviewedSources, 0);
  wm.offered(KEY, packet);
  assert.throws(() => wm.update(KEY, { revision: packet.revision, memoryReview: { sources: ['qq:2'], outcome: 'no_memory' } }), /保留原文件/);
  assert.equal(fs.readFileSync(store.file(KEY), 'utf8'), '{broken');
});

test('public API observes source progress, preserves unrelated receipts, and reserves manual archival for administrators', async t => {
  const plugin = await startMemoryProvider();
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, allow: { groups: ['456'] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false } },
    memory: { provider: 'local', providers: [{ id: 'local', features: ['consolidation-v1'], approvalMode: 'automatic', operations: ['write','query','delete','clear'], transport: { type: 'http', url: plugin.url } }] } } });
  await h.ensureSession(KEY); const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); await plugin.close(); });
  const client = new QQBridgeClient({ baseUrl, key: KEY, token: st.agentToken });
  h.appendSocialV2Message(KEY, '成员', '合成来源1', '合成来源1', false, false, 1, [], '234');
  const { snapshot } = await client.workingContext();
  let { item } = await client.consolidateMemory('stage', { text: '合成事实1', subject: '234', category: 'preference', assertion: 'self_report', sources: [{ id: 'qq:1', quote: '合成来源1' }] });
  await client.updateWorkingContext({ revision: snapshot.revision, memoryReview: { sources: ['qq:1'], outcome: 'candidates_staged' } });
  ({ item } = await client.consolidateMemory('commit', { id: item.id, revision: item.revision }));
  ({ item } = await client.consolidateMemory('verify', { id: item.id, revision: item.revision }));
  await client.memory('write', { id: 'unrelated', subject: '234', category: 'fact', text: '独立事实' });
  assert.equal((await client.memoryCandidates()).items[0].status, 'applied');
  assert.equal((await client.workingContext()).snapshot.memoryProgress.verifiedSources, 1);
  await assert.rejects(client.consolidateMemory('archive', { id: item.id, revision: item.revision }), /管理员/);
  const response = await fetch(baseUrl + '/api/socialV2/memory-consolidation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
    body: JSON.stringify({ key: KEY, operation: 'archive', input: { id: item.id, revision: item.revision } }) });
  assert.equal(response.status, 200); assert.equal((await client.memoryCandidates({ archived: true })).total, 1);
  assert.equal((await client.workingContext()).snapshot.memoryProgress.verifiedSources, 1); assert.equal(h.calls.sent.length, 0);
  await assert.rejects(client.memoryCandidates({ archived: 'invalid' }), /archived/);
  fs.writeFileSync(h.memoryConsolidation.file(KEY), '{broken'); h.memoryConsolidation.states.delete(KEY);
  const degraded = await client.workingContext();
  assert.equal(degraded.memoryConsolidation.available, false); assert.equal(degraded.snapshot.memoryProgress.candidateStateAvailable, false);
  assert.equal(degraded.snapshot.messages[0].id, 'qq:1');
  assert.equal(h.calls.sent.length, 0);
});
