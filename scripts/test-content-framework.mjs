import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { normalizeIncomingContent, normalizeOutgoingContent, ContentSourceStore } from '../src/framework/content.mjs';
import { FrameworkMediaStore, decodeMedia } from '../src/framework/media-store.mjs';
import { ContentServiceRuntime, mapServiceArguments } from '../src/framework/services.mjs';
import { ExtensionPermissions } from '../src/framework/permissions.mjs';

const KEY = 'group:456';
const PROVIDER = fileURLToPath(new URL('fixtures/content-service.mjs', import.meta.url));
const services = [
  { id: 'bilibili.inspect', description: '读取 B 站字幕', accepts: ['link'], hosts: ['bilibili.com', 'b23.tv'],
    transport: { type: 'stdio', command: process.execPath, args: [PROVIDER] }, tool: 'inspect_video', arguments: { url: '$source.url' } },
  { id: 'voice.synthesize', description: '合成测试语音', accepts: ['text'],
    transport: { type: 'stdio', command: process.execPath, args: [PROVIDER] }, tool: 'synthesize', arguments: { text: '$input.text' } },
];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';

async function fixture(run, config = {}) {
  const framework = { ...(config.framework ?? { services }) };
  framework.services = framework.services.map(service => ({ effect: 'read', inputSchema: { properties: { text: { type: 'string' }, request: { type: 'string' } } }, ...service }));
  framework.permissions ??= { rules: ['group:456', 'private:123'].flatMap(key => [...framework.services.map(service => service.id), 'bridge.media.read', 'bridge.media.upload'].map(capability => ({
    key, capability, decision: 'allow', dataScopes: ['source-reference', 'source-bytes', 'input', 'media-upload'], maxInputChars: 12000000,
  }))) };
  const h = await bridgeHarness({ config: { ownerQQ: 123, dualMode: { enabled: true, ownerPreset: 'standard' },
    allow: { groups: ['456', '789'], private: ['123'] }, framework: { services },
    socialV2: { voice: { enabled: true }, tools: { sendVoice: true }, wake: { preSleepWaitEnabled: false },
      proactive: { enabled: false }, sticker: { enabled: true } }, ...config, framework } });
  await h.ensureSession(KEY);
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new QQBridgeClient({ baseUrl, key: KEY, token: st.agentToken, timeoutMs: 10000 });
  const receive = async (message, { kind = 'group', id = 456, messageId = 100 } = {}) => {
    await h.handleIncoming(kind, id, { message_id: messageId, user_id: kind === 'private' ? id : 321, group_id: kind === 'group' ? id : undefined,
      self_id: 999, sender: { nickname: '张三' }, message }, h.cfg);
    return normalizeIncomingContent(`${kind}:${id}`, messageId, message);
  };
  try { await run({ h, client, st, receive, baseUrl }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('incoming text, cards and media produce typed references without running providers', () => fixture(async ({ h, receive, client }) => {
  const packet = await receive([
    { type: 'text', data: { text: '看看这个 https://www.bilibili.com/video/BV1234567890。' } },
    { type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'https://b23.tv/fixture' } } }) } },
    { type: 'record', data: { file: 'fixture.amr' } }, { type: 'video', data: { url: 'https://example.com/video.mp4' } },
    { type: 'image', data: { url: 'https://example.com/image.png' } }, { type: 'file', data: { name: '说明.pdf', file: 'file-id' } },
  ]);
  assert.deepEqual(new Set(packet.sources.map(source => source.type)), new Set(['link', 'voice', 'video', 'image', 'file']));
  assert.equal(h.contentServices.connections.size, 0);
  const unread = await client.unread();
  assert.ok(unread.messages[0].content.some(item => item.platform === 'bilibili' && item.sourceId));
  assert.match(h.buildWakePromptV2(KEY, 'atMention'), /待处理B站分享/);
  assert.match(h.buildWakePromptV2(KEY, 'atMention'), /bilibili.storyboard/);
  assert.ok(!JSON.stringify(unread.messages[0].content).includes('fixture.amr'));
  assert.equal(h.contentServices.connections.size, 0);
}));

test('Agent discovers and lazily dispatches a Bilibili reference to an MCP tool with mapped arguments', () => fixture(async ({ h, receive, client }) => {
  const packet = await receive([{ type: 'text', data: { text: '评价 https://www.bilibili.com/video/BV1234567890' } }]);
  const sourceId = packet.sources[0].sourceId;
  assert.deepEqual((await client.contentServices(sourceId)).services.map(service => service.id), ['bilibili.inspect']);
  assert.equal(h.contentServices.connections.size, 0);
  const result = await client.processContent('bilibili.inspect', { sourceId });
  assert.match(result.content[0].text, /fixture transcript/);
  assert.ok(!JSON.stringify(result).includes(PROVIDER));
  assert.equal(h.contentServices.connections.size, 1);
  const cached = await client.processContent('bilibili.inspect', { sourceId });
  assert.equal(cached.cached, true);
  await (await h.contentServices.connections.get('bilibili.inspect')).close();
  const reconnected = await client.processContent('bilibili.inspect', { sourceId, input: { request: 'new explicit call' } });
  assert.match(reconnected.content[0].text, /fixture transcript/);
  await client.sendContent({ type: 'text', text: '从返回的字幕看，这段主要在讲摄影。' });
  await client.sendContent({ type: 'link', url: 'https://www.bilibili.com/video/BV1234567890', title: '原视频' });
  assert.equal(h.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 2);
}));

test('configured HTTP recognizer receives voice bytes only after an explicit Agent call', async () => {
  let calls = 0;
  const provider = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      calls++; const input = JSON.parse(raw); assert.ok(input.source.data); assert.equal(input.source.type, 'voice');
      assert.equal(input.source.file, undefined);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: '周末去拍照' }], evidence: ['audio', 'transcript'] }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try { await fixture(async ({ h, receive, client }) => {
    const audio = path.join(h.temp, 'fixture.wav'); fs.writeFileSync(audio, 'RIFF0000WAVEfixture');
    h.cfg.framework.mediaRoots = [h.temp];
    const packet = await receive([{ type: 'record', data: { file: audio } }]);
    assert.equal(calls, 0);
    const result = await client.processContent('voice.transcribe', { sourceId: packet.sources[0].sourceId });
    assert.deepEqual(result.evidence, ['audio', 'transcript']); assert.equal(calls, 1);
  }, { framework: { services: [{ id: 'voice.transcribe', accepts: ['voice'], inputMode: 'bytes',
    transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }] } }); }
  finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});

test('gateway WAV bytes cross Docker boundary even when incoming voice has a SILK URL', async () => {
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  let processed = 0;
  const provider = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const input = JSON.parse(raw); assert.equal(input.source.data, wav.toString('base64'));
      assert.equal(input.source.mimeType, 'audio/wav'); assert.equal(input.source.file, undefined); processed++;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: '识别结果' }], evidence: ['transcript'] }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try { await fixture(async ({ h, receive, client }) => {
    let conversion = 0; let base64 = wav.toString('base64');
    h.bot.raw = async (action, args) => {
      assert.equal(action, 'get_record'); assert.equal(args.file, 'received.amr'); assert.equal(args.out_format, 'wav'); conversion++;
      return { data: { base64, url: 'https://must-not-download.invalid/raw.silk', file: '/container/private/audio.wav' } };
    };
    const packet = await receive([{ type: 'record', data: { file: 'received.amr', url: 'https://must-not-download.invalid/raw.silk' } }]);
    const sourceId = packet.sources[0].sourceId;
    assert.equal(conversion, 0);
    h.extensionPermissions.replacePolicy({ rules: [{ key: KEY, capability: 'voice.transcribe', decision: 'ask', dataScopes: ['source-bytes', 'input'] }] });
    assert.equal((await client.processContent('voice.transcribe', { sourceId })).status, 'approval_required'); assert.equal(conversion, 0);
    h.extensionPermissions.replacePolicy({ rules: [{ key: KEY, capability: 'voice.transcribe', decision: 'allow', dataScopes: ['source-bytes', 'input'] }] });
    const result = await client.processContent('voice.transcribe', { sourceId });
    assert.equal(result.content[0].text, '识别结果'); assert.equal(conversion, 1); assert.equal(processed, 1);
    for (const invalid of ['@@@=', Buffer.from('not-wave').toString('base64'), 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4)]) {
      base64 = invalid;
      await assert.rejects(client.processContent('voice.transcribe', { sourceId, input: { request: String(conversion) } }), /字节无效|WAV/);
    }
    assert.equal(processed, 1);
  }, { framework: { services: [{ id: 'voice.transcribe', accepts: ['voice'], inputMode: 'bytes',
    transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }] } }); }
  finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});

test('TTS service results become session-bound audio handles that can be sent as QQ voice', () => fixture(async ({ h, client }) => {
  const result = await client.processContent('voice.synthesize', { input: { text: '周末见' } });
  assert.equal(result.media[0].type, 'voice');
  assert.ok(!JSON.stringify(result).includes('framework-media'));
  await client.sendContent({ type: 'voice', mediaId: result.media[0].mediaId });
  const sent = h.calls.http.find(call => call.url.endsWith('/send_group_msg'));
  assert.equal(sent.body.message[0].type, 'record');
  assert.equal((await client.contentServices()).dispatch, 'on-demand');
}));

test('video service can return native image evidence without mixing it into every wake', async () => {
  const provider = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({
      content: [{ type: 'text', text: 'fixture caption' }, { type: 'image', mimeType: 'image/png', data: png }], evidence: ['transcript', 'frames'],
    }));
  }); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try { await fixture(async ({ receive, client, h }) => {
    const packet = await receive([{ type: 'text', data: { text: 'https://b23.tv/frame-fixture' } }]);
    const result = await client.processContent('video.frames', { sourceId: packet.sources[0].sourceId });
    assert.deepEqual(result.evidence, ['transcript', 'frames']);
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.media[0].type, 'image');
    assert.ok(!h.buildWakePromptV2(KEY, 'question').includes(png));
  }, { framework: { services: [{ id: 'video.frames', accepts: ['link'], hosts: ['b23.tv'],
    transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }] } }); }
  finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});

test('uploaded image can be emitted as a sticker without granting arbitrary local-file sending', () => fixture(async ({ h, client }) => {
  const result = await client.uploadMedia({ mimeType: 'image/png', data: png });
  await client.sendContent({ type: 'sticker', mediaId: result.media.mediaId });
  const sent = h.calls.http.find(call => call.url.endsWith('/send_group_msg'));
  assert.equal(sent.body.message[0].type, 'image');
  assert.equal(sent.body.message[0].data.sub_type, 1);
  await assert.rejects(client.sendContent({ type: 'voice', mediaId: result.media.mediaId }), /不是语音/);
  await assert.rejects(client.sendContent({ type: 'image', path: 'C:\\secret.png' }), /mediaId/);
}));

test('source and generated-media handles cannot cross conversations or survive a session lease change', () => fixture(async ({ h, receive, client, baseUrl, st }) => {
  const packet = await receive([{ type: 'text', data: { text: 'https://b23.tv/fixture' } }]);
  const uploaded = await client.uploadMedia({ data: png, mimeType: 'image/png' });
  await h.ensureSession('group:789');
  const other = new QQBridgeClient({ baseUrl, key: 'group:789', token: h.getSocialV2State('group:789').agentToken });
  await assert.rejects(other.contentServices(packet.sources[0].sourceId), /不属于/);
  await assert.rejects(other.sendContent({ type: 'image', mediaId: uploaded.media.mediaId }), /不属于/);
  st.agentToken = 'replacement-token';
  const replacement = new QQBridgeClient({ baseUrl, key: KEY, token: st.agentToken });
  await assert.rejects(replacement.sendContent({ type: 'image', mediaId: uploaded.media.mediaId }), /不属于/);
}));

test('missing services, wrong source types, disabled tools and paused sessions fail explicitly', () => fixture(async ({ h, receive, client }) => {
  const packet = await receive([{ type: 'record', data: { file: 'fixture.amr' } }]);
  await assert.rejects(client.processContent('bilibili.inspect', { sourceId: packet.sources[0].sourceId }), /不支持/);
  await assert.rejects(client.processContent('unknown', { input: { text: 'x' } }), /未配置/);
  h.cfg.socialV2.tools.contentServices = false;
  await assert.rejects(client.contentServices(), /未启用/);
  await client.sendContent({ type: 'text', text: '识别关闭时仍可发送' });
  h.cfg.socialV2.tools.contentServices = true; h.socialV2.paused = true;
  await assert.rejects(client.processContent('voice.synthesize', { input: { text: 'x' } }), /暂停/);
  await assert.rejects(client.sendContent({ type: 'text', text: 'x' }), /暂停/);
}));

test('owner tasks receive typed references and can use services without receiving group memory', () => fixture(async ({ h, receive, baseUrl }) => {
  const packet = await receive([{ type: 'text', data: { text: '看看 https://b23.tv/fixture' } }], { kind: 'private', id: 123 });
  assert.match(h.calls.prompts.at(-1).content[0].text, /内容引用/);
  const sessionId = await h.ensureSession('private:123');
  const owner = new QQBridgeClient({ baseUrl, key: 'private:123', token: h.ownerAgentToken('private:123', sessionId) });
  const result = await owner.processContent('bilibili.inspect', { sourceId: packet.sources[0].sourceId });
  assert.ok(result.content.length);
  await owner.sendContent({ type: 'text', text: '字幕分析完成' });
  assert.equal(h.socialV2.conversations.has('private:123'), false);
  await assert.rejects(owner.queryContext({ kind: 'memory' }), /不能调用/);
}));

test('normalization rejects spoofed Bilibili hosts, credential URLs and unsafe argument templates', () => {
  const packet = normalizeIncomingContent(KEY, '1', [{ type: 'text', data: { text: 'https://bilibili.com.evil.invalid/a https://user:secret@b23.tv/a' } }]);
  assert.equal(packet.sources.length, 1); assert.equal(packet.sources[0].platform, null);
  assert.throws(() => normalizeOutgoingContent({ type: 'link', url: 'file:///secret' }));
  assert.throws(() => mapServiceArguments({ value: '$input.__proto__' }, {}, {}));
  assert.throws(() => mapServiceArguments({ value: '$source.file' }, { url: 'https://b23.tv/x' }, {}));
});

test('source persistence, media expiry and format validation stay bounded and scoped', () => {
  const packet = normalizeIncomingContent(KEY, '1', 'https://b23.tv/fixture');
  let persisted;
  const store = new ContentSourceStore([], { onChange: records => { persisted = records; } });
  store.register(KEY, packet);
  assert.equal(new ContentSourceStore(persisted).get(KEY, packet.sources[0].sourceId).type, 'link');
  assert.throws(() => store.get('group:789', packet.sources[0].sourceId));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-media-'));
  try {
    const media = new FrameworkMediaStore({ directory: temp, ttlMs: 100 });
    const handle = media.put('scope', { data: png, mimeType: 'image/png' });
    assert.throws(() => media.get('other', handle.mediaId));
    media.prune(Date.now() + 200);
    assert.throws(() => media.get('scope', handle.mediaId));
    assert.throws(() => decodeMedia(png, 'audio/wav'));
    assert.throws(() => decodeMedia(png, 'image/gif'));
    assert.throws(() => decodeMedia('!', 'image/png'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('a slow service cannot return data after request revocation or timeout', async () => {
  let alive = true;
  const provider = http.createServer((req, res) => { req.resume(); setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'late' }] })); }, 150); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const runtime = new ContentServiceRuntime({ permissions: new ExtensionPermissions({ policy: { rules: [{ key: KEY, capability: 'slow', decision: 'allow', dataScopes: ['input'] }] } }),
    services: [{ id: 'slow', effect: 'read', inputSchema: { properties: { text: { type: 'string' } }, required: ['text'] }, accepts: ['text'], timeoutMs: 1000,
    transport: { type: 'http', url: `http://127.0.0.1:${provider.address().port}` } }] });
  try {
    const pending = runtime.call({ key: KEY, scope: 'scope', serviceId: 'slow', input: { text: 'test' }, assertLive: () => { if (!alive) throw Object.assign(new Error('revoked'), { statusCode: 403 }); } });
    setTimeout(() => { alive = false; }, 30);
    await assert.rejects(pending, /revoked/);
    runtime.services[0].timeoutMs = 100; alive = true;
    await assert.rejects(runtime.call({ key: KEY, scope: 'scope', serviceId: 'slow', input: { text: 'timeout' } }), /超时/);
  } finally { await runtime.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});
