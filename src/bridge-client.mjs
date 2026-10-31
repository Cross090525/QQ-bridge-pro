// Dependency-free client for external MCP servers, scripts and skill runners.
export class QQBridgeClient {
  constructor({ baseUrl = 'http://127.0.0.1:3100', key, token, timeoutMs = 660000, fetchImpl = globalThis.fetch } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new TypeError('baseUrl 必须是本机回环 HTTP 根地址');
    }
    if (!/^(group|private):[1-9]\d*$/.test(key ?? '') || !Number.isSafeInteger(Number(key.split(':')[1]))) throw new TypeError('无效的会话 key');
    if (typeof token !== 'string' || !token.trim()) throw new TypeError('必须提供当前会话令牌');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 660000) throw new TypeError('timeoutMs 无效');
    this.baseUrl = url.origin;
    this.key = key;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', params = {}, body } = {}) {
    if (!/^\/api\/v1\/[a-z/]+$/.test(path)) throw new TypeError('只允许调用 v1 接口');
    const url = new URL(path, this.baseUrl);
    for (const [name, value] of Object.entries({ ...params, key: this.key })) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const response = await this.fetch(url, {
      method, redirect: 'error',
      headers: { 'x-agent-token': this.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify({ ...body, key: this.key }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) {
      const error = new Error(result.error || `QQ bridge HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return result;
  }

  capabilities() { return this.request('/api/v1/capabilities'); }
  memoryProviders() { return this.request('/api/v1/memory/providers'); }
  memory(operation, input = {}, { providerId, approvalId } = {}) {
    if (!['query', 'write', 'update', 'delete', 'clear', 'ingest'].includes(operation)) throw new TypeError('未知记忆操作');
    return this.request(`/api/v1/memory/${operation}`, { method: 'POST', body: { providerId, approvalId, input } });
  }
  workingContext({ query, messageId } = {}) { return this.request('/api/v1/working/context', { params: { query, messageId } }); }
  updateWorkingContext(input) { return this.request('/api/v1/working/context', { method: 'POST', body: input }); }
  queryContext(query) { return this.request('/api/v1/context/query', { method: 'POST', body: query }); }
  contentServices(sourceId) { return this.request('/api/v1/content/services', { params: { sourceId } }); }
  processContent(serviceId, { sourceId, input = {}, approvalId } = {}) { return this.request('/api/v1/content/process', { method: 'POST', body: { serviceId, sourceId, input, approvalId } }); }
  sendContent(content) { return this.request('/api/v1/content/send', { method: 'POST', body: { content } }); }
  readMedia(sourceId, { approvalId } = {}) { return this.request('/api/v1/media/read', { params: { sourceId, approvalId } }); }
  uploadMedia(media) { return this.request('/api/v1/media/upload', { method: 'POST', body: media }); }
  unread(params = {}) { return this.request('/api/v1/messages/unread', { params }); }
  recent(params = {}) { return this.request('/api/v1/messages/recent', { params }); }
  send(messages, options = {}) { return this.request('/api/v1/messages/send', { method: 'POST', body: { ...options, messages } }); }
  acknowledge(throughSeq) {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new TypeError('必须提供已展示的 throughSeq');
    return this.request('/api/v1/messages/ack', { method: 'POST', body: { throughSeq } });
  }
  wait(options = {}) { return this.request('/api/v1/messages/wait', { method: 'POST', body: options }); }
}
