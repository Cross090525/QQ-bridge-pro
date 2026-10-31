import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DebateTasks } from '../src/framework/debate.mjs';
import { buildDebateInput, DshDebateAnalyzer } from '../src/framework/debate-analyzer.mjs';
import { processDebateBatch, runDebateWorker } from '../src/framework/debate-runner.mjs';
import { DebateClient } from '../src/debate-client.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const KEY = 'group:456';
const input = extra => ({ key: KEY, targetId: '234', topic: '电池安全', keywords: ['电池'], durationMinutes: 30, sendMode: 'auto', ...extra });
const event = (n, text = `电池论点${n}`) => ({ messageId: String(n), userId: '234', text, sender: '测试成员' });
const draft = (batch, extra = {}) => ({ batchId: batch.id, requestId: 'request-' + batch.id, requestSeq: 1,
  taskRevision: batch.taskRevision, throughEventId: batch.throughEventId, text: '请明确证据来源', analysis: '当前证据不足',
  verdict: 'uncertain', evidenceIds: [batch.messages[0].id], ...extra });
const facade = (tasks, task) => ({
  batch: async id => ({ batch: tasks.batch(task, id), task: tasks.view(task) }), task: async () => ({ task: tasks.view(task) }),
  submit: async value => ({ draft: await tasks.submit(task, value) }),
  heartbeat: async value => ({ task: tasks.heartbeat(task, value) }),
});
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw Error('fixture timeout'); await pause(); } }

test('40 events are analyzed oldest-first in two exact batches, with state carried forward and no early speech', async () => {
  const sent = [], analyzed = [];
  const tasks = new DebateTasks({ assertGroup: () => 'policy', send: async (_key, text) => sent.push(text) });
  const task = tasks.get(tasks.create(input()).task.id);
  for (let n = 1; n <= 40; n++) tasks.ingest(KEY, event(n));
  const client = facade(tasks, task);
  const analyzer = { analyze: async (_task, messages, options) => {
    analyzed.push(messages.map(m => m.id));
    if (messages[0].id === 21) assert.equal(options.debateState.claims[0].text, '尚未解决的争点');
    return { text: '前文追平后再回应', analysis: '根据本批消息整理', verdict: 'uncertain', evidenceIds: [messages[0].id],
      state: { claims: [{ text: '尚未解决的争点', side: 'target', status: 'open', evidenceIds: [1] }], questions: [], position: '证据不足' } };
  } };
  const first = await processDebateBatch({ client, analyzer });
  assert.equal(first.draft.status, 'skipped'); assert.equal(sent.length, 0); assert.equal(task.processedThrough, 20);
  await processDebateBatch({ client, analyzer });
  assert.equal(sent.length, 1); assert.equal(task.processedThrough, 40);
  assert.deepEqual(analyzed.flat(), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal((await processDebateBatch({ client, analyzer })).idle, true);
});

test('batch receipts reject skipped cursors, unseen citations and invented state evidence', async () => {
  const tasks = new DebateTasks({ assertGroup: () => 'policy', send: async () => assert.fail('must not send') });
  const task = tasks.get(tasks.create(input()).task.id);
  for (let n = 1; n <= 40; n++) tasks.ingest(KEY, event(n));
  const batch = tasks.batch(task);
  assert.equal(buildDebateInput(task, task.events).messages[0].id, 1);
  await assert.rejects(tasks.submit(task, draft(batch, { throughEventId: 40 })), /批次/);
  await assert.rejects(tasks.submit(task, draft(batch, { evidenceIds: [40] })), /批次|throughEventId/);
  await assert.rejects(tasks.submit(task, draft(batch)), /未分析前文/);
  await assert.rejects(tasks.submit(task, draft(batch, { verdict: 'skip', text: '', state: { claims: [{ text: '捏造来源', side: 'target', status: 'open', evidenceIds: [40] }] } })), /证据/);
  assert.equal(task.processedThrough || 0, 0); assert.equal(task.drafts.size, 0);
});

test('a correction invalidates a reviewed draft; changed media invalidates both submission and queued send', async () => {
  let context = { media: '未知' }, release, entered;
  const tasks = new DebateTasks({ assertGroup: () => 'policy', readContext: () => context,
    send: async (_key, _text, check) => { entered = true; await new Promise(r => release = r); check(); assert.fail('stale send'); } });
  const task = tasks.get(tasks.create(input({ sendMode: 'review' })).task.id); tasks.ingest(KEY, event(1));
  const submitted = await tasks.submit(task, draft(tasks.batch(task)));
  tasks.ingest(KEY, event(2, '更正，刚才的结论撤回'));
  await assert.rejects(tasks.review(task.id, submitted.id, 'approve'), /过期|处理/);
  assert.equal(task.drafts.get(submitted.id).status, 'stale');
  const batch = tasks.batch(task); context = { media: '新的媒体理解' };
  await assert.rejects(tasks.submit(task, draft(batch, { requestSeq: 2 })), /上下文已变化/);
  const fresh = tasks.batch(task);
  const next = await tasks.submit(task, draft(fresh, { requestSeq: 2 }));
  const sending = tasks.review(task.id, next.id, 'approve'); await until(() => entered);
  context = { media: '媒体理解再次更正' }; release();
  await assert.rejects(sending, /上下文已变化/); assert.equal(task.drafts.get(next.id).status, 'stale');
});

test('worker leases, monotonic heartbeats and takeover reject late workers without resurrecting stopped state', async () => {
  let now = 1000;
  const tasks = new DebateTasks({ now: () => now, assertGroup: () => 'policy' });
  const task = tasks.get(tasks.create(input()).task.id); tasks.ingest(KEY, event(1));
  const a = 'aaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbb';
  tasks.heartbeat(task, { workerId: a, sequence: 1, state: 'analyzing' });
  const batch = tasks.batch(task, a);
  assert.throws(() => tasks.heartbeat(task, { workerId: b, sequence: 1, state: 'idle' }), /另一个worker/);
  now += 6001; assert.equal(tasks.view(task).worker.online, false);
  tasks.heartbeat(task, { workerId: b, sequence: 1, state: 'idle' });
  await assert.rejects(tasks.submit(task, draft(batch)), /worker/);
  tasks.heartbeat(task, { workerId: b, sequence: 3, state: 'stopped' });
  tasks.heartbeat(task, { workerId: b, sequence: 2, state: 'analyzing' });
  assert.equal(tasks.view(task).worker.online, false); assert.equal(task.worker.state, 'stopped');
});

test('media-only context changes trigger reassessment without inventing new events or replaying a batch', async () => {
  let media = '待理解'; const tasks = new DebateTasks({ assertGroup: () => 'policy', readContext: () => ({ media }) });
  const task = tasks.get(tasks.create(input({ sendMode: 'review' })).task.id); tasks.ingest(KEY, event(1));
  await tasks.submit(task, draft(tasks.batch(task)));
  assert.equal(tasks.batch(task), null); media = '已理解视频，前提需要更正';
  assert.equal(tasks.view(task).needsReassessment, true);
  const batch = tasks.batch(task); assert.equal(batch.refresh, true); assert.equal(batch.throughEventId, 1);
  await tasks.submit(task, draft(batch, { requestSeq: 2, text: '', verdict: 'skip' }));
  assert.equal(task.nextEvent, 1); assert.equal(task.processedThrough, 1); assert.equal(tasks.batch(task), null);
});

test('analysis cannot smuggle a task credential through the shared dispute state', async () => {
  const tasks = new DebateTasks({ assertGroup: () => 'policy' }); const created = tasks.create(input());
  const task = tasks.get(created.task.id); tasks.ingest(KEY, event(1));
  await assert.rejects(tasks.submit(task, draft(tasks.batch(task), { state: { position: created.token } })), /凭据/);
  assert.equal(task.drafts.size, 0); assert.equal(task.debateState.position, '');
});

test('worker reports an evicted-event gap and never silently resets its cursor', async () => {
  const tasks = new DebateTasks({ assertGroup: () => 'policy' });
  const task = tasks.get(tasks.create(input()).task.id);
  for (let n = 1; n <= 205; n++) tasks.ingest(KEY, event(n));
  const stop = new AbortController(), client = facade(tasks, task), heartbeat = client.heartbeat;
  client.heartbeat = async value => { const result = await heartbeat(value); if (value.error === 'context_gap') stop.abort(); return result; };
  await runDebateWorker({ client, signal: stop.signal, analyzer: { analyze: () => assert.fail('gap must not reach model') } });
  assert.equal(task.worker.state, 'stopped'); assert.equal(task.worker.error, 'context_gap'); assert.equal(task.processedThrough || 0, 0);
});

test('personality formatting is a second tool-free phase and cannot change verdict or citations', async () => {
  const analyzer = new DshDebateAnalyzer({ api: {}, cwd: '/fixture' }); const phases = [];
  analyzer.run = async value => {
    phases.push(value.phase);
    if (value.phase === 'analysis') { assert.equal(value.context.persona, undefined); return { text: '请提供来源', analysis: '证据不足', verdict: 'uncertain', evidenceIds: [1] }; }
    assert.equal(value.context.persona, '说话简短，带点傲娇');
    return { text: '哼，来源呢', analysis: '表达阶段', verdict: 'uncertain', evidenceIds: [1] };
  };
  const result = await analyzer.analyze(input(), [{ id: 1, text: '电池结论' }], { context: { persona: '说话简短，带点傲娇' } });
  assert.deepEqual(phases, ['analysis', 'expression']); assert.equal(result.text, '哼，来源呢'); assert.equal(result.analysis, '证据不足');
  analyzer.run = async value => ({ text: '改变结论', analysis: 'x', verdict: value.phase === 'analysis' ? 'uncertain' : 'counterargument', evidenceIds: [1] });
  await assert.rejects(analyzer.analyze(input(), [{ id: 1, text: '电池' }], { context: { persona: '人设' } }), /改变了结论/);
});

test('cancellation while checking task freshness never submits an already-computed draft', async () => {
  const tasks = new DebateTasks({ assertGroup: () => 'policy' });
  const task = tasks.get(tasks.create(input()).task.id); tasks.ingest(KEY, event(1));
  const stop = new AbortController(), client = facade(tasks, task); let entered, release, submissions = 0;
  client.task = async () => { entered = true; await new Promise(r => release = r); return { task: tasks.view(task) }; };
  client.submit = async () => { submissions++; assert.fail('cancelled draft'); };
  const work = processDebateBatch({ client, signal: stop.signal, analyzer: { analyze: async () => ({ text: '草稿', analysis: '简短依据', verdict: 'uncertain', evidenceIds: [1] }) } });
  await until(() => entered); stop.abort(); release();
  await assert.rejects(work, /abort/i); assert.equal(submissions, 0);
});

test('stopping the standard worker releases its lease before a queued automatic send executes', async () => {
  let entered, release, sends = 0;
  const tasks = new DebateTasks({ assertGroup: () => 'policy', send: async (_key, _text, check) => {
    entered = true; await new Promise(r => release = r); check(); sends++;
  } });
  const task = tasks.get(tasks.create(input()).task.id); tasks.ingest(KEY, event(1));
  const stop = new AbortController();
  const work = runDebateWorker({ client: facade(tasks, task), signal: stop.signal,
    analyzer: { analyze: async () => ({ text: '待发送草稿', analysis: '证据不足', verdict: 'uncertain', evidenceIds: [1] }) } });
  await until(() => entered); stop.abort(); await until(() => task.worker.state === 'stopped'); release(); await work;
  assert.equal(sends, 0); assert.equal(task.status, 'active'); assert.equal(tasks.view(task).worker.online, false);
});

async function fixture(run, globals = {}) {
  const h = await bridgeHarness({ config: { dualMode: { enabled: true, ownerPreset: 'standard' },
    allow: { private: ['123'], groups: ['456', '789'] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, sticker: { enabled: false }, wake: { preSleepWaitEnabled: false } } },
    files: { 'roles/tester.md': '说话简短，带点傲娇。', 'state/current-role.json': { role: 'tester', mode: 'active' } }, globals });
  await h.ensureSession(KEY); const st = h.getSocialV2State(KEY); st.bootstrapSent = true;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const normal = new QQBridgeClient({ baseUrl, key: KEY, token: st.agentToken });
  const created = h.debateTasks.create(input({ includeContext: true }));
  const client = new DebateClient({ baseUrl, taskId: created.task.id, token: created.token });
  const task = h.debateTasks.get(created.task.id);
  const receive = async (n, text) => h.handleIncoming('group', 456, { self_id: 999, message_id: n, user_id: 234,
    group_id: 456, sender: { nickname: '测试成员' }, message: [{ type: 'text', data: { text } }] }, h.cfg);
  try { await run({ h, st, normal, client, task, receive, baseUrl }); }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
}

test('target off-topic messages still trigger ordinary observation when no worker is online', () => fixture(async ({ h, st, task, receive }) => {
  await receive(1, '晚上吃什么');
  assert.equal(task.events.length, 1); assert.equal(st.pendingWakeReason, 'observation');
  assert.equal(h.workingMemory.get(KEY).messages.length, 1); assert.equal(h.debateTasks.view(task).worker.online, false);
}));

test('task token receives only same-group related context and media summaries; explicit opt-out works', () => fixture(async ({ h, client, task, receive, baseUrl }) => {
  h.workingMemory.record('group:789', { id: 'foreign', sender: '其他群', text: '电池 FOREIGN_SECRET' });
  h.workingMemory.record(KEY, { id: 'related', sender: '背景成员', text: '电池历史背景', content: [{ type: 'video', sourceId: 'fixture-media' }] });
  h.workingMemory.media(KEY, 'fixture-media', { status: 'understood', summary: '视频前30秒介绍电池，后面未知' });
  h.workingMemory.record(KEY, { id: 'unrelated', sender: '路人', text: 'UNRELATED_SECRET' });
  await receive(1, '电池是否安全');
  const batch = (await client.batch()).batch;
  const body = JSON.stringify(batch.context);
  assert.match(body, /电池历史背景/); assert.match(body, /视频前30秒/); assert.match(body, /傲娇/);
  assert.doesNotMatch(body, /FOREIGN_SECRET|UNRELATED_SECRET|fixture-console-token/);
  task.includeContext = false;
  const limited = (await client.batch()).batch.context;
  assert.deepEqual(limited.messages, []); assert.deepEqual(limited.media, []);
  const swap = await fetch(baseUrl + '/api/v1/debate/batch?taskId=' + task.id, { method: 'POST',
    headers: { 'x-debate-token': client.token, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'group:789' }) });
  assert.equal(swap.status, 403);
}));

test('ordinary reply ahead in the shared send queue invalidates a stale debate reply', () => fixture(async ({ h, normal, client, task, receive }) => {
  await receive(1, '电池是否安全'); const batch = (await client.batch()).batch;
  let release; const blocked = new Promise(r => release = r); h.setSendChain(blocked);
  const ordinary = normal.send(['普通会话先回应']); await until(() => h.getSendChain() !== blocked);
  const debate = client.submit(draft(batch)); await until(() => task.drafts.size > 0);
  release(); await ordinary; await assert.rejects(debate, /上下文|发送失败/);
  assert.equal(h.calls.http.filter(x => x.url.endsWith('/send_group_msg')).length, 1);
}));

test('debate reply ahead in the queue requires ordinary agent to refresh before sending', () => fixture(async ({ h, normal, client, task, receive }) => {
  await receive(1, '电池是否安全'); await normal.workingContext(); const batch = (await client.batch()).batch;
  let release; const blocked = new Promise(r => release = r); h.setSendChain(blocked);
  const debate = client.submit(draft(batch)); await until(() => task.drafts.size > 0);
  const ordinary = normal.send(['旧上下文中的回应']); await pause(); release();
  assert.equal((await debate).draft.status, 'sent'); await assert.rejects(ordinary, /新的争论发言/);
  assert.equal(h.calls.http.filter(x => x.url.endsWith('/send_group_msg')).length, 1);
  await normal.workingContext(); await normal.send(['看过新回复后再补充']);
  assert.equal(h.calls.http.filter(x => x.url.endsWith('/send_group_msg')).length, 2);
}));

test('a multi-part debate reply does not invalidate itself, and actual output is recorded once per part', () => fixture(async ({ h, client, task, receive }) => {
  await receive(1, '电池是否安全'); const batch = (await client.batch()).batch;
  const result = await client.submit(draft(batch, { text: '论点与证据。'.repeat(300) }));
  assert.equal(result.draft.status, 'sent');
  const sent = h.workingMemory.get(KEY).messages.filter(m => m.isSelf && m.origin === 'debate');
  assert.ok(sent.length > 1); assert.ok(sent.every(m => m.debateTaskId === task.id));
  assert.equal(sent.length, h.calls.http.filter(x => x.url.endsWith('/send_group_msg')).length);
}));

test('a correction between message parts preserves confirmed partial delivery for future analysis', async () => {
  let runtime, parts = 0;
  await fixture(async ({ h, client, task, receive }) => {
    runtime = h;
    await receive(1, '电池是否安全'); const batch = (await client.batch()).batch;
    await assert.rejects(client.submit(draft(batch, { text: '论点与证据。'.repeat(300) })), /上下文|发送失败/);
    const failed = [...task.drafts.values()][0];
    assert.equal(failed.status, 'stale'); assert.equal(parts, 1); assert.equal(failed.deliveredText.length, 500);
    const next = (await client.batch()).batch;
    assert.equal(next.recentResponses[0].partial, true); assert.equal(next.recentResponses[0].deliveredText, failed.deliveredText);
  }, { fetch: async url => {
    if (String(url).endsWith('/send_group_msg') && ++parts === 1) runtime.debateTasks.ingest(KEY, event(2, '更正，原结论撤回'));
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  } });
});
