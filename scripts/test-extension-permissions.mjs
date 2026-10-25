import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { ExtensionPermissions, normalizePermissionPolicy } from '../src/framework/permissions.mjs';
import { ContentServiceRuntime, normalizeServices } from '../src/framework/services.mjs';

const KEY = 'group:456';
const SERVICE = { id: 'video.inspect', effect: 'read', accepts: ['link'], hosts: ['b23.tv'],
  transport: { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('fixtures/content-service.mjs', import.meta.url))] },
  tool: 'inspect_video', arguments: { url: '$source.url' }, inputSchema: { properties: { note: { type: 'string', maxLength: 50 } } } };
const grant = (decision, extra = {}) => ({ key: KEY, capability: SERVICE.id, decision, dataScopes: ['source-reference', 'input'], ...extra });
async function fixture(run, rules = [], extra = {}) {
  const h = await bridgeHarness({ config: { ownerQQ: 123, dualMode: { enabled: true, ownerPreset: 'standard' },
    allow: { groups: ['456', '789'], private: ['123'] },
    framework: { services: [SERVICE], permissions: { rules }, ...extra },
    socialV2: { proactive: { enabled: false }, sticker: { enabled: false }, wake: { preSleepWaitEnabled: false } } } });
  await h.ensureSession(KEY);
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new QQBridgeClient({ baseUrl, key: KEY, token: st.agentToken });
  const request = async (route, body, headers = {}) => {
    const response = await fetch(baseUrl + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const receive = async (key = KEY) => {
    const packet = { content: [], sources: [{ sourceId: (key === KEY ? 'a' : 'b').repeat(32), type: 'link', url: 'https://b23.tv/fixture', messageId: '42' }] };
    h.contentSources.register(key, packet);
    return packet.sources[0].sourceId;
  };
  try { await run({ h, st, client, request, baseUrl, receive }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('registered services default to deny; denied discovery/calls/media never start work', () => fixture(async ({ h, client, receive }) => {
  const sourceId = await receive();
  assert.equal((await client.contentServices(sourceId)).services.length, 0);
  await assert.rejects(client.processContent(SERVICE.id, { sourceId }), /未获/);
  await assert.rejects(client.readMedia(sourceId), /未获/);
  await assert.rejects(client.uploadMedia({ data: 'aA==', mimeType: 'image/png' }), /未获/);
  assert.equal(h.contentServices.connections.size, 0);
  assert.equal(h.frameworkMedia.items.size, 0);
  assert.ok(h.extensionPermissions.audit.every(entry => !JSON.stringify(entry).includes('https://')));
}));

test('new extension approval privately notifies only the owner once and supports exact-ID QQ decisions', () => fixture(async ({ h, client, receive }) => {
  const sourceId = await receive();
  const pending = await client.processContent(SERVICE.id, { sourceId });
  await new Promise(setImmediate); await h.getSendChain();
  assert.ok(h.calls.sent.length > 0);
  assert.ok(h.calls.sent.every(message => message.kind === 'private' && message.id === 123));
  const text = h.calls.sent.map(message => message.text).join('\n');
  assert.ok(text.includes(`/approve ${pending.approval.requestId}`));
  assert.ok(text.includes(`/deny ${pending.approval.requestId}`));
  assert.ok(text.includes(KEY)); assert.ok(text.includes(SERVICE.id));
  assert.equal(h.contentServices.connections.size, 0, 'notification must not start the service');
  const sent = h.calls.sent.length;
  await client.processContent(SERVICE.id, { sourceId });
  await new Promise(setImmediate); await h.getSendChain();
  assert.equal(h.calls.sent.length, sent, 'repeated requests must not spam the owner');
  const message = text => ({ user_id: 123, self_id: 999, message_id: 7, message: [{ type: 'text', data: { text } }] });
  await h.handleIncoming('group', 456, message(`/approve ${pending.approval.requestId}`), h.cfg);
  assert.equal(h.extensionPermissions.listRequests()[0].status, 'pending', 'owner cannot approve from a group');
  await h.handleIncoming('private', 123, message(`/approve ${pending.approval.requestId}`), h.cfg);
  assert.equal(h.extensionPermissions.listRequests()[0].status, 'approved');
  assert.equal(h.contentServices.connections.size, 0, 'approval is not execution');
  await client.processContent(SERVICE.id, { sourceId, approvalId: pending.approval.requestId });
  assert.equal(h.extensionPermissions.listRequests()[0].status, 'consumed');
}, [grant('ask')], { }));

test('QQ denial cannot be forged by group members and notification failures leave approvals pending', () => fixture(async ({ h, client, receive }) => {
  h.bot.sendPrivateMessage = async () => { throw Error('offline'); };
  const sourceId = await receive();
  const pending = await client.processContent(SERVICE.id, { sourceId });
  await new Promise(setImmediate); await h.getSendChain();
  assert.equal(h.extensionPermissions.listRequests()[0].status, 'pending');
  const message = user_id => ({ user_id, self_id: 999, message_id: 8, message: [{ type: 'text', data: { text: `/deny ${pending.approval.requestId}` } }] });
  await h.handleIncoming('group', 456, message(456), h.cfg);
  assert.equal(h.extensionPermissions.listRequests()[0].status, 'pending');
  await h.handleIncoming('private', 123, message(123), h.cfg);
  assert.equal(h.extensionPermissions.listRequests()[0].status, 'denied');
  assert.equal(h.contentServices.connections.size, 0);
}, [grant('ask')]));

test('ask is reviewed in the admin API, approved once, retried exactly and cannot replay', () => fixture(async ({ h, client, request, receive }) => {
  const sourceId = await receive();
  const pending = await client.processContent(SERVICE.id, { sourceId });
  assert.equal(pending.status, 'approval_required');
  const approvalId = pending.approval.requestId;
  assert.equal((await client.processContent(SERVICE.id, { sourceId })).approval.requestId, approvalId);
  assert.equal(h.contentServices.connections.size, 0);
  const list = await request('/api/extensions/approvals');
  assert.equal(list.data.requests[0].source.url, 'https://b23.tv/fixture');
  assert.equal(list.data.requests[0].effect, 'read');
  assert.equal((await request('/api/extensions/approvals/resolve', { requestId: approvalId, decision: 'approve' })).status, 200);
  assert.equal(h.contentServices.connections.size, 0);
  assert.equal((await client.processContent(SERVICE.id, { sourceId })).status, 'approval_required');
  await assert.rejects(client.processContent(SERVICE.id, { sourceId, input: { note: 'changed' }, approvalId }), /不匹配/);
  const result = await client.processContent(SERVICE.id, { sourceId, approvalId });
  assert.match(result.content[0].text, /fixture transcript/);
  await assert.rejects(client.processContent(SERVICE.id, { sourceId, approvalId }), /消费/);
  assert.equal((await request('/api/extensions/approvals')).data.requests[0].status, 'consumed');
}, [grant('ask')]));

test('Agent credentials cannot approve, inspect or change policy even with a console token', () => fixture(async ({ st, request }) => {
  for (const [route, body] of [['/api/extensions/permissions', undefined], ['/api/extensions/permissions', { policy: { rules: [] } }],
    ['/api/extensions/approvals', undefined], ['/api/extensions/approvals/resolve', { requestId: 'a'.repeat(32), decision: 'approve' }], ['/api/extensions/audit', undefined]]) {
    assert.equal((await request(route, body, { 'x-agent-token': st.agentToken })).status, 403);
    assert.equal((await request(route, body, { 'x-agent-call': '1' })).status, 403);
  }
}));

test('exact grants do not propagate to another group or the owner private task', () => fixture(async ({ h, client, receive, baseUrl }) => {
  const sourceId = await receive();
  assert.equal((await client.contentServices(sourceId)).services[0].permission, 'allow');
  for (const key of ['group:789', 'private:123']) {
    const session = await h.ensureSession(key);
    const token = key.startsWith('private') ? h.ownerAgentToken(key, session) : h.getSocialV2State(key).agentToken;
    const other = new QQBridgeClient({ baseUrl, key, token });
    const otherSource = await receive(key);
    assert.equal((await other.contentServices(otherSource)).services.length, 0);
    await assert.rejects(other.processContent(SERVICE.id, { sourceId: otherSource }), /未获/);
  }
}, [grant('allow')]));

test('deny wins, data scope is explicit, unknown parameters cannot be smuggled', () => fixture(async ({ h, client, receive }) => {
  const sourceId = await receive();
  await assert.rejects(client.processContent(SERVICE.id, { sourceId }), /未获/);
  h.extensionPermissions.replacePolicy({ rules: [grant('allow', { dataScopes: [] })] });
  await assert.rejects(client.processContent(SERVICE.id, { sourceId }), /未获/);
  h.extensionPermissions.replacePolicy({ rules: [grant('allow')] });
  await assert.rejects(client.processContent(SERVICE.id, { sourceId, input: { command: 'anything' } }), /schema/);
  assert.equal(h.contentServices.connections.size, 0);
}, [grant('allow'), grant('deny')]));

test('policy changes revoke approved requests and cached data; updates persist across restart', () => fixture(async ({ h, client, request, receive }) => {
  const sourceId = await receive();
  const first = await client.processContent(SERVICE.id, { sourceId });
  await request('/api/extensions/approvals/resolve', { requestId: first.approval.requestId, decision: 'approve' });
  const update = await request('/api/extensions/permissions', { policy: { rules: [grant('allow')] } });
  assert.equal(update.status, 200);
  await assert.rejects(client.processContent(SERVICE.id, { sourceId, approvalId: first.approval.requestId }), /失效|匹配/);
  await client.processContent(SERVICE.id, { sourceId });
  assert.equal((await client.processContent(SERVICE.id, { sourceId })).cached, true);
  await request('/api/extensions/permissions', { policy: { rules: [] } });
  await assert.rejects(client.processContent(SERVICE.id, { sourceId }), /未获/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))).framework.permissions.rules.length, 0);
  assert.equal((await request('/api/extensions/approvals')).data.requests[0].status, 'revoked');
  const restarted = await bridgeHarness({ config: JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))) });
  try {
    assert.equal(restarted.extensionPermissions.policy.rules.length, 0);
    assert.equal(restarted.extensionPermissions.listRequests().length, 0);
  } finally { await restarted.close(); }
}, [grant('ask')]));

test('revoked sessions invalidate approval before admin can approve', () => fixture(async ({ h, st, client, request, receive }) => {
  const pending = await client.processContent(SERVICE.id, { sourceId: await receive() });
  st.agentToken = 'replacement';
  const result = await request('/api/extensions/approvals/resolve', { requestId: pending.approval.requestId, decision: 'approve' });
  assert.equal(result.status, 409);
  assert.equal(h.contentServices.connections.size, 0);
}, [grant('ask')]));

test('service manifest and source changes invalidate pending approvals', () => fixture(async ({ h, client, request, receive }) => {
  const sourceId = await receive();
  const first = await client.processContent(SERVICE.id, { sourceId });
  h.contentServices.services[0].tool = 'synthesize';
  assert.equal((await request('/api/extensions/approvals/resolve', { requestId: first.approval.requestId, decision: 'approve' })).status, 409);
  h.contentServices.services[0].tool = SERVICE.tool;
  const second = await client.processContent(SERVICE.id, { sourceId, input: { note: 'second' } });
  h.contentSources.items.get(sourceId).url = 'https://b23.tv/changed';
  assert.equal((await request('/api/extensions/approvals/resolve', { requestId: second.approval.requestId, decision: 'approve' })).status, 409);
}, [grant('ask')]));

test('quota also applies to cache hits and rejected calls do not create MCP connections', () => fixture(async ({ h, client, receive }) => {
  const sourceId = await receive();
  await client.processContent(SERVICE.id, { sourceId });
  await assert.rejects(client.processContent(SERVICE.id, { sourceId }), /额度/);
  assert.equal(h.extensionPermissions.audit.filter(item => item.event === 'started').length, 1);
}, [grant('allow', { maxCallsPerMinute: 1 })]));

test('expiry, denial, single-use concurrency, invalid policies and broken auditing fail closed', async () => {
  let now = 1000;
  const broker = new ExtensionPermissions({ now: () => now, ttlMs: 100, policy: { rules: [grant('ask')] } });
  const input = { key: KEY, scope: 'lease', capability: SERVICE.id, manifest: { effect: 'read' }, dataScopes: [] };
  const pending = broker.authorize(input).pending;
  now += 101;
  assert.throws(() => broker.resolve(pending.approval.requestId, 'approve'), /失效/);
  now += 200;
  const request = broker.authorize(input).pending.approval.requestId;
  broker.resolve(request, 'approve');
  const attempts = await Promise.allSettled([0, 1].map(async () => broker.authorize({ ...input, approvalId: request })));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  now += 300;
  const denied = broker.authorize(input).pending.approval.requestId;
  broker.resolve(denied, 'deny');
  assert.throws(() => broker.authorize({ ...input, approvalId: denied }), /失效|消费/);
  assert.throws(() => normalizePermissionPolicy({ rules: [grant('allow', { key: '*' })] }));
  assert.throws(() => normalizePermissionPolicy({ default: 'allow' }));
  const broken = new ExtensionPermissions({ policy: { rules: [grant('allow')] }, onAudit: () => { throw new Error('disk'); } });
  assert.throws(() => broken.authorize(input), /审计不可写/);
});

test('write, execute and undeclared effects always require approval despite allow rules', () => fixture(async ({ h, client, receive }) => {
  assert.equal(normalizeServices([{ ...SERVICE, effect: undefined }])[0].effect, 'execute');
  const sourceId = await receive();
  for (const effect of ['write', 'execute']) {
    h.contentServices.services[0].effect = effect;
    assert.equal((await client.processContent(SERVICE.id, { sourceId })).status, 'approval_required');
  }
  assert.equal(h.contentServices.connections.size, 0);
}, [grant('allow')]));

test('permission revocation while an HTTP service runs prevents late results', async () => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const provider = http.createServer((req, res) => { req.resume(); began(); setTimeout(() => res.end(JSON.stringify({ content: [{ type: 'text', text: 'private result' }] })), 60); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const permissions = new ExtensionPermissions({ policy: { rules: [grant('allow', { capability: 'slow', dataScopes: ['input'] })] } });
  const runtime = new ContentServiceRuntime({ permissions, services: [{ id: 'slow', effect: 'read', accepts: ['text'],
    inputSchema: { properties: { text: { type: 'string' } } }, transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }] });
  try {
    const pending = runtime.call({ key: KEY, scope: 'lease', serviceId: 'slow', input: { text: 'secret' } });
    await started; permissions.replacePolicy({ rules: [] });
    await assert.rejects(pending, /权限|版本/);
  } finally { await runtime.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});

test('raw media reads wait for approval before accessing the source and uploads need their own grant', () => fixture(async ({ h, client, request, receive }) => {
  const sourceId = await receive();
  const pending = await client.readMedia(sourceId);
  assert.equal(pending.status, 'approval_required');
  await assert.rejects(client.uploadMedia({ data: 'aA==', mimeType: 'image/png' }), /未获/);
  assert.equal(h.frameworkMedia.items.size, 0);
  await request('/api/extensions/approvals/resolve', { requestId: pending.approval.requestId, decision: 'deny' });
  await assert.rejects(client.readMedia(sourceId, { approvalId: pending.approval.requestId }), /失效|消费/);
}, [grant('ask', { capability: 'bridge.media.read', dataScopes: ['source-bytes'] })]));

test('admin policy mutations reject unknown capabilities and malformed configuration without changing grants', () => fixture(async ({ h, request }) => {
  const before = h.extensionPermissions.revision;
  assert.equal((await request('/api/extensions/permissions', { policy: { rules: [grant('allow', { capability: 'not.installed' })] } })).status, 400);
  assert.equal((await request('/api/extensions/permissions', { policy: { rules: [grant('allow', { decision: 'yes' })] } })).status, 400);
  assert.equal(h.extensionPermissions.revision, before);
}));

test('ask occurs before byte reads, and a corrupt persistent audit blocks execution', async () => {
  const permissions = new ExtensionPermissions({ policy: { rules: [grant('ask', { capability: 'voice.asr', dataScopes: ['source-bytes'] })] } });
  let reads = 0; let requests = 0;
  const runtime = new ContentServiceRuntime({ permissions, services: [{ id: 'voice.asr', effect: 'read', accepts: ['voice'], inputMode: 'bytes',
    transport: { type: 'http', url: 'http://127.0.0.1:9871/transcribe' } }], readSource: async () => { reads++; throw new Error('must not read'); },
    fetchImpl: async () => { requests++; throw new Error('must not connect'); } });
  try {
    const result = await runtime.call({ key: KEY, scope: 'lease', serviceId: 'voice.asr', source: { type: 'voice', sourceId: 'a'.repeat(32) } });
    assert.equal(result.status, 'approval_required'); assert.equal(reads, 0); assert.equal(requests, 0);
  } finally { await runtime.close(); }
  const h = await bridgeHarness({ config: { framework: { services: [SERVICE], permissions: { rules: [grant('allow')] } } },
    files: { 'state/extension-audit.json': '{broken' } });
  try {
    await assert.rejects(h.contentServices.call({ key: KEY, scope: 'lease', serviceId: SERVICE.id,
      source: { type: 'link', sourceId: 'a'.repeat(32), url: 'https://b23.tv/fixture' } }), /审计不可写/);
    assert.equal(h.contentServices.connections.size, 0);
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/extension-audit.json'), 'utf8'), '{broken');
  } finally { await h.close(); }
});

test('concurrent retries of an approved write invoke the real HTTP provider only once and do not cache', async () => {
  let calls = 0;
  const provider = http.createServer((req, res) => { req.resume(); calls++; setTimeout(() => res.end(JSON.stringify({ content: [{ type: 'text', text: 'done' }] })), 40); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try { await fixture(async ({ h, client, request, receive }) => {
    const sourceId = await receive();
    const pending = await client.processContent(SERVICE.id, { sourceId });
    assert.equal(calls, 0);
    const approvalId = pending.approval.requestId;
    await request('/api/extensions/approvals/resolve', { requestId: approvalId, decision: 'approve' });
    const results = await Promise.allSettled([0, 1].map(() => client.processContent(SERVICE.id, { sourceId, approvalId })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(calls, 1); assert.equal(h.contentServices.cache.size, 0);
    await assert.rejects(client.processContent(SERVICE.id, { sourceId, approvalId }), /失效|消费/);
    assert.equal(calls, 1);
  }, [grant('allow')], { services: [{ ...SERVICE, effect: 'write', transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }] }); }
  finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});
