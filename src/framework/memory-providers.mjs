import crypto from 'node:crypto';
import { frameworkError } from './content.mjs';
import { ExtensionPermissions, permissionDigest } from './permissions.mjs';
import { RegisteredServiceTransport, normalizeServiceTransport } from './service-transport.mjs';

export const MEMORY_PROTOCOL = 'qq-bridge.memory/v1';
export const MEMORY_OPERATIONS = Object.freeze(['query', 'write', 'update', 'delete', 'clear', 'ingest']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw frameworkError('记忆参数含未知字段或不是对象');
  return value;
}
function text(value, max = 256, fallback = '') {
  value ??= fallback;
  if (typeof value !== 'string' || value.length > max) throw frameworkError('记忆文本字段类型或长度无效');
  return value;
}
function integer(value, fallback, min, max) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw frameworkError('记忆数值字段超出范围');
  return value;
}
function identifier(value) { if (!idPattern.test(value ?? '')) throw frameworkError('记忆条目 id 无效'); return value; }
function metadata(value = {}, depth = 0) {
  if (depth > 4) throw frameworkError('记忆元数据嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return text(value, 2000);
  if (Array.isArray(value)) { if (value.length > 20) throw frameworkError('记忆元数据数组过长'); return value.map(item => metadata(item, depth + 1)); }
  if (value && typeof value === 'object' && Object.keys(value).length <= 20) {
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 64) throw frameworkError('记忆元数据键无效');
      result[key] = metadata(item, depth + 1);
    }
    if (JSON.stringify(result).length > 4000) throw frameworkError('记忆元数据过大');
    return result;
  }
  throw frameworkError('记忆元数据仅支持有界 JSON');
}
function selector(input) {
  object(input, ['id', 'category', 'text', 'subject']);
  const result = {};
  if (input.id !== undefined) result.id = identifier(input.id);
  for (const field of ['category', 'text', 'subject']) if (input[field] !== undefined) result[field] = text(input[field], field === 'text' ? 2000 : 128);
  if (!Object.values(result).some(Boolean)) throw frameworkError('修改/删除记忆必须指定非空 selector；清空请用 clear');
  return result;
}
export function normalizeMemoryInput(operation, input = {}) {
  if (operation === 'query') {
    object(input, ['query', 'member', 'category', 'limit', 'offset', 'cursor', 'maxChars', 'options']);
    return { query: text(input.query), member: text(input.member, 128), category: text(input.category, 128),
      limit: integer(input.limit, 5, 1, 20), offset: integer(input.offset, 0, 0, 100000), cursor: text(input.cursor, 256),
      maxChars: integer(input.maxChars, 3000, 500, 12000), options: metadata(input.options) };
  }
  if (operation === 'write') {
    object(input, ['id', 'text', 'category', 'subject', 'metadata', 'expiresAt']);
    const content = text(input.text, 2000);
    if (!content.trim()) throw frameworkError('记忆 text 不能为空');
    return { ...(input.id === undefined ? {} : { id: identifier(input.id) }), text: content,
      category: text(input.category, 128), subject: text(input.subject, 128), metadata: metadata(input.metadata),
      ...(input.expiresAt === undefined ? {} : { expiresAt: integer(input.expiresAt, 0, 0, Number.MAX_SAFE_INTEGER) }) };
  }
  if (operation === 'update') {
    object(input, ['selector', 'patch']); object(input.patch, ['text', 'category', 'subject', 'metadata', 'expiresAt']);
    const patch = {};
    for (const field of ['text', 'category', 'subject']) if (input.patch[field] !== undefined) patch[field] = text(input.patch[field], field === 'text' ? 2000 : 128);
    if (input.patch.metadata !== undefined) patch.metadata = metadata(input.patch.metadata);
    if (input.patch.expiresAt !== undefined) patch.expiresAt = integer(input.patch.expiresAt, 0, 0, Number.MAX_SAFE_INTEGER);
    if (!Object.keys(patch).length) throw frameworkError('记忆更新 patch 不能为空');
    return { selector: selector(input.selector), patch };
  }
  if (operation === 'delete') { object(input, ['selector']); return { selector: selector(input.selector) }; }
  if (operation === 'clear') { object(input, ['category']); return { category: text(input.category, 128) }; }
  if (operation === 'ingest') {
    object(input, ['messageSeqs']);
    if (!Array.isArray(input.messageSeqs) || !input.messageSeqs.length || input.messageSeqs.length > 10
        || input.messageSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 1) || new Set(input.messageSeqs).size !== input.messageSeqs.length) throw frameworkError('ingest 需要 1~10 个不同的当前会话消息 seq');
    return { messageSeqs: input.messageSeqs.slice().sort((a, b) => a - b) };
  }
  throw frameworkError('不支持的记忆操作');
}
export function normalizeMemoryProviders(config = []) {
  if (!Array.isArray(config) || config.length > 8) throw frameworkError('memory.providers 至多 8 个提供者');
  const seen = new Set();
  return config.filter(provider => provider?.enabled !== false).map(provider => {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(provider.id ?? '') || seen.has(provider.id)) throw frameworkError('记忆提供者 id 无效或重复');
    seen.add(provider.id);
    if (!Array.isArray(provider.operations) || !provider.operations.length || provider.operations.some(op => !MEMORY_OPERATIONS.includes(op)) || new Set(provider.operations).size !== provider.operations.length) throw frameworkError('记忆提供者 operations 无效');
    const transport = normalizeServiceTransport(provider.transport);
    const approvalMode = provider.approvalMode ?? 'required';
    if (!['required', 'automatic'].includes(approvalMode)) throw frameworkError('memory approvalMode 必须为 required 或 automatic');
    if (approvalMode === 'automatic' && transport.type === 'http' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(transport.url).hostname)) throw frameworkError('自动记忆授权仅支持本机提供者');
    if (transport.type === 'stdio' && provider.operations.some(op => typeof (provider.tools?.[op] ?? provider.tool) !== 'string' || !(provider.tools?.[op] ?? provider.tool))) throw frameworkError('记忆 MCP 必须为每个操作配置固定 tool 或 tools 映射');
    return { ...provider, transport, approvalMode, description: text(provider.description, 240), version: text(provider.version, 64, '1'),
      timeoutMs: integer(provider.timeoutMs, 30000, 100, 180000) };
  });
}
export function memoryDataScopes(operation) { return [operation === 'ingest' ? 'history-export' : `memory-${operation === 'query' ? 'query' : 'write'}`]; }
function publicManifest(provider, operation) {
  return { effect: operation === 'query' ? 'read' : 'write', description: `${provider.description || provider.id} · memory ${operation}`,
    ...(provider.approvalMode === 'automatic' ? { memoryApproval: 'automatic' } : {}),
    destination: provider.transport.type === 'http' ? provider.transport.url : '本机记忆 MCP（系统权限由宿主管理）',
    entrypoint: provider.transport.type === 'http' ? 'HTTP POST' : `${provider.transport.command} ${provider.transport.args.join(' ')} :: ${provider.tools?.[operation] ?? provider.tool}`,
    configHash: permissionDigest({ provider, operation }) };
}
function normalizeResponse(raw, request, providerId) {
  if (raw?.isError) throw frameworkError('记忆提供者处理失败', 502);
  if (raw?.structuredContent) raw = raw.structuredContent;
  else if (raw?.content) {
    if (!Array.isArray(raw.content) || raw.content.length !== 1 || raw.content[0]?.type !== 'text') throw frameworkError('记忆 MCP 只接受一个 JSON 文本结果或 structuredContent', 502);
    try { raw = JSON.parse(raw.content[0].text); } catch { throw frameworkError('记忆提供者结果不是协议 JSON', 502); }
  }
  if (raw?.protocol !== MEMORY_PROTOCOL || raw.namespace !== request.namespace || raw.requestId !== request.requestId || raw.operation !== request.operation) throw frameworkError('记忆响应协议、命名空间或请求标识不匹配', 502);
  if (request.operation !== 'query') {
    if (!Array.isArray(raw.affectedIds) || raw.affectedIds.length > 100 || raw.affectedIds.some(id => !idPattern.test(id))) throw frameworkError('记忆变更结果需要有界 affectedIds', 502);
    return { providerId, operation: request.operation, affectedIds: raw.affectedIds,
      affectedCount: integer(raw.affectedCount, raw.affectedIds.length, raw.affectedIds.length, Number.MAX_SAFE_INTEGER), untrusted: true };
  }
  if (!Array.isArray(raw.items) || raw.items.length > request.input.limit) throw frameworkError('记忆查询 items 超出请求范围', 502);
  const items = raw.items.map(item => {
    object(item, ['id', 'text', 'category', 'subject', 'metadata', 'score', 'expiresAt', 'updatedAt']);
    return { id: identifier(item.id), text: text(item.text, 8000), category: text(item.category, 128), subject: text(item.subject, 128),
      ...(item.metadata === undefined ? {} : { metadata: metadata(item.metadata) }),
      ...(item.expiresAt === undefined ? {} : { expiresAt: integer(item.expiresAt, 0, 0, Number.MAX_SAFE_INTEGER) }) };
  }).filter(item => !item.expiresAt || item.expiresAt > Date.now());
  const result = { providerId, operation: 'query', items: [], nextCursor: raw.nextCursor == null ? null : text(raw.nextCursor, 256), truncated: false, untrusted: true };
  for (const item of items) {
    result.items.push(item);
    if (JSON.stringify(result).length <= request.input.maxChars) continue;
    result.items.pop(); result.truncated = true; result.nextCursor = null;
    if (!result.items.length) {
      const excerpt = { id: item.id, text: item.text, truncated: true };
      result.items.push(excerpt);
      while (JSON.stringify(result).length > request.input.maxChars) excerpt.text = Array.from(excerpt.text).slice(0, Math.floor(Array.from(excerpt.text).length / 2)).join('');
    }
    break;
  }
  return result;
}

export class MemoryProviderRuntime {
  constructor({ providers = [], defaultProvider = null, namespaceSalt = '', permissions = new ExtensionPermissions(), getMessages = () => [], fetchImpl = globalThis.fetch } = {}) {
    this.providers = normalizeMemoryProviders(providers); this.defaultProvider = defaultProvider;
    if (defaultProvider !== null && !this.providers.some(provider => provider.id === defaultProvider)) throw frameworkError('memory.provider 必须指向已注册提供者，或为 null');
    if (this.providers.length && !/^[a-f0-9]{64}$/.test(namespaceSalt)) throw frameworkError('记忆命名空间密钥无效');
    this.namespaceSalt = namespaceSalt; this.permissions = permissions; this.getMessages = getMessages;
    this.transport = new RegisteredServiceTransport({ fetchImpl }); this.inflight = new Map();
  }
  namespace(providerId, key) { return crypto.createHmac('sha256', this.namespaceSalt).update(`${providerId}\0${key}`).digest('hex'); }
  capabilities() { return this.providers.flatMap(provider => provider.operations.map(operation => ({ id: `memory.${provider.id}.${operation}`, effect: operation === 'query' ? 'read' : 'write', description: `${provider.description || provider.id} · ${operation}` }))); }
  list(key) {
    return this.providers.map(provider => ({ id: provider.id, description: provider.description, version: provider.version, approvalMode: provider.approvalMode,
      operations: provider.operations.map(operation => ({ operation, capability: `memory.${provider.id}.${operation}`,
        permission: this.permissions.inspect({ key, capability: `memory.${provider.id}.${operation}`, manifest: publicManifest(provider, operation), dataScopes: memoryDataScopes(operation) }).decision }))
        .filter(item => item.permission !== 'deny') })).filter(provider => provider.operations.length);
  }
  payload(key, operation, input) {
    if (operation !== 'ingest') return input;
    const records = this.getMessages(key, input.messageSeqs);
    return { messages: input.messageSeqs.map(seq => {
      const record = records.find(item => item.seq === seq);
      if (!record) throw frameworkError('所选消息不在当前会话近期记录中', 404);
      return { seq, messageId: record.messageId == null ? null : String(record.messageId).slice(0, 128),
        sender: String(record.sender ?? '').slice(0, 100), userId: record.userId == null ? null : String(record.userId).slice(0, 32),
        text: String(record.plain ?? record.text ?? '').slice(0, 1000), time: Number(record.time) || 0 };
    }) };
  }
  async call({ key, scope, providerId = this.defaultProvider, operation, input = {}, approvalId, assertLive = () => {} }) {
    if (!providerId) throw frameworkError('记忆功能未配置提供者；旧内置模块已停用', 503);
    const provider = this.providers.find(item => item.id === providerId);
    if (!provider || !provider.operations.includes(operation)) throw frameworkError('记忆提供者或操作不可用', 404);
    const normalized = normalizeMemoryInput(operation, input);
    const payload = this.payload(key, operation, normalized);
    const payloadHash = permissionDigest(payload);
    const manifest = publicManifest(provider, operation);
    const check = () => {
      assertLive();
      if (permissionDigest(this.payload(key, operation, normalized)) !== payloadHash) throw frameworkError('待处理聊天记录已变化', 403);
    };
    const request = { protocol: MEMORY_PROTOCOL, operation, namespace: this.namespace(provider.id, key), input: payload,
      requestId: permissionDigest({ key, scope, operation, payload, provider: manifest.configHash, revision: this.permissions.revision }) };
    const permit = this.permissions.authorize({ key, scope, capability: `memory.${provider.id}.${operation}`, manifest,
      input: request, dataScopes: memoryDataScopes(operation), approvalId, assertLive: check,
      currentManifest: () => { const current = this.providers.find(item => item.id === provider.id); return current ? publicManifest(current, operation) : {}; } });
    if (permit.pending) return permit.pending;
    if (this.inflight.size >= 4 || this.inflight.has(request.requestId)) { permit.finish('busy'); throw frameworkError('记忆服务正忙，请勿重复执行', 429); }
    let expired = false; let timer;
    const live = () => { if (expired) throw frameworkError('记忆服务调用已超时', 504); permit.check(); };
    const descriptor = { id: `memory.${provider.id}`, transport: provider.transport, timeoutMs: provider.timeoutMs, tool: provider.tools?.[operation] ?? provider.tool };
    const pending = Promise.race([this.transport.call(descriptor, request, { assertLive: live, maxBytes: 128 * 1024 }),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(frameworkError('记忆服务超时', 504)); }, provider.timeoutMs); })]);
    this.inflight.set(request.requestId, pending);
    try {
      const raw = await pending; live();
      let result;
      try { result = normalizeResponse(raw, request, provider.id); }
      catch (error) { if (error?.statusCode === 400) throw frameworkError('记忆提供者返回不符合协议的数据', 502); throw error; }
      live(); permit.finish('completed');
      return result;
    } catch (error) {
      permit.finish(error?.statusCode === 403 ? 'revoked' : 'failed');
      if (error?.statusCode) throw error;
      if (error?.name === 'TimeoutError' || error?.code === -32001) throw frameworkError('记忆服务超时', 504);
      throw frameworkError('记忆提供者调用失败，请检查插件配置和日志', 502);
    } finally { clearTimeout(timer); this.inflight.delete(request.requestId); }
  }
  async close() { await this.transport.close(); }
}
