// Shared, additive provider semantics for evidence-backed immutable facts.
import crypto from 'node:crypto';
const fail = message => { throw Object.assign(Error(message), { statusCode: 409 }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function memoryRecordHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical({ id: record.id, text: record.text,
    category: record.category ?? '', subject: record.subject ?? '', metadata: record.metadata ?? {}, expiresAt: record.expiresAt ?? null }))).digest('hex');
}
export function consolidationMetadata(metadata) {
  const value = metadata?.qqBridgeConsolidation;
  if (value === undefined) return null;
  if (!value || Object.keys(value).some(key => !['version','candidateId','assertion','sources','supersedes','expectedHash'].includes(key))
      || value.version !== 1 || !/^candidate-[a-f0-9]{24}$/.test(value.candidateId ?? '')
      || !['self_report','inferred'].includes(value.assertion) || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 5
      || value.sources.some(source => !source || Object.keys(source).some(key => !['id','hash','userId','eventAt','receivedAt'].includes(key))
        || !id(source.id) || !hash(source.hash) || !/^[1-9]\d{0,15}$/.test(source.userId ?? '')
        || !Number.isSafeInteger(source.receivedAt) || source.receivedAt <= 0
        || source.eventAt !== null && (!Number.isSafeInteger(source.eventAt) || source.eventAt <= 0))
      || new Set(value.sources.map(source => source.id)).size !== value.sources.length
      || (value.supersedes !== undefined || value.expectedHash !== undefined) && (!id(value.supersedes) || !hash(value.expectedHash))) fail('整理记忆来源或纠错参数无效');
  return value;
}
export function consolidationQuery(options = {}) {
  const value = options.consolidation;
  if (value === undefined) return null;
  if (!value || Object.keys(value).some(key => !['id','history'].includes(key)) || value.id !== undefined && !id(value.id)
      || value.history !== undefined && typeof value.history !== 'boolean') fail('整理记忆查询参数无效');
  return value;
}
export function selectConsolidated(records, options = {}) {
  const query = consolidationQuery(options);
  return records.filter(record => (!query?.id || record.id === query.id)
    && (query?.history === true || !record.metadata?.qqBridgeConsolidationState?.supersededBy));
}
export function putConsolidated(records, item) {
  const managed = consolidationMetadata(item.metadata);
  if (item.metadata?.qqBridgeConsolidationState !== undefined) fail('整理记忆历史状态只能由提供者维护');
  const old = records.find(record => record.id === item.id);
  if (old && managed && memoryRecordHash(old) === memoryRecordHash(item)) return { records, affectedIds: [] };
  if (old && (old.metadata?.qqBridgeConsolidation || old.metadata?.qqBridgeConsolidationState || managed)) fail('整理记忆不可覆盖，请读取后用新id纠错');
  let next = records.slice(); const affectedIds = [];
  if (managed?.supersedes) {
    const previous = records.find(record => record.id === managed.supersedes);
    if (!previous || previous.id === item.id || previous.subject !== item.subject || previous.category !== item.category
        || previous.metadata?.temporal || previous.metadata?.qqBridgeConsolidationState?.supersededBy
        || memoryRecordHash(previous) !== managed.expectedHash) fail('旧记忆已变化或对象类别不匹配，请重新查询后纠错');
    next = next.map(record => record.id === previous.id ? { ...record, metadata: { ...record.metadata, qqBridgeConsolidationState: { supersededBy: item.id } } } : record);
    affectedIds.push(previous.id);
  }
  next = next.filter(record => record.id !== item.id); next.push(item); affectedIds.push(item.id);
  return { records: next, affectedIds };
}
