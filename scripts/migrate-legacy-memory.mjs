import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportLegacyMemory } from './export-legacy-memory.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(repoRoot, 'state');
const defaultArchiveDir = path.join(stateDir, 'legacy-memory');
const keyPattern = /^(group|private):[1-9]\d*$/;

function usage() {
  return [
    'Migrate QQ Bridge v1 legacy-memory archives into a configured memory provider.',
    '',
    'Usage:',
    '  node scripts/migrate-legacy-memory.mjs [--dry-run]',
    '  node scripts/migrate-legacy-memory.mjs --apply',
    '',
    'Options:',
    '  --apply                 Perform writes. Without this flag the command only previews.',
    '  --archive=PATH          Read one archive file instead of the default archive directory.',
    '  --archive-dir=PATH      Read all .json archives from this directory.',
    '  --key=group:ID          Limit migration to one archived conversation key.',
    '  --provider=ID           Provider to use; defaults to memory.provider in config.json.',
    '  --help                  Show this help.',
    '',
    'The source archives are never changed or deleted. Re-running is idempotent.',
  ].join('\n');
}

export function parseArgs(argv) {
  const options = { apply: false, archive: null, archiveDir: null, key: null, provider: null };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--archive=')) options.archive = arg.slice('--archive='.length);
    else if (arg.startsWith('--archive-dir=')) options.archiveDir = arg.slice('--archive-dir='.length);
    else if (arg.startsWith('--key=')) options.key = arg.slice('--key='.length);
    else if (arg.startsWith('--provider=')) options.provider = arg.slice('--provider='.length);
    else throw new Error(`Unknown option: ${arg.split('=')[0]}`);
  }
  if (options.archive && options.archiveDir) throw new Error('Use either --archive or --archive-dir, not both.');
  if (options.archive !== null && !options.archive) throw new Error('--archive needs a file path.');
  if (options.archiveDir !== null && !options.archiveDir) throw new Error('--archive-dir needs a directory path.');
  if (options.key && !keyPattern.test(options.key)) throw new Error('--key must be a canonical group:ID or private:ID key.');
  if (options.provider && !/^[a-z][a-z0-9-]{0,39}$/.test(options.provider)) throw new Error('--provider is invalid.');
  return options;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  }
  return value;
}

function comparableRecord(record) {
  const comparable = {
    id: record.id,
    text: record.text,
    category: record.category,
    subject: record.subject ?? '',
    metadata: record.metadata ?? {},
  };
  if (Number.isSafeInteger(record.expiresAt)) comparable.expiresAt = record.expiresAt;
  return stable(comparable);
}

function sameRecord(left, right) {
  return JSON.stringify(comparableRecord(left)) === JSON.stringify(comparableRecord(right));
}

export function loadPlan(options) {
  const archivePath = options.archive ? path.resolve(options.archive) : null;
  const archiveDir = options.archiveDir ? path.resolve(options.archiveDir) : defaultArchiveDir;
  let files;
  if (archivePath) {
    if (!fs.statSync(archivePath).isFile()) throw new Error('--archive must name a file.');
    files = [archivePath];
  } else {
    if (!fs.existsSync(archiveDir) || !fs.statSync(archiveDir).isDirectory()) throw new Error('Legacy memory archive directory was not found.');
    files = fs.readdirSync(archiveDir).filter(name => name.endsWith('.json')).sort().map(name => path.join(archiveDir, name));
  }
  if (!files.length) throw new Error('No .json legacy memory archives were found.');

  const snapshotsByKey = new Map();
  let duplicateSnapshots = 0;
  let selectedConversations = 0;
  let skippedEmptyConversations = 0;
  for (const file of files) {
    let archive;
    try {
      archive = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('An archive could not be parsed; no provider writes were made.');
    }
    if (archive?.version !== 1 || !archive.conversations || typeof archive.conversations !== 'object' || Array.isArray(archive.conversations)) {
      throw new Error('An archive has an unsupported structure; no provider writes were made.');
    }
    for (const key of Object.keys(archive.conversations)) {
      if (options.key && key !== options.key) continue;
      if (!keyPattern.test(key)) throw new Error('An archive contains a non-canonical conversation key.');
      const converted = exportLegacyMemory(archive, key);
      selectedConversations += 1;
      if (!converted.records.length) skippedEmptyConversations += 1;
      const records = converted.records.slice().sort((a, b) => a.id.localeCompare(b.id));
      const signature = JSON.stringify(stable(records));
      const snapshots = snapshotsByKey.get(key) ?? [];
      const previous = snapshots[0];
      if (previous && previous.signature !== signature) {
        throw new Error('Different archive snapshots exist for one conversation. Select one with --archive to avoid importing stale memories.');
      }
      if (previous) {
        duplicateSnapshots += 1;
        continue;
      }
      snapshots.push({ records, signature });
      snapshotsByKey.set(key, snapshots);
    }
  }
  if (options.key && selectedConversations === 0) throw new Error('The selected conversation key was not found in the chosen archive source.');

  const groups = [...snapshotsByKey.entries()].map(([key, snapshots]) => ({ key, records: snapshots[0].records }));
  const recordIds = new Map();
  let duplicateRecords = 0;
  for (const group of groups) {
    group.records = group.records.filter(record => {
      const previous = recordIds.get(record.id);
      if (!previous) {
        recordIds.set(record.id, record);
        return true;
      }
      if (!sameRecord(previous, record)) throw new Error('Conflicting records with the same deterministic legacy ID were found.');
      duplicateRecords += 1;
      return false;
    });
  }
  const allRecords = groups.flatMap(group => group.records);
  const byCategory = {};
  for (const record of allRecords) byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
  return { files, groups: groups.filter(group => group.records.length), allRecords, byCategory, duplicateSnapshots, duplicateRecords, skippedEmptyConversations, selectedConversations };
}

function resolveProvider(config, requestedId) {
  const providers = config.memory?.providers;
  if (!Array.isArray(providers)) throw new Error('No memory providers are configured in config.json.');
  const providerId = requestedId ?? config.memory?.provider;
  if (!providerId) throw new Error('There is no default memory provider; pass --provider=ID.');
  const provider = providers.find(item => item?.id === providerId && item.enabled !== false);
  if (!provider) throw new Error('The selected provider is not registered or is disabled.');
  if (!provider.operations?.includes('query') || !provider.operations?.includes('write')) {
    throw new Error('The selected provider must support query and write for safe migration.');
  }
  const port = Number(config.consolePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('config.json has no valid consolePort.');
  return { providerId, port };
}

async function createApi(port) {
  const tokenPath = path.join(stateDir, 'console-token');
  let token;
  try { token = fs.readFileSync(tokenPath, 'utf8').trim(); } catch { throw new Error('The local Bridge console credential is unavailable.'); }
  if (!token) throw new Error('The local Bridge console credential is empty.');
  const base = `http://127.0.0.1:${port}`;
  return async (method, route, payload) => {
    let response;
    try {
      response = await fetch(new URL(route, base), {
        method,
        headers: {
          'x-console-token': token,
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(40_000),
      });
    } catch {
      throw new Error('Could not reach the local QQ Bridge API.');
    }
    let result;
    try { result = await response.json(); } catch { throw new Error(`QQ Bridge returned a non-JSON response (HTTP ${response.status}).`); }
    if (!response.ok || result?.ok === false) throw new Error(`QQ Bridge request failed (HTTP ${response.status}).`);
    return result;
  };
}

async function listAvailableProvider(api, key, providerId) {
  const url = new URL('/api/memory/providers', 'http://127.0.0.1');
  url.searchParams.set('key', key);
  const result = await api('GET', `${url.pathname}${url.search}`);
  const provider = result.providers?.find(item => item?.id === providerId);
  if (!provider) throw new Error('The selected provider is not available for an archived conversation.');
  const decision = operation => provider.operations?.find(item => item?.operation === operation)?.permission;
  if (decision('query') !== 'allow' || decision('write') !== 'allow') {
    throw new Error('The current provider policy does not allow both query and write for an archived conversation.');
  }
}

async function queryCategory(api, key, providerId, category) {
  const records = new Map();
  let cursor = null;
  for (let page = 0; page < 1000; page += 1) {
    const input = { query: '', category, limit: 1, maxChars: 12000 };
    if (cursor === null) input.offset = 0;
    else input.cursor = cursor;
    const result = await api('POST', '/api/memory/query', { key, providerId, input });
    for (const item of result.items ?? []) if (item?.id) records.set(item.id, item);
    const next = result.nextCursor == null ? null : String(result.nextCursor);
    if (next === null) return records;
    if (next === cursor) throw new Error('Provider pagination did not advance.');
    cursor = next;
  }
  throw new Error('Provider pagination exceeded the safety limit.');
}

async function existingRecords(api, group, providerId) {
  const result = new Map();
  const categories = [...new Set(group.records.map(record => record.category))];
  for (const category of categories) {
    const pageRecords = await queryCategory(api, group.key, providerId, category);
    for (const [id, item] of pageRecords) result.set(id, item);
  }
  return result;
}

function summarize(plan, mode, providerId) {
  console.log(`Mode: ${mode}`);
  console.log(`Provider: ${providerId}`);
  console.log(`Archive files: ${plan.files.length}`);
  console.log(`Conversations selected: ${plan.groups.length}`);
  console.log(`Records selected: ${plan.allRecords.length}`);
  console.log(`Records by category: ${JSON.stringify(plan.byCategory)}`);
  console.log(`Repeated identical archive snapshots skipped: ${plan.duplicateSnapshots}`);
  console.log(`Repeated identical records skipped: ${plan.duplicateRecords}`);
  console.log(`Conversations with no exportable records: ${plan.skippedEmptyConversations}`);
}

export async function migrate(plan, providerId, api) {
  const existingByKey = new Map();
  let alreadyPresent = 0;
  let toWrite = 0;

  // Complete every read-only permission/conflict check before the first write.
  for (const group of plan.groups) {
    await listAvailableProvider(api, group.key, providerId);
    const existing = await existingRecords(api, group, providerId);
    existingByKey.set(group.key, existing);
    for (const record of group.records) {
      const found = existing.get(record.id);
      if (!found) { toWrite += 1; continue; }
      if (!sameRecord(found, record)) throw new Error('A provider record conflicts with a legacy ID; no migration writes were made.');
      alreadyPresent += 1;
    }
  }

  let written = 0;
  try {
    for (const group of plan.groups) {
      const existing = existingByKey.get(group.key);
      for (const record of group.records) {
        if (existing.has(record.id)) continue;
        const result = await api('POST', '/api/memory/write', { key: group.key, providerId, input: record });
        if (!Array.isArray(result.affectedIds) || !result.affectedIds.includes(record.id)) {
          throw new Error('Provider did not confirm a migrated record ID.');
        }
        written += 1;
      }
    }
  } catch (error) {
    throw new Error(`Migration stopped after ${written} new records; source archives are intact and rerunning is safe. ${error.message}`);
  }

  let verified = 0;
  for (const group of plan.groups) {
    const after = await existingRecords(api, group, providerId);
    for (const record of group.records) {
      const found = after.get(record.id);
      if (!found || !sameRecord(found, record)) throw new Error('Post-migration verification did not match every expected record.');
      verified += 1;
    }
  }
  console.log(`New records written: ${written}`);
  console.log(`Identical records already present: ${alreadyPresent}`);
  console.log(`Records verified after migration: ${verified}`);
  console.log('Source archives were not modified or deleted.');
  return { written, alreadyPresent, verified, toWrite };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const plan = loadPlan(options);
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8'));
  const { providerId, port } = resolveProvider(config, options.provider);
  summarize(plan, options.apply ? 'apply' : 'dry-run', providerId);
  if (!plan.allRecords.length) {
    console.log('Nothing to migrate.');
    return;
  }
  if (!options.apply) {
    console.log('Preview only. Re-run with --apply to import these records.');
    return;
  }
  const api = await createApi(port);
  await migrate(plan, providerId, api);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(`Legacy memory migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
