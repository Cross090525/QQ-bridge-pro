// Shared temporal semantics; storage expiry remains distinct from factual validity.
const fail = text => { throw Object.assign(Error(text), { statusCode: 400 }); };
export function temporalMetadata(metadata) {
  const value = metadata?.temporal;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['validFrom','validTo','eventAt','timeZone','precision','originalTimeText','sources','assertionType','supersedes'].includes(k))) fail('时效记忆字段无效');
  for (const field of ['validFrom','validTo','eventAt']) if (value[field] != null && (!Number.isSafeInteger(value[field]) || value[field] <= 0)) fail('记忆时间须为正毫秒时间戳或null');
  if (value.validFrom != null && value.validTo != null && value.validFrom > value.validTo) fail('事实有效区间必须从早到晚');
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 10 || value.sources.some(id => typeof id !== 'string' || !id || id.length > 128)) fail('时效记忆必须带1至10条来源');
  if (!['reported','inferred'].includes(value.assertionType)) fail('时效记忆须区分明确陈述与推断');
  if (!['instant','calendar-day','range','unknown'].includes(value.precision)) fail('时间精度无效');
  if (value.originalTimeText !== undefined && (typeof value.originalTimeText !== 'string' || value.originalTimeText.length > 200)) fail('原时间表达过长');
  if (value.supersedes !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.supersedes))) fail('被替代记忆ID无效');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { fail('时区无效'); }
  if (typeof value.timeZone !== 'string' || !value.timeZone) fail('时效记忆需要明确时区');
  return value;
}
export function temporalQuery(options = {}) {
  const q = options.temporal;
  if (q === undefined) return { mode: 'current', at: Date.now() };
  if (!q || typeof q !== 'object' || Array.isArray(q) || Object.keys(q).some(k => !['mode','at'].includes(k))
      || !['current','history'].includes(q.mode) || (q.at !== undefined && (!Number.isSafeInteger(q.at) || q.at <= 0))) fail('时间查询参数无效');
  return { mode: q.mode, at: q.at ?? Date.now() };
}
export function selectTemporal(items, options = {}, now = Date.now()) {
  const query = { ...temporalQuery(options), at: options.temporal?.at ?? now };
  const superseded = new Set(items.filter(item => {
    const t = temporalMetadata(item.metadata);
    return t?.supersedes && (t.validFrom == null || t.validFrom <= query.at);
  }).map(item => item.metadata.temporal.supersedes));
  return items.filter(item => {
    const t = temporalMetadata(item.metadata);
    if (query.mode === 'history' && options.temporal?.at === undefined) return true;
    if (query.mode !== 'history' && item.expiresAt && item.expiresAt <= now) return false;
    if (!t) return true;
    return !superseded.has(item.id) && (t.validFrom == null || t.validFrom <= query.at) && (t.validTo == null || query.at < t.validTo);
  });
}
