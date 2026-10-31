import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDraftJudgeServices } from '../integrations/draft-judge-services.mjs';
import { normalizeServices } from '../src/framework/services.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const retired = new Set(['text.meme', 'text.tone']);
export function installDraftJudge(config, services = buildDraftJudgeServices()) {
  const oldJudge = config.framework?.services?.find(s => s.id === 'text.judge');
  const replacement = services.map(s => ({ ...s, ...(oldJudge?.enabled === false ? { enabled: false } : {}) }));
  const rules = (config.framework?.permissions?.rules || []).filter(r => !retired.has(r.capability));
  for (const key of [...(config.allow?.groups || []).map(id => `group:${id}`), ...(config.allow?.private || []).map(id => `private:${id}`)]) {
    if (!/^(group|private):[1-9]\d{0,15}$/.test(key) || rules.some(r => r.key === key && r.capability === 'text.judge')) continue;
    rules.push({ key, capability: 'text.judge', decision: 'allow', dataScopes: ['input'], maxInputChars: 8000, maxCallsPerMinute: 6, maxCallsPerHour: 60 });
  }
  return { ...config, slang: { referenceFallback: true, ...(config.slang || {}) }, framework: { ...(config.framework || {}),
    services: [...(config.framework?.services || []).filter(s => !retired.has(s.id) && s.id !== 'text.judge'), ...replacement],
    permissions: { ...(config.framework?.permissions || {}), rules } } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = path.join(root, 'config.json'), state = path.join(root, 'state');
  const updated = installDraftJudge(JSON.parse(fs.readFileSync(file, 'utf8')));
  normalizeServices(updated.framework.services); fs.mkdirSync(state, { recursive: true });
  const stamp = Date.now(), backup = path.join(state, `config-before-language-support-${stamp}.json`);
  fs.copyFileSync(file, backup); fs.chmodSync(backup, 0o600);
  fs.writeFileSync(file + '.tmp', JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  const oldSettings = path.join(state, 'fish-tone.json');
  if (fs.existsSync(oldSettings)) fs.renameSync(oldSettings, path.join(state, `fish-tone-retired-${stamp}.json`));
  console.log(JSON.stringify({ services: ['text.judge'], removed: [...retired], referenceFallback: updated.slang.referenceFallback, backup }));
}
