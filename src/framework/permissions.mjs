import crypto from 'node:crypto';
import { frameworkError } from './content.mjs';

const DECISIONS = new Set(['deny', 'ask', 'allow']);
const SCOPES = new Set(['source-reference', 'source-bytes', 'input', 'media-upload', 'memory-query', 'memory-write', 'history-export']);
const KEY = /^(group|private):[1-9]\d*$/;
const CAPABILITY = /^[a-z][a-z0-9.-]{0,95}$/;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
export function permissionDigest(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function integer(value, fallback, min, max) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw frameworkError('扩展权限额度配置无效');
  return value;
}
export function normalizePermissionPolicy(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => !['rules'].includes(key))
      || !Array.isArray(config.rules ?? []) || (config.rules ?? []).length > 256) throw frameworkError('permissions 仅支持至多 256 条 rules，默认拒绝');
  return { rules: (config.rules ?? []).map(rule => {
    if (!rule || Object.keys(rule).some(key => !['key', 'capability', 'decision', 'dataScopes', 'maxCallsPerMinute', 'maxCallsPerHour', 'maxInputChars'].includes(key))
        || !KEY.test(rule.key ?? '') || !CAPABILITY.test(rule.capability ?? '') || !DECISIONS.has(rule.decision)
        || !Array.isArray(rule.dataScopes ?? []) || (rule.dataScopes ?? []).some(scope => !SCOPES.has(scope))) throw frameworkError('权限规则必须使用准确会话、能力、decision 与 dataScopes，不支持通配符');
    return { key: rule.key, capability: rule.capability, decision: rule.decision, dataScopes: [...new Set(rule.dataScopes ?? [])].sort(),
      maxCallsPerMinute: integer(rule.maxCallsPerMinute, 6, 1, 60), maxCallsPerHour: integer(rule.maxCallsPerHour, 60, 1, 1000),
      maxInputChars: integer(rule.maxInputChars, 2000, 1, 12000000) };
  }) };
}

// The broker never executes work. Approval produces a single-use permit for an
// exact request, which the authenticated caller must retry with approvalId.
export class ExtensionPermissions {
  constructor({ policy = {}, now = Date.now, onAudit = () => {}, audit = [], ttlMs = 300000 } = {}) {
    this.now = now; this.onAudit = onAudit; this.ttlMs = ttlMs;
    this.requests = new Map(); this.usage = new Map(); this.audit = audit.slice(-500);
    this.replacePolicy(policy);
  }
  replacePolicy(policy) {
    this.policy = normalizePermissionPolicy(policy);
    this.revision = crypto.randomBytes(16).toString('hex');
  }
  record(event) {
    const entries = [...this.audit.filter(item => item.at > this.now() - 7 * 86400000), { at: this.now(), ...event }].slice(-500);
    // A broken audit destination must not silently authorize new executions.
    try { this.onAudit(entries); } catch { throw frameworkError('扩展审计不可写，拒绝执行', 503); }
    this.audit = entries;
  }
  decision(key, capability, manifest) {
    const matches = this.policy.rules.filter(rule => rule.key === key && rule.capability === capability);
    if (matches.some(rule => rule.decision === 'deny')) return { decision: 'deny' };
    // Ambiguous overlapping grants must not accidentally widen privileges.
    if (matches.length !== 1) return { decision: 'deny' };
    const rule = matches[0];
    const decision = rule.decision === 'allow' && !['read', 'generate'].includes(manifest.effect) ? 'ask' : rule.decision;
    return { ...rule, decision };
  }
  inspect(request) {
    const rule = this.decision(request.key, request.capability, request.manifest);
    if (rule.decision !== 'deny' && (request.dataScopes ?? []).some(scope => !rule.dataScopes.includes(scope))) return { decision: 'deny' };
    return rule;
  }
  prune() {
    for (const request of this.requests.values()) {
      if (['pending', 'approved'].includes(request.status)) {
        if (request.expiresAt <= this.now()) request.status = 'expired';
        else { try { request.check(); } catch { request.status = 'revoked'; } }
      }
    }
    // Keep expired tombstones for another TTL to reject accidental replays.
    for (const [id, request] of this.requests) if (request.expiresAt + this.ttlMs <= this.now()) this.requests.delete(id);
    for (const [id, times] of this.usage) {
      const live = times.filter(time => time > this.now() - 3600000);
      if (live.length) this.usage.set(id, live); else this.usage.delete(id);
    }
  }
  publicRequest(request, admin = false) {
    return { requestId: request.requestId, key: request.key, capability: request.capability, effect: request.manifest.effect,
      status: request.status, createdAt: request.createdAt, expiresAt: request.expiresAt,
      ...(admin ? { description: request.manifest.description ?? '', destination: request.manifest.destination ?? '',
        entrypoint: request.manifest.entrypoint ?? '', dataScopes: request.dataScopes, input: request.input,
        source: request.source ? { sourceId: request.source.sourceId, type: request.source.type, messageId: request.source.messageId,
          ...(request.source.url ? { url: request.source.url } : {}) } : null,
        limits: request.rule, requestHash: request.signature } : {}) };
  }
  listRequests() { this.prune(); return [...this.requests.values()].map(request => this.publicRequest(request, true)); }
  resolve(requestId, decision) {
    this.prune();
    const request = this.requests.get(requestId);
    if (!request || !['approve', 'deny'].includes(decision)) throw frameworkError('审批请求或决策无效', 404);
    if (!['pending', 'approved'].includes(request.status) || (decision === 'approve' && request.status !== 'pending')) throw frameworkError('审批已处理、失效或已消费', 409);
    request.check();
    this.record({ key: request.key, capability: request.capability, requestId, requestHash: request.signature,
      event: decision === 'approve' ? 'approved' : 'denied', actor: 'console' });
    request.status = decision === 'approve' ? 'approved' : 'denied';
    return this.publicRequest(request, true);
  }
  authorize({ key, scope, capability, manifest, source = null, input = {}, dataScopes = [], approvalId,
    assertLive = () => {}, currentManifest = () => manifest }) {
    this.prune(); assertLive();
    const rule = this.inspect({ key, capability, manifest, dataScopes });
    const revision = this.revision;
    const manifestHash = permissionDigest(manifest);
    const requestHash = permissionDigest({ scope, key, capability, manifestHash, revision, source, input, dataScopes });
    const check = () => {
      assertLive();
      if (revision !== this.revision || manifestHash !== permissionDigest(currentManifest())) throw frameworkError('扩展权限或服务版本已变化', 403);
    };
    if (rule.decision === 'deny') {
      this.record({ key, capability, requestHash, event: 'blocked' });
      throw frameworkError('当前会话未获此能力或数据范围授权', 403);
    }
    if (JSON.stringify(input).length > rule.maxInputChars) throw frameworkError('调用参数超过授权字数上限', 413);
    let approval;
    if (approvalId) {
      approval = this.requests.get(approvalId);
      if (!approval || approval.signature !== requestHash || !['pending', 'approved'].includes(approval.status)) throw frameworkError('审批不匹配、已失效或已消费', 403);
    }
    if (rule.decision === 'ask') {
      if (JSON.stringify(input).length > 64000) throw frameworkError('待审批参数过大，请管理员缩小请求或配置明确授权', 413);
      approval ??= [...this.requests.values()].find(item => item.signature === requestHash);
      if (approval && !['pending', 'approved'].includes(approval.status)) throw frameworkError('该请求已拒绝、过期或消费；请勿重复执行', 409);
      if (!approval) {
        if (this.requests.size >= 128 || [...this.requests.values()].filter(item => item.key === key && ['pending', 'approved'].includes(item.status)).length >= 8) throw frameworkError('待审批请求过多', 429);
        const requestId = crypto.randomBytes(16).toString('hex');
        approval = { requestId, signature: requestHash, key, capability, manifest: structuredClone(manifest), source: structuredClone(source),
          input: structuredClone(input), dataScopes: [...dataScopes], rule, check, status: 'pending', createdAt: this.now(), expiresAt: this.now() + this.ttlMs };
        this.record({ key, capability, requestHash, requestId, event: 'requested' });
        this.requests.set(requestId, approval);
      }
      if (approval.status === 'pending') return { pending: { status: 'approval_required', approval: this.publicRequest(approval),
        note: '尚未执行。请管理员在控制台批准，再携带 approvalId=requestId 和完全相同的参数重试一次；不要轮询或另起服务绕过审批。' } };
      // Even an identical request needs the explicit approval ID to consume it.
      if (!approvalId) return { pending: { status: 'approval_required', approval: this.publicRequest(approval), note: '已批准，请携带 approvalId=requestId 重试原请求。' } };
    }
    const usageId = `${key}\0${capability}`;
    const times = this.usage.get(usageId) ?? [];
    if (times.filter(time => time > this.now() - 60000).length >= rule.maxCallsPerMinute || times.length >= rule.maxCallsPerHour) throw frameworkError('扩展调用次数超过授权额度', 429);
    if (this.usage.size >= 4096 && !this.usage.has(usageId)) throw frameworkError('扩展配额容量已满', 429);
    check();
    this.record({ key, capability, requestHash, requestId: approval?.requestId, event: 'started', dataScopes,
      destinationHash: permissionDigest(manifest.destination ?? '') });
    // No await between checking and consuming: concurrent retries cannot double spend.
    if (approval) approval.status = 'consumed';
    this.usage.set(usageId, [...times, this.now()]);
    return { check, finish: event => this.record({ key, capability, requestHash, requestId: approval?.requestId, event }) };
  }
}
