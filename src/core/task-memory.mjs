// Durable unfinished work, separate from short-lived model context and send permission.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = (text, statusCode = 400) => { throw Object.assign(Error(text), { statusCode }); };
const statuses = ['pending', 'in_progress', 'waiting', 'completed', 'cancelled'];
const kinds = ['continuation', 'bot_task', 'user_plan'];
const terminal = item => ['completed', 'cancelled'].includes(item.status);
function string(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('任务文本无效或过长');
  return value.trim();
}
export class TaskMemory {
  constructor(directory, { now = Date.now, isSourceDeleted = () => false } = {}) {
    this.directory = directory; this.now = now; this.states = new Map(); this.isSourceDeleted = isSourceDeleted;
  }
  file(key) {
    if (!/^(group|private):[1-9]\d{0,15}$/.test(key)) fail('无效会话');
    return path.join(this.directory, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  }
  get(key) {
    if (!this.states.has(key)) {
      let state = { version: 1, revision: 0, items: [] };
      try {
        if (fs.existsSync(this.file(key))) {
          state = JSON.parse(fs.readFileSync(this.file(key), 'utf8'));
          if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.items) || state.items.length > 200
              || state.items.some(item => !/^task-[a-f0-9]{24}$/.test(item.id || '') || !statuses.includes(item.status) || !kinds.includes(item.kind)
                || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500 || typeof item.waitingFor !== 'string' || item.waitingFor.length > 300
                || !/^[1-9]\d{0,15}$/.test(item.ownerId || '') || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.modifiedAt)
                || (item.dueAt != null && (!Number.isSafeInteger(item.dueAt) || item.dueAt <= 0))
                || !Array.isArray(item.sources) || item.sources.length > 40 || item.sources.some(id => typeof id !== 'string' || !id || id.length > 128))
              || new Set(state.items.map(item => item.id)).size !== state.items.length) throw Error();
        }
      } catch { fail('任务记忆无法读取，保留原文件；请恢复备份', 503); }
      this.states.set(key, state);
    }
    const state = this.states.get(key), items = state.items.filter(item => !item.sources.some(id => this.isSourceDeleted(key, id)));
    if (items.length !== state.items.length) this.save(key, { ...state, revision: state.revision + 1, items });
    return this.states.get(key);
  }
  save(key, next) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(key), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next) + '\n', { mode: 0o600 }); fs.renameSync(temp, file);
    this.states.set(key, next);
  }
  view(item) { return { ...structuredClone(item), overdue: !terminal(item) && item.dueAt != null && this.now() >= item.dueAt, reminderScheduled: false }; }
  list(key, { query = '', status = '', offset = 0, limit = 20 } = {}) {
    string(query, 256);
    if (status && !statuses.includes(status)) fail('任务状态无效');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('分页无效');
    const state = this.get(key), q = query.toLowerCase();
    const items = state.items.filter(item => (!status || item.status === status) && (!q || `${item.text}\n${item.waitingFor}`.toLowerCase().includes(q)));
    return { revision: state.revision, total: items.length, items: items.slice(offset, offset + limit).map(item => this.view(item)), nextOffset: offset + limit < items.length ? offset + limit : null };
  }
  select(key, messages, { limit = 3, maxChars = 2400 } = {}) {
    const users = new Set(messages.filter(m => !m.isSelf).map(m => String(m.userId || '')));
    if (key.startsWith('private:')) users.add(key.slice(8));
    const text = messages.map(m => m.plain ?? m.text ?? '').join('\n').toLowerCase();
    const tokens = value => value.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2}/gu) || [];
    const candidates = this.get(key).items.filter(item => !terminal(item) && users.has(item.ownerId)).map(item => {
      const hits = tokens(item.text + item.waitingFor).filter(word => text.includes(word)).length;
      return { ...this.view(item), relevance: hits ? 'text-and-owner' : 'same-owner-review', rank: hits * 10 + (item.status === 'waiting' ? 1 : 0) };
    }).sort((a,b) => b.rank - a.rank || b.modifiedAt - a.modifiedAt);
    const selected = [];
    for (const { rank, ...item } of candidates) {
      if (selected.length >= limit) break;
      if (JSON.stringify([...selected, item]).length <= maxChars) selected.push(item);
    }
    return { revision: this.get(key).revision, items: selected, note: '同主体仅供核对，不证明本条在继续任务；无新证据不推进，不自动催问或发言。' };
  }
  update(key, input, { evidence = [], admin = false } = {}) {
    if (!input || Object.keys(input).some(k => !['revision','id','text','ownerId','kind','status','waitingFor','dueAt','sources','remove'].includes(k))) fail('任务参数含未知字段');
    const state = this.get(key);
    if (input.revision !== state.revision) fail('任务版本已变化，请重新读取', 409);
    const next = structuredClone(state), old = input.id ? next.items.find(item => item.id === input.id) : null;
    if (input.id && !old) fail('任务不存在', 404);
    if (input.remove !== undefined && (input.remove !== true || !admin || !old)) fail('仅管理员可以删除已有任务', 403);
    if (!admin && (!evidence.length || evidence.some(m => !input.sources?.includes(m.id)))) fail('任务需要当前会话已展示的消息依据', 403);
    const ownerId = old?.ownerId ?? input.ownerId;
    if (!/^[1-9]\d{0,15}$/.test(ownerId ?? '') || (input.ownerId !== undefined && input.ownerId !== ownerId)) fail('任务负责人无效或不可改变');
    if (!admin && !evidence.some(m => !m.isSelf && m.userId === ownerId)) fail('任务变更需要负责人的实际来信依据', 403);
    if (input.remove) next.items = next.items.filter(item => item.id !== old.id);
    else {
      if (old && terminal(old)) {
        if (Object.entries(input).every(([k,v]) => ['revision','id','sources'].includes(k) || old[k] === v)
            && (!input.sources || input.sources.every(id => old.sources.includes(id)))) return { revision: state.revision, item: this.view(old), unchanged: true };
        fail('已结束任务不可重新开启；请根据新要求创建事项', 409);
      }
      const item = { ...old, ownerId, text: string(input.text ?? old?.text, 500, true),
        kind: input.kind ?? old?.kind, status: input.status ?? old?.status ?? 'waiting',
        waitingFor: string(input.waitingFor ?? old?.waitingFor ?? '', 300), dueAt: input.dueAt === undefined ? old?.dueAt ?? null : input.dueAt };
      if (!kinds.includes(item.kind) || !statuses.includes(item.status)) fail('任务类型或状态无效；当前不支持定时提醒');
      if (item.dueAt != null && (!Number.isSafeInteger(item.dueAt) || item.dueAt <= 0)) fail('截止时间须为毫秒时间戳或null');
      if (!old && terminal(item)) fail('请先建立未完事项');
      if (old && terminal(item) && !admin && !evidence.some(m => !m.isSelf && m.userId === ownerId && !old.sources.includes(m.id))) fail('结束任务需要负责人的新消息依据');
      if (old && item.kind !== old.kind) fail('不能改变任务类型');
      const sources = admin ? old?.sources ?? [] : [...new Set([...(old?.sources || []), ...input.sources])];
      if (sources.length > 40) fail('任务来源已达上限，请由管理员整理', 409);
      const identity = JSON.stringify([key,ownerId,item.kind,input.sources,item.text]);
      item.id = old?.id ?? 'task-' + (admin ? crypto.randomBytes(12).toString('hex') : crypto.createHash('sha256').update(identity).digest('hex').slice(0,24));
      if (!old && next.items.some(t => t.id === item.id)) return { revision: state.revision, item: this.view(next.items.find(t => t.id === item.id)), unchanged: true };
      if (!old && (next.items.length >= 200 || next.items.filter(t => !terminal(t)).length >= 100)) fail('任务容量已满，请管理已有事项', 409);
      item.sources = sources; item.createdAt = old?.createdAt ?? this.now(); item.modifiedAt = this.now();
      item.completionEvidence = item.status === 'completed' ? (admin ? 'admin-reported' : 'owner-reported') : null;
      item.updatedBy = admin ? 'console' : 'owner-message';
      if (old && JSON.stringify({ ...item, modifiedAt: old.modifiedAt, updatedBy: old.updatedBy }) === JSON.stringify(old)) return { revision: state.revision, item: this.view(old), unchanged: true };
      next.items = [...next.items.filter(t => t.id !== item.id), item];
    }
    next.revision++; this.save(key, next);
    return { revision: next.revision, item: input.remove ? null : this.view(next.items.at(-1)) };
  }
  discard(key, ids) {
    const state = this.get(key), next = { ...state, items: state.items.filter(item => !item.sources.some(id => ids.includes(id))) };
    if (next.items.length !== state.items.length) { next.revision++; this.save(key, next); }
  }
}
