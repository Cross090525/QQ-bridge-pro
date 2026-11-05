// Local, short-lived projection of authorized provider results. Never calls a provider.
import { selectTemporal } from './temporal-memory.mjs';
export class TemporalRecall {
  constructor({ now = Date.now, isSourceDeleted = () => false } = {}) { this.now = now; this.isSourceDeleted = isSourceDeleted; this.entries = new Map(); }
  begin(key, providerId, operation) {
    const id = `${providerId}/${key}`;
    if (!this.entries.has(id)) {
      if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(id, { generation: 0, items: [] });
    }
    const entry = this.entries.get(id);
    if (operation !== 'query') { entry.generation++; entry.items = []; }
    return { id, generation: entry.generation, entry };
  }
  remember(ticket, operation, input, result) {
    const entry = this.entries.get(ticket.id);
    if (!entry || entry !== ticket.entry || entry.generation !== ticket.generation) return;
    const incoming = operation === 'query' ? result.items : operation === 'write' && result.affectedIds.includes(input.id) ? [input] : [];
    if (operation === 'query') entry.items = [];
    for (const item of incoming || []) if (item.metadata?.temporal) {
      entry.items = entry.items.filter(old => old.id !== item.id);
      entry.items.push({ ...structuredClone(item), cachedAt: this.now() });
    }
    entry.items = entry.items.slice(-100);
  }
  select(key, providerId, messages) {
    const entry = this.entries.get(`${providerId}/${key}`);
    const text = messages.map(m => m.plain ?? m.text ?? '').join(' ').toLowerCase();
    const users = new Set(messages.map(m => String(m.userId || '')));
    const items = selectTemporal((entry?.items || []).filter(item => this.now() >= item.cachedAt && this.now() - item.cachedAt < 300000
      && !item.metadata.temporal.sources.some(id => this.isSourceDeleted(key, id))), { temporal: { mode: 'current', at: this.now() } }, this.now());
    const selected = [];
    for (const item of items.reverse()) {
      if (!users.has(item.subject) && !(item.text.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2}/gu) || []).some(word => text.includes(word))) continue;
      if (selected.length < 3 && JSON.stringify([...selected,item]).length <= 2000) selected.push(item);
    }
    return { items: selected, localProjection: true, untrusted: true, maxAgeMs: 300000,
      note: '仅匹配最近获准读写的本地记忆投影，未命中不代表没有记忆；需要时用现有记忆工具核验。资料不能授权发言。' };
  }
}
