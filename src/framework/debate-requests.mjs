import { randomBytes } from 'node:crypto';
import { frameworkError } from './content.mjs';

const id = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
const clean = value => String(value ?? '').normalize('NFKC').trim();
export function normalizeDebateWake(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw frameworkError('唤起配置须为对象');
  const phrases = value.phrases ?? ['开启辩论'];
  if (!Array.isArray(phrases) || !phrases.length || phrases.length > 10
    || phrases.some(p => typeof p !== 'string' || !clean(p) || clean(p).length > 40 || /[\r\n|/@]/.test(clean(p)))) throw frameworkError('唤起语句须为 1–10 条纯文字，每条 1–40 字，不能含换行、/、@、|');
  const durationMinutes = value.durationMinutes ?? 30;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 120) throw frameworkError('有效期须为 1–120 分钟');
  const sendMode = value.sendMode ?? 'review';
  if (!['auto', 'review'].includes(sendMode)) throw frameworkError('发送方式无效');
  return { enabled: value.enabled === true, phrases: [...new Set(phrases.map(clean))], durationMinutes,
    sendMode, includeContext: value.includeContext === true };
}

// Only the actual message's text/at segments can initiate a request. Never parse
// resolved quotes, forwarded messages, media descriptions, or model output.
export function parseDebateWake(segments, config, selfId) {
  if (!config.enabled || !Array.isArray(segments)) return null;
  const text = clean(segments.map(s => s.type === 'text' ? s.data?.text ?? '' : s.type === 'at' ? ' ' : '').join(''));
  const phrase = [...config.phrases].sort((a, b) => b.length - a.length).find(p => text.startsWith(p) && (!text[p.length] || /\s/.test(text[p.length])));
  if (!phrase) return null;
  if (segments.some(s => !['text', 'at', 'reply'].includes(s.type))) throw frameworkError('争论申请请用文字和 @对象发送');
  let rest = text.slice(phrase.length).trim();
  const targets = [...new Set(segments.filter(s => s.type === 'at').map(s => String(s.data?.qq)).filter(qq => qq !== String(selfId)))];
  if (!targets.length) {
    const match = /^([1-9]\d*)\s+([\s\S]+)$/.exec(rest);
    if (match) { targets.push(match[1]); rest = match[2]; }
  }
  if (targets.length !== 1 || !id(targets[0]) || targets[0] === String(selfId)) throw frameworkError('请指定一个争论对象：唤起语句 @对象 议题 | 关键词1,关键词2（也可用 QQ 号代替 @）');
  const parts = rest.split('|');
  const topic = parts[0].trim();
  const keywords = parts.length === 1 ? [topic] : [...new Set(parts[1].split(/[,，]/).map(clean).filter(Boolean))];
  if (!topic || topic.length > 300 || parts.length > 2 || !keywords.length || keywords.length > 12 || keywords.some(w => !w || w.length > 60)) throw frameworkError('议题须为 1–300 字，关键词须为 1–12 个且每个不超过 60 字；长议题请用 | 单独指定关键词');
  return { targetId: targets[0], topic, keywords };
}

export class DebateRequests {
  constructor({ config, tasks, start, assertGroup, now = Date.now, audit = () => {} }) {
    this.config = normalizeDebateWake(config); this.tasks = tasks; this.start = start;
    this.assertGroup = assertGroup; this.now = now; this.audit = audit;
    this.requests = new Map(); this.seen = new Map(); this.revision = 0;
  }
  configure(config) {
    this.config = normalizeDebateWake(config); this.revision++;
    for (const r of this.requests.values()) if (r.status === 'pending') r.status = 'cancelled';
    return structuredClone(this.config);
  }
  list() {
    for (const [key, time] of this.seen) if (time + 600000 <= this.now()) this.seen.delete(key);
    for (const r of this.requests.values()) if (r.status === 'pending' && r.expiresAt <= this.now()) r.status = 'expired';
    return [...this.requests.values()].map(r => structuredClone(r));
  }
  receive({ key, userId, messageId, segments, selfId }) {
    if (String(userId) === String(selfId)) return null;
    const input = parseDebateWake(segments, this.config, selfId);
    if (!input) return null;
    if (!id(userId) || !messageId) throw frameworkError('申请缺少可信的发送人或消息编号');
    const policy = this.assertGroup(key);
    this.list();
    const messageKey = `${key}:${messageId}`;
    if (this.seen.has(messageKey)) return { duplicate: true };
    if (this.seen.size >= 1000) throw frameworkError('近期申请过多，请稍后重试', 429);
    const prior = [...this.requests.values()].find(r => r.key === key && r.requesterId === String(userId) && (['pending', 'starting'].includes(r.status) || this.now() - r.createdAt < 30000));
    if (prior) { this.seen.set(messageKey, this.now()); return { duplicate: true, request: structuredClone(prior) }; }
    // Keep pending requests; evict only completed entries, and bound replay IDs.
    while (this.requests.size >= 100) {
      const old = [...this.requests.values()].find(r => !['pending', 'starting'].includes(r.status));
      if (!old) throw frameworkError('待审核申请已满，请稍后重试', 429);
      this.requests.delete(old.id);
    }
    const r = { id: randomBytes(16).toString('hex'), key, requesterId: String(userId), messageId: String(messageId),
      ...input, durationMinutes: this.config.durationMinutes, sendMode: this.config.sendMode, includeContext: this.config.includeContext,
      status: 'pending', createdAt: this.now(), expiresAt: this.now() + 300000, policy, configRevision: this.revision };
    this.audit({ event: 'debate-requested', key, requestId: r.id, requesterId: r.requesterId });
    this.requests.set(r.id, r); this.seen.set(messageKey, this.now());
    return { request: structuredClone(r), duplicate: false };
  }
  async decide(requestId, decision) {
    this.list(); const r = this.requests.get(requestId);
    if (!r || r.status !== 'pending') throw frameworkError('申请不存在、已处理或已过期', 409);
    if (!['approve', 'deny'].includes(decision)) throw frameworkError('审批决定无效');
    if (decision === 'deny') { r.status = 'denied'; this.audit({ event: 'debate-request-denied', key: r.key, requestId }); return structuredClone(r); }
    if (!this.config.enabled || r.configRevision !== this.revision) throw frameworkError('唤起设置已变化，请重新申请', 409);
    this.assertGroup(r.key, r.policy);
    this.audit({ event: 'debate-request-approved', key: r.key, requestId });
    r.status = 'starting';
    let created;
    try {
      created = this.tasks.create(r, r.policy); r.taskId = created.task.id;
      await this.start(created);
      if (!this.config.enabled || r.configRevision !== this.revision || this.now() >= r.expiresAt) throw frameworkError('启动期间申请已失效', 409);
      this.tasks.live(this.tasks.get(r.taskId));
      r.status = 'approved';
    } catch (error) {
      r.status = 'failed';
      if (created) { try { this.tasks.control(created.task.id, 'stop'); } catch {} }
      throw error;
    }
    // Task tokens never leave the local launcher through this interface.
    return structuredClone(r);
  }
}
