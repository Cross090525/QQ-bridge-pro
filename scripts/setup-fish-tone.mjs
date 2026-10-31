import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFishToneServices } from '../integrations/fish-tone-services.mjs';
import { normalizeServices } from '../src/framework/services.mjs';
import { normalizeFishToneSettings } from '../src/fish-tone.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));

export function installFishToneServices(config, services = buildFishToneServices()) {
  const ids = new Set(services.map(s => s.id));
  services = services.map(service => ({ ...service, ...(config.framework?.services?.find(s => s.id === service.id)?.enabled === false ? { enabled: false } : {}) }));
  const rules = [...(config.framework?.permissions?.rules || [])];
  const keys = [...(config.allow?.groups || []).map(id => `group:${id}`), ...(config.allow?.private || []).map(id => `private:${id}`)];
  for (const key of keys) for (const service of services.filter(s => s.id !== 'text.tone')) {
    if (!/^(group|private):[1-9]\d{0,15}$/.test(key) || rules.some(r => r.key === key && r.capability === service.id)) continue;
    rules.push({ key, capability: service.id, decision: 'allow', dataScopes: ['input'], maxInputChars: 8000, maxCallsPerMinute: 6, maxCallsPerHour: 60 });
  }
  return { ...config, framework: { ...(config.framework || {}), services: [...(config.framework?.services || []).filter(s => !ids.has(s.id)), ...services],
    permissions: { ...(config.framework?.permissions || {}), rules } } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const configFile = path.join(root, 'config.json'), state = path.join(root, 'state');
  const old = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const updated = installFishToneServices(old);
  normalizeServices(updated.framework.services);
  fs.mkdirSync(state, { recursive: true });
  const settingsFile = path.join(state, 'fish-tone.json');
  const settings = normalizeFishToneSettings(fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {});
  const backup = path.join(state, `config-before-fish-tone-${Date.now()}.json`);
  fs.copyFileSync(configFile, backup); fs.chmodSync(backup, 0o600);
  for (const [file, value] of [[settingsFile, settings], [configFile, updated]]) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  }
  console.log(JSON.stringify({ services: ['text.judge', 'text.meme', 'text.tone'], rewriteEnabled: settings.defaults.rewriteEnabled, backup }));
}
