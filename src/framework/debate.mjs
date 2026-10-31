import { randomBytes, createHash } from 'node:crypto';
import { frameworkError } from './content.mjs';
import { selectDebateBatch, normalizeDebateState } from './debate-context.mjs';

const digest = value => createHash('sha256').update(String(value)).digest('hex');
const field = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw frameworkError(`${name} 无效`);
  return value.trim();
};
const cursor = value => {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw frameworkError('after 无效');
  return n;
};

// Deliberately ephemeral: a process restart revokes every task credential and draft.
// A task token grants only this finite API, never a conversation or console token.
export class DebateTasks {
  constructor({ now = Date.now, assertGroup, audit = () => {}, send, readContext = () => ({}) } = {}) {
    this.now = now; this.assertGroup = assertGroup; this.audit = audit; this.send = send; this.readContext = readContext;
    this.tasks = new Map();
  }
  record(event, task, extra = {}) {
    this.audit({ event: `debate-${event}`, key: task.key, taskId: task.id, ...extra });
  }
  live(task) {
    if (!task || task.status !== 'active' || task.expiresAt <= this.now()) throw frameworkError('争论任务已停止、暂停或过期', 403);
    this.assertGroup(task.key, task.policy);
    return task;
  }
  view(task) {
    return { id: task.id, key: task.key, targetId: task.targetId, topic: task.topic, keywords: task.keywords,
      status: task.expiresAt <= this.now() && task.status !== 'stopped' ? 'expired' : task.status,
      createdAt: task.createdAt, expiresAt: task.expiresAt, revision: task.revision,
      lastEventId: task.nextEvent, oldestEventId: task.events[0]?.id ?? null,
      lastRequestSeq: task.lastRequestSeq ?? 0,
      processedThrough: task.processedThrough ?? 0,
      protocolVersion: 2, includeContext: task.includeContext, contextVersion: this.contextVersion(task),
      needsReassessment: !!task.lastAnalysis && task.processedThrough >= task.nextEvent && task.lastAnalysis.contextVersion !== this.contextVersion(task),
      debateState: structuredClone(task.debateState),
      worker: { online: task.status === 'active' && task.expiresAt > this.now() && !!task.worker && task.worker.state !== 'stopped' && this.now() - task.worker.lastSeenAt < 6000,
        state: task.worker?.state || 'offline', lastSeenAt: task.worker?.lastSeenAt ?? null, error: task.worker?.error || '' },
      frequencyLimit: null, sendMode: task.sendMode, approvalRequired: task.sendMode !== 'auto' };
  }
  create(input, policy) {
    if (!/^group:[1-9]\d*$/.test(input.key ?? '') || !Number.isSafeInteger(Number(input.key.split(':')[1]))) throw frameworkError('只能指定有效群会话');
    if (!/^[1-9]\d*$/.test(String(input.targetId ?? '')) || !Number.isSafeInteger(Number(input.targetId))) throw frameworkError('targetId 无效');
    policy = this.assertGroup(input.key, policy);
    const topic = field(input.topic, 'topic', 300);
    const sendMode = input.sendMode ?? 'review';
    if (!['auto', 'review'].includes(sendMode)) throw frameworkError('sendMode 无效');
    if (!Array.isArray(input.keywords) || input.keywords.length < 1 || input.keywords.length > 12) throw frameworkError('须指定 1–12 个议题关键词');
    const keywords = [...new Set(input.keywords.map(word => field(word, 'keyword', 60)))];
    const minutes = input.durationMinutes ?? 30;
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) throw frameworkError('有效期须为 1–120 分钟');
    // Storage bounds are not message frequency or lifetime send quotas.
    for (const [id, t] of this.tasks) if (t.status === 'stopped' || t.expiresAt <= this.now()) this.tasks.delete(id);
    if (this.tasks.size >= 20) throw frameworkError('同时最多保留 20 个任务', 409);
    const token = randomBytes(32).toString('hex');
    const task = { id: randomBytes(16).toString('hex'), tokenHash: digest(token), key: input.key,
      targetId: String(input.targetId), topic, keywords, policy, sendMode, status: 'active', revision: 0,
      includeContext: input.includeContext === true, batches: new Map(), debateState: { claims: [], questions: [], position: '' },
      createdAt: this.now(), expiresAt: this.now() + minutes * 60000, nextEvent: 0, events: [], drafts: new Map() };
    this.record('created', task, { sendMode, includeContext: task.includeContext, protocolVersion: 2 });
    this.tasks.set(task.id, task);
    return { task: this.view(task), token };
  }
  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw frameworkError('任务不存在', 404);
    return task;
  }
  authenticate(id, token) {
    const task = this.tasks.get(id);
    if (typeof token !== 'string' || token.length !== 64 || !task || task.tokenHash !== digest(token)) throw frameworkError('任务令牌无效', 401);
    return this.live(task);
  }
  control(id, action) {
    const task = this.get(id);
    if (!['pause', 'resume', 'stop'].includes(action)) throw frameworkError('未知任务操作');
    if (task.status === 'stopped' || task.expiresAt <= this.now()) throw frameworkError('结束或过期的任务不能恢复', 409);
    if (action === 'resume') this.assertGroup(task.key, task.policy);
    if (action === 'resume') this.record(action, task);
    task.revision++;
    task.batches.clear();
    task.status = { pause: 'paused', resume: 'active', stop: 'stopped' }[action];
    // Pause invalidates every pending draft; resume never resurrects approvals.
    for (const draft of task.drafts.values()) if (draft.status === 'pending') draft.status = 'cancelled';
    if (action === 'stop') { task.events = []; task.tokenHash = ''; }
    // Audit failure must never prevent an administrator from revoking a task.
    if (action !== 'resume') this.record(action, task);
    return this.view(task);
  }
  ingest(key, msg) {
    if (msg.isSelf || !msg.userId || !msg.messageId) return false;
    let matched = false;
    const text = String(msg.plain ?? msg.text ?? '').slice(0, 2000);
    for (const task of this.tasks.values()) {
      if (task.key !== key) continue;
      try { this.live(task); } catch { continue; }
      const reasons = [];
      if (String(msg.userId) === task.targetId) reasons.push('target');
      if (msg.replyToMessageId && task.events.some(e => e.messageId === String(msg.replyToMessageId) && e.userId === task.targetId)) reasons.push('reply');
      if (task.keywords.some(word => text.toLocaleLowerCase().includes(word.toLocaleLowerCase()))) reasons.push('topic');
      if (new RegExp(`(^|\\D)${task.targetId}(\\D|$)`).test(text)) reasons.push('mention');
      if (!reasons.length || task.events.some(e => e.messageId === String(msg.messageId))) continue;
      matched = true;
      task.events.push({ id: ++task.nextEvent, messageId: String(msg.messageId), userId: String(msg.userId),
        sender: String(msg.sender ?? '').slice(0, 100), text, reasons, time: this.now() });
      if (task.events.length > 200) task.events.shift();
      for (const draft of task.drafts.values()) if (draft.status === 'pending') draft.status = 'stale';
    }
    return matched;
  }
  events(task, after = 0) {
    this.live(task);
    after = cursor(after);
    if (after > task.nextEvent) throw frameworkError('游标超出当前任务事件范围', 409);
    if (task.events.length && after < task.events[0].id - 1) throw frameworkError('事件已淘汰，请从 oldestEventId-1 重新读取', 409);
    return task.events.filter(event => event.id > after).map(event => ({ ...event, reasons: [...event.reasons] }));
  }
  contextVersion(task) { return digest(JSON.stringify(this.readContext(task))); }
  heartbeat(task, input) {
    this.live(task);
    if (!/^[a-f0-9-]{16,64}$/.test(input.workerId ?? '') || !Number.isSafeInteger(input.sequence) || input.sequence < 1
      || !['idle', 'analyzing', 'blocked', 'error', 'stopped'].includes(input.state)
      || !['', 'context_gap', 'analysis_failed', 'transport_failed'].includes(input.error ?? '')) throw frameworkError('worker状态无效');
    if (task.worker && task.worker.id !== input.workerId && this.now() - task.worker.lastSeenAt < 6000 && task.worker.state !== 'stopped') throw frameworkError('已有另一个worker在线', 409);
    if (task.worker?.id === input.workerId && input.sequence <= task.worker.sequence) return this.view(task);
    task.worker = { id: input.workerId, sequence: input.sequence, state: input.state, error: input.error || '', lastSeenAt: this.now() };
    return this.view(task);
  }
  batch(task, workerId) {
    this.live(task);
    if (task.worker && this.now() - task.worker.lastSeenAt < 6000 && task.worker.state !== 'stopped' && task.worker.id !== workerId) throw frameworkError('分析批次属于在线worker', 409);
    const context = this.readContext(task), contextVersion = digest(JSON.stringify(context));
    for (const draft of task.drafts.values()) if (draft.status === 'pending'
      && (draft.eventVersion !== task.nextEvent || draft.contextVersion !== contextVersion)) draft.status = 'stale';
    const events = this.events(task, task.processedThrough || 0);
    const refresh = !events.length && !!task.lastAnalysis && task.lastAnalysis.contextVersion !== contextVersion;
    const messages = refresh ? structuredClone(task.lastAnalysis.messages) : selectDebateBatch(events);
    if (!messages.length) return null;
    const batch = { id: randomBytes(16).toString('hex'), taskRevision: task.revision, eventVersion: task.nextEvent,
      contextVersion, throughEventId: messages.at(-1).id, hasMore: messages.at(-1).id < task.nextEvent,
      messages, context, refresh, debateState: structuredClone(task.debateState), workerId,
      recentResponses: [...task.drafts.values()].slice(-5).map(d => ({ text: d.text, verdict: d.verdict, status: d.status,
        deliveredText: d.deliveredText || '', partial: Boolean(d.deliveredText) && d.status !== 'sent' })),
      expiresAt: Math.min(task.expiresAt, this.now() + 300000) };
    for (const [id, b] of task.batches) if (b.expiresAt <= this.now()) task.batches.delete(id);
    while (task.batches.size >= 8) task.batches.delete(task.batches.keys().next().value);
    task.batches.set(batch.id, batch);
    return structuredClone(batch);
  }
  fresh(task, draft) {
    if (draft.eventVersion !== task.nextEvent || draft.contextVersion !== this.contextVersion(task)) {
      draft.status = 'stale'; throw frameworkError('争论上下文已变化，旧草稿必须重新分析', 409);
    }
  }
  async submit(task, input) {
    this.live(task);
    if (input.taskRevision !== task.revision) throw frameworkError('任务授权版本已变化，请重新读取任务', 403);
    const text = input.verdict === 'skip' && input.text === '' ? '' : field(input.text, 'text', 3000);
    if ([...text.matchAll(/[a-f0-9]{64}/g)].some(match => [...this.tasks.values()].some(t => t.tokenHash && digest(match[0]) === t.tokenHash))) throw frameworkError('草稿包含任务凭据，拒绝发送', 403);
    const analysis = field(input.analysis, 'analysis', 6000);
    const verdict = input.verdict;
    if (!['counterargument', 'uncertain', 'concede', 'skip'].includes(verdict)) throw frameworkError('verdict 无效');
    if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length < 1 || input.evidenceIds.length > 12
      || input.evidenceIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw frameworkError('须引用当前任务中实际收到的 evidenceIds');
    const through = input.throughEventId ?? Math.max(...input.evidenceIds);
    if (!Number.isSafeInteger(through) || through < Math.max(...input.evidenceIds)) throw frameworkError('throughEventId须为已收到且不早于evidenceIds引用的事件');
    // Idempotency prevents a worker retry from duplicating a reviewed draft.
    const requestId = field(input.requestId, 'requestId', 100);
    const fingerprint = digest(JSON.stringify([text, analysis, verdict, input.evidenceIds, input.requestSeq, through, input.batchId, input.state]));
    const existing = [...task.drafts.values()].find(d => d.requestId === requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw frameworkError('requestId 已绑定其他草稿', 409);
      return structuredClone(existing);
    }
    // A monotonic request sequence bounds replay state without a lifetime send
    // quota. Evicting old drafts must never allow an old request to send again.
    if (!Number.isSafeInteger(input.requestSeq) || input.requestSeq < 1 || input.requestSeq <= (task.lastRequestSeq ?? 0)) throw frameworkError('requestSeq 须递增，旧请求不能重放', 409);
    const batch = task.batches.get(input.batchId);
    if (!batch || batch.taskRevision !== task.revision || batch.expiresAt <= this.now()) throw frameworkError('须先领取当前授权版本的分析批次', 409);
    if (batch.workerId && (!task.worker || task.worker.id !== batch.workerId || this.now() - task.worker.lastSeenAt >= 6000
      || ['stopped', 'error', 'blocked'].includes(task.worker.state))) throw frameworkError('worker授权已失效', 403);
    if (through !== batch.throughEventId || through <= (task.processedThrough || 0)
      && (!batch.refresh || batch.contextVersion === task.lastAnalysis?.contextVersion)
      || input.evidenceIds.some(id => !batch.messages.some(m => m.id === id))) throw frameworkError('游标和evidenceIds必须限定在实际提供的分析批次', 409);
    if (verdict !== 'skip') {
      this.fresh(task, { eventVersion: batch.eventVersion, contextVersion: batch.contextVersion });
      if (batch.hasMore) throw frameworkError('尚有未分析前文，请先整理并选择skip', 409);
    }
    let nextState = task.debateState;
    if (input.state !== undefined) {
      const allowed = new Set([...batch.messages.map(m => m.id), ...['claims', 'questions'].flatMap(k => task.debateState[k].flatMap(x => x.evidenceIds))]);
      try { nextState = normalizeDebateState(input.state, allowed); } catch (error) { throw frameworkError(error.message); }
    }
    const privateText = JSON.stringify([analysis, nextState]);
    if ([...privateText.matchAll(/[a-f0-9]{64}/g)].some(match => [...this.tasks.values()].some(t => t.tokenHash && digest(match[0]) === t.tokenHash))) throw frameworkError('分析或争点状态包含任务凭据，拒绝保存', 403);
    if (task.drafts.size >= 100) {
      const old = [...task.drafts.values()].find(d => !['pending', 'sending'].includes(d.status));
      if (!old) throw frameworkError('待审草稿存储已满，请管理员处理', 409);
      task.drafts.delete(old.id);
    }
    const draft = { id: randomBytes(16).toString('hex'), requestId, fingerprint, text, analysis, verdict,
      evidence: input.evidenceIds.map(id => structuredClone(batch.messages.find(e => e.id === id))),
      revision: task.revision, batchId: batch.id, workerId: batch.workerId, eventVersion: batch.eventVersion, contextVersion: batch.contextVersion, status: 'pending', createdAt: this.now(), expiresAt: Math.min(task.expiresAt, this.now() + 300000) };
    this.record('draft-submitted', task, { draftId: draft.id, batchId: batch.id, throughEventId: through,
      eventVersion: batch.eventVersion, refresh: batch.refresh });
    task.lastRequestSeq = input.requestSeq;
    task.debateState = nextState;
    task.lastAnalysis = { messages: structuredClone(batch.messages), contextVersion: batch.contextVersion };
    task.processedThrough = Math.max(task.processedThrough ?? 0, through);
    task.drafts.set(draft.id, draft);
    if (verdict === 'skip') { draft.status = 'skipped'; return structuredClone(draft); }
    if (task.sendMode === 'auto') return this.review(task.id, draft.id, 'approve', { automatic: true });
    return structuredClone(draft);
  }
  async review(id, draftId, decision, { automatic = false } = {}) {
    const task = this.live(this.get(id));
    const draft = task.drafts.get(draftId);
    if (!draft || draft.status !== 'pending' || draft.revision !== task.revision || draft.expiresAt <= this.now()) throw frameworkError('草稿不存在、已处理或已过期', 409);
    if (!['approve', 'deny'].includes(decision)) throw frameworkError('审批决定无效');
    if (automatic && task.sendMode !== 'auto') throw frameworkError('任务未授权自动发送', 403);
    if (decision === 'approve') this.fresh(task, draft);
    this.record(automatic ? 'draft-auto-authorized' : `draft-${decision}`, task, { draftId });
    draft.status = decision === 'deny' ? 'denied' : 'sending';
    if (decision === 'deny') return structuredClone(draft);
    const revision = task.revision;
    const assertLive = () => {
      this.live(task);
      this.fresh(task, draft);
      if (automatic && draft.workerId && (task.worker?.id !== draft.workerId || this.now() - task.worker.lastSeenAt >= 6000
        || ['stopped', 'error', 'blocked'].includes(task.worker.state))) throw frameworkError('worker授权已失效', 403);
      if (revision !== task.revision || draft.expiresAt <= this.now()) throw frameworkError('审批发送已撤销或过期', 403);
    };
    try {
      assertLive();
      await this.send(task.key, draft.text, assertLive, { taskId: task.id });
      draft.status = 'sent';
      draft.deliveredText = draft.text;
      this.record('draft-sent', task, { draftId });
    } catch (error) {
      // Never retry an ambiguous transport failure automatically.
      if (Array.isArray(error.sent)) draft.deliveredText = error.sent.map(text => String(text)).join('\n').slice(0, 6000);
      if (!['sent', 'stale'].includes(draft.status)) draft.status = 'failed';
      throw error;
    }
    return structuredClone(draft);
  }
}

export async function handleDebateApi({ req, res, url, readBody, sendJson, tasks, admin }) {
  const external = url.pathname.startsWith('/api/v1/debate/');
  if (!external && !admin) throw frameworkError('争论任务管理仅供管理员控制台使用', 403);
  if (!external) {
    if (req.method === 'GET' && url.pathname === '/api/debate/tasks') return sendJson({ ok: true, tasks: [...tasks.tasks.values()].map(t => tasks.view(t)) });
    if (req.method === 'POST' && url.pathname === '/api/debate/tasks') return sendJson({ ok: true, ...tasks.create(await readBody()) });
    const body = req.method === 'POST' ? await readBody() : null;
    if (req.method === 'POST' && url.pathname === '/api/debate/control') return sendJson({ ok: true, task: tasks.control(body.taskId, body.action) });
    if (req.method === 'GET' && url.pathname === '/api/debate/drafts') {
      const limit = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw frameworkError('limit须为1–100');
      return sendJson({ ok: true, drafts: [...tasks.get(url.searchParams.get('taskId')).drafts.values()].slice(-limit) });
    }
    if (req.method === 'POST' && url.pathname === '/api/debate/review') return sendJson({ ok: true, draft: await tasks.review(body.taskId, body.draftId, body.decision) });
    throw frameworkError('未知争论管理接口', 404);
  }
  // Query-only taskId prevents body swapping while a request is being read.
  const id = url.searchParams.get('taskId');
  const token = req.headers['x-debate-token'];
  const task = tasks.authenticate(id, token);
  if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) throw frameworkError('不能混用任务和会话身份', 403);
  if (req.method === 'GET' && url.pathname === '/api/v1/debate/task') return sendJson({ ok: true, task: tasks.view(task) });
  if (req.method === 'GET' && url.pathname === '/api/v1/debate/events') {
    const after = url.searchParams.get('after') ?? 0;
    return sendJson({ ok: true, events: tasks.events(task, after), task: tasks.view(task) });
  }
  if (req.method === 'POST' && ['/api/v1/debate/batch', '/api/v1/debate/heartbeat'].includes(url.pathname)) {
    const body = await readBody(); tasks.authenticate(id, token);
    if (body.key !== undefined || body.taskId !== undefined) throw frameworkError('任务范围只能由凭据确定', 403);
    if (url.pathname.endsWith('/heartbeat')) return sendJson({ ok: true, task: tasks.heartbeat(task, body) });
    return sendJson({ ok: true, batch: tasks.batch(task, body.workerId), task: tasks.view(task) });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/debate/drafts') {
    const body = await readBody();
    tasks.authenticate(id, token);
    if (body.key !== undefined || body.taskId !== undefined) throw frameworkError('任务范围只能由凭据和查询 taskId 确定', 403);
    return sendJson({ ok: true, draft: await tasks.submit(task, body) });
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/debate/stream') {
    const revision = task.revision;
    let after = cursor(url.searchParams.get('after') ?? req.headers['last-event-id']);
    tasks.events(task, after); // Validate before writing SSE headers.
    if ((task.streams ?? 0) >= 4) throw frameworkError('该任务的并发订阅连接已满', 409);
    task.streams = (task.streams ?? 0) + 1;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    let timer;
    const close = () => { clearInterval(timer); res.end(); };
    const tick = () => {
      try {
        tasks.authenticate(id, token);
        if (task.revision !== revision) return close();
        for (const event of tasks.events(task, after)) {
          if (res.writableLength > 65536) return close();
          res.write(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
          after = event.id;
        }
        res.write(': heartbeat\n\n');
      } catch { close(); }
    };
    timer = setInterval(tick, 1000);
    timer.unref?.();
    res.once('close', () => { clearInterval(timer); task.streams--; });
    tick();
    return;
  }
  throw frameworkError('未知争论任务接口', 404);
}
