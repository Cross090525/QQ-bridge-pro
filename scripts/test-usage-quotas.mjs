import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { UsageQuotas, normalizeQuotaConfig } from '../src/core/usage-quotas.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { DebateTasks } from '../src/framework/debate.mjs';
import { runDebateWorker } from '../src/framework/debate-runner.mjs';

const KEY = 'group:456';
const rule = (resource = 'media.image', extra = {}) => ({ id: resource.replaceAll('.', '-'), resource, scope: 'global', limit: 2, windowMinutes: 60, ...extra });
const config = rules => ({ enabled: true, includeExisting: false, rules });
function unit(rules = [rule()], extra = {}) {
  let now = 100000, saved; const notifications = [];
  const quotas = new UsageQuotas({ config: config(rules), now: () => now, save: s => saved = structuredClone(s), notify: b => notifications.push(b), ...extra });
  return { quotas, notifications, advance: ms => now += ms, state: () => saved };
}
const flush = () => new Promise(r => setImmediate(r));

test('last allowed read is reserved; exhaustion notifies once, survives restart within its window and expires automatically', async () => {
  const f = unit(); f.quotas.consume(KEY, 'media.image'); const final = f.quotas.consume(KEY, 'media.image');
  final.check(); await flush(); assert.equal(f.notifications.length, 1); assert.equal(f.quotas.list()[0].used, 2);
  for (let n = 0; n < 20; n++) assert.throws(() => f.quotas.consume(KEY, 'media.image'), { code: 'QUOTA_EXHAUSTED' });
  assert.equal(f.state().buckets[0].blocked, undefined, 'suspension is not a persisted flag');
  const restored = new UsageQuotas({ config: config([rule()]), state: f.state(), now: () => 100000 });
  assert.throws(() => restored.consume(KEY, 'media.image'), { code: 'QUOTA_EXHAUSTED' }); restored.close();
  f.advance(86400000); assert.equal(f.quotas.list()[0].blocked, false); f.quotas.consume(KEY, 'media.image');
  assert.equal(f.quotas.list()[0].used, 1); await flush(); assert.equal(f.notifications.length, 1);
});
test('one approval resets only its bound bucket and starts a new finite window', () => {
  const f = unit([rule('media.image', { limit: 1 }), rule('media.video', { limit: 1 })]);
  const old = f.quotas.consume(KEY, 'media.image'); f.quotas.consume(KEY, 'media.video');
  const image = f.quotas.list().find(b => b.resource === 'media.image');
  const result = f.quotas.resolve(image.requestId, 'approve'); assert.equal(result.used, 0); assert.equal(result.blocked, false);
  assert.throws(() => old.check(), /变更/); assert.throws(() => f.quotas.resolve(image.requestId, 'approve'), /已处理/);
  assert.throws(() => f.quotas.consume(KEY, 'media.video'), { code: 'QUOTA_EXHAUSTED' }); f.quotas.consume(KEY, 'media.image');
  assert.notEqual(f.quotas.list().find(b => b.resource === 'media.image').requestId, image.requestId);
});
test('denial prevents early reset; administrator may reapply and deadlines invalidate old decisions', async () => {
  const f = unit([rule('media.image', { limit: 1 })]); f.quotas.consume(KEY, 'media.image'); const b = f.quotas.list()[0];
  await flush();
  f.quotas.resolve(b.requestId, 'deny'); assert.throws(() => f.quotas.consume(KEY, 'media.image'), { code: 'QUOTA_EXHAUSTED' });
  assert.throws(() => f.quotas.resolve(b.requestId, 'approve'), /已处理/);
  const next = f.quotas.requestAgain(b.id); assert.notEqual(next.requestId, b.requestId); await flush(); f.quotas.resolve(next.requestId, 'approve');
  f.quotas.consume(KEY, 'media.image'); await flush(); assert.equal(f.notifications.length, 3);
  const last = f.quotas.list()[0]; f.advance(99999999); assert.equal(f.quotas.list()[0].blocked, false);
  assert.throws(() => f.quotas.resolve(last.requestId, 'approve'), /窗口已结束/);
});
test('unexhausted windows renew normally; global, conversation and exact scopes compose atomically', () => {
  const f = unit([rule('media.image', { scope: 'conversation', limit: 2, windowMinutes: 1 }), rule('media.image', { id: 'global', limit: 3 }), rule('media.image', { id: 'exact', scope: 'exact', key: 'group:789', limit: 1 })]);
  f.quotas.consume(KEY, 'media.image'); f.advance(60001); f.quotas.consume(KEY, 'media.image');
  assert.equal(f.quotas.list().find(b => b.key === KEY).used, 1);
  f.quotas.consume('group:789', 'media.image');
  const before = f.quotas.list(); assert.throws(() => f.quotas.consume(KEY, 'media.image'), { code: 'QUOTA_EXHAUSTED' }); assert.deepEqual(f.quotas.list(), before);
  assert.equal(f.quotas.list().find(b => b.ruleId === 'exact').used, 1);
});
test('concurrent attempts cannot overspend, and storage failures do not grant work', async () => {
  const f = unit([rule('media.image', { limit: 3 })]);
  const results = await Promise.allSettled(Array.from({ length: 30 }, async () => f.quotas.consume(KEY, 'media.image')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3); assert.equal(f.quotas.list()[0].used, 3);
  const broken = unit([rule()], { save: () => { throw Error('disk full'); } });
  assert.throws(() => broken.quotas.consume(KEY, 'media.image'), /disk full/); assert.equal(broken.quotas.list().length, 0);
});
test('existing minute/hour limits share automatic renewal and optional early reset', () => {
  const q = new UsageQuotas({ config: { enabled: true, includeExisting: true } });
  const legacy = [[60000, 1], [3600000, 3]];
  q.consume(KEY, 'model.wake', { legacy }); assert.throws(() => q.consume(KEY, 'model.wake', { legacy }), { code: 'QUOTA_EXHAUSTED' });
  const minute = q.list().find(b => b.windowMs === 60000); q.resolve(minute.requestId, 'approve'); q.consume(KEY, 'model.wake', { legacy });
  assert.equal(q.list().find(b => b.windowMs === 3600000).used, 2);
});
test('configuration preserves usage counts; malformed state fails closed', () => {
  const f = unit([rule('media.image', { limit: 1 })]); f.quotas.consume(KEY, 'media.image');
  f.quotas.configure(config([rule('media.image', { limit: 1 })])); assert.throws(() => f.quotas.consume(KEY, 'media.image'), { code: 'QUOTA_EXHAUSTED' });
  f.quotas.configure(config([rule('media.image', { limit: 100 })])); f.quotas.consume(KEY, 'media.image'); assert.equal(f.quotas.list()[0].used, 2);
  for (const state of [{}, { version: 1, buckets: [{}] }, { ...f.state(), buckets: [f.state().buckets[0], f.state().buckets[0]] }]) assert.throws(() => new UsageQuotas({ state }), /损坏/);
  for (const c of [null, { rules: [{}] }, config([rule('bad')]), config([rule(), rule()]), config([rule('media.image', { limit: 0 })]), config([rule('media.image', { scope: 'exact', key: 'any' })])]) assert.throws(() => normalizeQuotaConfig(c));
});
test('deadline timer resumes pending work without new input or an open console', () => {
  let callback, resumed = 0;
  const f = unit([rule('media.image', { limit: 1, windowMinutes: 1 })], { setTimer: fn => { callback = fn; return {}; }, clearTimer: () => {}, onReset: () => resumed++ });
  f.quotas.consume(KEY, 'media.image'); assert.equal(resumed, 0); f.advance(60000); callback();
  assert.equal(resumed, 1); assert.equal(f.state().buckets[0].used, 0); f.quotas.close();
});
test('a read reserved before its deadline may finish after natural renewal; early reset revokes old reservations', () => {
  const f = unit([rule('media.video', { limit: 1, windowMinutes: 1 })]);
  const lease = f.quotas.consume(KEY, 'media.video'); f.advance(60000); f.quotas.list(); assert.doesNotThrow(() => lease.check());
  const next = f.quotas.consume(KEY, 'media.video'); f.quotas.resolve(f.quotas.list()[0].requestId, 'approve'); assert.throws(() => next.check(), /变更/); f.quotas.close();
});
test('debate worker waits without model calls at quota and resumes after early reset', { timeout: 10000 }, async () => {
  const f = unit([rule('debate.analysis', { limit: 1 })]);
  const tasks = new DebateTasks({ assertGroup: () => 'policy', beforeBatch: task => f.quotas.consume(task.key, 'debate.analysis') });
  const task = tasks.get(tasks.create({ key: KEY, targetId: '234', topic: '电池', keywords: ['电池'] }).task.id);
  tasks.ingest(KEY, { userId: '234', messageId: '1', text: '电池论点' });
  const stop = new AbortController(); let analyses = 0, blocked;
  const didBlock = new Promise(r => blocked = r);
  const client = {
    task: async () => ({ task: tasks.view(task) }),
    batch: async workerId => ({ task: tasks.view(task), batch: tasks.batch(task, workerId) }),
    heartbeat: async input => { const result = tasks.heartbeat(task, input); if (input.error === 'quota_exhausted') blocked(); return { task: result }; },
    submit: async input => ({ draft: await tasks.submit(task, input) }),
  };
  const work = runDebateWorker({ client, signal: stop.signal, analyzer: { analyze: async (_task, messages) => {
    analyses++; return { text: '', analysis: '记录争点', verdict: 'skip', evidenceIds: [messages[0].id] };
  } }, onResult: result => { if (!result.draft) return;
    if (analyses === 1) tasks.ingest(KEY, { userId: '234', messageId: '2', text: '第二个电池论点' });
    else stop.abort();
  } });
  try {
    await didBlock; assert.equal(analyses, 1); assert.equal(task.processedThrough, 1);
    f.quotas.resolve(f.quotas.list()[0].requestId, 'approve'); await work;
    assert.equal(analyses, 2); assert.equal(task.processedThrough, 2);
  } finally { stop.abort(); await work.catch(() => {}); f.quotas.close(); }
});

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
async function fixture(run, overrides = {}, globals = {}) {
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, sendDelayMs: 0, quotas: config([rule()]),
    allow: { groups: ['456', '789'], private: ['123'] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, sticker: { enabled: false }, wake: { preSleepWaitEnabled: false } }, ...overrides }, globals });
  await h.ensureSession(KEY); const st = h.getSocialV2State(KEY); st.bootstrapSent = true;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, headers = {}) => {
    const r = await fetch(baseUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const receive = (id, message, kind = 'group', user = 321) => h.handleIncoming(kind, kind === 'group' ? 456 : user,
    { self_id: 999, message_id: id, user_id: user, group_id: kind === 'group' ? 456 : undefined, sender: { nickname: '成员' }, message }, h.cfg);
  try { await run({ h, st, request, receive, baseUrl }); }
  finally { for (const job of h.observationJobs.values()) await job.promise; server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
}
const image = id => [{ type: 'image', data: { file: `fixture-${id}.png`, url: `https://public.invalid/${id}.png` } }];
test('automatic image preparation stops exactly at its quota; plaintext observation continues and approval retries blocked media', () => fixture(async ({ h, receive, request }) => {
  for (let n = 1; n <= 3; n++) await receive(n, image(n));
  await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
  assert.equal(h.calls.prompts.at(-1).content.filter(c => c.type === 'image').length, 2);
  const state = h.workingMemory.get(KEY); assert.equal(state.media.filter(m => m.status === 'quota_blocked').length, 1);
  const bucket = h.usageQuotas.list()[0]; assert.equal(bucket.used, 2); assert.equal(bucket.blocked, true);
  await flush(); assert.ok(h.calls.sent.some(m => JSON.stringify(m).includes('/quota-approve')));
  const persisted = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/usage-quotas.json'), 'utf8')); assert.equal(persisted.buckets[0].used, 2); assert.equal(persisted.buckets[0].blocked, undefined);
  const approved = await request('/api/quotas/review', { requestId: bucket.requestId, decision: 'approve' }); assert.equal(approved.status, 200);
  await h.deliverPrompt(KEY, '', { wakeReason: 'observation' }); assert.equal(h.usageQuotas.list()[0].used, 1);
  assert.ok(h.calls.prompts.at(-1).content.some(c => c.type === 'image'));
}, {}, { safeFetchBuffer: async () => ({ buffer: Buffer.from(png, 'base64') }) }));
test('manual image tools share the same quota and cannot bypass a global exhausted bucket', () => fixture(async ({ h, receive, request, st }) => {
  await receive(1, image(1)); await h.prepareObservationV2(KEY);
  const headers = { 'x-agent-token': st.agentToken };
  const read = await request('/api/images/message?key=group%3A456&messageId=1', undefined, headers);
  assert.equal(read.status, 429, JSON.stringify(read)); assert.equal(read.data.code, 'QUOTA_EXHAUSTED');
  assert.equal(h.usageQuotas.list()[0].used, 1);
}, { quotas: config([rule('media.image', { limit: 1 })]) }, { safeFetchBuffer: async () => ({ buffer: Buffer.from(png, 'base64') }) }));
test('quota management is admin-only; only owner private command can reset and denial stays paused', () => fixture(async ({ h, receive, request }) => {
  h.usageQuotas.consume(KEY, 'media.image'); h.usageQuotas.consume(KEY, 'media.image'); const b = h.usageQuotas.list()[0];
  for (const headers of [{ 'x-agent-token': 'bad' }, { 'x-agent-call': '1' }, { 'x-debate-token': 'bad' }]) {
    assert.equal((await request('/api/quotas/status', undefined, headers)).status, 403);
    assert.equal((await request('/api/quotas/review', { requestId: b.requestId, decision: 'approve' }, headers)).status, 403);
    assert.equal((await request('/api/quotas/config', config([]), headers)).status, 403);
  }
  await receive(7, [{ type: 'text', data: { text: '/quota-approve ' + b.requestId } }], 'group', 123); assert.equal(h.usageQuotas.list()[0].blocked, true);
  await receive(8, [{ type: 'text', data: { text: '/quota-approve ' + b.requestId } }], 'private', 123); assert.equal(h.usageQuotas.list()[0].blocked, false);
  assert.equal((await request('/api/quotas/review', { requestId: b.requestId, decision: 'approve' })).status, 409);
  assert.equal(h.calls.prompts.length, 0);
}));
test('configuration persists; ordinary session reset does not clear exhausted usage', () => fixture(async ({ h, receive, request }) => {
  const r = await request('/api/quotas/config', config([rule('media.video', { limit: 1, windowMinutes: 30 })])); assert.equal(r.status, 200);
  h.usageQuotas.consume(KEY, 'media.video'); const b = h.usageQuotas.list()[0];
  await receive(9, [{ type: 'text', data: { text: '/reset' } }], 'private', 123);
  assert.equal(h.usageQuotas.list().find(x => x.id === b.id).blocked, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))).quotas.rules[0].windowMinutes, 30);
}));
test('execution-time send quota cannot be overspent by concurrent queued sends; admin notification bypasses only its own gate', () => fixture(async ({ h, request }) => {
  const results = await Promise.all([h.sendToQQ(KEY, '一'), h.sendToQQ(KEY, '二'), h.sendToQQ(KEY, '三')]); await flush();
  assert.equal(h.calls.sent.filter(m => m.kind === 'group').length, 2);
  assert.equal(h.usageQuotas.list()[0].used, 2); assert.equal(h.usageQuotas.list()[0].blocked, true);
  assert.ok(h.calls.sent.some(m => JSON.stringify(m).includes('/quota-approve')));
  assert.equal((await request('/api/quotas/status')).status, 200); assert.equal(results.length, 3);
}, { quotas: config([rule('send.message')]) }));

test('video frames and transcript share one automatic video allowance; manual services also stop before external execution', async () => {
  let calls = 0;
  const provider = http.createServer((req, res) => { calls++; req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'sampled video evidence' }, { type: 'image', mimeType: 'image/png', data: png }] })); });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const services = ['bilibili.frames', 'bilibili.transcript'].map(id => ({ id, effect: 'read', accepts: ['link'], transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }));
  try {
    await fixture(async ({ h, receive }) => {
      await receive(1, [{ type: 'text', data: { text: 'https://www.bilibili.com/video/BV1234567890' } }]); await h.prepareObservationV2(KEY);
      assert.equal(calls, 2); assert.equal(h.usageQuotas.list()[0].used, 1);
      await receive(2, [{ type: 'text', data: { text: 'https://www.bilibili.com/video/BV0987654321' } }]); await h.prepareObservationV2(KEY); assert.equal(calls, 2);
      const source = [...h.contentSources.items.values()].find(s => s.key === KEY && s.messageId === '2');
      await assert.rejects(h.contentServices.call({ key: KEY, scope: 'fixture', serviceId: services[0].id, source, input: {} }), { code: 'QUOTA_EXHAUSTED' }); assert.equal(calls, 2);
    }, { quotas: config([rule('media.video', { limit: 1 })]), framework: { services,
      permissions: { rules: services.map(s => ({ key: KEY, capability: s.id, decision: 'allow', dataScopes: ['source-reference'] })) } } });
  } finally { provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
});
