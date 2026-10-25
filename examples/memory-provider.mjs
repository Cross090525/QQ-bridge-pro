// Minimal independent memory backend. Keyword retrieval only; replace this
// store with a vector DB, summarizer or another memory system behind the protocol.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MEMORY_PROTOCOL, normalizeMemoryInput } from '../src/framework/memory-providers.mjs';

export class ExampleMemoryStore {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath; this.namespaces = Object.create(null); this.receipts = new Map();
    if (filePath && fs.existsSync(filePath)) {
      if (fs.statSync(filePath).size > 16 * 1024 * 1024) throw new Error('Example memory file too large');
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw.version !== 1 || !raw.namespaces || Object.entries(raw.namespaces).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key) || !Array.isArray(value) || value.length > 500)) throw new Error('Invalid example memory file; refusing to overwrite');
      this.namespaces = Object.assign(Object.create(null), raw.namespaces);
    }
  }
  save(namespace, entries) {
    const next = Object.assign(Object.create(null), this.namespaces, { [namespace]: entries });
    if (Object.keys(next).length > 128 || entries.length > 500) throw new Error('Example memory quota exceeded');
    const data = JSON.stringify({ version: 1, namespaces: next });
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error('Example memory quota exceeded');
    if (this.filePath) {
      fs.mkdirSync(path.dirname(path.resolve(this.filePath)), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try { fs.writeFileSync(temp, data, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, this.filePath); }
      finally { try { fs.unlinkSync(temp); } catch {} }
    }
    this.namespaces = next;
  }
  handle(request) {
    if (!request || request.protocol !== MEMORY_PROTOCOL || !/^[a-f0-9]{64}$/.test(request.namespace ?? '') || !/^[a-f0-9]{64}$/.test(request.requestId ?? '')) throw new Error('Invalid memory envelope');
    const { operation, namespace, requestId } = request;
    const envelope = { protocol: MEMORY_PROTOCOL, operation, namespace, requestId };
    const existing = this.namespaces[namespace] ?? [];
    const matches = (item, selector) => Object.entries(selector).every(([key, value]) => !value || item[key] === value);
    if (operation === 'query') {
      const input = normalizeMemoryInput('query', request.input);
      let items = existing.filter(item => (!item.expiresAt || item.expiresAt > Date.now())
        && (!input.category || item.category === input.category)
        && (!input.member || item.subject === input.member || item.metadata?.participants?.includes(input.member)));
      const terms = input.query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length) items = items.filter(item => terms.some(term => JSON.stringify(item).normalize('NFKC').toLowerCase().includes(term)));
      items = items.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      if (input.cursor && !/^\d{1,6}$/.test(input.cursor)) throw new Error('Invalid example cursor');
      const offset = input.cursor ? Number(input.cursor) : input.offset;
      return { ...envelope, items: items.slice(offset, offset + input.limit), nextCursor: offset + input.limit < items.length ? String(offset + input.limit) : null };
    }
    const receiptKey = `${namespace}:${requestId}`;
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.receipts.get(receiptKey);
    if (previous) { if (previous.hash !== requestHash) throw new Error('Request ID reused with changed content'); return previous.result; }
    let next = existing.slice(); const affectedIds = [];
    if (operation === 'write') {
      const input = normalizeMemoryInput('write', request.input);
      const id = input.id ?? crypto.randomBytes(12).toString('hex');
      next = next.filter(item => item.id !== id); next.push({ ...input, id, updatedAt: Date.now() }); affectedIds.push(id);
    } else if (operation === 'update') {
      const input = normalizeMemoryInput('update', request.input);
      next = next.map(item => { if (!matches(item, input.selector)) return item; affectedIds.push(item.id); return { ...item, ...input.patch, updatedAt: Date.now() }; });
    } else if (operation === 'delete' || operation === 'clear') {
      const input = normalizeMemoryInput(operation, request.input);
      const selector = operation === 'clear' ? { category: input.category } : input.selector;
      next = next.filter(item => { if (!matches(item, selector)) return true; affectedIds.push(item.id); return false; });
    } else if (operation === 'ingest') {
      const messages = request.input?.messages;
      if (!Array.isArray(messages) || !messages.length || messages.length > 10) throw new Error('Invalid selected messages');
      for (const message of messages) {
        if (!Number.isSafeInteger(message.seq) || typeof message.text !== 'string' || message.text.length > 1000) throw new Error('Invalid selected message');
        const id = `message:${message.seq}:${crypto.createHash('sha256').update(message.text).digest('hex').slice(0, 12)}`;
        next = next.filter(item => item.id !== id);
        next.push({ id, text: message.text, category: 'message', subject: message.userId ?? '',
          metadata: { messageId: message.messageId, sender: message.sender }, updatedAt: Date.now() }); affectedIds.push(id);
      }
    } else throw new Error('Unsupported memory operation');
    this.save(namespace, next);
    const result = { ...envelope, affectedIds: affectedIds.slice(0, 100), affectedCount: affectedIds.length };
    this.receipts.set(receiptKey, { hash: requestHash, result });
    while (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value);
    return result;
  }
}

export async function startMemoryProvider({ port = 0, filePath = null, token = process.env.QQ_MEMORY_PLUGIN_TOKEN ?? '' } = {}) {
  const store = new ExampleMemoryStore({ filePath });
  const server = http.createServer(async (req, res) => {
    const reply = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST' || req.url !== '/memory') { reply({ error: 'not found' }, 404); return; }
    if (token && req.headers.authorization !== `Bearer ${token}`) { reply({ error: 'unauthorized' }, 401); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) { reply({ error: 'request too large' }, 413); return; } chunks.push(chunk); }
      reply(store.handle(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    } catch { reply({ error: 'invalid memory request or storage failure' }, 400); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { store, server, url: `http://127.0.0.1:${server.address().port}/memory`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const filePath = process.argv.find(arg => arg.startsWith('--data='))?.slice(7) ?? null;
  if (process.argv.includes('--stdio')) {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { z } = await import('zod');
    const store = new ExampleMemoryStore({ filePath });
    const server = new McpServer({ name: 'qq-memory-example', version: '1.0.0' });
    server.tool('memory', 'Memory provider v1 protocol', { protocol: z.literal(MEMORY_PROTOCOL), operation: z.string(), namespace: z.string(), requestId: z.string(), input: z.record(z.string(), z.unknown()) }, async request => {
      try { return { content: [{ type: 'text', text: JSON.stringify(store.handle(request)) }] }; }
      catch { return { content: [{ type: 'text', text: 'memory request failed' }], isError: true }; }
    });
    await server.connect(new StdioServerTransport());
  } else {
    const provider = await startMemoryProvider({ port: Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 9873), filePath });
    console.log(`Memory protocol example: ${provider.url} (loopback only; keyword retrieval)`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await provider.close(); process.exit(0); });
  }
}
