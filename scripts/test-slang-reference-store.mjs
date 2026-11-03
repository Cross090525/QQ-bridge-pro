import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SlangReferenceStore } from '../src/core/slang-reference-store.mjs';
import { bundledSlangReferences } from '../src/slang-reference.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-meme-store-'));
  try { return run(new SlangReferenceStore(path.join(dir, 'references.json'))); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const editable = e => Object.fromEntries(['term', 'aliases', 'meaning', 'usage', 'source', 'kind', 'known', 'enabled'].map(k => [k, e[k] ?? (k === 'source' ? '' : e[k])]));

test('reference management searches and pages both dictionaries without writing bundled data', () => fixture(store => {
  assert.ok(store.list().total >= 1000);
  assert.equal(store.list({ limit: 10 }).entries.length, 10);
  assert.equal(store.list({ limit: 10 }).nextOffset, 10);
  assert.ok(store.list({ kind: 'construction' }).entries.every(e => e.kind === 'construction'));
  assert.ok(store.list({ query: '233' }).entries.some(e => e.term === '233'));
  assert.equal(fs.existsSync(store.file), false);
  assert.throws(() => store.list({ limit: 10000 }));
  assert.throws(() => store.list({ kind: 'invalid' }));
}));

test('edits, aliases, disable, reset and custom additions survive restart and affect lookup immediately', () => fixture(store => {
  const base = bundledSlangReferences(), original = store.list({ query: '233' }).entries.find(e => e.term === '233');
  const changed = { ...editable(original), aliases: ['本地别名xyz'], meaning: '本机修订后的释义', known: true };
  store.save({ id: original.id, entry: changed, revision: 0 });
  assert.equal(store.lookup('本地别名xyz')[0].meaning, changed.meaning);
  const restored = new SlangReferenceStore(store.file);
  assert.equal(restored.lookup('本地别名xyz')[0].meaning, changed.meaning);
  const upgraded = new SlangReferenceStore(store.file); upgraded.base.delete(original.id);
  assert.equal(upgraded.lookup('本地别名xyz')[0].meaning, changed.meaning, 'removed upstream IDs must retain their local edits');
  assert.equal(restored.list({ state: 'customized' }).total, 1);
  assert.throws(() => restored.save({ id: original.id, entry: changed, revision: 0 }), { statusCode: 409 });
  restored.save({ id: original.id, entry: { ...changed, enabled: false }, revision: 1 });
  assert.equal(restored.lookup('本地别名xyz').length, 0);
  assert.equal(restored.list({ state: 'disabled' }).total, 1);
  restored.reset({ id: original.id, revision: 2 });
  assert.equal(restored.lookup('本地别名xyz').length, 0);
  assert.equal(restored.list({ query: '233' }).entries.find(e => e.id === original.id).meaning, original.meaning);
  const custom = restored.save({ entry: { ...changed, term: '自建测试词xyz', kind: 'construction' }, revision: 3 });
  assert.equal(custom.builtin, false);
  assert.equal(new SlangReferenceStore(store.file).lookup(custom.term)[0].meaning, changed.meaning);
  restored.remove({ id: custom.id, revision: 4 });
  assert.equal(restored.lookup(custom.term).length, 0);
  assert.deepEqual(bundledSlangReferences(), base);
}));

test('invalid or unknown entries cannot corrupt stored overrides; corrupt files remain untouched', () => fixture(store => {
  const original = store.list().entries[0], entry = editable(original);
  for (const invalid of [{ term: '' }, { aliases: Array(21).fill('alias') }, { meaning: '', known: true }, { source: 'x'.repeat(301) }, { path: '/tmp/file' }]) {
    assert.throws(() => store.save({ id: original.id, revision: 0, entry: { ...entry, ...invalid } }));
  }
  assert.throws(() => store.save({ revision: 0, entry }), /同名/);
  assert.throws(() => store.remove({ id: original.id, revision: 0 }), /内置/);
  store.save({ id: original.id, revision: 0, entry: { ...entry, known: false, meaning: '' } });
  assert.equal(store.lookup(original.term).find(e => e.content === original.term).definitionKnown, false);
  fs.writeFileSync(store.file, '{broken');
  const broken = new SlangReferenceStore(store.file);
  assert.throws(() => broken.list(), { statusCode: 503 });
  assert.throws(() => broken.save({ revision: 0, entry }), { statusCode: 503 });
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
}));

test('real admin routes persist edits and update both query tools and chat wakes while rejecting agent management', async () => {
  const key = 'group:456';
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, slang: { enabled: true, autoResearch: false } } });
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' };
  const request = async (route, body, extra = {}) => {
    const response = await fetch(baseUrl + '/api/slang/reference' + route, { method: body ? 'POST' : 'GET', headers: { ...headers, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    await h.ensureSession(key); const st = h.getSocialV2State(key); st.bootstrapSent = true;
    const client = new QQBridgeClient({ baseUrl, key, token: st.agentToken });
    assert.equal((await fetch(baseUrl + '/api/slang/reference')).status, 401);
    const { data: listed } = await request('?q=233'); const original = listed.entries.find(e => e.term === '233');
    const entry = { ...editable(original), aliases: ['管理测试别名xyz'], meaning: '管理界面修改立即生效', known: true };
    for (const extra of [{ 'x-agent-token': st.agentToken }, { 'x-agent-call': '1' }, { 'x-debate-token': 'not-an-admin' }]) {
      assert.equal((await request('', null, extra)).status, 403);
      assert.equal((await request('/save', { id: original.id, entry, revision: 0 }, extra)).status, 403);
    }
    assert.equal((await request('/save', { id: original.id, entry, revision: 0 }, { origin: 'https://example.com' })).status, 403);
    assert.equal((await request('/save', { id: original.id, entry, revision: 0 })).status, 200);
    assert.equal((await client.queryContext({ kind: 'slang', query: '管理测试别名xyz' })).items[0].meaning, entry.meaning);
    const legacy = await fetch(baseUrl + '/api/socialV2/slang/query?key=' + key + '&q=' + encodeURIComponent('管理测试别名xyz'), { headers: { ...headers, 'x-agent-token': st.agentToken } });
    assert.equal((await legacy.json()).entries[0].meaning, entry.meaning);
    await h.handleIncoming('group', 456, { self_id: 999, message_id: 90, user_id: 321, group_id: 456,
      sender: { nickname: '小王' }, message: [{ type: 'text', data: { text: '管理测试别名xyz' } }] }, h.cfg);
    await h.deliverPrompt(key, '', { wakeReason: 'observation' });
    assert.ok(h.calls.prompts.at(-1).content[0].text.includes(entry.meaning));
    assert.equal(new SlangReferenceStore(path.join(h.temp, 'state/slang-reference.json')).lookup('管理测试别名xyz')[0].meaning, entry.meaning);
    assert.equal((await request('/save', { id: original.id, entry, revision: 0 })).status, 409);
    assert.equal((await request('/reset', { id: original.id, revision: 1 })).status, 200);
    assert.equal((await client.queryContext({ kind: 'slang', query: '管理测试别名xyz' })).total, 0);
    assert.equal(h.calls.sent.length, 0);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
});

test('corrupt reference overrides reject management writes without blocking confirmed chat meanings', async () => {
  const key = 'group:456';
  const h = await bridgeHarness({ config: { dualMode: { enabled: true }, slang: { enabled: true, autoResearch: false } },
    files: { 'state/slang-reference.json': '{broken', 'state/slang.json': [{ content: '本地测试词xyz', meaning: '确认释义仍然可用', status: 'confirmed' }] } });
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`, headers = { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(baseUrl + '/api/slang/reference', { headers })).status, 503);
    const entry = { term: '新词', aliases: [], meaning: '释义', usage: '', source: '', kind: 'word', known: true, enabled: true };
    assert.equal((await fetch(baseUrl + '/api/slang/reference/save', { method: 'POST', headers, body: JSON.stringify({ revision: 0, entry }) })).status, 503);
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/slang-reference.json'), 'utf8'), '{broken');
    await h.ensureSession(key); h.getSocialV2State(key).bootstrapSent = true;
    await h.handleIncoming('group', 456, { self_id: 999, message_id: 90, user_id: 321, group_id: 456,
      sender: { nickname: '小王' }, message: [{ type: 'text', data: { text: '本地测试词xyz' } }] }, h.cfg);
    await h.deliverPrompt(key, '', { wakeReason: 'observation' });
    const text = h.calls.prompts.at(-1).content[0].text;
    assert.ok(text.includes('确认释义仍然可用')); assert.ok(text.includes('梗库提示'));
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
});
