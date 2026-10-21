import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { normalizeDualMode, createDualModeRouter } from '../src/core/dual-mode.mjs';

const config = { dualMode: { enabled: true, ownerPreset: 'standard', ownerPrompt: 'OWNER_PERSONA' }, ackMessage: '' };
async function fixture(run, overrides = {}) {
  const h = await bridgeHarness({ config: { ...config, ...overrides } });
  try { await h.refreshMode(); return await run(h); } finally { await h.close(); }
}
async function consoleApi(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { token, body, agent = true } = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', ...(agent ? { 'x-agent-call': '1' } : {}),
        ...(token !== undefined ? { 'x-agent-token': token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try { return await run(request); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('concurrent owner and group sessions select distinct presets and workspace paths', () => fixture(async h => {
  const paths = [];
  h.api.workspace.create = async ({ path }) => { paths.push(path); return { result: { ok: true, value: { created: false, workspace: { workspaceId: path } } } }; };
  const [owner, group] = await Promise.all([h.ensureSession('private:123'), h.ensureSession('group:456')]);
  assert.notEqual(owner, group);
  assert.deepEqual(new Set(h.calls.created.map(x => x.agentPreset)), new Set(['standard', 'qq-chat-v2']));
  assert.equal(new Set(paths).size, 2);
  assert.ok(paths.some(p => p.endsWith('private-123')));
  assert.ok(paths.some(p => p.endsWith('group-456')));
  assert.equal(h.modeFor('group:456'), 'reserved2');
  assert.equal(h.modeFor('private:123'), 'closed-agent');
  assert.equal(h.modeAllowed('private:789', 'private', 789, h.cfg, 'closed-agent'), false);
}));
test('owner in group remains simulation; owner prompt is isolated from QQ role and slang', () => fixture(async h => {
  fs.mkdirSync(`${h.temp}/roles`);
  fs.writeFileSync(`${h.temp}/roles/fixture.md`, 'GROUP_PERSONA');
  fs.writeFileSync(`${h.temp}/state/current-role.json`, JSON.stringify({ role: 'fixture', mode: 'active' }));
  await h.handleIncoming('private', 123, { user_id: 123, self_id: 999, message_id: 1, message: [{ type: 'text', data: { text: '执行只读任务' } }] }, h.cfg);
  const prompt = h.calls.prompts.at(-1).content[0].text;
  assert.ok(prompt.includes('OWNER_PERSONA'));
  assert.ok(!prompt.includes('GROUP_PERSONA'));
  assert.ok(prompt.includes('token='));
  await h.handleIncoming('group', 456, { user_id: 123, self_id: 999, message_id: 2, message: [{ type: 'text', data: { text: '你好' } }] }, h.cfg);
  assert.equal(h.modeFor('group:456'), 'reserved2');
  assert.equal(h.socialV2.conversations.get('private:123'), undefined);
}));
test('mixed-mode tools bind owner and group tokens to their own target; tokenless calls fail closed', () => fixture(async h => {
  const ownerId = await h.ensureSession('private:123');
  await h.ensureSession('group:456');
  const ownerToken = h.ownerAgentToken('private:123', ownerId);
  const groupToken = h.getSocialV2State('group:456').agentToken;
  await consoleApi(h, async request => {
    assert.equal((await request('/api/status', { token: ownerToken })).data.mode, 'closed-agent');
    assert.equal((await request('/api/status', { token: groupToken })).data.mode, 'reserved2');
    assert.equal((await request('/api/status', { agent: false })).data.dualMode.enabled, true);
    assert.equal((await request('/api/send/private', { body: { userId: '123', message: 'no token' } })).status, 403);
    assert.equal((await request('/api/send/private', { token: groupToken, body: { userId: '123', message: 'cross', token: groupToken } })).status, 403);
    assert.equal((await request('/api/send/group', { token: ownerToken, body: { groupId: '456', message: 'cross', token: ownerToken } })).status, 403);
    assert.equal((await request('/api/socialV2/state?key=group:456', { token: ownerToken })).status, 403);
    assert.equal((await request('/api/role', { token: ownerToken, body: { role: 'x' } })).status, 403);
    assert.equal((await request('/api/mode', { agent: false, body: { mode: 'closed-agent' } })).status, 409);
    h.socialV2.paused = true;
    assert.equal((await request('/api/send/private', { token: ownerToken, body: { userId: '123', message: 'owner-ok', token: ownerToken } })).status, 200);
    assert.equal((await request('/api/send/group', { token: groupToken, body: { groupId: '456', message: 'paused', token: groupToken } })).status, 403);
    assert.equal(h.calls.http.filter(x => x.url.endsWith('/send_private_msg')).length, 1);
    assert.equal(h.socialV2.conversations.has('private:123'), false);
  });
}));
test('owner replacement revokes only its token/session without disturbing group', () => fixture(async h => {
  const owner = await h.ensureSession('private:123');
  const group = await h.ensureSession('group:456');
  const token = h.ownerAgentToken('private:123', owner);
  h.cfg.ownerQQ = 789;
  h.reconcileSessionPolicies();
  assert.equal(h.state.sessions['private:123'], undefined);
  assert.equal(h.state.sessions['group:456'], group);
  await consoleApi(h, async request => assert.equal((await request('/api/status', { token })).status, 403));
  const nextGroup = await h.ensureSession('group:456');
  assert.equal(nextGroup, group);
  assert.equal(h.modeFor('private:789'), 'closed-agent');
}));
test('owner preset change during concurrent session creation cannot adopt the old task', () => fixture(async h => {
  let release;
  const create = h.api.sessions.create;
  h.api.sessions.create = async params => {
    const result = await create(params);
    if (params.agentPreset === 'standard') await new Promise(resolve => { release = resolve; });
    return result;
  };
  const ownerCreation = h.ensureSession('private:123');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const group = await h.ensureSession('group:456');
  h.cfg.dualMode.ownerPrompt = 'NEW_OWNER_PERSONA';
  const rejected = assert.rejects(ownerCreation, /已重置/);
  release();
  await rejected;
  assert.equal(h.state.sessions['private:123'], undefined);
  assert.equal(await h.ensureSession('group:456'), group);
}));
test('offline owner instructions cannot be replayed after changing the owner preset', () => fixture(async h => {
  h.setReady(false);
  assert.equal((await h.deliverPrompt('private:123', 'OLD_OWNER_TASK')).queued, true);
  h.cfg.dualMode.ownerPrompt = 'CHANGED';
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 0);
}));
test('retiring a group token leaves owner work available', () => fixture(async h => {
  const owner = await h.ensureSession('private:123');
  await h.ensureSession('group:456');
  const ownerToken = h.ownerAgentToken('private:123', owner);
  const groupToken = h.getSocialV2State('group:456').agentToken;
  h.cfg.allow.groups = [];
  h.reconcileSessionPolicies();
  await consoleApi(h, async request => {
    assert.equal((await request('/api/status', { token: groupToken })).status, 403);
    assert.equal((await request('/api/status', { token: ownerToken })).data.mode, 'closed-agent');
  });
  assert.equal(h.state.sessions['private:123'], owner);
}));
test('unavailable owner preset never falls back; denied owner is not admitted', () => fixture(async h => {
  h.setPresets(['qq-chat-v2', 'qq-chat']);
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.calls.created.length, 0);
  h.setPresets(['standard', 'qq-chat-v2']);
  h.cfg.deny.private = ['123'];
  await assert.rejects(h.ensureSession('private:123'));
}));
test('revoked session cannot authorize late sends or reuse a retired token', () => fixture(async h => {
  const id = await h.ensureSession('private:123');
  const token = h.ownerAgentToken('private:123', id);
  h.retireSession('private:123');
  const replacement = await h.ensureSession('private:123');
  assert.notEqual(h.ownerAgentToken('private:123', replacement), token);
  await consoleApi(h, async request => assert.equal((await request('/api/send/private', { token, body: { userId: '123', message: 'late', token } })).status, 403));
}));
test('queued owner tool send cannot inherit a replacement session lease', () => fixture(async h => {
  const id = await h.ensureSession('private:123');
  const token = h.ownerAgentToken('private:123', id);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  h.setSendChain(barrier);
  await consoleApi(h, async request => {
    const sending = request('/api/send/private', { token, body: { userId: '123', message: 'old-task-output', token } });
    try {
      const deadline = Date.now() + 2000;
      while (h.getSendChain() === barrier) {
        if (Date.now() > deadline) throw new Error('send was not queued');
        await new Promise(resolve => setImmediate(resolve));
      }
      h.retireSession('private:123');
      await h.ensureSession('private:123');
    } finally { release(); }
    assert.equal((await sending).status, 403);
    assert.equal(h.calls.http.filter(x => x.url.endsWith('/send_private_msg')).length, 0);
  });
}));
test('first queued message survives loading the preset catalogue', () => fixture(async h => {
  h.setPresets([]);
  h.setReady(false);
  await h.deliverPrompt('private:123', 'queued-before-catalogue');
  h.setPresets(['standard', 'qq-chat-v2']);
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 1);
  assert.ok(h.calls.prompts[0].content[0].text.includes('queued-before-catalogue'));
}));
test('invalid mixed-mode configuration never silently enables a privileged default', () => {
  assert.throws(() => normalizeDualMode({ enabled: 'true' }), /boolean/);
  assert.throws(() => createDualModeRouter({ dualMode: { enabled: true }, ownerQQ: null }), /ownerQQ/);
  assert.throws(() => createDualModeRouter({ dualMode: { enabled: true, ownerPreset: 'qq-chat-v2' }, ownerQQ: 123, agentPreset: 'qq-chat-v2' }), /不同/);
  assert.equal(createDualModeRouter({ dualMode: { enabled: false } }), null);
});
test('late approval cannot revive work from a retired owner policy', () => fixture(async h => {
  const id = await h.ensureSession('private:123');
  const responses = [];
  h.api.respond = async value => { responses.push(value); return { result: { ok: true, value: {} } }; };
  await h.registerPending('private:123', { kind: 'approval', sessionId: id, eventId: 'old-approval', clientId: 'fixture' });
  const entry = h.pending.get('private:123');
  h.cfg.dualMode.ownerPrompt = 'changed-policy';
  await h.handlePendingAnswer(entry, '同意', 'private:123', true);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].outcome.value, 'rejected');
  assert.equal(h.pending.has('private:123'), false);
}));
test('group wake scheduling excludes owner, and policy snapshot is reproducible on restart', () => fixture(async h => {
  h.getSocialV2State('private:123');
  await h.sendWakePromptV2('private:123', 'bootstrap');
  h.setupSleepTimerV2('private:123');
  assert.equal(h.calls.prompts.length, 0);
  const snapshot = JSON.parse(fs.readFileSync(`${h.temp}/state/conversation-policies.json`, 'utf8'));
  await fixture(async restarted => {
    const other = JSON.parse(fs.readFileSync(`${restarted.temp}/state/conversation-policies.json`, 'utf8'));
    assert.deepEqual(other, snapshot);
  });
}));
