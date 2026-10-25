import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { frameworkError } from './content.mjs';

export function normalizeServiceTransport(transport) {
  if (!transport || !['stdio', 'http'].includes(transport.type)) throw frameworkError('服务 transport 必须为 stdio 或 http');
  if (transport.type === 'stdio' && (typeof transport.command !== 'string' || !transport.command
      || !Array.isArray(transport.args ?? []) || (transport.args ?? []).some(arg => typeof arg !== 'string'))) throw frameworkError('stdio 服务需要固定 command 和 args');
  if (transport.type === 'http') {
    let url;
    try { url = new URL(transport.url); } catch { throw frameworkError('HTTP 服务 URL 无效'); }
    if (url.username || url.password || url.hash || !(url.protocol === 'https:'
        || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw frameworkError('HTTP 服务地址仅允许 HTTPS 或本机回环 HTTP');
  }
  return { ...transport, ...(transport.type === 'stdio' ? { args: transport.args ?? [] } : {}) };
}

// Fixed transports only. Callers must authorize before invoking this driver.
export class RegisteredServiceTransport {
  constructor({ fetchImpl = globalThis.fetch } = {}) { this.fetch = fetchImpl; this.connections = new Map(); }
  async connection(service) {
    if (this.connections.has(service.id)) return this.connections.get(service.id);
    const connecting = (async () => {
      const env = {};
      for (const [name, from] of Object.entries(service.transport.envFrom ?? {})) {
        if (typeof from !== 'string' || !process.env[from]) throw frameworkError(`服务环境变量未配置：${name}`);
        env[name] = process.env[from];
      }
      const client = new Client({ name: 'qq-bridge-framework', version: '1.0.0' });
      client.onclose = () => { if (this.connections.get(service.id) === connecting) this.connections.delete(service.id); };
      const transport = new StdioClientTransport({ command: service.transport.command, args: service.transport.args, env, stderr: 'pipe' });
      transport.stderr?.on('data', () => {});
      let timer;
      try { await Promise.race([client.connect(transport), new Promise((_, reject) => {
        timer = setTimeout(() => reject(frameworkError('MCP 服务连接超时', 504)), service.timeoutMs);
      })]); }
      catch (error) { await client.close().catch(() => {}); throw error; }
      finally { clearTimeout(timer); }
      return client;
    })();
    this.connections.set(service.id, connecting);
    try { return await connecting; }
    catch (error) { if (this.connections.get(service.id) === connecting) this.connections.delete(service.id); throw error; }
  }
  async call(service, args, { assertLive = () => {}, maxBytes = 12 * 1024 * 1024 } = {}) {
    assertLive();
    if (service.transport.type === 'stdio') {
      const client = await this.connection(service); assertLive();
      const raw = await client.callTool({ name: service.tool, arguments: args }, undefined, { timeout: service.timeoutMs });
      assertLive();
      if (Buffer.byteLength(JSON.stringify(raw)) > maxBytes) throw frameworkError('服务响应超过体积上限', 413);
      return raw;
    }
    const headers = { 'content-type': 'application/json' };
    for (const [name, from] of Object.entries(service.transport.headersFrom ?? {})) {
      if (typeof from !== 'string' || !process.env[from]) throw frameworkError(`服务请求头未配置：${name}`);
      headers[name] = process.env[from];
    }
    const response = await this.fetch(service.transport.url, { method: 'POST', headers, body: JSON.stringify(args),
      redirect: 'error', signal: AbortSignal.timeout(service.timeoutMs) });
    if (!response.ok) throw frameworkError(`服务返回 HTTP ${response.status}`, 502);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      assertLive(); bytes += chunk.length;
      if (bytes > maxBytes) { await response.body?.cancel?.().catch(() => {}); throw frameworkError('服务响应超过体积上限', 413); }
      chunks.push(chunk);
    }
    assertLive();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async close() { await Promise.allSettled([...this.connections.values()].map(async pending => (await pending).close())); this.connections.clear(); }
}
