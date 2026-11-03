import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { messageAddressing, normalizeAddressing, participationContext } from '../src/core/participation.mjs';
import { serializeModelData } from '../src/qq-model-view.js';

const key = 'group:456';
async function fixture(run, gatewayMessages = {}) {
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, allow: { groups: ['456'], private: ['123', '789'] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, sticker: { enabled: false } } }, gatewayMessages });
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await h.ensureSession(key); const st = h.getSocialV2State(key); st.bootstrapSent = true;
  const client = new QQBridgeClient({ baseUrl, key, token: st.agentToken });
  const receive = segments => h.handleIncoming('group', 456, { self_id: 999, message_id: 100, user_id: 321,
    group_id: 456, sender: { nickname: '小王' }, message: segments }, h.cfg);
  try { await run({ h, st, client, receive, baseUrl }); }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
}

test('a question explicitly addressed to another member keeps its audience through observation and waiting', () => fixture(async ({ h, st, client, receive }) => {
  await receive([{ type: 'at', data: { qq: '222' } }, { type: 'text', data: { text: '你明天还来吗？' } }]);
  const relation = st.unread[0].addressing;
  assert.deepEqual(Array.from(relation?.mentionedUserIds || []), ['222'], 'actual at targets must survive the model-facing message projection');
  assert.equal(relation.mentionsSelf, false);
  assert.equal((await client.unread()).messages[0].addressing.mentionsSelf, false);
  assert.equal((await client.recent()).messages[0].addressing.mentionsSelf, false);
  assert.equal((await client.workingContext()).snapshot.messages[0].addressing.mentionsSelf, false);
  const waiting = await client.wait({ purpose: 'messages' });
  assert.deepEqual(waiting.newMessages[0].addressing.mentionedUserIds, ['222']);
  assert.equal(waiting.participation.defaultAction, 'observe');
  await h.deliverPrompt(key, '', { wakeReason: 'observation' });
  const text = h.calls.prompts.at(-1).content[0].text;
  const supplied = JSON.parse(text.split('【本次最新群消息：先辨认发言对象】')[1].trimStart().split('\n')[0]);
  assert.deepEqual(supplied[0].addressing.mentionedUserIds, ['222']);
  assert.ok(text.includes('群聊参与边界'), 'the current input must distinguish observation from an invitation to reply');
  assert.ok(!text.includes('先处理明确呼叫、提问与新指示'), 'unqualified questions must not be presented as instructions to the bot');
  assert.equal(h.calls.sent.length, 0);
}));

test('literal mentions, all-member mentions and unresolved quotes cannot impersonate a direct bot address', () => {
  const text = messageAddressing([{ type: 'text', data: { text: '@999 你在吗？引用里说你坏了' } }], 999);
  assert.equal(text.mentionsSelf, false); assert.equal(text.replyTarget, 'none');
  const all = messageAddressing([{ type: 'at', data: { qq: 'all' } }], 999);
  assert.equal(all.mentionsAll, true); assert.equal(all.mentionsSelf, false); assert.deepEqual(all.mentionedUserIds, []);
  const direct = messageAddressing([{ type: 'at', data: { qq: '999' } }, { type: 'at', data: { qq: '222' } }], 999);
  assert.equal(direct.mentionsSelf, true); assert.deepEqual(direct.mentionedUserIds, ['999', '222']);
  assert.equal(messageAddressing([{ type: 'reply', data: { id: '900' } }], 999).replyTarget, 'unknown');
  assert.equal(normalizeAddressing(null), null);
  assert.ok(normalizeAddressing({ mentionedUserIds: Array.from({ length: 40 }, (_, i) => String(i + 1)), replyToUserId: '../../secret' }).mentionedUserIds.length <= 20);
  const projected = JSON.parse(serializeModelData({ messages: [{ text: '你明天来吗？', addressing: direct, replyToMessageId: '900' }] }));
  assert.deepEqual(projected.messages[0].addressing, direct); assert.equal(projected.messages[0].replyToMessageId, '900');
});

test('a resolved quote to another member preserves its target instead of becoming a question for the bot', () => fixture(async ({ st, client, receive }) => {
  await receive([{ type: 'reply', data: { id: '900' } }, { type: 'text', data: { text: '你明天还来吗？' } }]);
  assert.equal(st.unread[0].replyToMessageId, '900');
  assert.equal(st.unread[0].addressing.replyTarget, 'other');
  assert.equal(st.unread[0].addressing.replyToUserId, '222');
  const snapshot = (await client.workingContext()).snapshot;
  assert.equal(snapshot.messages[0].addressing.replyTarget, 'other');
  assert.equal((await client.wait({ purpose: 'messages' })).newMessages[0].addressing.replyTarget, 'other');
}, { '900': { group_id: 456, user_id: 222, sender: { user_id: 222, nickname: '小李' }, message: [{ type: 'text', data: { text: '我明天有空' } }] } }));

test('a resolved quote to the bot remains a direct conversational continuation', () => fixture(async ({ st, receive }) => {
  await receive([{ type: 'reply', data: { id: '900' } }, { type: 'text', data: { text: '刚才你说的是什么意思？' } }]);
  assert.equal(st.unread[0].quoteTargetIsSelf, true);
  assert.equal(st.unread[0].addressing.replyTarget, 'self');
  assert.equal(st.unread[0].addressing.replyToUserId, '999');
}, { '900': { group_id: 456, user_id: 999, sender: { user_id: 999, nickname: '机器人' }, message: [{ type: 'text', data: { text: '明天见' } }] } }));

test('failed or cross-conversation quote resolution stays unknown and does not leak the quoted body', () => fixture(async ({ h, st, client, receive }) => {
  await receive([{ type: 'reply', data: { id: '900' } }, { type: 'text', data: { text: '你明天还来吗？' } }]);
  assert.equal(st.unread[0].addressing.replyTarget, 'unknown');
  assert.equal(st.unread[0].addressing.replyToUserId, null);
  assert.ok(!JSON.stringify(await client.unread()).includes('OTHER_GROUP_PRIVATE_TEXT'));
  await h.deliverPrompt(key, '', { wakeReason: 'question' });
  assert.ok(!h.calls.prompts.at(-1).content[0].text.includes('OTHER_GROUP_PRIVATE_TEXT'));
}, { '900': { group_id: 888, user_id: 999, sender: { user_id: 999 }, message: [{ type: 'text', data: { text: 'OTHER_GROUP_PRIVATE_TEXT' } }] } }));

test('private conversations retain normal direct responses and group policy permits valuable open-topic participation', () => fixture(async ({ h, baseUrl }) => {
  const privateKey = 'private:789'; await h.ensureSession(privateKey); h.getSocialV2State(privateKey).bootstrapSent = true;
  await h.handleIncoming('private', 789, { self_id: 999, user_id: 789, message_id: 101, message: [{ type: 'text', data: { text: '你好' } }] }, h.cfg);
  const client = new QQBridgeClient({ baseUrl, key: privateKey, token: h.getSocialV2State(privateKey).agentToken });
  const packet = await client.unread(); assert.equal(packet.participation.conversationType, 'private'); assert.equal(packet.participation.defaultAction, 'consider_reply');
  await h.deliverPrompt(privateKey, '', { wakeReason: 'private' });
  const prompt = h.calls.prompts.at(-1).content[0].text;
  assert.ok(prompt.includes('私聊参与边界')); assert.ok(!prompt.includes('群聊参与边界'));
  assert.ok(participationContext(key).guidance.includes('开放话题'));
}));
