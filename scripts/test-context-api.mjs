import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { queryConversationContext } from '../src/core/context-query.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { apply as applyGuard } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { startMemoryProvider } from '../examples/memory-provider.mjs';

const GROUP = 'group:456';
const config = {
  ownerQQ: 123, dualMode: { enabled: true, ownerPreset: 'standard', ownerPrompt: 'OWNER_ONLY' },
  allow: { private: ['123'], groups: ['456', '789'] },
  slang: { enabled: true, autoResearch: false },
  socialV2: { proactive: { enabled: false }, sticker: { enabled: false }, wake: { preSleepWaitEnabled: false } },
};
const slang = Array.from({ length: 15 }, (_, i) => ({ content: `词${i}`, meaning: `含义${i}`, status: 'confirmed', count: 100 - i }));

async function fixture(run, override = {}) {
  const plugin = await startMemoryProvider();
  const h = await bridgeHarness({ config: { ...config,
    memory: { provider: 'fixture', providers: [{ id: 'fixture', operations: ['query'], transport: { type: 'http', url: plugin.url } }] },
    framework: { permissions: { rules: [{ key: GROUP, capability: 'memory.fixture.query', decision: 'allow', dataScopes: ['memory-query'] }] } },
    ...override }, files: { 'state/slang.json': slang } });
  await h.ensureSession(GROUP);
  const st = h.getSocialV2State(GROUP);
  plugin.store.save(h.memoryProviders.namespace('fixture', GROUP), [
    { id: 'topic', text: '周末摄影', category: 'activeTopic', metadata: { participants: ['张三'] } },
    { id: 'member-a', text: '喜欢摄影', category: 'memberImpression', subject: '张三' },
    { id: 'member-b', text: '喜欢足球', category: 'memberImpression', subject: '李四' },
  ]);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new QQBridgeClient({ baseUrl, key: GROUP, token: st.agentToken });
  const request = async (path, { token = st.agentToken, body, headers = {} } = {}) => {
    const res = await fetch(baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token === null ? {} : { 'x-agent-token': token }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  try { await run({ h, st, server, client, request, baseUrl, plugin }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); await plugin.close(); }
}

test('default wakes contain no inline memory, slang, message history or role body; inline is an explicit fallback', () => fixture(async ({ h, st }) => {
  fs.mkdirSync(`${h.temp}/roles`);
  fs.writeFileSync(`${h.temp}/roles/fixture.md`, 'ROLE_BODY');
  fs.writeFileSync(`${h.temp}/state/current-role.json`, JSON.stringify({ role: 'fixture' }));
  st.recentMessages.push({ seq: 1, sender: '张三', text: 'CHAT_BODY' });
  st.unread.push(st.recentMessages[0]);
  await h.deliverPrompt(GROUP, '', { wakeReason: 'question' });
  const lean = h.calls.prompts.at(-1).content[0].text;
  for (const secret of ['ROLE_BODY', 'CHAT_BODY', '喜欢摄影', '词0', '含义0']) assert.ok(!lean.includes(secret), secret);
  assert.match(lean, /按需上下文/);
  assert.equal(h.buildWakeSnapshotV2(GROUP), null);
  h.cfg.socialV2.context.strategy = 'inline';
  await h.deliverPrompt(GROUP, '', { wakeReason: 'question' });
  const legacy = h.calls.prompts.at(-1).content[0].text;
  for (const text of ['CHAT_BODY', '含义0']) assert.ok(legacy.includes(text), text);
  assert.ok(!legacy.includes('喜欢摄影'), '即使 inline 也不绕过提供者授权自动注入记忆');
  assert.ok(lean.length < legacy.length);
}));

test('external SDK queries one member through its provider without changing stored private facts', () => fixture(async ({ h, client, st, plugin }) => {
  const result = await client.queryContext({ kind: 'memory', category: 'memberImpression', member: '张三' });
  assert.deepEqual(result.items.map(item => item.subject), ['张三']);
  assert.ok(!JSON.stringify(result).includes('足球'));
  assert.equal(plugin.store.namespaces[h.memoryProviders.namespace('fixture', GROUP)].length, 3);
  const caps = await client.capabilities();
  assert.equal(caps.apiVersion, '1');
  assert.ok(caps.contextKinds.includes('memory'));
  assert.ok(!JSON.stringify(caps).includes(st.agentToken));
}));

test('external stdio MCP example performs a scoped context query end to end', () => fixture(async ({ baseUrl, st }) => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../examples/mcp-context-server.mjs', import.meta.url))],
    env: { ...process.env, QQ_BRIDGE_URL: baseUrl }, stderr: 'pipe' });
  const client = new Client({ name: 'fixture-extension-host', version: '1.0.0' });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name), ['qq_extension_context']);
    const reply = await client.callTool({ name: 'qq_extension_context', arguments: {
      key: GROUP, token: st.agentToken, kind: 'memory', member: '张三',
    } });
    assert.ok(!reply.isError);
    assert.ok(JSON.parse(reply.content[0].text).items.some(item => item.subject === '张三'));
    const denied = await client.callTool({ name: 'qq_extension_context', arguments: {
      key: 'group:789', token: st.agentToken, kind: 'memory',
    } });
    assert.equal(denied.isError, true);
  } finally { await client.close(); }
}));

test('slang search covers the full confirmed dictionary, not just the popular eight entries', () => fixture(async ({ client }) => {
  const result = await client.queryContext({ kind: 'slang', query: '词14' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].content, '词14');
  assert.ok(!JSON.stringify(result).includes('词0'));
}));

test('on-demand history queries do not acknowledge messages or authorize an unseen watermark', () => fixture(async ({ h, client, st }) => {
  h.appendSocialV2Message(GROUP, '张三', '摄影这件事', '摄影这件事', false, false, '3', [], '321', []);
  const result = await client.queryContext({ kind: 'history', query: '摄影' });
  assert.equal(result.items.length, 1);
  assert.equal(st.unread.length, 1);
  await assert.rejects(client.acknowledge(st.unread[0].seq), /水位|读取|展示/);
  const unread = await client.unread();
  await client.acknowledge(unread.readThroughSeq);
  assert.equal(st.unread.length, 0);
}));

test('public aliases keep cross-session, empty/retired-token and management boundaries', () => fixture(async ({ h, request, st }) => {
  assert.equal((await request('/api/v1/capabilities', { token: null })).status, 401);
  assert.equal((await request('/api/v1/capabilities', { token: '' })).status, 401);
  assert.equal((await request('/api/v1/context/query', { body: { key: 'group:789', kind: 'memory' } })).status, 403);
  assert.equal((await request('/api/v1/context/query?key=group:789', { body: { key: GROUP, kind: 'memory' } })).status, 403);
  assert.equal((await request('/api/v1/mode', { body: {} })).status, 404);
  assert.equal((await request('/api/role', { body: {} })).status, 401);
  const old = st.agentToken;
  h.cfg.allow.groups = ['789'];
  h.reconcileSessionPolicies();
  assert.equal((await request('/api/v1/capabilities', { token: old })).status, 401);
}));

test('public calls still enforce pause, feature switches and JSON input limits', () => fixture(async ({ h, client, request }) => {
  h.socialV2.paused = true;
  await assert.rejects(client.queryContext({ kind: 'memory' }), /暂停/);
  h.socialV2.paused = false;
  h.cfg.socialV2.tools.memory = false;
  await assert.rejects(client.queryContext({ kind: 'memory' }), /未启用/);
  assert.ok(!(await client.capabilities()).contextKinds.includes('memory'));
  h.cfg.socialV2.tools.memory = true;
  assert.equal((await request('/api/v1/context/query', { body: { kind: 'memory', limit: 999999 } })).status, 400);
  assert.equal((await request('/api/v1/context/query', { body: { kind: 'shell' } })).status, 400);
  assert.equal((await request('/api/v1/context/query', { body: { kind: 'role' }, headers: { origin: 'https://evil.invalid' } })).status, 403);
}));

test('legacy single-mode public tokens also lose access after mode or allowlist changes', () => fixture(async ({ h, client }) => {
  h.setMode('reserved2');
  await client.capabilities();
  h.cfg.allow.groups = [];
  await assert.rejects(client.capabilities(), /会话令牌/);
  h.cfg.allow.groups = ['456'];
  h.setMode('chat');
  await assert.rejects(client.capabilities(), /会话令牌/);
}, { dualMode: { enabled: false } }));

test('public send reuses gateway/audit checks, and owner calls remain in their own private task', () => fixture(async ({ h, client, baseUrl, request }) => {
  await client.send('群聊测试');
  assert.equal(h.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 1);
  const ownerId = await h.ensureSession('private:123');
  const token = h.ownerAgentToken('private:123', ownerId);
  const owner = new QQBridgeClient({ baseUrl, key: 'private:123', token });
  assert.deepEqual((await owner.capabilities()).contextKinds, []);
  await owner.send('任务结果');
  assert.equal(h.calls.http.filter(call => call.url.endsWith('/send_private_msg')).length, 1);
  await assert.rejects(owner.queryContext({ kind: 'memory' }), /不能调用/);
  assert.equal((await request('/api/v1/messages/send', { token, body: { messages: 'cross', key: GROUP } })).status, 403);
}));

test('a request waiting for its body cannot use a newly recreated session', () => fixture(async ({ h, st, baseUrl }) => {
  const url = new URL(baseUrl);
  const body = JSON.stringify({ key: GROUP, kind: 'memory' });
  const response = new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: '/api/v1/context/query', method: 'POST',
      headers: { 'x-agent-token': st.agentToken, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.flushHeaders();
    setTimeout(() => { h.retireSession(GROUP); req.end(body); }, 20);
  });
  assert.equal(await response, 403);
}));

test('non-memory context budgets and paging handle oversized text without retaining an internal memory engine', () => {
  const source = { state: { recentMessages: Array.from({ length: 8 }, (_, i) => ({ text: `消息${i}`, seq: i + 1 })) } };
  const before = JSON.stringify(source);
  const page = queryConversationContext(source, { kind: 'history', limit: 2 });
  assert.equal(page.total, 8);
  assert.equal(page.nextOffset, 2);
  const second = queryConversationContext(source, { kind: 'history', limit: 2, offset: 2 });
  assert.notEqual(page.items[0].text, second.items[0].text);
  assert.equal(JSON.stringify(source), before);
  assert.throws(() => queryConversationContext(source, { kind: 'memory' }), /提供者/);
  const huge = queryConversationContext({ role: { text: '\u0000"\\😀'.repeat(6000) } }, { kind: 'role', maxChars: 500 });
  assert.ok(JSON.stringify(huge).length <= 500);
  assert.equal(huge.items[0].truncated, true);
  for (const limit of [0, NaN, '5', 21]) assert.throws(() => queryConversationContext(source, { limit }));
});

test('external MCP must pass the service permission broker; direct guard bypass stays denied', () => {
  let guard;
  const ctx = { tools: { restrict() {}, guard(fn) { guard = fn; } } };
  applyGuard(ctx);
  assert.ok(guard({ name: 'mcp__example__query' }));
  assert.ok(guard({ name: 'mcp__example__execute' }));
  assert.ok(guard({ name: 'pwsh' }));
  for (const allowedMcpTools of [['mcp__example__query'], ['mcp__example__*'], ['skill'], 'invalid']) {
    applyGuard(ctx, { allowedMcpTools });
    assert.match(guard({ name: 'mcp__example__query' }), /绕过审批/);
    assert.ok(guard({ name: 'mcp__snowluma__qq_get_unread_messages' }), '配置出错时守卫仍安装并拒绝执行，不能因插件失败而继承全权工具');
  }
});

test('only an authenticated administrator can explicitly bypass wake limits for one request', () => fixture(async ({ h, st, request }) => {
  h.cfg.socialV2.wake.maxWakePerMinute = 1; h.cfg.socialV2.wake.maxWakePerHour = 12;
  st.wakeTimes = Array.from({ length: 12 }, (_, i) => Date.now() - 120000 - i * 1000);
  const before = h.calls.prompts.length;
  const body = { key: GROUP, reason: 'admin', bypassRateLimit: true };
  assert.equal((await request('/api/socialV2/wake', { body })).status, 401);
  assert.equal((await request('/api/socialV2/wake', { body, headers: { 'x-console-token': 'fixture-console-token' } })).status, 403);
  const admin = { token: null, headers: { 'x-console-token': 'fixture-console-token' } };
  assert.equal((await request('/api/socialV2/wake', { ...admin, body: { ...body, bypassRateLimit: 'true' } })).status, 400);
  await request('/api/socialV2/wake', { ...admin, body: { key: GROUP, reason: 'admin' } });
  assert.equal(h.calls.prompts.length, before); assert.ok(st.rateLimitRetryTimer);
  const forced = await request('/api/socialV2/wake', { ...admin, body });
  assert.equal(forced.status, 200); assert.equal(forced.data.bypassRateLimit, true);
  for (let n = 0; n < 50 && h.calls.prompts.length === before; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.calls.prompts.length, before + 1); assert.equal(st.rateLimitRetryTimer, null);
  assert.equal((await request('/api/socialV2/wake', { ...admin, body })).status, 409);
  assert.equal(h.calls.prompts.length, before + 1);
  assert.equal(h.cfg.socialV2.wake.maxWakePerHour, 12);
}));

test('SDK rejects remote/credentialed origins and never sends console credentials or follows redirects', async () => {
  for (const baseUrl of ['https://example.com', 'http://127.0.0.1:3100@evil.invalid', 'http://localhost:3100/?token=secret']) {
    assert.throws(() => new QQBridgeClient({ baseUrl, key: GROUP, token: 'fixture' }));
  }
  const client = new QQBridgeClient({ key: GROUP, token: 'fixture', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-console-token'], undefined);
    assert.equal(url.searchParams.get('token'), null);
    assert.equal(JSON.parse(options.body).key, GROUP);
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  await client.queryContext({ kind: 'memory', key: 'group:789' });
});
