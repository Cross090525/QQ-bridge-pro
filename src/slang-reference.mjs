// Read-only dictionary queries and relevant chat context. No learning or persistence.
import { readFileSync } from 'node:fs';
const base = new URL('../integrations/vendor/dsh-fish-tone/data/', import.meta.url);
const words = JSON.parse(readFileSync(new URL('memes.json', base), 'utf8')).memes;
const constructions = JSON.parse(readFileSync(new URL('constructions.json', base), 'utf8'));
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();
const records = [
  ...words.map(m => ({ id: `word:${m.id}`, term: m.term, aliases: m.aliases || [], meaning: m.gloss || '', usage: m.usage || '',
    known: Boolean(m.known && m.gloss), source: m.source, kind: 'word' })),
  ...constructions.map(m => ({ id: `construction:${m.id}`, term: m.name, aliases: [], meaning: m.effect || '', usage: m.example || '',
    known: Boolean(m.effect), source: 'dsh-fish-tone静态句式库', kind: 'construction' })),
];
const referenceItem = m => ({
  content: String(m.term).slice(0, 100), meaning: m.known ? String(m.meaning).slice(0, 300) : '该词条尚未考据，不能据此编造释义。',
  usage: String(m.usage || '').slice(0, 300), source: 'static-reference', confirmed: false,
  definitionKnown: m.known, referenceSource: String(m.source || '').slice(0, 300), kind: m.kind,
});
export const bundledSlangReferences = () => structuredClone(records);
const namesOf = m => [...new Set([m.term, ...m.aliases].map(norm).filter(Boolean))];

// Match only literal names in text already supplied to this conversation. Short
// and Latin names need word boundaries so e.g. "典礼" and "day" do not match 典/ay.
function occurrences(texts, names) {
  const found = [];
  for (let message = 0; message < texts.length; message++) for (const name of names) {
    if (!name) continue;
    let start = texts[message].indexOf(name);
    while (start !== -1) {
      const end = start + name.length, single = Array.from(name).length === 1;
      const left = Array.from(texts[message].slice(0, start)).at(-1) || '';
      const right = Array.from(texts[message].slice(end))[0] || '';
      if ((!single && !/^[a-z0-9_]/.test(name) || !/[\p{L}\p{N}_]/u.test(left))
        && (!single && !/[a-z0-9_]$/.test(name) || !/[\p{L}\p{N}_]/u.test(right))) {
        found.push({ message, start, end }); break;
      }
      start = texts[message].indexOf(name, start + 1);
    }
  }
  return found;
}
const overlaps = (a, b) => a.message === b.message && a.start < b.end && b.start < a.end;

export function selectRelevantSlang(messageTexts, { entries = [], referenceFallback = true, referenceEntries = records, limit = 8, maxChars = 2000 } = {}) {
  const texts = []; let remaining = 12000, truncated = false;
  for (const value of new Set(messageTexts.filter(t => typeof t === 'string' && t.trim()))) {
    if (!remaining || texts.length === 24) { truncated = true; break; }
    const text = norm(value); texts.push(text.slice(0, remaining));
    truncated ||= text.length > remaining; remaining -= Math.min(text.length, remaining);
  }
  if (!texts.length) return { items: [], truncated };
  const confirmed = entries.filter(e => e?.status === 'confirmed' && e.content && e.meaning)
    .map(e => ({ item: { content: String(e.content).slice(0, 100), meaning: String(e.meaning).slice(0, 300),
      usage: String(e.usage || e.example || '').slice(0, 300), source: 'confirmed-slang', confirmed: true },
      matches: occurrences(texts, [norm(e.content)]) })).filter(e => e.matches.length)
    .sort((a, b) => a.matches[0].message - b.matches[0].message || a.matches[0].start - b.matches[0].start);
  const occupied = confirmed.flatMap(e => e.matches);
  const references = referenceFallback ? referenceEntries.map(m => ({ item: referenceItem(m),
    matches: occurrences(texts, namesOf(m)).filter(a => !occupied.some(b => overlaps(a, b))) }))
    .filter(e => e.matches.length).sort((a, b) => a.matches[0].message - b.matches[0].message
      || b.matches[0].end - b.matches[0].start - (a.matches[0].end - a.matches[0].start)) : [];
  const result = { items: [], truncated };
  const seen = new Set();
  for (const entry of [...confirmed, ...references]) {
    const name = norm(entry.item.content);
    if (seen.has(name) || !entry.item.confirmed && !entry.matches.some(a => !occupied.some(b => overlaps(a, b)))) continue;
    if (result.items.length >= Math.max(1, Math.min(20, Number(limit) || 8))) { result.truncated = true; break; }
    result.items.push(entry.item);
    if (JSON.stringify(result).length > maxChars) { result.items.pop(); result.truncated = true; break; }
    seen.add(name);
    if (!entry.item.confirmed) occupied.push(...entry.matches);
  }
  return result;
}

export function lookupSlangReference(query, limit = 20, referenceEntries = records) {
  const q = norm(query);
  if (!q || q.length > 256) return [];
  return referenceEntries.map((m, index) => {
    const names = [m.term, ...m.aliases].map(norm).filter(Boolean);
    const rank = Math.max(0, ...names.map(name => name === q ? 100 : name.includes(q) ? 30 : q.includes(name) && name.length > 1 ? 10 : 0));
    return { m, index, rank };
  }).filter(item => item.rank > 0).sort((a, b) => b.rank - a.rank || a.index - b.index).slice(0, Math.max(1, Math.min(20, limit))).map(({ m }) => referenceItem(m));
}
