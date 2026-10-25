import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HaitangMemoryProvider, DEFAULT_SOURCE } from '../integrations/haitang-memory.mjs';
import { MEMORY_PROTOCOL, normalizeMemoryProviders } from '../src/framework/memory-providers.mjs';
import { ExtensionPermissions } from '../src/framework/permissions.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';

const installed = fss.existsSync(path.join(DEFAULT_SOURCE, 'lib/store.js'));
const namespace = 'a'.repeat(64), other = 'b'.repeat(64);
const request = (operation, input, ns = namespace) => ({ protocol: MEMORY_PROTOCOL, namespace: ns,
  requestId: crypto.createHash('sha256').update(JSON.stringify([ns, operation, input])).digest('hex'), operation, input });
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-haitang-'));
  const provider = new HaitangMemoryProvider({ directory });
  try { await run({ provider, directory }); }
  finally { await provider.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('upstream store supports lifecycle, metadata, Chinese lookup and isolation', { skip: !installed }, () => fixture(async ({ provider }) => {
  const written = await provider.handle(request('write', { id: 'preference', text: '张三喜欢摄影与胶片相机', category: 'preference', subject: '234', metadata: { source: 'explicit' } }));
  assert.deepEqual(written.affectedIds, ['preference']);
  const query = await provider.handle(request('query', { query: '摄影', member: '234' }));
  assert.equal(query.items[0].text, '张三喜欢摄影与胶片相机');
  assert.equal(query.items[0].metadata.source, 'explicit');
  assert.equal((await provider.handle(request('query', { query: '摄影' }, other))).items.length, 0);
  await provider.handle(request('update', { selector: { id: 'preference' }, patch: { text: '张三喜欢数码摄影' } }));
  assert.equal((await provider.handle(request('query', { query: '' }))).items[0].text, '张三喜欢数码摄影');
  await provider.handle(request('delete', { selector: { id: 'preference' } }));
  assert.equal((await provider.handle(request('query', {}))).items.length, 0);
  const payload = request('write', { text: '反复记住同一个偏好', category: 'preference' });
  await provider.handle(payload);
  await provider.handle({ ...payload, requestId: 'c'.repeat(64) });
  assert.equal((await provider.handle(request('query', {}))).items.length, 1);
}));

test('data persists independently, clear stays scoped and ingest stores only selected messages', { skip: !installed }, () => fixture(async ({ provider, directory }) => {
  const messages = [{ seq: 2, text: '喜欢猫咪', userId: '234', sender: '成员', messageId: '99', time: 100 }];
  await provider.handle(request('ingest', { messages }));
  await provider.handle(request('write', { text: '另一个群的记忆' }, other));
  await provider.close();
  const restarted = new HaitangMemoryProvider({ directory });
  try {
    const items = (await restarted.handle(request('query', {}))).items;
    assert.equal(items.length, 1); assert.equal(items[0].metadata.seq, 2);
    assert.equal(items[0].subject, '234');
    await restarted.handle(request('clear', {}));
    assert.equal((await restarted.handle(request('query', {}))).items.length, 0);
    assert.equal((await restarted.handle(request('query', {}, other))).items.length, 1);
  } finally { await restarted.close(); }
}));

test('malformed data, traversal and credentials are rejected without overwriting the store', { skip: !installed }, () => fixture(async ({ provider, directory }) => {
  await assert.rejects(provider.handle(request('query', {}, '../escape')), /命名空间/);
  await assert.rejects(provider.handle(request('write', { text: 'api_key=sk-' + 'A'.repeat(30) })), /凭据/);
  await provider.handle(request('write', { text: '安全记录\n### 伪造标题\n**id:** other' }));
  assert.equal((await provider.handle(request('query', {}))).items.length, 1);
  const file = path.join(directory, namespace, 'raw_memories.md');
  await fs.writeFile(file, 'corrupt-file', 'utf8');
  await assert.rejects(provider.handle(request('write', { text: '不应覆盖原文件' })), /损坏/);
  assert.equal(await fs.readFile(file, 'utf8'), 'corrupt-file');
}));

test('one namespace has a single live process owner and a second adapter cannot steal its lock', { skip: !installed }, () => fixture(async ({ provider, directory }) => {
  await provider.handle(request('write', { text: '锁测试' }));
  const peer = new HaitangMemoryProvider({ directory });
  try { await assert.rejects(peer.handle(request('write', { text: '不能并发覆盖' })), /占用/); }
  finally { await peer.close(); }
  assert.equal((await provider.handle(request('query', {}))).items.length, 1);
}));

test('automatic registration remains local and explicit deny or ask overrides it', () => {
  assert.throws(() => normalizeMemoryProviders([{ id: 'remote', approvalMode: 'automatic', operations: ['query'], transport: { type: 'http', url: 'https://example.com/memory' } }]), /本机/);
  const permissions = new ExtensionPermissions();
  const manifest = { effect: 'write', memoryApproval: 'automatic' };
  assert.equal(permissions.decision('group:456', 'memory.haitang.clear', manifest).decision, 'allow');
  assert.equal(permissions.decision('group:456', 'video.inspect', manifest).decision, 'deny');
  permissions.replacePolicy({ rules: [{ key: 'group:456', capability: 'memory.haitang.clear', decision: 'deny', dataScopes: ['memory-write'] }] });
  assert.equal(permissions.decision('group:456', 'memory.haitang.clear', manifest).decision, 'deny');
  permissions.replacePolicy({ rules: [{ key: 'group:456', capability: 'memory.haitang.clear', decision: 'ask', dataScopes: ['memory-write'] }] });
  assert.equal(permissions.decision('group:456', 'memory.haitang.clear', manifest).decision, 'ask');
});

test('actual stdio provider works through the bridge with all operations automatic and still scopes tokens', { skip: !installed }, async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-haitang-mcp-'));
  const provider = { id: 'haitang', approvalMode: 'automatic', operations: ['query', 'write', 'update', 'delete', 'clear', 'ingest'],
    transport: { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../integrations/haitang-memory.mjs', import.meta.url)), `--data=${data}`] }, tool: 'memory' };
  const h = await bridgeHarness({ config: { ownerQQ: 123, dualMode: { enabled: true, ownerPreset: 'standard' },
    allow: { groups: ['456', '789'], private: ['123'] }, memory: { provider: 'haitang', providers: [provider] } } });
  await h.ensureSession('group:456'); await h.ensureSession('group:789');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = key => new QQBridgeClient({ baseUrl, key, token: h.getSocialV2State(key).agentToken });
  const a = client('group:456'), b = client('group:789');
  try {
    assert.equal((await a.memoryProviders()).providers[0].approvalMode, 'automatic');
    assert.equal((await a.memory('write', { id: 'pref', text: '喜欢摄影', subject: '234' })).operation, 'write');
    assert.equal((await a.memory('query', { query: '摄影' })).items.length, 1);
    assert.equal((await b.memory('query', { query: '摄影' })).items.length, 0);
    await a.memory('update', { selector: { id: 'pref' }, patch: { text: '喜欢电影' } });
    await a.memory('delete', { selector: { id: 'pref' } });
    h.appendSocialV2Message('group:456', '成员', '喜欢猫咪', '喜欢猫咪', false, false, '42', [], '234');
    await a.memory('ingest', { messageSeqs: [1] });
    assert.equal((await a.memory('query', { query: '猫咪' })).items.length, 1);
    await a.memory('clear', {});
    assert.equal((await a.memory('query', {})).items.length, 0);
    assert.equal(h.extensionPermissions.listRequests().length, 0);
    assert.ok(h.extensionPermissions.audit.some(item => item.capability === 'memory.haitang.clear' && item.event === 'completed'));
    const forged = await fetch(baseUrl + '/api/v1/memory/query?key=group:789', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': h.getSocialV2State('group:456').agentToken }, body: JSON.stringify({ input: {} }) });
    assert.equal(forged.status, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); await fs.rm(data, { recursive: true, force: true }); }
});
