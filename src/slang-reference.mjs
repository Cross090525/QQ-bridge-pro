// Static dictionary fallback behind the existing slang queries. No learning or persistence.
import { readFileSync } from 'node:fs';
const base = new URL('../integrations/vendor/dsh-fish-tone/data/', import.meta.url);
const words = JSON.parse(readFileSync(new URL('memes.json', base), 'utf8')).memes;
const constructions = JSON.parse(readFileSync(new URL('constructions.json', base), 'utf8'));
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();
const records = [
  ...words.map(m => ({ term: m.term, aliases: m.aliases || [], meaning: m.gloss, usage: m.usage,
    known: Boolean(m.known && m.gloss), source: m.source, kind: 'word' })),
  ...constructions.map(m => ({ term: m.name, aliases: [], meaning: m.effect, usage: m.example,
    known: Boolean(m.effect), source: 'dsh-fish-tone静态句式库', kind: 'construction' })),
];
export function lookupSlangReference(query, limit = 20) {
  const q = norm(query);
  if (!q || q.length > 256) return [];
  return records.map((m, index) => {
    const names = [m.term, ...m.aliases].map(norm).filter(Boolean);
    const rank = Math.max(0, ...names.map(name => name === q ? 100 : name.includes(q) ? 30 : q.includes(name) && name.length > 1 ? 10 : 0));
    return { m, index, rank };
  }).filter(item => item.rank > 0).sort((a, b) => b.rank - a.rank || a.index - b.index).slice(0, Math.max(1, Math.min(20, limit))).map(({ m }) => ({
    content: String(m.term).slice(0, 100), meaning: m.known ? String(m.meaning).slice(0, 300) : '该词条尚未考据，不能据此编造释义。',
    usage: String(m.usage || '').slice(0, 300), source: 'static-reference', confirmed: false,
    definitionKnown: m.known, referenceSource: String(m.source || '').slice(0, 300), kind: m.kind,
  }));
}
