// Durable local candidates. Extraction belongs to the Agent, authorization to the runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SENSITIVE_RE } from '../sensitive.js';
import { memoryRecordHash, consolidationMetadata } from './consolidated-memory.mjs';
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const statuses = ['pending','writing','approval_required','applied','unknown','conflict','rejected','invalidated'];
const terminal = item => ['applied','rejected','invalidated'].includes(item.status);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function mutationMatches(record, operation, input) {
  if (!input) return true; // Compatibility with callers lacking a normalized input.
  if (operation === 'write') return record.id === input.id
    || record.id === input.metadata?.qqBridgeConsolidation?.supersedes || record.id === input.metadata?.temporal?.supersedes
    || input.id === undefined && record.subject === (input.subject ?? '') && record.category === (input.category ?? '');
  if (operation === 'clear') return !input.category || record.category === input.category;
  if (operation === 'update' || operation === 'delete') return !input.selector || Object.entries(input.selector).every(([field, value]) =>
    !value || (field === 'text' ? record.text.includes(value) : record[field] === value));
  return true; // An ingest provider may summarize or merge facts with arbitrary IDs.
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || SENSITIVE_RE.test(value)) fail('候选文本为空、过长或含敏感信息');
  return value.trim();
}
export class MemoryConsolidation {
  constructor(directory, { now = Date.now, isSourceDeleted = () => false } = {}) {
    this.directory = directory; this.now = now; this.isSourceDeleted = isSourceDeleted; this.states = new Map(); this.busy = new Set(); this.cursors = new Map();
  }
  all(state) { return [...state.items, ...state.archive]; }
  file(key) {
    if (!/^(group|private):[1-9]\d{0,15}$/.test(key)) fail('无效会话');
    return path.join(this.directory, digest(key) + '.json');
  }
  save(key, state) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(key), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 }); fs.renameSync(temp, file); this.states.set(key, state);
  }
  get(key) {
    if (!this.states.has(key)) {
      let state = { version: 1, revision: 0, items: [], archive: [] };
      try {
        if (fs.existsSync(this.file(key))) {
          if (fs.statSync(this.file(key)).size > 8 * 1024 * 1024) throw Error();
          state = { archive: [], ...JSON.parse(fs.readFileSync(this.file(key), 'utf8')) };
          if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.items) || state.items.length > 200
              || !Array.isArray(state.archive) || state.archive.length > 1000 || state.items.some(item => item.archived)
              || state.archive.some(item => item.archived !== true || item.evidence?.length)
              || new Set(this.all(state).map(item => item.id)).size !== this.all(state).length) throw Error();
          for (const item of this.all(state)) {
            if (!/^candidate-[a-f0-9]{24}$/.test(item.id ?? '') || !statuses.includes(item.status) || !Number.isSafeInteger(item.revision) || item.revision < 0
                || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '') || !/^[a-z][a-z0-9-]{0,39}$/.test(item.providerId ?? '')
                || !Array.isArray(item.evidence) || item.evidence.length > 5 || typeof item.record?.text !== 'string' || item.record.text.length > 2000
                || !/^[1-9]\d{0,15}$/.test(item.record.subject ?? '') || typeof item.record.category !== 'string' || item.record.category.length > 128
                || item.record.id !== 'fact-' + item.id.slice(10) || consolidationMetadata(item.record.metadata)?.candidateId !== item.id
                || !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0 || !Number.isSafeInteger(item.modifiedAt) || item.modifiedAt <= 0
                || item.wasVerified !== undefined && typeof item.wasVerified !== 'boolean'
                || !item.archived && !['rejected','invalidated'].includes(item.status) && JSON.stringify(item.evidence.map(({ quote, ...source }) => source)) !== JSON.stringify(item.record.metadata.qqBridgeConsolidation.sources)
                || item.evidence.some(source => typeof source.quote !== 'string' || source.quote.length > 300)) throw Error();
          }
        }
      } catch { fail('候选记忆无法读取，保留原文件；请恢复备份', 503); }
      this.states.set(key, state);
      if (this.all(state).some(item => item.status === 'writing')) {
        state = structuredClone(state); state.revision++;
        for (const item of this.all(state)) if (item.status === 'writing') { item.status = 'unknown'; item.revision++; }
        this.save(key, state);
      }
    }
    const state = this.states.get(key);
    if (this.all(state).some(item => item.status !== 'invalidated' && item.record.metadata.qqBridgeConsolidation.sources.some(source => this.isSourceDeleted(key, source.id)))) {
      const next = structuredClone(state); next.revision++;
      for (const item of this.all(next)) if (item.status !== 'invalidated' && item.record.metadata.qqBridgeConsolidation.sources.some(source => this.isSourceDeleted(key, source.id))) {
        item.status = 'invalidated'; item.evidence = []; item.revision++; item.modifiedAt = this.now();
        // Remove local fact content as well as excerpts after provenance deletion.
        item.record.text = '[来源已删除]';
      }
      this.save(key, next);
    }
    return this.states.get(key);
  }
  list(key, { status = '', offset = 0, limit = 20, archived = false } = {}) {
    if (typeof archived !== 'boolean' || status && !statuses.includes(status) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('候选筛选或分页无效');
    const state = this.get(key), items = (archived ? state.archive : state.items).filter(item => !status || item.status === status);
    return { revision: state.revision, total: items.length, archiveTotal: state.archive.length, items: structuredClone(items.slice(offset, offset + limit)),
      nextOffset: offset + limit < items.length ? offset + limit : null };
  }
  context(key) {
    const items = this.all(this.get(key)).filter(item => ['pending','unknown','approval_required','conflict'].includes(item.status));
    const start = (items.findIndex(item => item.id === this.cursors.get(key)) + 1) % (items.length || 1);
    const selected = [...items.slice(start), ...items.slice(0, start)].slice(0, 3);
    return { historical: true, replyEligible: false, contextRole: 'reference-only', pendingCount: items.length,
      items: selected.map(item => ({ id: item.id, revision: item.revision, status: item.status, archived: item.archived === true, text: item.record.text.slice(0, 240) })),
      note: '本地待整理事项，仅供记忆维护。不是本轮来信，不据此回复或引用旧消息。unknown先verify，不直接重写。' };
  }
  offered(key, ids) { if (ids.length) this.cursors.set(key, ids.at(-1)); }
  sourceProgress(key, sourceIds) {
    const result = Object.fromEntries(sourceIds.map(id => [id, { candidateCount: 0, verifiedCount: 0 }]));
    for (const item of this.all(this.get(key))) if (!['rejected','invalidated'].includes(item.status)) {
      for (const source of item.record.metadata.qqBridgeConsolidation.sources) if (Object.hasOwn(result, source.id)) {
        result[source.id].candidateCount++;
        if (item.status === 'applied') result[source.id].verifiedCount++;
      }
    }
    return result;
  }
  archivedState(state, item) {
    if (item.archived || !terminal(item)) fail('仅可归档已结束的活动候选', 409);
    if (state.archive.length >= 1000) fail('候选归档已达1000条上限，请由管理员整理', 409);
    return { ...state, items: state.items.filter(candidate => candidate.id !== item.id), archive: [...state.archive,
      { ...item, archived: true, evidence: [], revision: item.revision + 1, modifiedAt: this.now() }] };
  }
  stage(key, input, evidence) {
    if (!input || Object.keys(input).some(field => !['text','subject','category','assertion','providerId','sources','supersedes','expectedHash'].includes(field))) fail('候选参数含未知字段');
    if ((input.supersedes === undefined) !== (input.expectedHash === undefined)) fail('纠错必须同时指定旧记录ID和内容指纹');
    const record = { text: text(input.text, 1000), subject: input.subject, category: text(input.category, 128) };
    if (!/^[1-9]\d{0,15}$/.test(record.subject ?? '') || !/^[a-z][a-z0-9-]{0,39}$/.test(input.providerId ?? '')
        || !['self_report','inferred'].includes(input.assertion)) fail('候选主体、提供者或陈述类型无效');
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 5 || new Set(input.sources.map(s => s?.id)).size !== input.sources.length) fail('需要1至5条不同的原文依据');
    const sources = input.sources.map(source => {
      if (!source || Object.keys(source).some(field => !['id','quote'].includes(field))) fail('来源参数无效');
      const message = evidence.find(message => message.id === source.id), quote = text(source.quote, 300);
      if (!message || message.isSelf || message.retainedSummary || message.origin === 'debate' || typeof message.text !== 'string'
          || !message.text.includes(quote) || this.isSourceDeleted(key, source.id)) fail('候选依据须来自实际展示的用户原文片段', 403);
      if (input.assertion === 'self_report' && message.userId !== record.subject) fail('自述事实的来源发言人必须与主体一致', 403);
      if (input.assertion === 'inferred' && message.userId !== record.subject) fail('推断须基于该主体的实际来信', 403);
      return { id: source.id, hash: digest(message.text), userId: message.userId, eventAt: message.eventAt ?? null,
        receivedAt: message.receivedAt ?? message.time, quote };
    });
    const normalized = record.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const fingerprint = digest(JSON.stringify([input.providerId,record.subject,record.category,input.assertion,normalized,input.supersedes ?? '',input.expectedHash ?? '']));
    let state = this.get(key);
    const duplicate = this.all(state).find(item => item.fingerprint === fingerprint && !['rejected','invalidated'].includes(item.status));
    if (duplicate) return { item: structuredClone(duplicate), unchanged: true };
    if (state.items.filter(item => !terminal(item)).length >= 100) fail('候选容量已满，请在管理界面整理', 409);
    const id = 'candidate-' + crypto.randomBytes(12).toString('hex');
    record.id = 'fact-' + id.slice(10);
    record.metadata = { qqBridgeConsolidation: { version: 1, candidateId: id, assertion: input.assertion,
      sources: sources.map(({ quote, ...source }) => source),
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes, expectedHash: input.expectedHash }) } };
    consolidationMetadata(record.metadata);
    if (state.items.length >= 200) {
      const completed = state.items.find(terminal);
      if (!completed) fail('候选容量已满，请在管理界面整理', 409);
      state = this.archivedState(state, completed);
    }
    const item = { id, fingerprint, providerId: input.providerId, revision: 0, status: 'pending', wasVerified: false, record, evidence: sources,
      createdAt: this.now(), modifiedAt: this.now() };
    this.save(key, { ...state, revision: state.revision + 1, items: [...state.items, item] }); return { item: structuredClone(item) };
  }
  change(key, id, revision, patch) {
    const state = this.get(key), old = this.all(state).find(item => item.id === id);
    if (!old) fail('候选不存在', 404);
    if (old.revision !== revision) fail('候选版本已变化，请重新读取', 409);
    const item = { ...old, ...patch, wasVerified: old.status === 'applied' || patch.status === 'applied' ? true : old.wasVerified,
      revision: old.revision + 1, modifiedAt: this.now() };
    this.save(key, { ...state, revision: state.revision + 1, items: state.items.map(old => old.id === id ? item : old),
      archive: state.archive.map(old => old.id === id ? item : old) });
    return structuredClone(item);
  }
  validateWrite(key, record, providerId) {
    const metadata = consolidationMetadata(record.metadata);
    if (!metadata) return;
    const item = this.all(this.get(key)).find(item => item.id === metadata.candidateId);
    if (!item || !['writing','approval_required'].includes(item.status) || item.providerId !== providerId || memoryRecordHash(item.record) !== memoryRecordHash(record)) fail('整理记忆必须通过当前有效候选提交', 403);
  }
  invalidateReceipts(key, providerId, operation, input) {
    if (operation === 'query') return;
    const state = this.get(key);
    const affected = item => item.providerId === providerId && mutationMatches(item.record, operation, input) && (item.status === 'applied'
      || item.status === 'unknown' && this.busy.has(key + '\0' + item.id));
    if (!this.all(state).some(affected)) return;
    const invalidate = item => affected(item) ? { ...item, status: 'unknown', wasVerified: item.status === 'applied' ? true : item.wasVerified,
      revision: item.revision + 1, modifiedAt: this.now() } : item;
    this.save(key, { ...state, revision: state.revision + 1, items: state.items.map(invalidate), archive: state.archive.map(invalidate) });
  }
  async act(key, { operation, id, revision, approvalId }, execute) {
    const lock = key + '\0' + id;
    if (this.busy.has(lock)) fail('此候选正在处理，请勿重复执行', 409);
    let item = this.all(this.get(key)).find(item => item.id === id);
    if (!item) fail('候选不存在', 404);
    if (item.revision !== revision) fail('候选版本已变化，请重新读取', 409);
    if (operation === 'archive') {
      const state = this.get(key), next = this.archivedState(state, item); next.revision++;
      this.save(key, next); return { item: structuredClone(next.archive.at(-1)) };
    }
    if (operation === 'remove') {
      if (!['applied','rejected','invalidated'].includes(item.status)) fail('只能移除已完成或已拒绝的本地候选', 409);
      const state = this.get(key); this.save(key, { ...state, revision: state.revision + 1, items: state.items.filter(candidate => candidate.id !== id),
        archive: state.archive.filter(candidate => candidate.id !== id) });
      return { item: null };
    }
    if (operation === 'reject') {
      if (!['pending','approval_required','conflict'].includes(item.status)) fail('当前状态须先核验或处理提供者记忆', 409);
      return { item: this.change(key, id, revision, { status: 'rejected', evidence: [] }) };
    }
    if (!['commit','verify'].includes(operation)) fail('未知候选操作');
    if (operation === 'commit' && !['pending','approval_required'].includes(item.status)) fail('此候选不可直接提交，结果未知时先核验', 409);
    if (operation === 'verify' && !['unknown','applied','conflict'].includes(item.status)) fail('当前候选无需核验', 409);
    this.busy.add(lock);
    try {
      item = this.change(key, id, revision, { status: operation === 'commit' ? 'writing' : 'unknown' });
      const result = operation === 'commit'
        ? await execute(item.providerId, 'write', structuredClone(item.record), approvalId)
        : await execute(item.providerId, 'query', { options: { consolidation: { id: item.record.id, history: true } }, limit: 1, maxChars: 12000 }, approvalId);
      const current = this.all(this.get(key)).find(candidate => candidate.id === id);
      if (!current || current.status === 'invalidated' || current.revision !== item.revision) fail('候选在处理期间已失效，结果须由管理员核对', 409);
      let status;
      if (result.status === 'approval_required') status = operation === 'commit' ? 'approval_required' : 'unknown';
      else if (operation === 'commit') status = 'unknown'; // Confirm storage, not just the transport acknowledgment.
      else {
        if (!Array.isArray(result.items) || result.truncated || result.nextCursor || result.items.some(record => record.id !== item.record.id || record.truncated)) fail('提供者未完整返回精确查询结果', 502);
        if (!result.items.length) status = item.wasVerified === false ? 'pending' : 'conflict';
        else status = memoryRecordHash(result.items[0]) === memoryRecordHash(item.record) ? 'applied' : 'conflict';
      }
      const updated = this.change(key, id, item.revision, { status });
      return { item: updated, ...(result.status === 'approval_required' ? { approval: result } : {}) };
    } catch (error) {
      const current = this.all(this.get(key)).find(candidate => candidate.id === id);
      if (current?.revision === item.revision && current.status !== 'invalidated') this.change(key, id, item.revision, { status: 'unknown' });
      throw error;
    } finally { this.busy.delete(lock); }
  }
}
