// Provider adapter around the exact storage/search primitives used by haitang1's
// standalone MCP. No DSH host hooks, automatic history collection or LLM calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MEMORY_PROTOCOL, normalizeMemoryInput } from '../src/framework/memory-providers.mjs';

const RECORD = 'qq-bridge.haitang-entry/v1';
const repo = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_SOURCE = path.resolve(repo, '../external-memory/haitang-dsh-memory');

export class HaitangMemoryProvider {
  constructor({ source = DEFAULT_SOURCE, directory } = {}) {
    if (!directory) throw new Error('必须指定独立记忆目录');
    this.directory = path.resolve(directory); this.source = path.resolve(source);
    this.stores = new Map(); this.closed = false;
    this.module = import(pathToFileURL(path.join(this.source, 'lib/store.js')).href);
  }
  async store(namespace) {
    if (this.closed || !/^[a-f0-9]{64}$/.test(namespace ?? '')) throw new Error('命名空间无效或服务已关闭');
    if (this.stores.has(namespace)) return this.stores.get(namespace);
    if (this.stores.size >= 64) throw new Error('本机记忆打开的命名空间过多');
    const pending = (async () => {
      const upstream = await this.module;
      await fs.mkdir(this.directory, { recursive: true });
      const dir = path.join(this.directory, namespace);
      await fs.mkdir(dir, { recursive: true });
      if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error('命名空间目录不能是符号链接');
      const lockFile = path.join(dir, upstream.LOCK_FILE);
      // Never steal a live lock merely because 60 seconds elapsed. A dead local
      // process can be recovered after an abrupt Windows stdio termination.
      let lockText;
      try { lockText = await fs.readFile(lockFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (lockText) {
        const holder = JSON.parse(lockText);
        if (holder.host === os.hostname() && Number.isSafeInteger(holder.pid) && holder.pid > 0) {
          let dead = false;
          try { process.kill(holder.pid, 0); } catch (e) { if (e.code === 'ESRCH') dead = true; }
          if (dead && await fs.readFile(lockFile, 'utf8') === lockText) await fs.unlink(lockFile);
        }
      }
      const store = new upstream.MemoryStore(dir);
      const lease = await store.acquireLock({ staleMs: Infinity });
      if (!lease.owner) throw new Error('记忆目录已由其他进程占用');
      return { store, upstream, release: lease.release };
    })();
    this.stores.set(namespace, pending);
    try { return await pending; }
    catch (e) { this.stores.delete(namespace); throw e; }
  }
  async handle(request) {
    if (!request || request.protocol !== MEMORY_PROTOCOL || !/^[a-f0-9]{64}$/.test(request.requestId ?? '')
        || Object.keys(request).some(k => !['protocol', 'namespace', 'requestId', 'operation', 'input'].includes(k))) throw new Error('无效的记忆协议请求');
    const { operation, namespace, requestId } = request;
    const input = operation === 'ingest' ? this.ingestInput(request.input) : normalizeMemoryInput(operation, request.input);
    const entry = await this.store(namespace);
    return entry.store.withLock(async () => {
      const { store, upstream } = entry;
      const text = await store.readText(upstream.RAW_FILE);
      const raw = await store.readRawEntries();
      if (text && (!text.startsWith('# Raw memories\n') || Number(/^Entries: (\d+)$/m.exec(text)?.[1]) !== raw.length)) throw new Error('记忆数据损坏，拒绝覆盖');
      const records = raw.map(row => {
        const item = JSON.parse(row.content);
        if (item.protocol !== RECORD || item.id !== row.id || typeof item.text !== 'string') throw new Error('记忆记录不符合适配器格式');
        const { protocol, ...record } = item;
        normalizeMemoryInput('write', record);
        return record;
      });
      const timestamps = new Map(raw.map(row => [row.id, row.ts]));
      const envelope = { protocol: MEMORY_PROTOCOL, namespace, requestId, operation };
      if (operation === 'query') {
        let candidates = records.filter(item => (!input.category || item.category === input.category)
          && (!input.member || item.subject === input.member) && (!item.expiresAt || item.expiresAt > Date.now()));
        if (input.query.trim()) {
          // BM25/CJK fuzzy ranking is upstream code, not a bridge-side algorithm.
          const lookup = new Map(candidates.map(item => [item.id, item]));
          candidates = upstream.searchEntries(candidates.map(item => ({ id: item.id, ts: timestamps.get(item.id), content: item.text, tags: [], importance: 1 })), input.query,
            { mode: 'any', fuzzy: true, limit: 50 }).map(hit => lookup.get(hit.entry.id));
        }
        if (input.cursor && !/^\d{1,6}$/.test(input.cursor)) throw new Error('无效的分页游标');
        const offset = input.cursor ? Number(input.cursor) : input.offset;
        return { ...envelope, items: candidates.slice(offset, offset + input.limit), nextCursor: offset + input.limit < candidates.length ? String(offset + input.limit) : null };
      }
      let next = records.slice(); const affectedIds = [];
      const put = item => {
        normalizeMemoryInput('write', item);
        // JSON-in-Markdown prevents a remembered "###" line from becoming a
        // forged second raw entry when the upstream Markdown parser reads it.
        if (upstream.detectSecrets(JSON.stringify(item)).length) throw new Error('内容疑似包含凭据，拒绝存入记忆');
        next = next.filter(old => old.id !== item.id); next.push(item); affectedIds.push(item.id);
      };
      if (operation === 'write') {
        const duplicate = input.id ? null : records.find(item => item.category === input.category && item.subject === input.subject
          && upstream.contentFingerprint(item.text) === upstream.contentFingerprint(input.text));
        put({ ...input, id: input.id ?? duplicate?.id ?? `m-${requestId.slice(0, 24)}` });
      }
      else if (operation === 'ingest') {
        for (const message of input.messages) put({ id: `msg-${crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 24)}`,
          text: message.text, category: 'message', subject: message.userId ?? '', metadata: { messageId: message.messageId, sender: message.sender, seq: message.seq } });
      } else if (operation === 'update') {
        for (const item of records.filter(item => this.matches(item, input.selector))) put({ ...item, ...input.patch });
      } else if (operation === 'delete' || operation === 'clear') {
        next = next.filter(item => {
          const match = operation === 'clear' ? !input.category || item.category === input.category : this.matches(item, input.selector);
          if (match) affectedIds.push(item.id);
          return !match;
        });
      } else throw new Error('未知记忆操作');
      if (next.length > 10000 || Buffer.byteLength(JSON.stringify(next)) > 16 * 1024 * 1024) throw new Error('当前会话记忆存储容量已满');
      // A single upstream atomic replace commits the complete batch or none.
      const changed = new Set(affectedIds);
      await store.writeAtomic(upstream.RAW_FILE, upstream.serializeRaw(next.map(item => ({ id: item.id, ts: changed.has(item.id) ? upstream.nowStamp() : timestamps.get(item.id),
        content: JSON.stringify({ protocol: RECORD, ...item }), tags: [], importance: 1 }))));
      store.rawCache = null;
      return { ...envelope, affectedIds: affectedIds.slice(0, 100), affectedCount: affectedIds.length };
    });
  }
  matches(item, selector) {
    return Object.entries(selector).every(([key, value]) => !value || (key === 'text' ? item.text.includes(value) : item[key] === value));
  }
  ingestInput(input) {
    if (!input || Object.keys(input).some(k => k !== 'messages') || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 10) throw new Error('仅允许导入 1–10 条选定消息');
    for (const message of input.messages) {
      if (!Number.isSafeInteger(message.seq) || message.seq < 1 || typeof message.text !== 'string' || message.text.length > 1000
          || typeof message.sender !== 'string' || message.sender.length > 100
          || message.userId !== null && (typeof message.userId !== 'string' || message.userId.length > 32)
          || message.messageId !== null && (typeof message.messageId !== 'string' || message.messageId.length > 128)) throw new Error('导入消息格式无效');
    }
    return input;
  }
  async close() {
    this.closed = true;
    for (const pending of this.stores.values()) { try { const entry = await pending; await entry.store.withLock(entry.release); } catch {} }
    this.stores.clear();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const provider = new HaitangMemoryProvider({ source: arg('upstream') || DEFAULT_SOURCE, directory: arg('data') });
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'qq-haitang-memory', version: '1.0.0' });
  server.tool('memory', 'Namespaced haitang memory provider', { protocol: z.literal(MEMORY_PROTOCOL), operation: z.string(), namespace: z.string(), requestId: z.string(), input: z.record(z.string(), z.unknown()) }, async request => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await provider.handle(request)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  await server.connect(new StdioServerTransport());
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await provider.close(); await server.close(); };
  process.stdin.on('end', close);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await close(); process.exit(0); });
}
