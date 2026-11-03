// Per-install overrides; bundled upstream dictionaries remain intact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bundledSlangReferences, lookupSlangReference } from '../slang-reference.mjs';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const norm = value => value.normalize('NFKC').toLowerCase().trim();
const fields = ['term', 'aliases', 'meaning', 'usage', 'source', 'kind', 'known', 'enabled'];
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) fail('梗库词条含无效字段');
  const result = {};
  for (const [key, max] of [['term', 100], ['meaning', 300], ['usage', 300], ['source', 300]]) {
    if (typeof input[key] !== 'string' || input[key].length > max) fail(`${key}必须为最多${max}字符的文本`);
    result[key] = input[key].trim();
  }
  if (!result.term) fail('梗词不能为空');
  if (!['word', 'construction'].includes(input.kind)) fail('梗库类型无效');
  if (typeof input.known !== 'boolean' || typeof input.enabled !== 'boolean') fail('考据与启用状态必须为布尔值');
  if (input.known && !result.meaning) fail('已考据词条必须填写释义');
  if (!Array.isArray(input.aliases) || input.aliases.length > 20 || input.aliases.some(a => typeof a !== 'string' || !a.trim() || a.length > 100)) fail('别名最多20条，每条1–100字符');
  return { ...result, aliases: [...new Set(input.aliases.map(a => a.trim()))], kind: input.kind, known: input.known, enabled: input.enabled };
}

export class SlangReferenceStore {
  constructor(file) {
    this.file = file; this.base = new Map(bundledSlangReferences().map(e => [e.id, e])); this.state = null;
  }
  load() {
    if (this.state) return this.state;
    if (!fs.existsSync(this.file)) return this.state = { version: 1, revision: 0, entries: [] };
    try {
      if (fs.statSync(this.file).size > 4 * 1024 * 1024) throw Error();
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.entries) || state.entries.length > 3000) throw Error();
      const ids = new Set();
      for (const { id, ...entry } of state.entries) {
        // Retain edits even when a later upstream bundle removes the base ID.
        if (typeof id !== 'string' || !/^(?:(?:word|construction):[a-zA-Z0-9_-]{1,100}|custom:[a-f0-9-]{36})$/.test(id) || ids.has(id)) throw Error();
        validate(entry); ids.add(id);
      }
      this.state = state; return state;
    } catch { fail('梗库本地修改文件无法读取，原文件已保留；请恢复备份后重启桥接', 503); }
  }
  all() {
    const overrides = new Map(this.load().entries.map(e => [e.id, e]));
    return [...this.base.values(), ...this.load().entries.filter(e => !this.base.has(e.id))].map(base => ({
      ...base, enabled: true, ...overrides.get(base.id), builtin: this.base.has(base.id),
      customized: overrides.has(base.id), originalSource: this.base.get(base.id)?.source || '',
    }));
  }
  entries() { return this.all().filter(e => e.enabled); }
  lookup(query, limit = 20) { return lookupSlangReference(query, limit, this.entries()); }
  list({ query = '', kind = '', state = '', offset = 0, limit = 50 } = {}) {
    if (typeof query !== 'string' || query.length > 256 || !['', 'word', 'construction'].includes(kind)
      || !['', 'enabled', 'disabled', 'customized'].includes(state) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('梗库查询参数无效');
    const q = norm(query);
    const all = this.all().filter(e => (!kind || e.kind === kind) && (!state || (state === 'customized' ? e.customized : e.enabled === (state === 'enabled')))
      && (!q || norm([e.term, ...e.aliases, e.meaning, e.usage, e.source].join('\n')).includes(q)));
    return { revision: this.load().revision, total: all.length, entries: all.slice(offset, offset + limit), offset, limit,
      nextOffset: offset + limit < all.length ? offset + limit : null };
  }
  commit(entries, revision) {
    const current = this.load();
    if (revision !== current.revision) fail('梗库已被修改，请刷新列表后重新编辑', 409);
    if (entries.length > 3000) fail('本地梗库修改最多3000条');
    const next = { version: 1, revision: current.revision + 1, entries };
    const serialized = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) fail('本地梗库修改文件不能超过4MiB');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, serialized, { mode: 0o600 });
      fs.renameSync(temp, this.file); this.state = next;
    } catch {
      try { fs.unlinkSync(temp); } catch {}
      fail('梗库保存失败，未应用本次修改', 503);
    }
  }
  save({ id = '', entry, revision } = {}) {
    const value = validate(entry), current = this.load();
    const previous = id ? this.all().find(e => e.id === id) : null;
    if (id && !previous) fail('梗库词条不存在', 404);
    if (previous?.builtin && previous.kind !== value.kind) fail('内置词条不能更改类型');
    if (this.all().some(e => e.id !== id && norm(e.term) === norm(value.term))) fail('梗库中已存在同名词条');
    const target = id || `custom:${crypto.randomUUID()}`;
    this.commit([...current.entries.filter(e => e.id !== target), { id: target, ...value }], revision);
    return this.all().find(e => e.id === target);
  }
  reset({ id, revision } = {}) {
    const current = this.load();
    if (!this.base.has(id)) fail('只有内置词条可以恢复原版');
    this.commit(current.entries.filter(e => e.id !== id), revision);
  }
  remove({ id, revision } = {}) {
    const current = this.load();
    if (this.base.has(id)) fail('内置词条请使用停用或恢复原版');
    if (!current.entries.some(e => e.id === id)) fail('自建词条不存在', 404);
    this.commit(current.entries.filter(e => e.id !== id), revision);
  }
}
