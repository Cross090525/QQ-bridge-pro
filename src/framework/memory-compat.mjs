import fs from 'node:fs';
import path from 'node:path';
import { permissionDigest } from './permissions.mjs';
import { frameworkError } from './content.mjs';

// Wire compatibility only. Storage, scoring, merging and forgetting belong to
// the provider; these aliases contain no built-in memory implementation.
export function legacyMemoryOperation(pathname, body = {}) {
  if (pathname === '/api/socialV2/memory') return { operation: 'query', input: { category: body.category ?? '', limit: 20, maxChars: 12000 } };
  if (pathname.endsWith('memory-append')) return { operation: 'write', input: { ...(body.id === undefined ? {} : { id: body.id }), text: body.content, category: body.category,
    subject: body.extra?.target ?? '', metadata: body.extra ?? {} } };
  if (pathname.endsWith('memory-clear')) return { operation: 'clear', input: { category: body.category ?? '' } };
  if (pathname.endsWith('memory-update') || pathname.endsWith('memory-remove')) {
    if (!body.id && !body.oldContent && !body.content && !body.target) throw frameworkError('修改/删除记忆需要 id、原文或 subject');
    const selector = body.id ? { id: body.id } : { category: body.category ?? '',
      ...(body.target ? { subject: body.target } : { text: body.oldContent ?? body.content }) };
    if (pathname.endsWith('memory-remove')) return { operation: 'delete', input: { selector } };
    return { operation: 'update', input: { selector, patch: {
      ...(body.newContent === undefined ? {} : { text: body.newContent }),
      ...(body.newExtra && Object.keys(body.newExtra).length ? { metadata: body.newExtra } : {}) } } };
  }
  throw frameworkError('未知的旧记忆接口', 404);
}

// Preserve legacy data before the first state save removes its old fields.
// Content-addressed archives are never imported or sent to a provider implicitly.
export function archiveLegacyMemory(raw, directory, atomicWriteJson) {
  const conversations = Object.create(null);
  for (const [key, value] of Object.entries(raw?.conversations ?? {})) {
    if (!/^(group|private):\d+$/.test(key) || !value) continue;
    if (!(value.activeTopics?.length || value.pendingThoughts?.length || Object.keys(value.memberImpressions ?? {}).length)) continue;
    conversations[key] = { activeTopics: value.activeTopics ?? [], pendingThoughts: value.pendingThoughts ?? [], memberImpressions: value.memberImpressions ?? {} };
  }
  if (!Object.keys(conversations).length) return;
  const snapshot = { version: 1, conversations };
  const file = path.join(directory, `${permissionDigest(snapshot)}.json`);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      if (permissionDigest(JSON.parse(fs.readFileSync(file, 'utf8'))) !== permissionDigest(snapshot)) throw new Error('invalid backup');
    } else atomicWriteJson(file, snapshot);
  } catch {
    const error = frameworkError('旧记忆归档失败，拒绝启动以免覆盖原数据', 503);
    error.code = 'MEMORY_MIGRATION_BACKUP_FAILED'; throw error;
  }
}
