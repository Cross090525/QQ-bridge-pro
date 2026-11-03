import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ParticipationManager, normalizeParticipationConfig } from '../src/core/participation.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';

const KEY = 'group:456';
function modelFixture() {
  let now = 10000, config = { defaults: {}, groups: {} };
  const states = new Map();
  const getState = key => {
    if (!states.has(key)) states.set(key, { agentToken: key, recentMessages: [], lastUnreadSeq: 0 });
    return states.get(key);
  };
  const manager = new ParticipationManager({ getState, getConfig: () => config, now: () => now });
  const receive = (addressing = {}, key = KEY) => {
    now += 100; const state = getState(key), seq = ++state.lastUnreadSeq;
    const message = { id: `qq:${seq}`, seq, time: now, addressing, isSelf: false };
    state.recentMessages.push(message); return message;
  };
  const decide = (message, extra = {}) => manager.decided(KEY, { action: 'reply', audience: 'open', sources: [message.id], ...extra }, [message]);
  return { manager, getState, receive, decide, configure: value => config = value, advance: ms => now += ms };
}
test('natural open-topic participation coexists with strict audience facts and isolated group policies', () => {
  const f = modelFixture();
  f.configure({ defaults: { style: 'natural' }, groups: { 'group:789': { style: 'cautious', allowHumor: false } } });
  assert.equal(f.manager.context(KEY).policy.style, 'natural');
  assert.ok(f.manager.context(KEY).guidance.includes('不必每次提供新知识'));
  assert.equal(f.manager.context('group:789').policy.allowHumor, false);
  const other = f.receive({ mentionedUserIds: ['222'], mentionsSelf: false });
  f.decide(other, { audience: 'direct' });
  assert.equal(f.manager.context(KEY).plan.audience, 'other', 'model label cannot overwrite gateway addressing');
  assert.equal(f.manager.context('private:123').defaultAction, 'consider_reply');
  for (const value of [{ defaults: null }, { defaults: { style: 'toString' } }, { defaults: { allowHumor: 'yes' } }, { groups: { 'private:123': {} } }, JSON.parse('{"groups":{"__proto__":{}}}')]) {
    assert.throws(() => normalizeParticipationConfig(value), e => e.statusCode === 400);
  }
});
test('one split reply is one participation; unrelated traffic is not a continuation', () => {
  const f = modelFixture(), source = f.receive(); f.decide(source); f.manager.sent(KEY, 3);
  assert.equal(f.manager.context(KEY).activity.turnsLastHour, 1);
  assert.equal(f.manager.context(KEY).phase, 'yielding');
  f.receive({ replyTarget: 'other' });
  assert.equal(f.manager.context(KEY).phase, 'yielding');
  assert.equal(f.manager.context('group:789').activity.turnsLastHour, 0);
  const addressed = f.receive({ mentionsSelf: true });
  assert.equal(f.manager.context(KEY).phase, 'invited');
  f.decide(addressed, { audience: 'continuation' });
  assert.equal(f.manager.context(KEY).plan.audience, 'direct');
  assert.equal(f.getState(KEY).participation.history.filter(x => x.action === 'sent').length, 1);
});
test('new arrivals require review and renewed decisions; policy changes, expiry and session replacement invalidate plans', () => {
  const f = modelFixture(), old = f.receive(); f.decide(old); f.manager.assertSend(KEY);
  const next = f.receive();
  assert.throws(() => f.manager.assertSend(KEY), /新消息/);
  f.decide(old); // Repeating an old source must not acknowledge unseen new input.
  assert.throws(() => f.manager.assertSend(KEY), /新消息/);
  f.manager.presented(KEY, [next]);
  assert.throws(() => f.manager.assertSend(KEY), /更新decision/);
  f.decide(next); f.manager.assertSend(KEY);
  f.configure({ defaults: { style: 'cautious' } });
  assert.throws(() => f.manager.assertSend(KEY), /设置变化/);
  f.decide(next); f.manager.assertSend(KEY);
  f.advance(300001); assert.throws(() => f.manager.assertSend(KEY), /过期/);
  f.getState(KEY).agentToken = 'replacement';
  assert.equal(f.manager.context(KEY).plan, null);
});
test('outcomes survive restore but visibility and live decisions do not; discard removes linked decision history', () => {
  const f = modelFixture(), source = f.receive(); f.decide(source); f.manager.sent(KEY, 2);
  const restoredState = structuredClone(f.getState(KEY));
  const restored = new ParticipationManager({ getState: () => restoredState, now: () => 11000 });
  assert.equal(restored.context(KEY, { history: true }).activity.turnsLastHour, 1);
  assert.equal(restored.context(KEY).plan, null);
  assert.equal(JSON.stringify(restoredState.participation).includes('note'), false);
  f.manager.discarded(KEY, [source.id]);
  assert.equal(f.manager.context(KEY, { history: true }).history.length, 0);
  assert.equal(f.manager.context(KEY).plan, null);
});

async function fixture(run, globals = {}) {
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, allow: { groups: ['456', '789'], private: ['123'] },
    socialV2: { workingMemory: { enabled: true }, wake: { preSleepWaitEnabled: false }, proactive: { enabled: false }, sticker: { enabled: false } } }, globals });
  let server;
  try {
    await h.ensureSession(KEY); const st = h.getSocialV2State(KEY);
    server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = new QQBridgeClient({ baseUrl, key: KEY, token: st.agentToken });
    const admin = async (body, key = KEY, agent = false) => {
      const res = await fetch(baseUrl + '/api/socialV2/participation' + (body === undefined ? '?key=' + encodeURIComponent(key) : ''), {
        method: body === undefined ? 'GET' : 'POST', headers: { 'x-console-token': 'fixture-console-token',
          ...(agent ? { 'x-agent-token': st.agentToken } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    };
    await run({ h, st, client, admin, baseUrl });
  } finally { if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } await h.close(); }
}
test('console policies persist, inherit live defaults and reach unread/recent/wait/wake without granting agent management', () => fixture(async ({ h, st, client, admin }) => {
  assert.equal((await admin({ key: KEY, policy: { style: 'active' } }, KEY, true)).status, 403);
  assert.equal((await admin(undefined, KEY, true)).status, 403);
  const before = h.socialV2.conversations.size;
  assert.equal((await admin(undefined, 'group:789')).data.status, null);
  assert.equal(h.socialV2.conversations.size, before, 'admin preview must not create a new active conversation');
  assert.equal((await admin({ key: KEY, policy: { style: 'active', allowHumor: false } })).status, 200);
  assert.equal((await admin({ policy: { allowEmpathy: false } })).status, 200);
  const disk = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json')));
  assert.equal(disk.socialV2.participation.groups[KEY].style, 'active');
  assert.equal((await admin()).data.policy.allowEmpathy, false, 'partial overrides inherit changed defaults');
  h.appendSocialV2Message(KEY, 'fixture', '开放问题', '开放问题', false, false, 100);
  for (const result of [await client.unread(), await client.recent(), await client.wait({ purpose: 'messages' })]) {
    assert.equal(result.participation.policy.style, 'active'); assert.equal(result.participation.policy.allowHumor, false);
  }
  await h.deliverPrompt(KEY, '', { wakeReason: 'observation' });
  assert.ok(h.calls.prompts.at(-1).content[0].text.includes('活跃：开放话题'));
  assert.ok(!h.calls.prompts.at(-1).content[0].text.includes('最近发言偏多'));
  assert.equal((await admin({ key: KEY, inherit: true })).data.policy.style, 'natural');
  assert.equal((await admin({ key: KEY, policy: { style: 'invalid' } })).status, 400);
  assert.equal((await admin()).data.policy.style, 'natural');
}));
test('real send gate blocks stale decisions, resumes after review, counts successful split replies and records no failed send', () => fixture(async ({ h, st, client, admin }) => {
  const add = id => h.appendSocialV2Message(KEY, 'fixture', '开放问题' + id, '开放问题' + id, false, false, id);
  const decide = async id => {
    const { snapshot } = await client.workingContext();
    return client.updateWorkingContext({ revision: snapshot.revision, decision: { action: 'reply', note: '合成测试', audience: 'open', intent: 'answer', sources: [`qq:${id}`] } });
  };
  add(100); await decide(100); add(101);
  await assert.rejects(client.send('旧回答'), e => e.statusCode === 409);
  assert.equal(st.participation.turns.length, 0);
  await client.unread();
  await assert.rejects(client.send('仍需重新判断'), e => e.statusCode === 409);
  await decide(101);
  const sent = await client.send(['第一句', '第二句'], { gapMode: 'fixed', gapMs: 0 });
  assert.equal(sent.sent, 2); assert.equal(st.participation.turns.length, 1);
  await client.send('同一决策的补充表达');
  assert.equal(st.participation.turns.length, 1, 'one decision across multiple send calls is one participation');
  const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json')));
  assert.equal(saved.conversations[KEY].participation.turns.length, 1);
  assert.equal((await admin()).data.status.history.filter(x => x.action === 'sent').length, 1);
  assert.equal(JSON.stringify((await admin()).data.status.history).includes('合成测试'), false);
  const { snapshot } = await client.workingContext();
  await assert.rejects(client.updateWorkingContext({ revision: snapshot.revision, decision: { action: 'reply', note: '', audience: 'forged', sources: ['qq:101'] } }), e => e.statusCode === 400);
  h.socialV2.paused = true;
  await assert.rejects(client.send('暂停不能绕过'), e => e.statusCode === 403);
}));
test('a new arrival during a split batch preserves partial success and exposes retry counts', async () => {
  let onSend = () => {};
  await fixture(async ({ h, st, client }) => {
    h.appendSocialV2Message(KEY, 'fixture', '开放问题', '开放问题', false, false, 100);
    const { snapshot } = await client.workingContext();
    await client.updateWorkingContext({ revision: snapshot.revision, decision: { action: 'reply', note: '', audience: 'open', sources: ['qq:100'] } });
    let actualSends = 0;
    onSend = () => { actualSends++; h.appendSocialV2Message(KEY, 'fixture', '新的话题', '新的话题', false, false, 101); };
    await assert.rejects(client.send(['已发一句', '应当暂停'], { gapMode: 'fixed', gapMs: 1 }), e => e.statusCode === 409 && e.sent === 1 && e.failed === 1);
    assert.equal(actualSends, 1); assert.equal(st.participation.turns.length, 1);
    assert.equal(st.recentMessages.filter(m => m.isSelf).length, 1);
  }, { fetch: async () => { onSend(); return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) }; } });
});
