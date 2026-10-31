import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { queryConversationContext } from '../src/core/context-query.mjs';
import { lookupSlangReference } from '../src/slang-reference.mjs';
import { judgeDraft } from '../integrations/draft-judge-provider.mjs';
import { buildDraftJudgeServices } from '../integrations/draft-judge-services.mjs';
import { installDraftJudge } from './setup-draft-judge.mjs';
import { ContentServiceRuntime } from '../src/framework/services.mjs';
import { ExtensionPermissions } from '../src/framework/permissions.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const key = 'group:456';
const slangEntries = [{ content: '破防', meaning: '本群约好去喝奶茶', status: 'confirmed' },
  { content: '典', meaning: '候选含义不能作结论', status: 'candidate' }];

test('confirmed slang always wins, with no merged generic definition or storage changes', () => {
  const before = JSON.stringify(slangEntries);
  const result = queryConversationContext({ slangEntries, slangReferenceFallback: true }, { kind: 'slang', query: '破防' });
  assert.deepEqual(result.items.map(x => x.meaning), ['本群约好去喝奶茶']); assert.equal(result.provenance, undefined);
  assert.equal(JSON.stringify(slangEntries), before);
});

test('reference fallback is opt-in in the pure selector, is bounded and never marks data confirmed', () => {
  assert.equal(queryConversationContext({ slangEntries: [] }, { kind: 'slang', query: '破防' }).total, 0);
  const result = queryConversationContext({ slangEntries: [], slangReferenceFallback: true }, { kind: 'slang', query: '破防' });
  assert.equal(result.provenance, 'static-reference'); assert.ok(result.items.length > 0);
  assert.ok(result.items.every(x => x.confirmed === false && x.source === 'static-reference' && x.referenceSource));
  assert.match(result.note, /未经本群确认/);
  for (const maxChars of [500, 1000, 3000]) {
    const limited = queryConversationContext({ slangReferenceFallback: true }, { kind: 'slang', query: 'X', maxChars });
    assert.ok(JSON.stringify(limited).length <= maxChars);
  }
  assert.equal(queryConversationContext({ slangReferenceFallback: false }, { kind: 'slang', query: '破防' }).total, 0);
  assert.equal(queryConversationContext({ slangReferenceFallback: true }, { kind: 'slang', query: '' }).total, 0);
});

test('unverified definitions remain explicitly unknown and dictionary lookups do not learn or write', () => {
  assert.deepEqual(lookupSlangReference('从未存在词xyz'), []);
  const words = JSON.parse(readFileSync(new URL('../integrations/vendor/dsh-fish-tone/data/memes.json', import.meta.url))).memes;
  const entry = words.find(m => !m.known && !m.gloss);
  const found = lookupSlangReference(entry.term).find(x => x.content === entry.term);
  assert.ok(found); assert.equal(found.definitionKnown, false); assert.match(found.meaning, /尚未考据/);
});
test('draft checking is read-only; rewrite inputs and oversized text are rejected', () => {
  const text = '最重要的是先分析再处理。'; const out = JSON.parse(judgeDraft({ text }).content[0].text);
  assert.equal(out.original, text); assert.equal(out.text, undefined); assert.ok(out.hitCount > 0); assert.match(out.note, /不修改草稿/);
  for (const input of [{ text, mode: 'cute' }, { text, strength: 'off' }, { text: '' }, { text: '字'.repeat(6001) }]) assert.throws(() => judgeDraft(input));
  assert.deepEqual(buildDraftJudgeServices().map(s => s.id), ['text.judge']);
});

test('migration removes duplicate services and grants, preserves judge deny/ask and other extensions', () => {
  const old = { allow: { groups: ['456'] }, slang: { enabled: true, referenceFallback: false }, framework: {
    services: [{ id: 'text.judge', enabled: false }, { id: 'text.meme' }, { id: 'text.tone' }, { id: 'media.storyboard' }],
    permissions: { rules: [{ key, capability: 'text.judge', decision: 'ask' }, { key, capability: 'text.meme', decision: 'allow' }, { key, capability: 'text.tone', decision: 'allow' }] } } };
  const fresh = installDraftJudge(old);
  assert.deepEqual(fresh.framework.services.map(s => s.id), ['media.storyboard', 'text.judge']);
  assert.equal(fresh.framework.services[1].enabled, false); assert.equal(fresh.slang.referenceFallback, false);
  assert.deepEqual(fresh.framework.permissions.rules.map(r => [r.capability, r.decision]), [['text.judge', 'ask']]);
  assert.deepEqual(installDraftJudge(fresh), fresh); assert.equal(installDraftJudge({}).framework.permissions.rules.length, 0);
});

test('real stdio draft service retains default deny, approval and cross-conversation isolation', async () => {
  const permissions = new ExtensionPermissions(), runtime = new ContentServiceRuntime({ services: buildDraftJudgeServices(), permissions });
  try {
    await assert.rejects(runtime.call({ key, scope: 'one', serviceId: 'text.judge', input: { text: '草稿' } }), /未获/);
    assert.equal(runtime.connections.size, 0);
    permissions.replacePolicy({ rules: [{ key, capability: 'text.judge', decision: 'ask', dataScopes: ['input'] }] });
    const args = { key, scope: 'one', serviceId: 'text.judge', input: { text: '最重要的是先分析再处理。' } };
    const pending = await runtime.call(args); assert.equal(pending.status, 'approval_required'); assert.equal(runtime.connections.size, 0);
    permissions.resolve(pending.approval.requestId, 'approve');
    const result = await runtime.call({ ...args, approvalId: pending.approval.requestId });
    assert.ok(JSON.parse(result.content[0].text).hitCount > 0);
    await assert.rejects(runtime.call({ ...args, key: 'group:789', scope: 'other' }), /未获/);
  } finally { await runtime.close(); }
});

test('both existing slang APIs share fallback and precedence; switches, role authority and storage remain intact', async () => {
  const h = await bridgeHarness({ config: { dualMode: { enabled: true, ownerPreset: 'standard' }, slang: { enabled: true, autoResearch: false },
    framework: { services: buildDraftJudgeServices(), permissions: { rules: [{ key, capability: 'text.judge', decision: 'allow', dataScopes: ['input'] }] } } },
    files: { 'state/slang.json': slangEntries, 'roles/tester.md': '保持原有人格，说话沉稳。', 'state/current-role.json': { role: 'tester', mode: 'active' } } });
  await h.ensureSession(key); const token = h.getSocialV2State(key).agentToken;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new QQBridgeClient({ baseUrl, key, token });
  const slang = async q => {
    const res = await fetch(baseUrl + '/api/socialV2/slang/query?key=' + key + '&q=' + encodeURIComponent(q), {
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token } });
    return { status: res.status, body: await res.json() };
  };
  try {
    const before = await fs.readFile(path.join(h.temp, 'state/slang.json'), 'utf8');
    const known = await slang('破防'); assert.equal(known.status, 200); assert.deepEqual(known.body.entries.map(x => x.meaning), ['本群约好去喝奶茶']);
    const reference = await slang('绷不住了'); assert.equal(reference.status, 200); assert.equal(reference.body.provenance, 'static-reference');
    const viaContext = await client.queryContext({ kind: 'slang', query: '绷不住了' }); assert.deepEqual(viaContext.items, reference.body.entries);
    h.cfg.socialV2.context.strategy = 'inline';
    const inline = await slang('绷不住了'); assert.match(inline.body.block, /未经本群确认/); assert.doesNotMatch(inline.body.block, /群聊黑话表/);
    h.cfg.slang.referenceFallback = false; assert.equal((await slang('绷不住了')).body.total, 0);
    assert.equal((await client.queryContext({ kind: 'slang', query: '绷不住了' })).total, 0);
    h.cfg.slang.enabled = false; assert.equal((await slang('破防')).status, 403);
    await assert.rejects(client.queryContext({ kind: 'slang', query: '破防' }), /未启用/);
    assert.equal(await fs.readFile(path.join(h.temp, 'state/slang.json'), 'utf8'), before);
    assert.doesNotMatch(h.buildWakePromptV2(key, 'atMention'), /【聊天表达】|text\.meme|text\.tone/);
    assert.ok(!h.contentServices.services.some(s => ['text.meme', 'text.tone'].includes(s.id)));
    const judged = await client.processContent('text.judge', { input: { text: '这是一份草稿。' } }); assert.equal(judged.media.length, 0);
    assert.equal(JSON.parse(judged.content[0].text).original, '这是一份草稿。');
    const oldSettings = await fetch(baseUrl + '/api/fish-tone', { headers: { 'x-console-token': 'fixture-console-token' } }); assert.equal(oldSettings.status, 404);
    assert.equal(h.calls.sent.length, 0);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
});
