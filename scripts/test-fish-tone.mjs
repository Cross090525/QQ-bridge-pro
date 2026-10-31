import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { normalizeFishToneSettings, loadFishToneSettings, resolveFishTone, fishTonePrompt } from '../src/fish-tone.mjs';
import { runFishTone } from '../integrations/fish-tone-provider.mjs';
import { buildFishToneServices } from '../integrations/fish-tone-services.mjs';
import { installFishToneServices } from './setup-fish-tone.mjs';
import { allMemes, randomMeme, flavor } from '../integrations/vendor/dsh-fish-tone/lib/flavor.js';
import { ContentServiceRuntime, mapServiceArguments } from '../src/framework/services.mjs';
import { ExtensionPermissions } from '../src/framework/permissions.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const key = 'group:456', context = { key };
const enabled = { defaults: { rewriteEnabled: true } };
const value = result => JSON.parse(result.content[0].text);
const tone = (text, input = {}, settings = enabled) => value(runFishTone('text_tone', { input: { text, ...input }, context }, { settings }));

test('settings have conservative defaults and support role then conversation overrides', () => {
  const settings = normalizeFishToneSettings({ roles: { tester: { style: 'cute', strength: 'normal' } }, conversations: { [key]: { style: 'abstract' } } });
  assert.equal(settings.defaults.rewriteEnabled, false);
  assert.deepEqual(resolveFishTone(settings, { key, role: 'tester' }), { enabled: true, style: 'abstract', strength: 'normal', rewriteEnabled: false });
  assert.equal(resolveFishTone(settings, { key: 'group:789', role: 'tester' }).style, 'cute');
  assert.match(fishTonePrompt(settings, { key }), /不编经历/);
  assert.match(fishTonePrompt({ conversations: { [key]: { enabled: false } } }, context), /关闭额外语气/);
  assert.match(fishTonePrompt({ defaults: { strength: 'off' } }, context), /关闭额外语气/);
});

test('settings reject unknown fields, unsafe targets, bad types and corrupted storage', async () => {
  for (const input of [{ endpoint: 'http://private' }, { defaults: { enabled: 'true' } }, { roles: { '../file': {} } },
    { conversations: { '*': { style: 'cute' } } }, { defaults: { mode: 'max' } }]) assert.throws(() => normalizeFishToneSettings(input));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-config-test-'));
  try {
    assert.equal(loadFishToneSettings(path.join(dir, 'absent')).defaults.rewriteEnabled, false);
    await fs.writeFile(path.join(dir, 'bad'), '{'); assert.throws(() => loadFishToneSettings(path.join(dir, 'bad')), /损坏/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rewriting requires both enabled settings and a valid trusted conversation; unknown runtime knobs are rejected', () => {
  assert.throws(() => tone('这段内容挺有趣。', {}, {}), /未启用/);
  assert.throws(() => tone('这段内容挺有趣。', {}, { defaults: { enabled: false, rewriteEnabled: true } }), /未启用/);
  assert.throws(() => runFishTone('text_judge', { input: { text: '内容' }, context: { key: '*' } }), /会话/);
  for (const input of [{ protect: false }, { marks: 'max' }, { key: 'group:789' }, { seed: -1 }, { strength: 'bad' }, { mode: 'bad' }]) assert.throws(() => tone('这段内容挺有趣。', input));
});

test('regression: strength=off is a complete identity across every style and seed', () => {
  const text = '我看过这段内容。这个功能挺麻烦。';
  for (const mode of ['neutral', 'cute', 'abstract', 'shock']) for (let seed = 0; seed < 20; seed++) {
    const out = tone(text, { strength: 'off', mode, seed }); assert.equal(out.text, text); assert.equal(out.changed, false);
  }
});

test('regression: flavor preserves balanced and unfinished fenced text in every mode', () => {
  for (const mode of ['cute', 'abstract', 'shock']) for (const src of ['```text\n这个功能挺好用。\n```', '~~~text\n这段安排真的离谱。', '```\n这个地方有点奇怪。\n```']) {
    for (let seed = 0; seed < 20; seed++) assert.equal(flavor(src, { mode, rate: 'high', seed, protect: true }).text, src);
  }
});

test('regression: shock reaches the implementation through the bridge adapter', () => {
  const out = tone('这段安排真的离谱。', { mode: 'shock', seed: 3 });
  assert.match(out.text, /？！/); assert.equal(out.original, '这段安排真的离谱。');
});

test('regression: seeded random memes reach past the first 30 and cover the full library', () => {
  const library = allMemes(), sampled = new Set(Array.from({ length: 1000 }, (_, i) => randomMeme(i + 1).term));
  assert.equal(library.length, 1024); assert.ok(sampled.size > 400);
  assert.ok([...sampled].some(term => !library.slice(0, 30).some(m => m.term === term)));
  assert.equal(randomMeme(12).term, randomMeme(12).term);
  assert.equal(randomMeme(7, { kind: 'construction' }).kind, 'construction');
});

test('all styles preserve numeric, factual, quoted and technical lines; no typo or semantic mark pipeline runs', () => {
  const text = '价格是14.69元。\n已经确认可以使用。\n结论：必须保留原始资料。\n“我看过这个”\n运行 `npm test`。\nhttps://example.com/file\n```text\n这段安排真的离谱。\n```';
  for (const mode of ['neutral', 'cute', 'abstract', 'shock']) assert.equal(tone(text, { mode, strength: 'max', seed: 1 }).text, text);
  const src = '我看过这段内容。';
  const result = tone(src, { strength: 'light', seed: 1 }); assert.ok(!result.text.includes('我也')); assert.ok(!result.text.includes('好像'));
});

test('judge returns the original, bounded findings and an explicit heuristic limitation; unknown memes stay unknown', () => {
  const text = '不是速度太慢，而是代码有问题。最重要的是先分析再处理。';
  const out = value(runFishTone('text_judge', { input: { text }, context }));
  assert.equal(out.original, text); assert.ok(out.hitCount > 0); assert.match(out.note, /不是AI鉴定/);
  const unknown = value(runFishTone('text_meme', { input: { text: '从未存在词xyz' }, context })); assert.equal(unknown.memes.length, 0);
  const found = value(runFishTone('text_meme', { input: { text: '破防' }, context })); assert.ok(found.memes.length > 0);
  assert.ok(found.memes.every(m => m.source && typeof m.known === 'boolean'));
});

test('installation is idempotent and preserves unrelated services, existing deny/ask and leaves rewriting ungranted', () => {
  const original = { allow: { groups: ['456'] }, framework: { services: [{ id: 'media.storyboard' }], permissions: { rules: [
    { key, capability: 'text.judge', decision: 'deny' }, { key, capability: 'text.meme', decision: 'ask' } ] } } };
  const installed = installFishToneServices(original);
  assert.deepEqual(installFishToneServices(installed), installed);
  assert.ok(installed.framework.services.some(s => s.id === 'media.storyboard'));
  assert.equal(installed.framework.permissions.rules.find(r => r.capability === 'text.judge').decision, 'deny');
  assert.equal(installed.framework.permissions.rules.find(r => r.capability === 'text.meme').decision, 'ask');
  assert.ok(!installed.framework.permissions.rules.some(r => r.capability === 'text.tone'));
  assert.equal(installFishToneServices({}).framework.permissions.rules.length, 0);
});

test('trusted context comes from the bound call, never an input key; whole input mapping keeps schema validation', () => {
  const args = mapServiceArguments({ input: '$input', context: { key: '$context.key' } }, {}, { text: 'draft', key: 'group:789' }, 0, context);
  assert.equal(args.context.key, key); assert.equal(args.input.key, 'group:789');
  for (const template of ['$context.token', '$context.scope', '$context.__proto__']) assert.throws(() => mapServiceArguments(template, {}, {}, 0, context));
});

test('real stdio honors default deny, approvals, rewrite settings and exact conversation context', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-stdio-test-'));
  const settingsFile = path.join(dir, 'fish.json'); await fs.writeFile(settingsFile, JSON.stringify(enabled));
  const services = buildFishToneServices({ settingsFile, roleFile: path.join(dir, 'absent-role') });
  const permissions = new ExtensionPermissions();
  const runtime = new ContentServiceRuntime({ services, permissions });
  try {
    await assert.rejects(runtime.call({ key, scope: 'fixture', serviceId: 'text.judge', input: { text: '草稿' } }), /未获/);
    assert.equal(runtime.connections.size, 0);
    permissions.replacePolicy({ rules: [{ key, capability: 'text.judge', decision: 'ask', dataScopes: ['input'] }] });
    const pending = await runtime.call({ key, scope: 'fixture', serviceId: 'text.judge', input: { text: '草稿' } });
    assert.equal(pending.status, 'approval_required'); assert.equal(runtime.connections.size, 0);
    permissions.resolve(pending.approval.requestId, 'approve');
    const approved = await runtime.call({ key, scope: 'fixture', serviceId: 'text.judge', input: { text: '草稿' }, approvalId: pending.approval.requestId });
    assert.equal(JSON.parse(approved.content[0].text).original, '草稿');
    permissions.replacePolicy({ rules: ['text.judge', 'text.meme', 'text.tone'].map(capability => ({ key, capability, decision: 'allow', dataScopes: ['input'] })) });
    const out = await runtime.call({ key, scope: 'fixture', serviceId: 'text.judge', input: { text: '不是速度慢，而是代码有问题。' } });
    assert.equal(JSON.parse(out.content[0].text).original, '不是速度慢，而是代码有问题。');
    await assert.rejects(runtime.call({ key: 'group:789', scope: 'other', serviceId: 'text.judge', input: { text: '草稿' } }), /未获/);
    const unchanged = await runtime.call({ key, scope: 'fixture', serviceId: 'text.tone', input: { text: '我看过这个。', strength: 'off' } });
    assert.equal(JSON.parse(unchanged.content[0].text).text, '我看过这个。');
    await fs.writeFile(settingsFile, '{}');
    await assert.rejects(runtime.call({ key, scope: 'fixture', serviceId: 'text.tone', input: { text: '新的草稿。' } }), /处理失败/);
    await assert.rejects(runtime.call({ key, scope: 'fixture', serviceId: 'text.judge', input: { text: '草稿', context: { key: 'group:789' } } }), /schema/);
  } finally { await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('bridge console settings are admin-only; group prompt reacts to overrides; text services use real API and stdio', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-api-test-'));
  const settingsFile = path.join(dir, 'fish.json'); await fs.writeFile(settingsFile, '{}');
  const services = buildFishToneServices({ settingsFile, roleFile: path.join(dir, 'absent-role') });
  const rules = [{ key, capability: 'text.judge', decision: 'allow', dataScopes: ['input'] }];
  const h = await bridgeHarness({ config: { dualMode: { enabled: true, ownerPreset: 'standard' }, framework: { services, permissions: { rules } } } });
  await h.ensureSession(key); const agent = h.getSocialV2State(key).agentToken;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, extra = {}) => fetch(baseUrl + route, { method: body ? 'POST' : 'GET', headers: {
    'x-console-token': 'fixture-console-token', ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.match(h.buildWakePromptV2(key, 'atMention'), /【聊天表达】/);
    assert.doesNotMatch(h.buildWakePromptV2('private:123', 'atMention'), /【聊天表达】/);
    for (const route of ['/api/fish-tone', '/api/fish-tone/preview']) {
      const r = await request(route, { settings: {}, operation: 'judge', input: { text: '草稿' } }, { 'x-agent-token': agent, 'x-agent-call': '1' }); assert.equal(r.status, 403);
    }
    const settings = { conversations: { [key]: { style: 'cute' }, 'group:789': { enabled: false } } };
    const saved = await request('/api/fish-tone', { settings }); assert.equal(saved.status, 200);
    assert.match(h.buildWakePromptV2(key, 'atMention'), /温和可爱/);
    assert.match(h.buildWakePromptV2('group:789', 'atMention'), /关闭额外语气/);
    const preview = await request('/api/fish-tone/preview', { operation: 'judge', input: { text: '最重要的是先分析再处理。' } });
    assert.equal(preview.status, 200); assert.ok((await preview.json()).result.hitCount > 0);
    const client = new QQBridgeClient({ baseUrl, key, token: agent });
    const result = await client.processContent('text.judge', { input: { text: '这是一份草稿。' } }); assert.equal(result.media.length, 0);
    assert.equal(JSON.parse(result.content[0].text).original, '这是一份草稿。');
    let started, finish;
    const ready = new Promise(resolve => { started = resolve; });
    h.contentServices.transport.call = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
    const inFlight = client.processContent('text.judge', { input: { text: '正在检查的另一份草稿。' } });
    const rejected = assert.rejects(inFlight, /变化|配置|授权/);
    await ready; assert.equal((await request('/api/fish-tone', { settings: {} })).status, 200);
    finish({ content: [{ type: 'text', text: 'stale result' }] }); await rejected;
    assert.equal(h.calls.sent.length, 0);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
