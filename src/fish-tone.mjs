import fs from 'node:fs';

export const FISH_TONE_DEFAULTS = Object.freeze({ enabled: true, style: 'neutral', strength: 'light', rewriteEnabled: false });
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
export function normalizeFishToneOptions(value = {}, partial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !own(FISH_TONE_DEFAULTS, k))) throw Error('聊天表达设置含未知字段');
  const result = partial ? {} : { ...FISH_TONE_DEFAULTS };
  for (const [key, v] of Object.entries(value)) {
    if (['enabled', 'rewriteEnabled'].includes(key) ? typeof v !== 'boolean'
      : key === 'style' ? !['neutral', 'cute', 'abstract'].includes(v) : !['off', 'light', 'normal', 'max'].includes(v)) throw Error('聊天表达设置字段无效');
    result[key] = v;
  }
  return result;
}
export function normalizeFishToneSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['version', 'defaults', 'conversations', 'roles'].includes(k))
    || value.version !== undefined && value.version !== 1) throw Error('聊天表达设置结构无效');
  const out = { version: 1, defaults: normalizeFishToneOptions(value.defaults), conversations: {}, roles: {} };
  for (const field of ['conversations', 'roles']) {
    const entries = value[field] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 256) throw Error('聊天表达覆盖项无效');
    for (const [key, options] of Object.entries(entries)) {
      if (field === 'conversations' ? !/^(group|private):[1-9]\d{0,15}$/.test(key) : !/^[\p{L}\p{N}_-]{1,64}$/u.test(key)) throw Error('聊天表达覆盖目标无效');
      Object.defineProperty(out[field], key, { value: normalizeFishToneOptions(options, true), enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}
export function loadFishToneSettings(file) {
  try { return normalizeFishToneSettings(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return normalizeFishToneSettings(); throw Error('聊天表达配置损坏，请管理员修复'); }
}
export function resolveFishTone(settings, { key, role } = {}) {
  const s = normalizeFishToneSettings(settings);
  return { ...s.defaults, ...(own(s.roles, role) ? s.roles[role] : {}), ...(own(s.conversations, key) ? s.conversations[key] : {}) };
}
export function fishTonePrompt(settings, context = {}) {
  const cfg = resolveFishTone(settings, context);
  if (!cfg.enabled || cfg.strength === 'off') return '【聊天表达】本会话关闭额外语气修饰。保持原有人格和自然表达，不按配额加语气词、梗或错字。\n\n';
  const style = { neutral: '保持原有人格，不额外添加可爱或抽象口癖。', cute: '适度温和可爱，偶尔使用自然语气词，避免句句撒娇。', abstract: '只在语境合适时少量用梗，不强行挖苦或冒犯。' }[cfg.style];
  return `【聊天表达】自然回应对方，少复述、少套话，不为显得有见解堆句式。${style}不编经历、关系、事实，不故意写错字；严谨说明、数字、代码和结论保持准确。草稿生硬时按需发现text.judge，梗义不清查text.meme；无需每次检查。${cfg.rewriteEnabled ? 'text.tone仅在已获授权且确需润色时使用，核对原意后自行决定是否采用。' : '本会话关闭机械润色，不调用text.tone。'}\n\n`;
}
