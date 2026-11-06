const MINUTE = 60 * 1000;

export function normalizeMessageFreshness(config = {}) {
  const policy = {
    replyMaxAgeMs: config.replyMaxAgeMs ?? 30 * MINUTE,
    historyMaxAgeMs: config.historyMaxAgeMs ?? 2 * 60 * MINUTE,
  };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < MINUTE || value > 7 * 24 * 60 * MINUTE) {
      throw Object.assign(new Error(`${name}须为一分钟至七天之间的整数毫秒`), { statusCode: 400 });
    }
  }
  if (policy.replyMaxAgeMs > policy.historyMaxAgeMs) {
    throw Object.assign(new Error('回复时限不能长于自动上下文保留窗口'), { statusCode: 400 });
  }
  return policy;
}

export function describeMessageFreshness(message, { now = Date.now(), readThroughSeq = 0, policy = normalizeMessageFreshness() } = {}) {
  const timeBasis = ['eventAt', 'receivedAt', 'time'].find(field => Number.isFinite(message[field]) && message[field] > 0);
  const ageMs = timeBasis ? now - message[timeBasis] : null;
  const clockValid = ageMs !== null && ageMs >= -5 * MINUTE;
  const stale = !clockValid || ageMs > policy.replyMaxAgeMs;
  const acknowledged = Number.isSafeInteger(message.seq) && message.seq > 0 && message.seq <= readThroughSeq;
  const historical = message.isSelf === true || acknowledged || stale;
  return {
    ...message,
    ageMs,
    timeBasis: timeBasis || 'unknown',
    historical,
    stale,
    acknowledged,
    replyEligible: !historical,
    contextEligible: clockValid && ageMs <= policy.historyMaxAgeMs,
    contextRole: historical ? 'historical_reference' : 'current_input',
  };
}

export const MESSAGE_FRESHNESS_GUIDANCE = '消息的historical、stale、acknowledged、replyEligible和contextRole由桥接提供。只有current_input且replyEligible=true的来信可作为本轮接话依据。历史参考用于理解、检索和整理，不作为新提问，也不能仅因尚未整理就补回旧话。当前用户重新引用或明确重提旧事时，围绕当前来信回应。historyOmittedCount表示超出自动上下文窗口的原文数量，按需查询，不为补回旧话反复读取。';
