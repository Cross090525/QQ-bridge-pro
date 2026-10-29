import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadPlan, migrate, parseArgs } from './migrate-legacy-memory.mjs';

function archive(conversations) {
  return { version: 1, conversations };
}

async function withArchiveDir(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-legacy-memory-'));
  try { return await run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function writeArchive(directory, name, value) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

function sampleArchive() {
  return archive({
    'group:456': {
      activeTopics: [{ text: '准备把旧会话记忆迁入海棠', participants: ['456'], pendingQuestion: '先验证迁移结果' }],
      pendingThoughts: [{ text: '检查导入后是否重复', motivation: '避免重复记忆' }],
      memberImpressions: { '张三': { traits: ['喜欢摄影', '回答直接'], interactionCount: 4 } },
    },
    'private:789': {
      activeTopics: [], pendingThoughts: [],
      memberImpressions: { '李四': { traits: ['负责部署'], interactionCount: 2 } },
    },
  });
}

function createFakeApi({ seed = [], failAfterWrites = Infinity } = {}) {
  const stores = new Map();
  let writeCount = 0;
  for (const item of seed) {
    const bucket = stores.get(item.key) ?? new Map();
    bucket.set(item.record.id, item.record);
    stores.set(item.key, bucket);
  }
  const bucketFor = key => {
    const bucket = stores.get(key) ?? new Map();
    stores.set(key, bucket);
    return bucket;
  };
  const api = async (method, route, payload) => {
    if (method === 'GET' && route.startsWith('/api/memory/providers')) {
      return { providers: [{ id: 'mock', operations: [
        { operation: 'query', permission: 'allow' },
        { operation: 'write', permission: 'allow' },
      ] }] };
    }
    if (method === 'POST' && route === '/api/memory/query') {
      const input = payload.input ?? {};
      const records = [...bucketFor(payload.key).values()].filter(item => !input.category || item.category === input.category);
      const offset = input.cursor == null ? (input.offset ?? 0) : Number(input.cursor);
      const items = records.slice(offset, offset + input.limit);
      const next = offset + input.limit;
      return { items, nextCursor: next < records.length ? String(next) : null };
    }
    if (method === 'POST' && route === '/api/memory/write') {
      if (writeCount >= failAfterWrites) {
        failAfterWrites = Infinity;
        throw new Error('simulated provider outage');
      }
      writeCount += 1;
      bucketFor(payload.key).set(payload.input.id, payload.input);
      return { affectedIds: [payload.input.id], affectedCount: 1 };
    }
    throw new Error('Unexpected fake API request: ' + method + ' ' + route);
  };
  return { api, stores, get writeCount() { return writeCount; } };
}

test('migration arguments default to preview and reject ambiguous or unsafe selectors', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(['--apply', '--key=group:456']).apply, true);
  assert.throws(() => parseArgs(['--archive=a.json', '--archive-dir=archives']), /either/);
  assert.throws(() => parseArgs(['--key=all']), /canonical/);
});

test('planner consolidates identical snapshots and rejects conflicting snapshots', () => withArchiveDir(directory => {
  const value = sampleArchive();
  writeArchive(directory, 'a.json', value);
  writeArchive(directory, 'b.json', value);
  const plan = loadPlan(parseArgs(['--archive-dir=' + directory]));
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.duplicateSnapshots, 2);
  assert.equal(plan.allRecords.length, 4);

  const changed = sampleArchive();
  changed.conversations['group:456'].memberImpressions['张三'].traits = ['新内容'];
  writeArchive(directory, 'b.json', changed);
  assert.throws(() => loadPlan(parseArgs(['--archive-dir=' + directory])), /Different archive snapshots/);
}));

test('migration writes namespaced records once, verifies them, and is safe to rerun', async () => withArchiveDir(async directory => {
  const file = writeArchive(directory, 'source.json', sampleArchive());
  const original = fs.readFileSync(file);
  const plan = loadPlan(parseArgs(['--archive=' + file]));
  const fake = createFakeApi();

  const first = await migrate(plan, 'mock', fake.api);
  assert.equal(first.written, 4);
  assert.equal(first.verified, 4);
  assert.equal(fake.writeCount, 4);

  const second = await migrate(plan, 'mock', fake.api);
  assert.equal(second.written, 0);
  assert.equal(second.alreadyPresent, 4);
  assert.equal(second.verified, 4);
  assert.equal(fake.writeCount, 4);
  assert.deepEqual(fs.readFileSync(file), original);
}));

test('provider conflicts are detected before any migration write', async () => withArchiveDir(async directory => {
  const file = writeArchive(directory, 'source.json', sampleArchive());
  const plan = loadPlan(parseArgs(['--archive=' + file]));
  const first = plan.groups[0];
  const conflicting = { ...first.records[0], text: 'conflicting provider content' };
  const fake = createFakeApi({ seed: [{ key: first.key, record: conflicting }] });

  await assert.rejects(migrate(plan, 'mock', fake.api), /conflicts with a legacy ID/);
  assert.equal(fake.writeCount, 0);
}));

test('partial provider failure leaves source intact and a rerun resumes idempotently', async () => withArchiveDir(async directory => {
  const file = writeArchive(directory, 'source.json', sampleArchive());
  const original = fs.readFileSync(file);
  const plan = loadPlan(parseArgs(['--archive=' + file]));
  const fake = createFakeApi({ failAfterWrites: 1 });

  await assert.rejects(migrate(plan, 'mock', fake.api), /stopped after 1 new records/);
  assert.equal(fake.writeCount, 1);
  assert.deepEqual(fs.readFileSync(file), original);

  const resumed = await migrate(plan, 'mock', fake.api);
  assert.equal(resumed.written, 3);
  assert.equal(resumed.alreadyPresent, 1);
  assert.equal(resumed.verified, 4);
}));
