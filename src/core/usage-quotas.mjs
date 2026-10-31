import { randomBytes, createHash } from 'node:crypto';
import { frameworkError } from '../framework/content.mjs';

export const QUOTA_RESOURCES = ['media.image', 'media.video', 'media.audio', 'model.wake', 'debate.analysis', 'send.message', 'send.voice', 'sticker.collect', 'slang.submit', 'feedback.submit'];
const resourceOk = value => QUOTA_RESOURCES.includes(value) || /^(extension|memory)\.[a-z][a-z0-9.-]{0,95}$/.test(value ?? '');
const keyOk = key => /^(group|private):[1-9]\d*$/.test(key ?? '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw frameworkError(message); };
export function normalizeQuotaConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['enabled', 'includeExisting', 'rules'].includes(k))) fail('用量配置仅支持 enabled、includeExisting、rules');
  const rules = value.rules ?? [];
  if (!Array.isArray(rules) || rules.length > 100) fail('最多配置100条额度');
  const ids = new Set();
  return { enabled: value.enabled === true, includeExisting: value.includeExisting !== false, rules: rules.map(rule => {
    if (!rule || Object.keys(rule).some(k => !['id', 'resource', 'scope', 'key', 'limit', 'windowMinutes'].includes(k))
      || !/^[a-z][a-z0-9-]{0,39}$/.test(rule.id ?? '') || ids.has(rule.id) || !resourceOk(rule.resource)
      || !['global', 'conversation', 'exact'].includes(rule.scope) || (rule.scope === 'exact' && !keyOk(rule.key))
      || !Number.isSafeInteger(rule.limit) || rule.limit < 1 || rule.limit > 1000000
      || !Number.isSafeInteger(rule.windowMinutes) || rule.windowMinutes < 1 || rule.windowMinutes > 43200) fail('额度规则无效：需要唯一编号、资源、范围、1–1000000次及1–43200分钟');
    ids.add(rule.id);
    return { id: rule.id, resource: rule.resource, scope: rule.scope, ...(rule.scope === 'exact' ? { key: rule.key } : {}), limit: rule.limit, windowMinutes: rule.windowMinutes };
  }) };
}

// Counts reservations, not model claims of success. Suspension is derived from
// the current window's usage; it expires automatically. Approval resets early.
export class UsageQuotas {
  constructor({ config, state = null, now = Date.now, save = () => {}, notify = () => {}, audit = () => {}, onReset = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, waitMs = 300000 } = {}) {
    this.config = normalizeQuotaConfig(config); this.now = now; this.save = save; this.notify = notify; this.audit = audit; this.onReset = onReset;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.waitMs = waitMs; this.waiters = new Set();
    if (state !== null && (!state || state.version !== 1 || !Array.isArray(state.buckets) || state.buckets.length > 4096
      || new Set(state.buckets.map(b => b?.id)).size !== state.buckets.length
      || state.buckets.some(b => !b || !/^[a-f0-9]{64}$/.test(b.id ?? '') || !resourceOk(b.resource) || !Number.isSafeInteger(b.used) || b.used < 0
        || !Number.isSafeInteger(b.limit) || b.limit < 1 || !Number.isFinite(b.windowStart) || !Number.isSafeInteger(b.windowMs) || b.windowMs < 60000
        || typeof b.builtin !== 'boolean' || !(b.key === '*' || keyOk(b.key)) || typeof b.ruleId !== 'string'
        || !Number.isSafeInteger(b.cycle) || b.cycle < 0
        || (b.resetRevision !== undefined && (!Number.isSafeInteger(b.resetRevision) || b.resetRevision < 0))
        || (b.used >= b.limit && (!/^[a-f0-9]{32}$/.test(b.requestId ?? '') || !['pending', 'denied'].includes(b.decision)))))) throw frameworkError('用量状态损坏，拒绝自动清零；请恢复备份', 503);
    this.state = structuredClone(state ?? { version: 1, buckets: [] }); this.revision = 0;
    for (const b of this.state.buckets) { b.blocked = b.used >= b.limit; if (b.decision === 'pending' && b.notifiedAt === undefined) b.notifiedAt = b.requestedAt; }
    this.schedule();
  }
  get enabled() { return this.config.enabled; }
  commit(next) {
    // Persist counts and deadlines, never a permanent "blocked" flag.
    this.save({ ...next, buckets: next.buckets.map(({ blocked, ...bucket }) => bucket) });
    this.state = next; this.schedule();
    for (const wake of [...this.waiters]) wake();
  }
  configure(config) {
    const previous = this.config, updated = normalizeQuotaConfig(config), next = structuredClone(this.state), notifications = [];
    for (const b of next.buckets) if (!b.builtin) {
      const r = updated.rules.find(r => r.id === b.ruleId && r.resource === b.resource && r.windowMinutes * 60000 === b.windowMs
        && (r.scope === 'global' ? b.key === '*' : b.key !== '*' && (r.scope !== 'exact' || r.key === b.key)));
      if (!r) continue;
      const wasBlocked = b.blocked; b.limit = r.limit;
      if (this.now() >= b.windowStart + b.windowMs) { b.used = 0; b.windowStart = this.now(); b.cycle++; }
      b.blocked = b.used >= b.limit;
      if (b.blocked && !wasBlocked) { b.requestId = randomBytes(16).toString('hex'); b.requestedAt = this.now(); b.decision = 'pending'; b.notifiedAt = null; }
      else if (!b.blocked && wasBlocked) b.decision = 'cancelled';
    }
    this.config = updated;
    try { this.commit(next); } catch (error) { this.config = previous; throw error; }
    this.revision++;
    for (const b of notifications) this.dispatch(b);
    try { this.onReset({ key: '*', resource: 'config' }); } catch {}
    return structuredClone(this.config);
  }
  schedule() {
    this.clearTimer(this.timer);
    if (this.closed || !this.enabled) return;
    const deadlines = this.state.buckets.filter(b => b.blocked).map(b => b.windowStart + b.windowMs);
    if (!deadlines.length) return;
    this.timer = this.setTimer(() => {
      try { this.refresh(); } catch { this.timer = this.setTimer(() => this.schedule(), 5000); this.timer.unref?.(); }
    }, Math.min(60000, Math.max(1, Math.min(...deadlines) - this.now())));
    this.timer.unref?.();
  }
  refresh() {
    if (!this.enabled) return;
    const next = structuredClone(this.state), renewed = [];
    for (const b of next.buckets) if (b.blocked && this.now() >= b.windowStart + b.windowMs) {
      renewed.push(b);
      b.used = 0; b.blocked = false; b.windowStart = this.now(); b.cycle++; b.decision = 'expired';
    }
    if (next.buckets.some((b, i) => b.cycle !== this.state.buckets[i].cycle)) this.commit(next); else this.schedule();
    for (const b of renewed) { try { this.onReset(structuredClone(b)); } catch {} }
  }
  close() { this.closed = true; this.clearTimer(this.timer); for (const wake of [...this.waiters]) wake(); }
  async waitFor(operation, { budget = {}, assertLive = () => {}, signal, onWait = () => {} } = {}) {
    for (;;) {
      signal?.throwIfAborted(); assertLive();
      if (this.closed) throw frameworkError('额度任务已取消：桥接正在关闭', 503);
      if (budget.deadline && this.now() >= budget.deadline) {
        const error = frameworkError('等待额度已满5分钟，请根据已经取得的信息回应，并说明尚未读取的内容', 408);
        error.code = 'QUOTA_TIMEOUT'; throw error;
      }
      try { return operation(); } catch (error) {
        if (error.code !== 'QUOTA_EXHAUSTED' || this.waitMs === 0) throw error;
        budget.deadline ??= this.now() + this.waitMs;
        onWait(error);
        if (this.waiters.size >= 128) throw frameworkError('额度等待任务过多', 429);
        await new Promise((resolve, reject) => {
          let timer;
          const done = () => { this.clearTimer(timer); this.waiters.delete(done); signal?.removeEventListener('abort', aborted); resolve(); };
          const aborted = () => { done(); reject(signal.reason || Error('任务已取消')); };
          this.waiters.add(done); signal?.addEventListener('abort', aborted, { once: true });
          timer = this.setTimer(done, Math.max(1, Math.min(1000, budget.deadline - this.now(), (error.resetsAt || Infinity) - this.now())));
        });
      }
    }
  }
  rules(key, resource, legacy = []) {
    if (!this.enabled) return [];
    if (!keyOk(key) || !resourceOk(resource)) throw frameworkError('用量必须绑定真实会话与资源');
    const rules = this.config.rules.filter(r => r.resource === resource && (r.scope !== 'exact' || r.key === key)).map(r => ({
      ruleId: r.id, resource, scope: r.scope, key: r.scope === 'global' ? '*' : key, limit: r.limit, windowMs: r.windowMinutes * 60000, builtin: false,
    }));
    if (this.config.includeExisting) for (const [windowMs, limit] of legacy) if (Number.isSafeInteger(limit) && limit > 0) rules.push({
      ruleId: `existing:${windowMs}`, resource, scope: 'exact', key, limit, windowMs, builtin: true,
    });
    return rules.map(r => ({ ...r, id: hash([r.builtin, r.ruleId, r.resource, r.key, r.windowMs]) }));
  }
  denied(b) {
    const error = frameworkError(`用量暂满：${b.resource}（${b.used}/${b.limit}），${new Date(b.windowStart + b.windowMs).toISOString()} 自动恢复；可请管理员提前重置 ${b.requestId ?? ''}`, 429);
    error.code = 'QUOTA_EXHAUSTED'; error.resetsAt = b.windowStart + b.windowMs; return error;
  }
  consume(key, resource, { count = 1, legacy = [] } = {}) {
    this.refresh();
    const rules = this.rules(key, resource, legacy);
    if (!rules.length) return { check() {} };
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) fail('用量次数无效');
    const next = structuredClone(this.state), now = this.now(), notifications = [];
    // Prune obsolete, unblocked windows only. Outstanding reset requests survive.
    const activeIds = new Set(rules.map(r => r.id));
    next.buckets = next.buckets.filter(b => b.blocked || activeIds.has(b.id) || b.windowStart + b.windowMs > now);
    for (const rule of rules) {
      let b = next.buckets.find(b => b.id === rule.id);
      if (!b) { if (next.buckets.length >= 4096) throw frameworkError('用量计数容量已满', 429);
        b = { ...rule, used: 0, windowStart: now, blocked: false, cycle: 0, resetRevision: 0 }; next.buckets.push(b); }
      b.limit = rule.limit;
      if (now >= b.windowStart + b.windowMs) { b.used = 0; b.windowStart = now; b.cycle++; }
      b.blocked = b.used >= b.limit;
      if (b.blocked) {
        if (b.decision === 'pending' && b.notifiedAt == null) { b.notifiedAt = now; this.commit(next); this.dispatch(b); }
        throw this.denied(b);
      }
      if (b.used + count > b.limit) {
        throw this.denied(b);
      }
    }
    for (const rule of rules) {
      const b = next.buckets.find(b => b.id === rule.id); b.used += count;
      if (b.used >= b.limit) { b.blocked = true; b.requestId = randomBytes(16).toString('hex'); b.requestedAt = now; b.decision = 'pending'; b.notifiedAt = null; }
    }
    this.commit(next);
    for (const b of notifications) this.dispatch(b);
    const revision = this.revision;
    return { check: () => {
      if (revision !== this.revision) throw frameworkError('用量授权已变更，请重新获取额度', 409);
    } };
  }
  dispatch(bucket) {
    const data = structuredClone(bucket);
    Promise.resolve().then(() => {
      const current = this.state.buckets.find(b => b.id === data.id);
      if (this.enabled && current?.blocked && current.requestId === data.requestId && current.decision === 'pending'
        && this.now() < current.windowStart + current.windowMs) return this.notify(data);
    }).catch(() => {});
  }
  list() { this.refresh(); return this.state.buckets.map(b => ({ ...structuredClone(b),
    used: !b.blocked && this.now() >= b.windowStart + b.windowMs ? 0 : b.used,
    resetsAt: b.windowStart + b.windowMs, remainingMs: Math.max(0, b.windowStart + b.windowMs - this.now()) })); }
  resolve(requestId, decision) {
    this.refresh();
    if (!['approve', 'deny'].includes(decision)) fail('额度审核决定无效');
    const next = structuredClone(this.state), b = next.buckets.find(b => b.requestId === requestId);
    if (!b || !b.blocked || b.decision !== 'pending') throw frameworkError('重置申请不存在、已处理或窗口已结束', 409);
    this.audit({ event: `quota-reset-${decision}`, key: b.key, resource: b.resource, requestId, used: b.used, limit: b.limit });
    b.decision = decision === 'approve' ? 'approved' : 'denied';
    if (decision === 'approve') { b.used = 0; b.windowStart = this.now(); b.blocked = false; b.cycle++; b.resetRevision = (b.resetRevision || 0) + 1; }
    this.commit(next);
    if (decision === 'approve') { try { this.onReset(structuredClone(b)); } catch {} }
    return structuredClone(b);
  }
  requestAgain(id) {
    this.refresh();
    const next = structuredClone(this.state), b = next.buckets.find(b => b.id === id);
    if (!b?.blocked || b.decision !== 'denied') throw frameworkError('只有已拒绝且仍暂停的额度可以重新申请', 409);
    b.requestId = randomBytes(16).toString('hex'); b.requestedAt = this.now(); b.decision = 'pending'; b.notifiedAt = this.now(); this.commit(next); this.dispatch(b); return structuredClone(b);
  }
}
