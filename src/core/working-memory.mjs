// Per-conversation working context. No model/network calls or long-term memory writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const copy = value => structuredClone(value);
const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const LISTS = ['topics', 'facts', 'questions', 'uncertainties'];
export class WorkingMemory {
  constructor(directory, { now = Date.now, maxMessages = 500 } = {}) {
    this.directory = directory; this.now = now; this.maxMessages = maxMessages;
    this.states = new Map(); this.receipts = new Map();
  }
  file(key) {
    if (!/^(group|private):[1-9]\d{0,15}$/.test(key)) fail('无效会话');
    return path.join(this.directory, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  }
  get(key) {
    const file = this.file(key);
    if (!this.states.has(key)) {
      let state = { version: 1, revision: 0, messages: [], media: [], topics: [], facts: [], questions: [], uncertainties: [], consideredIds: [], decision: null };
      if (fs.existsSync(file)) {
        try {
          const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || !Array.isArray(saved.messages)
            || !Array.isArray(saved.media) || LISTS.some(k => !Array.isArray(saved[k]))) throw Error();
          state = { consideredIds: [], ...saved };
        } catch { fail('实时工作记忆无法读取，保留原文件；请恢复备份', 503); }
      }
      this.states.set(key, state);
    }
    return this.states.get(key);
  }
  save(key, state) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(key), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 }); fs.renameSync(temp, file);
    this.states.set(key, state);
  }
  record(key, message) {
    const state = copy(this.get(key));
    if (state.messages.some(m => m.id === message.id)) return;
    state.messages.push({ id: String(message.id), seq: message.seq ?? null, messageId: str(message.messageId, 100),
      sender: str(message.sender, 100), userId: str(message.userId, 30), isSelf: message.isSelf === true, origin: message.origin === 'debate' ? 'debate' : 'chat',
      debateTaskId: /^[a-f0-9]{32}$/.test(message.debateTaskId || '') ? message.debateTaskId : '',
      text: str(message.plain ?? message.text, 12000), textTruncated: String(message.plain ?? message.text ?? '').length > 12000,
      replyToMessageId: str(message.replyToMessageId, 100),
      quoteTargetIsSelf: message.quoteTargetIsSelf === true, time: Number(message.time) || this.now(),
      media: (message.content || []).filter(c => c.sourceId).slice(0, 20).map(c => ({ sourceId: c.sourceId, type: c.type })) });
    state.messages = state.messages.slice(-this.maxMessages);
    const retained = new Set(state.messages.map(m => m.id));
    state.consideredIds = state.consideredIds.filter(id => retained.has(id));
    const sources = new Set(state.messages.flatMap(m => m.media.map(x => x.sourceId)));
    state.media = state.media.filter(m => sources.has(m.sourceId));
    state.updatedAt = this.now(); this.save(key, state);
  }
  media(key, sourceId, patch) {
    const state = copy(this.get(key));
    if (!state.messages.some(m => m.media.some(x => x.sourceId === sourceId))) fail('媒体不属于当前记忆');
    const old = state.media.find(m => m.sourceId === sourceId) || { sourceId };
    // Bounded by references in the retained raw messages. Do not evict completion
    // markers independently: doing so would repeatedly re-run old media jobs.
    state.media = [...state.media.filter(m => m.sourceId !== sourceId), { ...old, ...patch, sourceId, updatedAt: this.now() }];
    this.save(key, state);
  }
  snapshot(key, { recent = 20, maxChars = 10000, query = '', messageId = '' } = {}) {
    if (typeof query !== 'string' || query.length > 256 || typeof messageId !== 'string' || messageId.length > 120) fail('检索条件过长或无效');
    const state = this.get(key), now = this.now();
    const matching = state.messages.filter(m => (!messageId || m.id === messageId)
      && (!query || (m.sender + '\n' + m.text).toLowerCase().includes(query.toLowerCase())));
    const pending = matching.filter(m => !m.isSelf && !state.consideredIds.includes(m.id));
    const selectedIds = new Set(query || messageId ? matching.slice(-recent).map(m => m.id)
      : [...pending.slice(0, 12), ...matching.slice(-8)].map(m => m.id));
    const messages = matching.filter(m => selectedIds.has(m.id)).map(m => m.text.length > 1500
      ? { ...m, text: m.text.slice(0, 1200) + '\n…\n' + m.text.slice(-200), excerpt: true } : m);
    if (messageId && messages[0]) { messages[0] = copy(matching.find(m => m.id === messageId)); }
    const packet = { revision: state.revision, updatedAt: state.updatedAt || null,
      topics: state.topics.map(t => ({ ...t, status: t.status === 'active' && now - t.updatedAt > 3600000 ? 'dormant' : t.status })),
      facts: state.facts, questions: state.questions, uncertainties: state.uncertainties,
      decision: state.decision, media: state.media.slice(-20), messages,
      pendingCount: pending.length, totalMessages: state.messages.length, matchedMessages: matching.length,
      truncated: matching.length > messages.length || messages.some(m => m.excerpt) };
    // Keep newest raw context and compact structured state. Never pretend omitted data was presented.
    while (JSON.stringify(packet).length > maxChars && packet.messages.length > 1) { packet.messages.pop(); packet.truncated = true; }
    while (JSON.stringify(packet).length > maxChars && packet.media.length) { packet.media.shift(); packet.truncated = true; }
    for (const k of ['facts', 'questions', 'uncertainties', 'topics']) {
      packet[k] = [...packet[k]];
      while (JSON.stringify(packet).length > maxChars && packet[k].length) { packet[k].shift(); packet.truncated = true; }
    }
    if (JSON.stringify(packet).length > maxChars) {
      packet.messages = packet.messages.map(m => ({ ...m, text: m.text.slice(0, maxChars - 2000), excerpt: true }));
      packet.truncated = true;
    }
    while (JSON.stringify(packet).length > maxChars && packet.messages[0]?.text.length) {
      packet.messages[0].text = packet.messages[0].text.slice(0, Math.floor(packet.messages[0].text.length / 2));
    }
    return copy(packet);
  }
  offered(key, packet, preparedSources = []) {
    const receipt = this.receipts.get(key) || { ids: new Set(), media: new Set() };
    for (const m of packet.messages) receipt.ids.add(m.id);
    // Previously validated summaries remain usable when their raw source has
    // aged out; this grants a reference to the summary, not the missing original.
    for (const k of LISTS) for (const item of packet[k]) for (const id of item.sources) receipt.ids.add(id);
    for (const m of packet.media) if (m.status === 'understood' || preparedSources.includes(m.sourceId)) receipt.media.add(m.sourceId);
    const current = this.get(key);
    const valid = new Set([...current.messages.map(m => m.id), ...LISTS.flatMap(k => current[k].flatMap(item => item.sources))]);
    receipt.ids = new Set([...receipt.ids].filter(id => valid.has(id))); this.receipts.set(key, receipt);
  }
  update(key, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['revision', ...LISTS, 'decision', 'media'].includes(k))) fail('实时记忆更新参数无效');
    const state = copy(this.get(key)), receipt = this.receipts.get(key);
    if (input.revision !== state.revision) fail('实时记忆版本已变化，请重新读取', 409);
    const evidence = value => {
      if (!Array.isArray(value) || !value.length || value.length > 10 || value.some(id => typeof id !== 'string' || !receipt?.ids.has(id))) fail('必须引用当前会话实际展示的来源编号');
      return [...new Set(value)];
    };
    for (const k of LISTS) if (input[k] !== undefined) {
      if (!Array.isArray(input[k]) || input[k].length > (k === 'topics' ? 5 : 10)) fail('实时记忆条目过多');
      state[k] = input[k].map(item => {
        if (!item || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500 || !['active', 'dormant', 'resolved'].includes(item.status)) fail('条目需要text和有效status');
        if (!['reported', 'confirmed', 'inferred'].includes(item.certainty)) fail('必须区分转述、确认和推测');
        return { text: item.text, status: item.status, certainty: item.certainty, sources: evidence(item.sources), updatedAt: this.now() };
      });
    }
    if (input.media !== undefined) {
      if (!Array.isArray(input.media) || input.media.length > 10) fail('媒体摘要过多');
      for (const item of input.media) {
        if (!item || !receipt?.media.has(item.sourceId) || typeof item.summary !== 'string' || !item.summary.trim() || item.summary.length > 600) fail('只能总结已提供证据的媒体');
        const target = state.media.find(m => m.sourceId === item.sourceId);
        if (!target || !['prepared', 'understood'].includes(target.status)) fail('媒体证据已失效');
        target.summary = item.summary; target.status = 'understood'; target.updatedAt = this.now();
      }
    }
    if (input.decision !== undefined) {
      const d = input.decision;
      if (!d || !['observe', 'need_context', 'reply'].includes(d.action) || typeof d.note !== 'string' || d.note.length > 300) fail('参与决策必须为observe/need_context/reply和简短说明');
      const sources = evidence(d.sources);
      state.decision = { action: d.action, note: d.note, sources, updatedAt: this.now() };
      state.consideredIds = [...new Set([...state.consideredIds, ...receipt.ids])].slice(-this.maxMessages);
    }
    state.revision++; state.updatedAt = this.now(); this.save(key, state);
    return { revision: state.revision, decision: state.decision };
  }
}

export class ObservationQueue {
  constructor() { this.running = 0; this.pending = []; }
  run(task) {
    if (this.pending.length >= 32) return Promise.reject(Error('观察队列繁忙'));
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject }); this.drain();
    });
  }
  drain() {
    while (this.running < 2 && this.pending.length) {
      const item = this.pending.shift(); this.running++;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { this.running--; this.drain(); });
    }
  }
}

// A deterministic selection of existing, read-only media capabilities; never selects a text rewriter.
export function observationServices(source, services) {
  const ids = source.type === 'link' ? ['bilibili.storyboard', 'bilibili.frames', 'bilibili.transcript']
    : source.type === 'voice' ? ['media.transcript'] : ['media.storyboard', 'media.frames', 'media.transcript'];
  const found = ids.filter(id => services.some(s => s.id === id && s.effect === 'read' && s.permission === 'allow'));
  return found.some(id => id.endsWith('.storyboard')) ? found.filter(id => id.endsWith('.storyboard')) : found;
}
