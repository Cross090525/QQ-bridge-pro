// Verify the actual model inputs; no model account or live QQ connection needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';

const key = 'group:456';
const card = '# 角色卡\n\n## 身份\n你是纸飞机收藏员小岚。\n\n## 说话风格\n说话干脆，熟人间会轻轻打趣，用短句表达关心。\n\n## 一代 〔一代〕\n仅一代专属标记V1_ONLY。\n\n## 二代 〔二代〕\n保持好奇心，别把日常聊天写成客服建议。';
async function fixture(run, config = {}) {
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, sticker: { enabled: false },
    wait: { minMs: 100, maxMs: 1000, minQuietAfterNewMs: 0 }, ...config } },
    files: { 'roles/fixture.md': card, 'state/current-role.json': { role: 'fixture', mode: 'active' } } });
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await h.ensureSession(key); const st = h.getSocialV2State(key); st.bootstrapSent = true;
  const client = new QQBridgeClient({ baseUrl, key, token: st.agentToken });
  const append = (text, id = 1) => h.handleIncoming('group', 456, { self_id: 999, message_id: id, user_id: 321,
    group_id: 456, sender: { nickname: '小王' }, message: [{ type: 'text', data: { text } }] }, h.cfg);
  try { await run({ h, st, client, baseUrl, server, append }); }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
}
const hasRole = text => typeof text === 'string' && text.includes('纸飞机收藏员小岚') && text.includes('别把日常聊天写成客服建议') && !text.includes('V1_ONLY');

test('each later wake supplies the active role even if an earlier prompt tool result is no longer retained', () => fixture(async ({ h, st, baseUrl, append }) => {
  const prompt = await fetch(baseUrl + '/api/socialV2/prompt?key=' + key, {
    headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
  });
  assert.ok(hasRole((await prompt.json()).role.hint), 'initial role lookup must contain the selected card');
  await append('前面的对话已压缩，请继续聊收藏。');
  await h.deliverPrompt(key, '', { wakeReason: 'question' });
  assert.ok(hasRole(h.calls.prompts.at(-1).content[0].text), 'the latest model input must carry the role itself, not only its name/hash');
  for (let turn = 0; turn < 30; turn++) {
    h.cfg.socialV2.context.strategy = turn % 2 ? 'inline' : 'onDemand';
    await append('群聊背景和工具观察会不断增加。'.repeat(100), turn + 2);
    await h.deliverPrompt(key, '', { wakeReason: 'observation' });
    const text = h.calls.prompts.at(-1).content[0].text;
    const latestRole = text.slice(text.lastIndexOf('【当前有效角色卡：管理员配置，持续提供】'));
    assert.ok(hasRole(latestRole), `turn ${turn}: current role must survive both context strategies and a large message backlog`);
  }
}));

test('message reads and in-turn waits refresh the role without relying on another wake', () => fixture(async ({ client, append }) => {
  await append('继续聊，不用重新唤醒。');
  const unread = await client.unread();
  assert.ok(hasRole(unread.role?.hint), 'unread tools must refresh the active role for a continuing turn');
  const waiting = await client.wait({ purpose: 'messages', timeoutMs: 100 });
  assert.ok(hasRole(waiting.role?.hint), 'existing-unread wait responses must refresh the active role');
  assert.ok(hasRole((await client.recent()).role?.hint));
  assert.ok(hasRole((await client.workingContext()).role?.hint));
}));

test('a pending wait returns the current edited role and clearing the role revokes the old identity', () => fixture(async ({ h, client, server }) => {
  const before = (await client.recent()).role;
  let observeRequest;
  const requested = new Promise(resolve => {
    observeRequest = req => { if (req.url.startsWith('/api/v1/messages/wait')) { server.off('request', observeRequest); resolve(); } };
    server.on('request', observeRequest);
  });
  const pending = client.wait({ purpose: 'messages', timeoutMs: 150, quietMs: 0 });
  await requested;
  fs.writeFileSync(path.join(h.temp, 'roles/fixture.md'), '# 新角色\n你是修理钟表的老周，慢条斯理，喜欢用生活小事解释。');
  const changed = (await pending).role;
  assert.ok(changed.hint.includes('修理钟表的老周')); assert.notEqual(changed.version, before.version);
  assert.ok(!changed.hint.includes('纸飞机收藏员小岚'));
  fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: null, mode: 'active' }));
  const cleared = (await client.recent()).role;
  assert.equal(cleared.name, null); assert.equal(cleared.hint, '');
  await h.deliverPrompt(key, '', { wakeReason: 'question' });
  const latest = h.calls.prompts.at(-1).content[0].text.split('【当前有效角色卡：管理员配置，持续提供】')[1];
  assert.ok(latest.includes('"name":null')); assert.ok(!latest.includes('修理钟表的老周'));
}));

test('role refresh does not enter owner tasks, denied responses, or console-only message previews', () => fixture(async ({ h, st, baseUrl, client }) => {
  const denied = await fetch(baseUrl + '/api/v1/messages/unread?key=group:789', { headers: { 'x-agent-token': st.agentToken } });
  assert.equal(denied.status, 403); assert.equal((await denied.json()).role, undefined);
  const preview = await fetch(baseUrl + '/api/socialV2/recent?key=' + key, { headers: { 'x-console-token': 'fixture-console-token' } });
  assert.equal((await preview.json()).role, undefined);
  await h.ensureSession('private:123');
  await h.deliverPrompt('private:123', '管理员处理工作事项。');
  assert.ok(!hasRole(h.calls.prompts.at(-1).content[0].text));
  h.cfg.socialV2.tools.getPrompt = false;
  h.cfg.socialV2.workingMemory.enabled = false;
  assert.ok(hasRole((await client.recent()).role?.hint), 'disabling the discovery tool must not cancel the administrator-selected identity');
}));
