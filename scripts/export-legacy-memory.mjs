// Offline conversion only: no provider calls and no credentials are required.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function exportLegacyMemory(archive, key) {
  if (archive?.version !== 1 || !/^(group|private):[1-9]\d*$/.test(key ?? '')) throw new Error('需要 v1 旧记忆归档与准确的会话 key');
  const state = archive.conversations?.[key];
  if (!state) throw new Error('归档中没有该会话');
  const records = [];
  const push = (category, text, subject, metadata, expiresAt) => {
    if (typeof text !== 'string' || !text.trim()) return;
    records.push({ id: `legacy:${crypto.createHash('sha256').update(JSON.stringify([key, category, text, subject])).digest('hex').slice(0, 32)}`,
      text: text.slice(0, 2000), category, subject: String(subject ?? '').slice(0, 128), metadata,
      ...(Number.isSafeInteger(expiresAt) && expiresAt > 0 ? { expiresAt } : {}) });
  };
  for (const topic of Array.isArray(state.activeTopics) ? state.activeTopics : []) push('activeTopic', topic?.text, '',
    { participants: Array.isArray(topic?.participants) ? topic.participants.map(String).slice(0, 20) : [], pendingQuestion: String(topic?.pendingQuestion ?? '').slice(0, 2000) });
  for (const thought of Array.isArray(state.pendingThoughts) ? state.pendingThoughts : []) push('pendingThought', thought?.text, '',
    { motivation: String(thought?.motivation ?? '').slice(0, 2000) }, thought?.expiresAt);
  for (const [subject, impression] of Object.entries(state.memberImpressions ?? {})) push('memberImpression',
    Array.isArray(impression?.traits) ? impression.traits.map(String).join('、') : '', subject, { interactionCount: Number(impression?.interactionCount) || 0 });
  return { version: 1, source: 'legacy-memory', key, records };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const archivePath = arg('archive'), key = arg('key'), output = arg('out');
  if (!archivePath || !key || !output) throw new Error('用法：node scripts/export-legacy-memory.mjs --archive=归档.json --key=group:123 --out=待导入.json');
  const result = exportLegacyMemory(JSON.parse(fs.readFileSync(archivePath, 'utf8')), key);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`已离线转换 ${result.records.length} 条，未上传提供者：${path.resolve(output)}`);
}
