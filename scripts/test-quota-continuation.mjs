import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageQuotas } from '../src/core/usage-quotas.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const KEY = 'group:456';
const config = (resource = 'media.image') => ({ enabled: true, includeExisting: false,
  rules: [{ id: 'test-budget', resource, scope: 'global', limit: 2, windowMinutes: 3 }] });
const pause = () => new Promise(r => setTimeout(r, 2));
async function until(check) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw Error('fixture timeout'); await pause(); } }

test('waiting reservations continue after early reset without replaying completed operations', async () => {
  const q = new UsageQuotas({ config: config(), waitMs: 1000 }); const budget = {}; let completed = 0;
  const work = (async () => { for (let n = 0; n < 5; n++) { await q.waitFor(() => q.consume(KEY, 'media.image'), { budget }); completed++; } })();
  try {
    await until(() => q.waiters.size === 1); assert.equal(completed, 2);
    q.resolve(q.list()[0].requestId, 'approve');
    await until(() => completed === 4 && q.waiters.size === 1); q.resolve(q.list()[0].requestId, 'approve');
    await work; assert.equal(completed, 5); assert.equal(q.list()[0].used, 1);
  } finally { q.close(); await work.catch(() => {}); }
});
test('one task shares a fixed waiting deadline across resets; cancellation removes waiters', async () => {
  const q = new UsageQuotas({ config: config(), waitMs: 30 }); const budget = {};
  q.consume(KEY, 'media.image'); q.consume(KEY, 'media.image');
  await assert.rejects(q.waitFor(() => q.consume(KEY, 'media.image'), { budget }), { code: 'QUOTA_TIMEOUT' });
  q.resolve(q.list()[0].requestId, 'approve');
  await assert.rejects(q.waitFor(() => q.consume(KEY, 'media.image'), { budget }), { code: 'QUOTA_TIMEOUT' });
  const stop = new AbortController(); q.consume(KEY, 'media.image'); q.consume(KEY, 'media.image');
  const pending = q.waitFor(() => q.consume(KEY, 'media.image'), { signal: stop.signal });
  stop.abort(Error('fixture cancelled')); await assert.rejects(pending, /cancelled/); assert.equal(q.waiters.size, 0); q.close();
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
async function fixture(run, waitMs = 1000) {
  let downloads = 0;
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, sendDelayMs: 0, quotas: config(),
    allow: { groups: ['456', '789'], private: ['123'] }, socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, sticker: { enabled: false } } },
    globals: { UsageQuotas: class extends UsageQuotas { constructor(options) { super({ ...options, waitMs }); } },
      safeFetchBuffer: async () => { downloads++; return { buffer: png }; } } });
  await h.ensureSession(KEY); const st = h.getSocialV2State(KEY); st.bootstrapSent = true;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async (offset = 0) => {
    const r = await fetch(base + `/api/images/message?key=${KEY}&messageId=100&offset=${offset}`, { headers: { 'x-agent-token': st.agentToken, 'x-console-token': 'fixture-console-token' } });
    const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d)); return d;
  };
  const receive = count => h.handleIncoming('group', 456, { user_id: 321, self_id: 999, group_id: 456, message_id: 100,
    sender: { nickname: '成员' }, message: [{ type: 'text', data: { text: '图片测试' } }, ...Array.from({ length: count }, (_, i) => ({ type: 'image', data: { file: `fixture-${i}.png`, url: `https://public.invalid/${i}.png` } }))] }, h.cfg);
  try { await run({ h, read, receive, downloaded: () => downloads + h.calls.images.length, st, base }); }
  finally { h.usageQuotas.close(); for (const job of h.observationJobs.values()) await job.promise; server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
}
test('twelve images resume through five quota resets and pagination, each downloaded exactly once', () => fixture(async ({ h, read, receive, downloaded }) => {
  await receive(12); let finished = false, resets = 0;
  const resetting = (async () => { while (!finished) { if (h.usageQuotas.waiters.size) {
    const pending = h.usageQuotas.list().find(b => b.blocked && b.decision === 'pending'); if (pending) { h.usageQuotas.resolve(pending.requestId, 'approve'); resets++; }
  } await pause(); } })();
  const images = [];
  try {
    let offset = 0;
    do { const result = await read(offset); images.push(...result.images.filter(i => i.data)); offset = result.nextOffset; } while (offset !== null);
    assert.equal(images.length, 12); assert.equal(new Set(images.map(i => i.index)).size, 12); assert.equal(downloaded(), 12); assert.equal(resets, 5);
    await read(0); assert.equal(downloaded(), 12, 'cached completed images do not spend the next allowance');
  } finally { finished = true; await resetting; }
}));
test('timeout returns already-read images with an explicit gap instead of discarding the whole result', () => fixture(async ({ receive, read, downloaded }) => {
  await receive(3); const result = await read();
  assert.equal(result.images.filter(i => i.data).length, 2); assert.equal(result.images.at(-1).quotaTimeout, true);
  assert.equal(result.partial, true); assert.equal(result.nextOffset, null); assert.match(result.note, /超时/); assert.equal(downloaded(), 2);
}, 30));
test('media offered to the model and permanently failed old sources do not wake or download again after cache eviction', () => fixture(async ({ h, receive, downloaded }) => {
  await receive(1); await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
  assert.equal(downloaded(), 1); h.observationJobs.clear();
  const next = await h.prepareObservationV2(KEY); assert.equal(next.parts.length, 0); assert.equal(downloaded(), 1);
}));

test('one group waiting to send does not block other conversations or administrator quota notification', () => fixture(async ({ h }) => {
  h.usageQuotas.configure({ enabled: true, includeExisting: false, rules: [{ id: 'send', resource: 'send.message', scope: 'exact', key: KEY, limit: 1, windowMinutes: 3 }] });
  h.usageQuotas.consume(KEY, 'send.message');
  const blocked = h.sendToQQ(KEY, '等待恢复后发送');
  await until(() => h.usageQuotas.waiters.size === 1);
  await h.sendToQQ('group:789', '其他群正常发送');
  assert.ok(h.calls.sent.some(m => m.kind === 'group' && m.id === 789));
  assert.ok(h.calls.sent.some(m => m.kind === 'private' && m.id === 123));
  const b = h.usageQuotas.list().find(b => b.blocked); h.usageQuotas.resolve(b.requestId, 'approve'); await blocked;
  assert.ok(h.calls.sent.some(m => m.kind === 'group' && m.id === 456));
}));

test('media evidence outside the bounded text snapshot can still receive a verified understanding summary', () => fixture(async ({ h, receive, read }) => {
  await receive(1); await read();
  const state = h.workingMemory.get(KEY), sourceId = state.messages.at(-1).media[0].sourceId;
  h.workingMemory.receipts.delete(KEY);
  h.workingMemory.offered(KEY, { messages: [], media: [], topics: [], facts: [], questions: [], uncertainties: [] }, [sourceId]);
  h.workingMemory.update(KEY, { revision: state.revision, media: [{ sourceId, summary: '已提供证据的图片' }] });
  assert.equal(h.workingMemory.get(KEY).media.find(m => m.sourceId === sourceId).status, 'understood');
}));
