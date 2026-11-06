// Conversation relationships come from gateway segments, never from quoted text.
import { normalizeMessageFreshness, describeMessageFreshness } from './message-freshness.mjs';
const userId = value => /^[1-9]\d{0,15}$/.test(String(value ?? '')) ? String(value) : null;
export function normalizeAddressing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    mentionedUserIds: [...new Set((Array.isArray(value.mentionedUserIds) ? value.mentionedUserIds : []).map(userId).filter(Boolean))].slice(0, 20),
    mentionsSelf: value.mentionsSelf === true, mentionsAll: value.mentionsAll === true,
    replyTarget: ['none', 'self', 'other', 'unknown'].includes(value.replyTarget) ? value.replyTarget : 'unknown',
    replyToUserId: userId(value.replyToUserId),
  };
}

export function messageAddressing(segments, selfId, replyInfo = null, quoteTargetIsSelf = false) {
  const list = Array.isArray(segments) ? segments : [];
  const ids = list.filter(s => s?.type === 'at').map(s => String(s.data?.qq ?? ''));
  const reply = list.find(s => s?.type === 'reply' && s.data?.id != null);
  const target = userId(replyInfo?.userId), self = userId(selfId);
  return normalizeAddressing({ mentionedUserIds: ids, mentionsSelf: !!self && ids.includes(self), mentionsAll: ids.includes('all'),
    replyTarget: !reply ? 'none' : target && self ? (target === self ? 'self' : 'other') : quoteTargetIsSelf ? 'self' : 'unknown',
    replyToUserId: target });
}

const GROUP_GUIDANCE = '【群聊参与边界】观察到消息只表示可以理解，不表示有人在对你说话。先看实际@对象、引用对象和前后对话：addressing.mentionedUserIds/mentionsSelf/replyTarget是网关提供的指向，replyTarget=unknown表示未能确认，不可猜成自己。问号、“你”、出现你的名字、你感兴趣、你刚说过话，都不足以单独认定在叫你；第三人称评价也不是邀请。明确@或引用他人的消息默认observe，不代替对方回答，不把别人的“你”认成自己，不抢两人之间的对话。明确叫你、确实接着与你交流，或者适合参与的开放话题，才考虑回复。关系不明先观察；不能为了证明自己在场而说话。普通图片、视频或链接分享不要求报告解析状态。选择观察时安静确认已读或继续等待，不发送“与我无关”“我潜水了”等说明。被唤醒、随机触发、普通提问、媒体准备完成都不是发言命令；人设决定怎么说，不能替代要不要说的判断。';
const PRIVATE_GUIDANCE = '【私聊参与边界】对方当前发给你的话通常可以直接回应，结合语境保持自然节奏；引用、转发或提及第三人时仍须区分原话的对象，不能把引用内容里的“你”自动认成自己。';

const STYLES = {
  cautious: '谨慎：开放话题以必要回答或具体补充为主，通常先听别人；明确与你交流时正常回应。',
  natural: '自然：没有指定对象的开放话题可以自然加入，回答、补充、共鸣和贴切玩笑都有价值，不必每次提供新知识；别人已接得很好就不重复。',
  active: '活跃：开放话题中可以更主动分享观点、接梗和交流；积极不等于每条都回，明确对别人说的话仍默认观察。',
};
export const PARTICIPATION_REASONS = Object.freeze({
  direct: '明确呼叫或引用机器人', continuation: '判断为延续与机器人的交流', open: '判断为开放话题',
  other: '存在其他明确交流对象', unknown: '交流对象尚不明确', observe: '决定继续观察',
  need_context: '决定补充上下文', sent: '已实际发送一次参与', recheck: '出现未复核的新消息，暂缓发送',
});
export function participationDecisionFields(value) {
  if (value.audience !== undefined && !['direct', 'continuation', 'open', 'other', 'unknown'].includes(value.audience)) invalid('decision.audience无效');
  if (value.intent !== undefined && !['answer', 'supplement', 'empathy', 'humor', 'follow_up'].includes(value.intent)) invalid('decision.intent无效');
  return { ...(value.audience === undefined ? {} : { audience: value.audience }), ...(value.intent === undefined ? {} : { intent: value.intent }) };
}
const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const groupKey = value => /^group:[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value.split(':')[1]));
export function normalizeParticipationPolicy(value = {}, base = {}) {
  if (!object(value) || Object.keys(value).some(k => !['style', 'allowHumor', 'allowEmpathy', 'allowFollowUp'].includes(k))) invalid('接话设置包含未知字段');
  const out = { style: 'natural', allowHumor: true, allowEmpathy: true, allowFollowUp: false, ...base, ...value };
  if (typeof out.style !== 'string' || !Object.hasOwn(STYLES, out.style)) invalid('接话风格必须为 cautious、natural 或 active');
  for (const k of ['allowHumor', 'allowEmpathy', 'allowFollowUp']) if (typeof out[k] !== 'boolean') invalid(`${k}必须为布尔值`);
  return out;
}
export function normalizeParticipationConfig(value = {}) {
  if (!object(value) || Object.keys(value).some(k => !['defaults', 'groups'].includes(k))) invalid('participation配置无效');
  const defaults = normalizeParticipationPolicy(value.defaults === undefined ? {} : value.defaults), groups = Object.create(null);
  if (value.groups !== undefined && (!object(value.groups) || Object.keys(value.groups).length > 128)) invalid('接话群设置最多128项');
  for (const [key, policy] of Object.entries(value.groups ?? {})) {
    if (!groupKey(key)) invalid('接话覆盖只接受有效group:群号');
    // Keep overrides partial so future default changes still reach inherited fields.
    normalizeParticipationPolicy(policy, defaults); groups[key] = { ...policy };
  }
  return { defaults, groups };
}
export function participationContext(key, policy = {}) {
  const group = String(key).startsWith('group:');
  const settings = normalizeParticipationPolicy(policy);
  return { conversationType: group ? 'group' : 'private', defaultAction: group ? 'observe' : 'consider_reply',
    policy: settings, guidance: group ? [GROUP_GUIDANCE, STYLES[settings.style],
      '风格控制开放参与的积极度，以下具体开关优先。',
      settings.allowHumor ? '允许贴切的玩笑和接梗，但不能借此错认对象或重复插话。' : '本群不主动靠玩笑或接梗加入开放话题。',
      settings.allowEmpathy ? '允许对开放分享作简短共鸣和自然反应。' : '本群不单为附和或共鸣加入开放话题。',
      settings.allowFollowUp ? '无人承接时最多补充一次必要的新内容，随后让出话头。' : '无人承接就停，不连续补话或追问。',
      '有人确实接你的话，可以正常来回，不要求每句点名；同一人发新消息不自动表示仍在与你交流。',
      '用qq_working_memory update记录decision时可提供audience=direct/continuation/open/other/unknown、intent=answer/supplement/empathy/humor/follow_up及实际sources；只描述当前这段交流。决定reply不等于已发送。',
    ].join('\n') : PRIVATE_GUIDANCE };
}

// Durable state contains bounded outcomes and source handles, never reply text or private reasoning.
export function normalizeParticipationState(value = {}) {
  const turns = (Array.isArray(value?.turns) ? value.turns : []).filter(x => Number.isFinite(x?.at) && Number.isSafeInteger(x?.afterSeq) && x.afterSeq >= 0)
    .slice(-40).map(x => ({ at: x.at, afterSeq: x.afterSeq }));
  const history = (Array.isArray(value?.history) ? value.history : []).filter(x => Number.isFinite(x?.at) && typeof x.reason === 'string' && Object.hasOwn(PARTICIPATION_REASONS, x.reason))
    .slice(-20).map(x => ({ at: x.at, action: ['observe', 'need_context', 'reply', 'sent', 'recheck'].includes(x.action) ? x.action : 'observe',
      reason: x.reason, sources: (Array.isArray(x.sources) ? x.sources : []).filter(s => typeof s === 'string' && s.length <= 120).slice(0, 10) }));
  return { turns, history };
}
const audienceOf = message => {
  const a = message?.addressing;
  if (a?.mentionsSelf || a?.replyTarget === 'self' || message?.quoteTargetIsSelf) return 'direct';
  if (a?.replyTarget === 'other' || a?.mentionedUserIds?.length && !a.mentionsSelf) return 'other';
  return 'unknown';
};
export class ParticipationManager {
  constructor({ getState, getConfig = () => ({}), getMessages, getFreshness = () => ({}), now = Date.now }) {
    this.getState = getState; this.getConfig = getConfig; this.now = now; this.live = new Map();
    this.getMessages = getMessages; this.getFreshness = getFreshness;
  }
  session(key) {
    const state = this.getState(key);
    if (this.live.get(key)?.token !== state.agentToken) this.live.set(key, { token: state.agentToken, seen: new Set(), plan: null });
    state.participation = normalizeParticipationState(state.participation);
    return { state, live: this.live.get(key) };
  }
  policy(key) {
    const config = normalizeParticipationConfig(this.getConfig());
    return normalizeParticipationPolicy(config.groups[key] ?? {}, config.defaults);
  }
  presented(key, messages) {
    const { live } = this.session(key);
    for (const m of messages) if (!m.isSelf && Number.isSafeInteger(m.seq)) live.seen.add(m.seq);
    if (live.seen.size > 500) live.seen = new Set([...live.seen].sort((a, b) => a - b).slice(-500));
  }
  remember(key, action, reason, sources = []) {
    const { state } = this.session(key);
    state.participation.history.push({ at: this.now(), action, reason, sources: sources.slice(0, 10) });
    state.participation.history = state.participation.history.slice(-20);
  }
  decided(key, decision, evidence) {
    const { live } = this.session(key);
    const received = evidence.filter(m => !m.isSelf);
    this.presented(key, received);
    const actual = received.map(audienceOf);
    const audience = actual.includes('direct') ? 'direct' : actual.length && actual.every(x => x === 'other') ? 'other' : decision.audience || 'unknown';
    live.plan = { action: decision.action, audience, intent: decision.intent || 'answer', sources: [...decision.sources],
      currentEvidence: evidence.some(message => Object.hasOwn(message, 'replyEligible'))
        ? evidence.filter(message => message.replyEligible && !message.isSelf).map(message => ({
          id: message.id, seq: message.seq, eventAt: message.eventAt, receivedAt: message.receivedAt, time: message.time,
        })) : null,
      at: this.now(), seq: Math.max(0, ...live.seen), policy: JSON.stringify(this.policy(key)) };
    this.remember(key, decision.action, decision.action === 'reply' || audience === 'other' ? audience : decision.action, decision.sources);
  }
  sent(key, count) {
    if (!count) return;
    const { state, live } = this.session(key);
    // Text, stickers and partial batches belonging to one decision form one participation.
    if (live.plan?.sent) return;
    if (live.plan) live.plan.sent = true;
    state.participation.turns.push({ at: this.now(), afterSeq: live.plan?.seq ?? state.lastUnreadSeq ?? 0 });
    state.participation.turns = state.participation.turns.slice(-40);
    this.remember(key, 'sent', 'sent', this.live.get(key)?.plan?.sources || []);
  }
  discarded(key, ids) {
    const { state, live } = this.session(key), removed = new Set(ids);
    state.participation.history = state.participation.history.filter(x => !x.sources.some(id => removed.has(id)));
    if (live.plan?.sources.some(id => removed.has(id))) live.plan = null;
  }
  context(key, { history = false } = {}) {
    const { state, live } = this.session(key), now = this.now(), policy = this.policy(key);
    const recent = state.recentMessages || [], incoming = recent.filter(m => !m.isSelf);
    const latest = incoming.at(-1), actualAudience = audienceOf(latest);
    const plan = live.plan && now - live.plan.at < 5 * 60000 && live.plan.seq === (state.lastUnreadSeq || 0) ? live.plan : null;
    const turns = state.participation.turns.filter(t => now - t.at < 3600000), lastTurn = turns.at(-1);
    const directSinceTurn = lastTurn && incoming.some(m => m.seq > lastTurn.afterSeq && audienceOf(m) === 'direct');
    let phase = 'observing';
    if (actualAudience === 'direct' && (!lastTurn || latest?.seq > lastTurn.afterSeq)) phase = 'invited';
    else if (plan?.action === 'reply' && plan.audience === 'continuation') phase = 'engaged';
    else if (lastTurn && now - lastTurn.at < 5 * 60000 && !directSinceTurn) phase = 'yielding';
    const activity = { turnsLastHour: turns.length, messagesLastHour: recent.filter(m => m.isSelf && now - m.time < 3600000).length,
      othersLastFiveMinutes: incoming.filter(m => now - m.time < 5 * 60000).length };
    const hint = phase === 'yielding' ? '你已参与过这段交流；先确认是否有人承接，无人承接就让出话头。其他开放话题仍可独立判断。'
      : phase === 'invited' ? '有明确找你的新消息，优先查看语境。' : phase === 'engaged' ? '当前记录为延续与你的交流，只对这些来源有效。' : '开放话题可以自然加入，关系不明先听；不因近期发言少而补足次数。';
    const summary = String(key).startsWith('private:') ? '【参与状态】私聊按当前来信自然回应，引用内容仍须区分对象。'
      : `【参与状态】${phase}；近一小时已记录参与${activity.turnsLastHour}次（近期缓存中发送${activity.messagesLastHour}条）。${hint}`;
    return { ...participationContext(key, policy), phase, audience: actualAudience, activity, summary, plan: plan && { action: plan.action, audience: plan.audience, intent: plan.intent, sources: plan.sources },
      ...(history ? { history: state.participation.history.map(x => ({ ...x, reasonText: PARTICIPATION_REASONS[x.reason] })) } : {}),
      guidance: participationContext(key, policy).guidance + '\n' + summary };
  }
  assertReplyTarget(key, targetId, state, plan) {
    if (targetId == null || String(targetId).trim() === '') return;
    const id = String(targetId).trim();
    const policy = normalizeMessageFreshness(this.getFreshness());
    const messages = this.getMessages ? this.getMessages(key) : state.recentMessages || [];
    const options = { now: this.now(), readThroughSeq: state.lastReadThroughSeq || 0, policy };
    const reintroduced = messages.some(message => {
      const context = describeMessageFreshness(message, options);
      return !message.isSelf && !context.stale && String(message.replyToMessageId || '') === id
        && (context.replyEligible || plan?.currentEvidence?.some(source => source.id === message.id));
    });
    if (reintroduced) return;
    const target = messages.find(message => String(message.messageId || '') === id || message.id === `qq:${id}`);
    if (!target || describeMessageFreshness(target, options).stale) {
      throw Object.assign(new Error('引用目标已过回复时限或缺少可核验时间，请针对当前来信重新判断；用户重新引用旧消息后可以继续'), { statusCode: 409 });
    }
  }
  assertSend(key, { replyToMessageId } = {}) {
    if (!String(key).startsWith('group:')) return;
    const { state, live } = this.session(key), plan = live.plan;
    this.assertReplyTarget(key, replyToMessageId, state, plan);
    // Legacy callers without a structured decision retain their existing behavior.
    if (!plan) return;
    if (this.now() - plan.at > 5 * 60000) throw Object.assign(new Error('接话决策已过期，请重新读取上下文并更新decision'), { statusCode: 409 });
    if (plan.action !== 'reply') throw Object.assign(new Error('当前参与决策为观察或补充上下文，请先更新reply决策再发送'), { statusCode: 409 });
    if (plan.currentEvidence !== null) {
      const options = { now: this.now(), policy: normalizeMessageFreshness(this.getFreshness()) };
      if (!plan.currentEvidence.some(message => !describeMessageFreshness(message, options).stale)) {
        throw Object.assign(new Error('决策依据只有历史参考或已过回复时限，请读取当前来信并更新decision，勿补回旧话'), { statusCode: 409 });
      }
    }
    const newer = (state.recentMessages || []).filter(m => !m.isSelf && m.seq > plan.seq);
    const changedPolicy = plan.policy !== JSON.stringify(this.policy(key));
    if (changedPolicy || newer.some(m => !live.seen.has(m.seq))) {
      this.remember(key, 'recheck', 'recheck', plan.sources);
      throw Object.assign(new Error('接话前出现新消息或设置变化，请读取最新消息与参与规则，并更新decision后再发送'), { statusCode: 409 });
    }
    // Reading is necessary but not sufficient: refresh a stale plan after reviewing new context.
    if (newer.length) {
      this.remember(key, 'recheck', 'recheck', plan.sources);
      throw Object.assign(new Error('已读到新的群消息，请重新判断交流对象并更新decision后再发送'), { statusCode: 409 });
    }
  }
}
