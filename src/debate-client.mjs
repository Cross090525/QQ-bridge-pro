// This client never accepts a console or conversation credential.
export class DebateClient {
  constructor({ baseUrl = 'http://127.0.0.1:3100', taskId, token, fetchImpl = globalThis.fetch } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new TypeError('baseUrl 须为本机回环 HTTP 根地址');
    if (!/^[a-f0-9]{32}$/.test(taskId ?? '') || !/^[a-f0-9]{64}$/.test(token ?? '')) throw new TypeError('须提供任务 ID 和任务令牌');
    this.baseUrl = url.origin; this.taskId = taskId; this.token = token; this.fetch = fetchImpl;
  }
  async request(route, body, params = {}) {
    if (!['task', 'events', 'drafts'].includes(route)) throw new TypeError('未知争论接口');
    const url = new URL(`/api/v1/debate/${route}`, this.baseUrl);
    url.searchParams.set('taskId', this.taskId);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
    const response = await this.fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'x-debate-token': this.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`); error.statusCode = response.status; throw error;
    }
    return data;
  }
  task() { return this.request('task'); }
  events(after = 0) { return this.request('events', undefined, { after }); }
  submit(draft) { return this.request('drafts', draft); }
}
