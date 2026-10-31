// Read-only, task-scoped projection. Never includes credentials, transport refs or long-term memory.
export function projectDebateContext(task, state = {}, persona = '') {
  const result = { persona: String(persona).slice(0, 3000), messages: [], topics: [], media: [] };
  if (!task.includeContext) return result;
  const eventMessages = new Set(task.events.map(e => e.messageId));
  const matches = text => task.keywords.some(word => String(text).toLowerCase().includes(word.toLowerCase()));
  const selected = (state.messages || []).filter(m => m.debateTaskId !== task.id && (eventMessages.has(m.messageId)
    || matches(m.text ?? m.plain) || String(m.userId) === task.targetId)).slice(-12);
  const selectedIds = new Set(selected.map(m => m.id));
  const sources = new Set(selected.flatMap(m => (m.media || []).map(s => s.sourceId)));
  result.messages = selected.map(m => ({ id: m.id, messageId: m.messageId, userId: m.userId,
    sender: String(m.sender || '').slice(0, 100), text: String(m.text ?? m.plain ?? '').slice(0, 800),
    isSelf: Boolean(m.isSelf), time: Number(m.time) || 0, replyToMessageId: m.replyToMessageId || '' }));
  // Actual recent replies help avoid parallel ordinary/debate responses to one point.
  result.recentReplies = (state.messages || []).filter(m => m.isSelf && m.debateTaskId !== task.id).slice(-3)
    .map(m => ({ text: String(m.text ?? m.plain ?? '').slice(0, 800), origin: m.origin || 'chat', time: m.time }));
  result.topics = (state.topics || []).filter(t => matches(t.text) || t.sources?.some(id => selectedIds.has(id))).slice(-5)
    .map(t => ({ text: String(t.text).slice(0, 500), certainty: t.certainty, status: t.status }));
  result.media = (state.media || []).filter(m => sources.has(m.sourceId)).slice(-6)
    .map(m => ({ sourceId: m.sourceId, status: m.status, summary: String(m.summary || '').slice(0, 600),
      evidence: String(m.evidence || '').slice(0, 1000) }));
  // Keep the entire projection bounded, retaining persona and newest relevant context.
  while (JSON.stringify(result).length > 10000 && result.messages.length) result.messages.shift();
  while (JSON.stringify(result).length > 10000 && result.media.length) result.media.shift();
  while (JSON.stringify(result).length > 10000 && result.topics.length) result.topics.shift();
  return result;
}

export function selectDebateBatch(events, after = 0) {
  const messages = []; let chars = 0;
  for (const event of events.filter(e => e.id > after).sort((a, b) => a.id - b.id)) {
    const item = { id: event.id, messageId: event.messageId, userId: event.userId,
      sender: event.sender, text: String(event.text).slice(0, 2000), time: event.time, reasons: event.reasons };
    const size = JSON.stringify(item).length;
    if (messages.length >= 20 || chars + size > 24000) break;
    messages.push(item); chars += size;
  }
  return messages;
}

export function normalizeDebateState(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['claims', 'questions', 'position'].includes(k))) throw Error('争点状态格式无效');
  const result = { claims: [], questions: [], position: '' };
  if (value.position !== undefined) {
    if (typeof value.position !== 'string' || value.position.length > 600) throw Error('立场说明过长');
    result.position = value.position;
  }
  for (const key of ['claims', 'questions']) {
    const items = value[key] ?? [];
    if (!Array.isArray(items) || items.length > 12) throw Error('争点条目过多');
    result[key] = items.map(item => {
      if (!item || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 400
        || !['open', 'supported', 'disputed', 'withdrawn', 'conceded', 'resolved'].includes(item.status)
        || !['target', 'self', 'other'].includes(item.side) || !Array.isArray(item.evidenceIds)
        || !item.evidenceIds.length || item.evidenceIds.length > 12 || item.evidenceIds.some(id => !allowed.has(id))) throw Error('争点状态须引用已提供的证据');
      return { text: item.text, status: item.status, side: item.side, evidenceIds: [...new Set(item.evidenceIds)] };
    });
  }
  return result;
}
