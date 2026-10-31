import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { DebateRequests, normalizeDebateWake, parseDebateWake } from '../src/framework/debate-requests.mjs';
import { DebateTasks } from '../src/framework/debate.mjs';
import { ManagedDebateWorkers } from '../src/framework/debate-workers.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const text = value => ({ type: 'text', data: { text: value } });
const at = qq => ({ type: 'at', data: { qq: String(qq) } });
const segments = () => [text('开个辩论 '), at(234), text(' 电池安全 | 电池,事故')];
const config = normalizeDebateWake({ enabled: true, phrases: ['开个辩论', '启动争论'], durationMinutes: 10, sendMode: 'review', includeContext: true });
const receive = (r, extra = {}) => r.receive({ key: 'group:456', userId: '345', selfId: '999', messageId: '1', segments: segments(), ...extra });
function fixture(extra = {}) {
  let now = 1000000, allowed = true; const starts = [], audit = [];
  const assertGroup = (key, policy) => { if (!allowed || key !== 'group:456' || (policy !== undefined && policy !== 'policy')) throw Error('group denied'); return 'policy'; };
  const tasks = new DebateTasks({ now: () => now, assertGroup, send: () => assert.fail('must not send') });
  const requests = new DebateRequests({ config, tasks, assertGroup, now: () => now, audit: e => audit.push(e), start: async c => starts.push(c), ...extra });
  return { tasks, requests, starts, audit, advance: n => now += n, revoke: () => allowed = false };
}
function fakeSpawner(records, failure = false) {
  return (...args) => {
    const child = new EventEmitter(); child.kill = signal => { child.killed = signal || 'SIGTERM'; queueMicrotask(() => child.emit('exit', 0, signal)); return true; };
    records.push({ args, child }); queueMicrotask(() => child.emit(failure ? 'error' : 'spawn', failure ? Error('fixture failure') : undefined)); return child;
  };
}

test('literal customizable triggers parse only current text and explicit QQ target', () => {
  assert.deepEqual(parseDebateWake(segments(), config, '999'), { targetId: '234', topic: '电池安全', keywords: ['电池', '事故'] });
  assert.equal(parseDebateWake([text('启动争论 234 电池')], config, '999').targetId, '234');
  assert.equal(parseDebateWake([at(999), ...segments()], config, '999').targetId, '234');
  for (const value of ['我说开个辩论 234 电池', '开个辩论家 234 电池', '开启辩论 234 电池']) assert.equal(parseDebateWake([text(value)], config, '999'), null);
  assert.equal(parseDebateWake([{ type: 'reply', data: { text: '开个辩论 234 电池' } }, text('是吗')], config, '999'), null);
  assert.equal(parseDebateWake([{ type: 'json', data: { data: '开个辩论 234 电池' } }], config, '999'), null);
  assert.equal(parseDebateWake(segments(), normalizeDebateWake(), '999'), null);
});
test('ambiguous targets, malformed topics and unsafe configuration are rejected', () => {
  for (const s of [[text('开个辩论 电池')], [text('开个辩论 '), at('all'), text(' 电池')], [...segments(), at(567)], [text('开个辩论 999 电池')], [text('开个辩论 234 电池|')], [text('开个辩论 234 电池|a|b')], [...segments(), { type: 'forward', data: {} }]]) assert.throws(() => parseDebateWake(s, config, '999'));
  for (const c of [null, [], { phrases: [] }, { phrases: ['@me'] }, { phrases: ['／deny'] }, { phrases: ['a\nb'] }, { durationMinutes: 0 }, { sendMode: 'shell' }]) assert.throws(() => normalizeDebateWake(c));
});
test('group trigger creates only a pending request, including for the owner; no task, token or analyzer', () => {
  const f = fixture(), result = receive(f.requests, { userId: '123' });
  assert.equal(result.request.status, 'pending'); assert.equal(f.tasks.tasks.size, 0); assert.equal(f.starts.length, 0);
  assert.ok(!JSON.stringify(f.requests.list()).includes('token'));
  assert.equal(receive(f.requests, { userId: '999' }), null);
});
test('administrator approval starts one exact task and never returns its credential', async () => {
  const f = fixture(), r = receive(f.requests).request;
  const result = await f.requests.decide(r.id, 'approve');
  assert.equal(result.status, 'approved'); assert.equal(f.starts.length, 1);
  const task = f.tasks.get(result.taskId);
  assert.equal(task.key, r.key); assert.equal(task.targetId, r.targetId); assert.equal(task.sendMode, 'review'); assert.equal(task.includeContext, true);
  assert.equal(task.expiresAt - task.createdAt, 600000);
  assert.ok(!JSON.stringify([result, f.requests.list(), f.audit]).includes(f.starts[0].token));
  await assert.rejects(f.requests.decide(r.id, 'approve'), /已处理/);
});
test('expiry, denial, configuration changes and revoked group policy cannot launch tasks', async () => {
  for (const kind of ['expiry', 'deny', 'config', 'policy']) {
    const f = fixture(), r = receive(f.requests).request;
    if (kind === 'expiry') f.advance(300001);
    if (kind === 'deny') await f.requests.decide(r.id, 'deny');
    if (kind === 'config') f.requests.configure({ ...config, phrases: ['新语句'] });
    if (kind === 'policy') f.revoke();
    await assert.rejects(f.requests.decide(r.id, 'approve'));
    assert.equal(f.starts.length, 0); assert.equal(f.tasks.tasks.size, 0);
  }
});
test('replays and repeated pending requests are deduplicated; expiry and storage are bounded', () => {
  const f = fixture(), r = receive(f.requests).request;
  assert.equal(receive(f.requests).duplicate, true);
  assert.equal(receive(f.requests, { messageId: '2' }).duplicate, true);
  for (let n = 1; n < 100; n++) receive(f.requests, { messageId: String(n + 10), userId: String(n + 1000) });
  assert.equal(f.requests.list().length, 100);
  assert.throws(() => receive(f.requests, { messageId: '999', userId: '9999' }), /已满/);
  f.advance(300001); assert.equal(f.requests.list().find(x => x.id === r.id).status, 'expired');
  receive(f.requests, { messageId: '999', userId: '9999' }); assert.equal(f.requests.list().length, 100);
});
test('concurrent approvals cannot start twice; startup failure revokes the task', async () => {
  let release; const f = fixture({ start: () => new Promise(r => release = r) }), r = receive(f.requests).request;
  const first = f.requests.decide(r.id, 'approve'); await assert.rejects(f.requests.decide(r.id, 'approve')); release(); await first;
  const bad = fixture({ start: async () => { throw Error('launch failed'); } }), b = receive(bad.requests).request;
  await assert.rejects(bad.requests.decide(b.id, 'approve'), /launch failed/);
  assert.equal(bad.requests.list()[0].status, 'failed'); assert.equal([...bad.tasks.tasks.values()][0].status, 'stopped');
});
test('settings or group policy changed during startup revoke newly-created task', async () => {
  for (const kind of ['settings', 'policy', 'expiry']) {
    let release; const f = fixture({ start: () => new Promise(r => release = r) }), r = receive(f.requests).request;
    const operation = f.requests.decide(r.id, 'approve');
    if (kind === 'settings') f.requests.configure({ ...config, enabled: false });
    if (kind === 'policy') f.revoke();
    if (kind === 'expiry') f.advance(300001);
    release(); await assert.rejects(operation); assert.equal([...f.tasks.tasks.values()][0].status, 'stopped');
  }
});
test('managed workers use a private credential file and fixed shell-free command; pause/resume/close clean up', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-worker-test-')), records = [], errors = [];
  const manager = new ManagedDebateWorkers({ directory, entry: path.resolve('examples/debate-worker.mjs'), spawn: fakeSpawner(records), baseUrl: () => 'http://127.0.0.1:3100', onError: (...e) => errors.push(e) });
  const credential = { task: { id: 'a'.repeat(32), expiresAt: Date.now() + 60000 }, token: 'b'.repeat(64) };
  try {
    await manager.start(credential);
    const [exe, args, options] = records[0].args;
    assert.equal(exe, process.execPath); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(!JSON.stringify(args).includes(credential.token)); assert.equal(JSON.parse(fs.readFileSync(args[1])).token, credential.token);
    manager.control({ ...credential.task, status: 'paused' }, 'pause'); await new Promise(r => setImmediate(r)); assert.ok(!fs.existsSync(args[1]));
    manager.control({ ...credential.task, status: 'active' }, 'resume'); await new Promise(r => setImmediate(r)); assert.equal(records.length, 2);
    manager.close(); await new Promise(r => setImmediate(r)); assert.equal(manager.workers.size, 0); assert.ok(!fs.existsSync(args[1])); assert.equal(errors.length, 0);
    await assert.rejects(manager.start(credential), /关闭/);
  } finally { manager.close(); fs.rmdirSync(directory); }
});
test('failed child spawn and unexpected exit are visible without exposing credentials', async () => {
  for (const failure of [true, false]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-worker-test-')), records = [], errors = [];
    const manager = new ManagedDebateWorkers({ directory, entry: 'fixture.mjs', spawn: fakeSpawner(records, failure), baseUrl: () => 'http://127.0.0.1:3100', onError: (...e) => errors.push(e) });
    const credential = { task: { id: 'a'.repeat(32), expiresAt: Date.now() + 60000 }, token: 'b'.repeat(64) };
    try {
      if (failure) await assert.rejects(manager.start(credential), /启动失败/);
      else { await manager.start(credential); records[0].child.emit('exit', 1); }
      assert.equal(fs.readdirSync(directory).length, 0); assert.equal(errors[0][1], 'transport_failed'); assert.ok(!JSON.stringify(errors).includes(credential.token));
    } finally { manager.close(); fs.rmdirSync(directory); }
  }
});
test('rapid pause/resume cycles restart only once and release the old worker lease', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-worker-test-')), records = [];
  const manager = new ManagedDebateWorkers({ directory, entry: 'fixture.mjs', spawn: fakeSpawner(records), baseUrl: () => 'http://127.0.0.1:3100' });
  const tasks = new DebateTasks({ assertGroup: () => 'policy', onControl: (task, action) => manager.control(task, action) });
  const credential = tasks.create({ key: 'group:456', targetId: '234', topic: '电池', keywords: ['电池'] });
  try {
    await manager.start(credential); const task = tasks.get(credential.task.id);
    tasks.heartbeat(task, { workerId: 'a'.repeat(16), sequence: 1, state: 'idle' });
    tasks.control(task.id, 'pause'); tasks.control(task.id, 'resume'); tasks.control(task.id, 'pause'); tasks.control(task.id, 'resume');
    await new Promise(r => setImmediate(r)); assert.equal(records.length, 2);
    assert.doesNotThrow(() => tasks.heartbeat(task, { workerId: 'b'.repeat(16), sequence: 1, state: 'idle' }));
  } finally { manager.close(); await new Promise(r => setImmediate(r)); fs.rmdirSync(directory); }
});
test('real local Node worker process starts and stops without QQ or DSH access', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-worker-test-')), entry = path.join(directory, 'fixture.mjs'); let child;
  fs.writeFileSync(entry, 'setInterval(() => {}, 1000);');
  const manager = new ManagedDebateWorkers({ directory, entry, spawn: (...args) => child = spawn(...args), baseUrl: () => 'http://127.0.0.1:3100' });
  const credential = { task: { id: 'a'.repeat(32), expiresAt: Date.now() + 60000 }, token: 'b'.repeat(64) };
  try {
    await manager.start(credential); assert.ok(child.pid > 0);
    const exited = new Promise(resolve => child.once('exit', resolve)); manager.close(); await exited;
    assert.ok(!fs.existsSync(path.join(directory, credential.task.id + '.json')));
  } finally { manager.close(); fs.unlinkSync(entry); fs.rmdirSync(directory); }
});
test('worker expiry and shutdown during spawn never leave running credentials', async () => {
  for (const phase of ['expiry', 'startup']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-worker-test-')), records = [];
    const manager = new ManagedDebateWorkers({ directory, entry: 'fixture.mjs', spawn: fakeSpawner(records), baseUrl: () => 'http://127.0.0.1:3100' });
    const credential = { task: { id: 'a'.repeat(32), expiresAt: Date.now() + 20 }, token: 'b'.repeat(64) };
    try {
      const operation = manager.start(credential);
      if (phase === 'startup') { manager.close(); await assert.rejects(operation); }
      else { await operation; await new Promise(r => setTimeout(r, 40)); }
      await new Promise(r => setImmediate(r)); assert.equal(manager.workers.size, 0);
      assert.ok(records[0].child.killed); assert.equal(fs.readdirSync(directory).length, 0);
    } finally { manager.close(); fs.rmdirSync(directory); }
  }
});

async function bridgeFixture(run) {
  const records = [];
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, sendDelayMs: 0,
    debate: { groupWake: config }, socialV2: { proactive: { enabled: false }, sticker: { enabled: false } } }, globals: { spawn: fakeSpawner(records) } });
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(baseUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const incoming = (kind = 'group', user = 345, message = segments(), messageId = 1) => h.handleIncoming(kind, kind === 'group' ? 456 : user, { user_id: user, self_id: 999, group_id: kind === 'group' ? 456 : undefined, message_id: messageId, sender: { nickname: '成员' }, message }, h.cfg);
  try { await run({ h, records, request, incoming }); }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
}
test('real bridge group trigger waits for admin API review, then starts a scoped worker', () => bridgeFixture(async ({ h, records, request, incoming }) => {
  await incoming(); assert.equal(h.debateTasks.tasks.size, 0); assert.equal(records.length, 0); assert.equal(h.calls.prompts.length, 0);
  const list = await request('/api/debate/requests'); assert.equal(list.status, 200); const r = list.data.requests[0];
  assert.equal(r.status, 'pending'); assert.ok(h.calls.sent.some(x => JSON.stringify(x).includes('/debate-approve')));
  const approved = await request('/api/debate/requests/review', { requestId: r.id, decision: 'approve' });
  assert.equal(approved.status, 200, JSON.stringify(approved)); assert.equal(records.length, 1); assert.equal(h.debateTasks.tasks.size, 1);
  const task = h.debateTasks.get(approved.data.request.taskId); assert.equal(task.managedWorker, true);
  const credential = JSON.parse(fs.readFileSync(records[0].args[1][1], 'utf8')); assert.ok(!JSON.stringify(approved).includes(credential.token));
  assert.equal((await request('/api/debate/requests/review', { requestId: r.id, decision: 'approve' })).status, 409);
  await request('/api/debate/control', { taskId: task.id, action: 'stop' }); assert.equal(task.tokenHash, '');
}));
test('only owner private command can approve: group messages and nonowners cannot', () => bridgeFixture(async ({ h, records, incoming }) => {
  await incoming(); const r = h.debateRequests.list()[0];
  await incoming('group', 345, [text('/debate-approve ' + r.id)], 2);
  await incoming('group', 123, [text('/debate-approve ' + r.id)], 3);
  assert.equal(records.length, 0); assert.equal(h.debateRequests.list()[0].status, 'pending');
  await incoming('private', 123, [text('/debate-approve ' + r.id)], 4);
  assert.equal(records.length, 1); assert.equal(h.debateRequests.list()[0].status, 'approved'); assert.equal(h.calls.prompts.length, 0);
}));
test('wake config persists and invalidates pending requests; agent/task identities cannot manage it', () => bridgeFixture(async ({ h, request, incoming, records }) => {
  await incoming(); const r = h.debateRequests.list()[0];
  for (const headers of [{ 'x-agent-token': 'anything' }, { 'x-agent-call': '1' }, { 'x-debate-token': 'anything' }]) {
    for (const route of ['/api/debate/wake', '/api/debate/requests']) assert.equal((await request(route, undefined, headers)).status, 403);
    assert.equal((await request('/api/debate/requests/review', { requestId: r.id, decision: 'approve' }, headers)).status, 403);
  }
  const saved = await request('/api/debate/wake', { ...config, phrases: ['新的启动词'] }); assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))).debate.groupWake.phrases, ['新的启动词']);
  assert.equal((await request('/api/debate/requests/review', { requestId: r.id, decision: 'approve' })).status, 409); assert.equal(records.length, 0);
  assert.equal((await request('/api/debate/wake', { phrases: [] })).status, 400);
}));
