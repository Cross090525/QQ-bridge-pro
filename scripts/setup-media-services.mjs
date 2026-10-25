import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildMediaServices } from '../integrations/media-services.mjs';
import { mediaPaths } from '../integrations/media-engine.mjs';
import { DEFAULT_BILIBILI_SOURCE } from '../integrations/media-provider.mjs';
import { normalizeServices } from '../src/framework/services.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const upstream = path.resolve(arg('upstream') || DEFAULT_BILIBILI_SOURCE);
const ffmpeg = path.resolve(arg('ffmpeg') || mediaPaths().ffmpeg), ffprobe = path.resolve(arg('ffprobe') || mediaPaths().ffprobe);
const asrModule = path.resolve(arg('asr-module') || path.join(root, '../dsh-runtime/node_modules/sherpa-onnx-node/sherpa-onnx.js'));
const asrModel = path.resolve(arg('asr-model') || path.join(root, '../external-media/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'));
for (const file of [ffmpeg, ffprobe, asrModule, path.join(upstream, 'lib/extractor.js'), path.join(asrModel, 'model.int8.onnx'), path.join(asrModel, 'tokens.txt')]) fs.accessSync(file);
const version = bin => execFileSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).split(/\r?\n/)[0];
const services = buildMediaServices({ upstream, ffmpeg, ffprobe, asrModule, asrModel });
const configFile = path.join(root, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const ids = new Set(services.map(service => service.id));
const rules = [...(config.framework?.permissions?.rules || [])];
const keys = [...(config.allow?.groups || []).map(id => `group:${id}`), ...(config.allow?.private || []).map(id => `private:${id}`)];
for (const key of keys.filter(key => /^(group|private):[1-9]\d*$/.test(key))) for (const service of services) {
  if (!rules.some(rule => rule.key === key && rule.capability === service.id)) rules.push({ key, capability: service.id, decision: 'allow',
    dataScopes: [service.inputMode === 'bytes' ? 'source-bytes' : 'source-reference', 'input'], maxInputChars: 8000, maxCallsPerMinute: 12, maxCallsPerHour: 120 });
}
config.framework = { ...(config.framework || {}), services: [...(config.framework?.services || []).filter(service => !ids.has(service.id)), ...services],
  permissions: { ...(config.framework?.permissions || {}), rules } };
normalizeServices(config.framework.services);
const installation = { upstream: 'https://github.com/CZX2244/dsh-bilibili', revision: execFileSync('git', ['-c', `safe.directory=${upstream.replaceAll('\\', '/')}`, '-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  upstreamVersion: JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'))).version,
  ffmpeg: { path: ffmpeg, version: version(ffmpeg) }, ffprobe: { path: ffprobe, version: version(ffprobe) },
  files: Object.fromEntries([ffmpeg, ffprobe, path.join(upstream, 'lib/extractor.js'), path.join(asrModel, 'model.int8.onnx'), path.join(asrModel, 'tokens.txt')]
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])) };
fs.writeFileSync(path.join(path.dirname(upstream), 'media-installation.json'), JSON.stringify(installation, null, 2) + '\n');
fs.writeFileSync(configFile + '.tmp', JSON.stringify(config, null, 2) + '\n'); fs.renameSync(configFile + '.tmp', configFile);
console.log(`Registered ${services.length} media services; existing explicit deny/ask preserved; grants added only for ${keys.length} configured conversations. Restart bridge to apply.`);
