import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WorkingMemory } from '../src/core/working-memory.mjs';
import { normalizeMessageFreshness, describeMessageFreshness } from '../src/core/message-freshness.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';

const KEY = 'group:456';
const TWO_DAYS = 48 * 60 * 60 * 1000;

test('automatic snapshots omit two-day-old raw context while explicit recall marks its age', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-safety-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = Date.now();
  const memory = new WorkingMemory(directory, { now: () => now });
  memory.record(KEY, { id: 'qq:100', seq: 1, messageId: '100', plain: 'history-old-deploy-question', time: now - TWO_DAYS,
    content: [{ type: 'image', sourceId: 'historical-image' }] });
  memory.media(KEY, 'historical-image', { status: 'prepared', evidence: 'historical image evidence' });
  memory.record(KEY, { id: 'qq:101', seq: 2, messageId: '101', plain: '[卡片消息]', time: now });
  const automatic = memory.snapshot(KEY);
  assert.ok(!automatic.messages.some(message => message.id === 'qq:100'));
  assert.equal(automatic.messages[0].historical, false);
  assert.equal(automatic.messages[0].replyEligible, true);
  assert.equal(automatic.media.length, 0);
  const explicit = memory.snapshot(KEY, { messageId: 'qq:100' });
  const recalled = explicit.messages[0];
  assert.equal(recalled.historical, true);
  assert.equal(recalled.stale, true);
  assert.equal(recalled.replyEligible, false);
  assert.equal(explicit.media[0].historical, true);
  assert.equal(memory.get(KEY).messages.length, 2);
});

async function fixture(t) {
  const bridge = await bridgeHarness({ config: {
    dualMode: { enabled: true, ownerPreset: 'standard' },
    allow: { groups: ['456'] },
    socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, wake: { preSleepWaitEnabled: false } },
  }, gatewayMessages: { '100': { group_id: 456, user_id: 234, sender: { user_id: 234 }, message: [{ type: 'text', data: { text: 'history-old-deploy-question' } }] } } });
  await bridge.ensureSession(KEY);
  const state = bridge.getSocialV2State(KEY);
  bridge.appendSocialV2Message(KEY, 'fixture', 'history-old-deploy-question', 'history-old-deploy-question', false, false, 100, [], '234');
  const oldTime = Date.now() - TWO_DAYS;
  for (const record of [...state.recentMessages, ...state.unread, ...bridge.workingMemory.get(KEY).messages]) {
    record.time = oldTime;
    record.receivedAt = oldTime;
    record.eventAt = oldTime;
  }
  state.lastReadThroughSeq = 1;
  state.unread = [];
  bridge.appendSocialV2Message(KEY, 'fixture', '[卡片消息]', '[卡片消息]', false, false, 101, [], '345');
  const server = bridge.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await bridge.close();
  });
  const client = new QQBridgeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: KEY, token: state.agentToken });
  return { bridge, state, client, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('a new card wake cannot present the old question as current input', async t => {
  const { bridge } = await fixture(t);
  await bridge.deliverPrompt(KEY, '', { wakeReason: 'observation' });
  const prompt = bridge.calls.prompts.at(-1).content[0].text;
  assert.ok(prompt.includes('[卡片消息]'));
  assert.ok(!prompt.includes('history-old-deploy-question'));
});

test('ordinary group sends reject a quote of an old cached message before gateway delivery', async t => {
  const { bridge, client } = await fixture(t);
  await client.recent();
  await assert.rejects(client.send('late reply', { replyToMessageId: '100' }), error => error.statusCode === 409);
  assert.equal(bridge.calls.sent.length, 0);
  assert.equal(bridge.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 0);
});

test('recent and waiting responses distinguish historical references from the current card', async t => {
  const { client, state } = await fixture(t);
  const recent = (await client.recent()).messages;
  assert.equal(recent.find(message => message.messageId === '100').historical, true);
  assert.equal(recent.find(message => message.messageId === '100').replyEligible, false);
  assert.equal(recent.find(message => message.messageId === '101').contextRole, 'current_input');
  const waiting = await client.wait({ purpose: 'messages' });
  assert.equal(waiting.newMessages[0].messageId, '101');
  assert.equal(waiting.newMessages[0].historical, false);
  await client.acknowledge(waiting.readThroughSeq);
  assert.equal(state.lastReadThroughSeq, 2);
  assert.equal((await client.recent()).messages.find(message => message.messageId === '101').historical, true);
});

test('explicitly reading a historical message does not grant permission to answer it alone', async t => {
  const { bridge, client } = await fixture(t);
  const { snapshot } = await client.workingContext({ messageId: 'qq:100' });
  await client.updateWorkingContext({ revision: snapshot.revision, decision: { action: 'reply', note: 'incorrect old-message reply', sources: ['qq:100'] } });
  await assert.rejects(client.send('reply based only on old context'), error => error.statusCode === 409);
  assert.equal(bridge.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 0);
});

test('a current user can explicitly reintroduce the old quote', async t => {
  const { bridge, client } = await fixture(t);
  bridge.appendSocialV2Message(KEY, 'fixture', '请接着讨论这条旧消息', '请接着讨论这条旧消息', false, false, 103, [], '234', [], null, '100',
    { mentionsSelf: true, mentionedUserIds: ['999'], replyTarget: 'other' });
  await client.workingContext({ messageId: 'qq:100' });
  const { snapshot } = await client.workingContext();
  await client.updateWorkingContext({ revision: snapshot.revision, decision: { action: 'reply', note: 'new user explicitly resumed this quote', sources: ['qq:103', 'qq:100'] } });
  const result = await client.send('continuing the requested discussion', { replyToMessageId: '100' });
  assert.equal(result.ok, true);
  assert.equal(bridge.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 1);
});

test('a current card decision cannot authorize an unrelated old quote', async t => {
  const { bridge, client } = await fixture(t);
  await client.workingContext({ messageId: 'qq:100' });
  const { snapshot } = await client.workingContext();
  await client.updateWorkingContext({ revision: snapshot.revision, decision: { action: 'reply', note: 'a current card was received', sources: ['qq:101', 'qq:100'] } });
  await assert.rejects(client.send('incorrect old quotation', { replyToMessageId: '100' }), error => error.statusCode === 409);
  assert.equal(bridge.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 0);
  assert.equal((await client.send('replying to the current card')).ok, true);
});

test('inline snapshots omit expired reference text as well', async t => {
  const { bridge } = await fixture(t);
  bridge.cfg.socialV2.context = { strategy: 'inline', inlineWakeMessages: true };
  const snapshot = bridge.buildWakeSnapshotV2(KEY);
  assert.ok(!JSON.stringify(snapshot).includes('history-old-deploy-question'));
  await bridge.deliverPrompt(KEY, '', { wakeReason: 'observation' });
  assert.ok(!bridge.calls.prompts.at(-1).content[0].text.includes('history-old-deploy-question'));
});

test('source freshness is checked again after queuing', async t => {
  const { bridge, client } = await fixture(t);
  const message = bridge.workingMemory.get(KEY).messages.find(item => item.id === 'qq:101');
  message.eventAt = Date.now() - 61 * 1000;
  const { snapshot } = await client.workingContext();
  await client.updateWorkingContext({ revision: snapshot.revision, decision: { action: 'reply', note: 'initially within the reply window', sources: ['qq:101'] } });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  bridge.setSendChain(held);
  const sending = client.send('queued response');
  for (let attempt = 0; attempt < 50 && bridge.getSendChain() === held; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.notEqual(bridge.getSendChain(), held);
  bridge.cfg.socialV2.workingMemory.replyMaxAgeMs = 60 * 1000;
  release();
  await assert.rejects(sending, error => error.statusCode === 409);
  assert.equal(bridge.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 0);
});

test('event age takes priority over recent receipt time and thresholds are validated', () => {
  const now = Date.now();
  const context = describeMessageFreshness({ eventAt: now - TWO_DAYS, receivedAt: now, seq: 1 }, { now });
  assert.equal(context.stale, true);
  assert.equal(context.timeBasis, 'eventAt');
  assert.equal(describeMessageFreshness({ eventAt: now, seq: 1 }, { now, readThroughSeq: 1 }).historical, true);
  assert.equal(describeMessageFreshness({}, { now }).replyEligible, false);
  assert.throws(() => normalizeMessageFreshness({ replyMaxAgeMs: 1 }), /毫秒/);
  assert.throws(() => normalizeMessageFreshness({ replyMaxAgeMs: 3 * 60 * 60 * 1000 }), /保留窗口/);
});

test('historical media cannot force an automatic media read or a pending-media wait', async t => {
  const { bridge, client } = await fixture(t);
  bridge.workingMemory.get(KEY).messages[0].media = [{ type: 'image', sourceId: 'unavailable-historical-media' }];
  const observation = await bridge.prepareObservationV2(KEY);
  assert.equal(observation.parts.length, 0);
  assert.equal(bridge.calls.images.length, 0);
  bridge.cfg.socialV2.wait = { minMs: 1, maxMs: 10, minQuietAfterNewMs: 0 };
  const response = await client.wait({ purpose: 'reply', timeoutMs: 10 });
  assert.notEqual(response.mediaPending, true);
});

test('console validates freshness windows and applies valid values to subsequent reads', async t => {
  const { bridge, client, baseUrl } = await fixture(t);
  const save = async workingMemory => fetch(baseUrl + '/api/socialV2/config', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
    body: JSON.stringify({ workingMemory }),
  });
  const valid = await save({ enabled: true, replyMaxAgeMs: 60000, historyMaxAgeMs: 120000 });
  assert.equal(valid.status, 200);
  const stored = fs.readFileSync(path.join(bridge.temp, 'config.json'), 'utf8');
  assert.equal((await client.recent()).messageFreshness.replyMaxAgeMs, 60000);
  const invalid = await save({ enabled: true, replyMaxAgeMs: 180000, historyMaxAgeMs: 120000 });
  assert.equal(invalid.status, 400);
  assert.equal(fs.readFileSync(path.join(bridge.temp, 'config.json'), 'utf8'), stored);
});
