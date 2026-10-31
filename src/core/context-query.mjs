// Read-only, bounded context selection. Never receives credentials or other sessions.
import { compactModelMessage } from '../qq-model-view.js';
import { lookupSlangReference } from '../slang-reference.mjs';

export const CONTEXT_KINDS = Object.freeze(['memory', 'slang', 'history', 'role']);

function fail(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function boundedNumber(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} 必须为 ${min}~${max} 的整数`);
  return value;
}

export function normalizeContextQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('查询必须是 JSON 对象');
  const { kind = 'memory', query = '', member = '', category = '' } = input;
  if (!CONTEXT_KINDS.includes(kind)) fail('kind 必须为 memory / slang / history / role');
  for (const [name, value] of Object.entries({ query, member, category })) {
    if (typeof value !== 'string' || value.length > 256) fail(`${name} 必须是最多 256 字符的字符串`);
  }
  return {
    kind, query: query.trim(), member: member.trim(), category,
    limit: boundedNumber(input.limit, 5, 1, 20, 'limit'),
    offset: boundedNumber(input.offset, 0, 0, 100000, 'offset'),
    maxChars: boundedNumber(input.maxChars, 3000, 500, 12000, 'maxChars'),
  };
}

function normalized(text) { return String(text ?? '').normalize('NFKC').toLowerCase(); }
function score(text, query) {
  if (!query) return 1;
  const value = normalized(text);
  const q = normalized(query);
  return (value.includes(q) ? 10 : 0) + q.split(/\s+/u).filter(term => term && value.includes(term)).length;
}

// Budget applies to the whole JSON result. Oversized first items are returned as
// explicit excerpts; callers can paginate without silently skipping that item.
function pack(kind, candidates, options, provenance = {}) {
  const selected = candidates.slice(options.offset, options.offset + options.limit);
  const result = { kind, total: candidates.length, items: [], nextOffset: null, truncated: false, ...provenance };
  for (const item of selected) {
    result.items.push(item);
    if (JSON.stringify(result).length <= options.maxChars - 80) continue;
    result.items.pop();
    if (!result.items.length) {
      const excerpt = Array.from(JSON.stringify(item)).slice(0, Math.floor((options.maxChars - 220) / 2)).join('');
      result.items.push({ excerpt, truncated: true });
    }
    result.truncated = true;
    break;
  }
  const consumed = options.offset + result.items.length;
  result.nextOffset = consumed < candidates.length ? consumed : null;
  result.truncated ||= result.nextOffset !== null;
  while (JSON.stringify(result).length > options.maxChars && result.items[0]?.excerpt) {
    result.items[0].excerpt = Array.from(result.items[0].excerpt).slice(0, Math.floor(result.items[0].excerpt.length / 2)).join('');
  }
  return result;
}

export function queryConversationContext(source, input = {}, now = Date.now()) {
  const options = normalizeContextQuery(input);
  const { kind, query, member, category } = options;
  const st = source.state ?? {};
  let items = [];
  if (kind === 'memory') {
    const error = new Error('记忆由开放提供者接口处理，内置记忆检索已停用');
    error.statusCode = 503;
    throw error;
  } else if (kind === 'slang') {
    items = (source.slangEntries ?? []).filter(item => item?.status === 'confirmed' && item.content && item.meaning).map(item => ({
      content: item.content, meaning: item.meaning, usage: item.usage ?? '', example: item.example ?? '',
    }));
  } else if (kind === 'history') {
    items = (st.recentMessages ?? []).filter(item => !member
      || normalized(item?.sender) === normalized(member) || String(item?.userId ?? '') === member)
      .slice().reverse().map(compactModelMessage);
  } else if (kind === 'role') {
    items = [{ name: source.role?.name ?? null, version: source.role?.version ?? '', text: source.role?.text ?? '' }];
  }
  items = items.map((item, index) => ({ item, index, relevance: score(JSON.stringify(item), query) }))
    .filter(entry => entry.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || (Number(b.item.updatedAt) || 0) - (Number(a.item.updatedAt) || 0) || a.index - b.index)
    .map(entry => entry.item);
  if (kind === 'slang' && !items.length && query && source.slangReferenceFallback === true) {
    const references = lookupSlangReference(query);
    return pack(kind, references, options, { provenance: 'static-reference',
      note: '已确认黑话未命中；以下仅为通用词典参考，未经本群确认，不能覆盖本群用法或自动写入黑话库。' });
  }
  return pack(kind, items, options);
}
