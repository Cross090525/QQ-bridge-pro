import { SessionRouter, createInitialConversationState } from './session-router.mjs';

/** Fixed, opt-in routing. Config is authoritative; snapshots are diagnostic only. */
export function normalizeDualMode(value) {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('dualMode must be an object');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new TypeError('dualMode.enabled must be boolean');
  const ownerPreset = value.ownerPreset ?? 'standard';
  if (typeof ownerPreset !== 'string' || !ownerPreset.trim() || ownerPreset !== ownerPreset.trim()) {
    throw new TypeError('dualMode.ownerPreset must name an installed preset');
  }
  const ownerPrompt = value.ownerPrompt ?? '';
  if (typeof ownerPrompt !== 'string') throw new TypeError('dualMode.ownerPrompt must be text');
  return { enabled: value.enabled === true, ownerPreset, ownerPrompt };
}

export function createDualModeRouter(cfg) {
  const options = normalizeDualMode(cfg.dualMode);
  if (!options.enabled) return null;
  if (!cfg.ownerQQ) throw new TypeError('双模式必须配置 ownerQQ');
  const simulationPreset = String(cfg.socialV2?.agentPreset || cfg.agentPreset || 'qq-chat-v2');
  if (simulationPreset === options.ownerPreset) throw new TypeError('双模式的群聊与管理员必须使用不同 preset');
  const modePresets = {
    simulation: [simulationPreset], reserved2: [simulationPreset],
    'closed-agent': [options.ownerPreset], chat: [cfg.agentPreset || 'qq-chat'], reserved: [cfg.agentPreset || 'qq-chat'],
  };
  const state = createInitialConversationState(cfg.ownerQQ, {
    defaultMode: 'simulation', closedAgentEnabled: true, modePresets,
  });
  return new SessionRouter({ ownerQQ: cfg.ownerQQ, defaultMode: 'simulation', state, modePresets });
}

export function legacyModeOf(router, key, fallback) {
  if (!router) return fallback;
  return router.modeFor(key) === 'closed-agent' ? 'closed-agent' : 'reserved2';
}
