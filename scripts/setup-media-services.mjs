import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildMediaServices } from '../integrations/media-services.mjs';
import { mediaPaths } from '../integrations/media-engine.mjs';
import { normalizeServices } from '../src/framework/services.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const legacy = ['bilibili.transcript', 'bilibili.frames', 'media.frames'];
export function migrateMediaServices(config, services) {
  const current = config.framework?.services || [], rules = [...(config.framework?.permissions?.rules || [])];
  const ids = new Set([...legacy, ...services.map(s => s.id)]);
  // Preserve administrator credentials/environment mappings, never model supplied arguments.
  const installed = services.map(service => {
    const old = current.find(s => s.id === service.id) ?? current.find(s => s.id === (service.id.startsWith('bilibili.') ? 'bilibili.frames' : 'media.frames'));
    return { ...service, ...(old?.transport?.envFrom ? { transport: { ...service.transport, envFrom: old.transport.envFrom } } : {}) };
  });
  const keys = new Set([...(config.allow?.groups || []).map(id => `group:${id}`), ...(config.allow?.private || []).map(id => `private:${id}`),
    ...rules.filter(r => ids.has(r.capability)).map(r => r.key)]);
  for (const key of keys) for (const service of installed) {
    if (!/^(group|private):[1-9]\d*$/.test(key) || rules.some(r => r.key === key && r.capability === service.id)) continue;
    const predecessors = service.id === 'bilibili.storyboard' ? ['bilibili.transcript', 'bilibili.frames'] : service.id === 'media.storyboard' ? ['media.frames'] : [];
    const old = rules.filter(r => r.key === key && predecessors.includes(r.capability));
    const restrictive = old.find(r => r.decision === 'deny') ?? old.find(r => r.decision === 'ask');
    const allowedKey = [...(config.allow?.groups || []).map(id => `group:${id}`), ...(config.allow?.private || []).map(id => `private:${id}`)].includes(key);
    if (!restrictive && !allowedKey && !old.length) continue;
    const min = (field, fallback) => Math.min(fallback, ...old.map(r => r[field]).filter(Number.isFinite));
    rules.push({ key, capability: service.id, decision: restrictive?.decision ?? 'allow',
      dataScopes: [service.inputMode === 'bytes' ? 'source-bytes' : 'source-reference', 'input'],
      maxInputChars: min('maxInputChars', 8000), maxCallsPerMinute: min('maxCallsPerMinute', 12), maxCallsPerHour: min('maxCallsPerHour', 120) });
  }
  return { ...config, framework: { ...(config.framework || {}), services: [...current.filter(s => !ids.has(s.id)), ...installed],
    permissions: { ...(config.framework?.permissions || {}), rules: rules.filter(r => !legacy.includes(r.capability)) } } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
  const configFile = path.resolve(arg('config') || path.join(root, 'config.json'));
  const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const priorArgs = current.framework?.services?.find(s => ['media.frames', 'media.storyboard'].includes(s.id))?.transport?.args || [];
  const prior = name => priorArgs.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const ffmpeg = arg('ffmpeg') || mediaPaths().ffmpeg, ffprobe = arg('ffprobe') || prior('ffprobe') || mediaPaths().ffprobe;
  const asrModule = arg('asr-module') || prior('asr-module') || path.resolve(root, '../dsh-runtime/node_modules/sherpa-onnx-node/sherpa-onnx.js');
  const asrModel = arg('asr-model') || prior('asr-model') || path.resolve(root, '../external-media/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
  const version = bin => execFileSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).split(/\r?\n/)[0];
  const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true });
  for (const filter of ['scale', 'crop', 'ebur128', 'silencedetect']) if (!new RegExp(`\\b${filter}\\b`).test(filters)) throw Error(`FFmpeg缺少${filter}滤镜`);
  const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
  if (!/\bpng\b/.test(encoders)) throw Error('FFmpeg缺少PNG编码器');
  for (const f of [asrModule, path.join(asrModel, 'model.int8.onnx'), path.join(asrModel, 'tokens.txt')]) fs.accessSync(f);
  const installed = buildMediaServices({ ffmpeg, ffprobe, asrModule, asrModel });
  const config = migrateMediaServices(current, installed);
  normalizeServices(config.framework.services);
  // Private config backup stays in ignored state, including any existing credentials.
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const backup = path.join(root, 'state', `media-config-before-storyboard-${Date.now()}.json`);
  fs.copyFileSync(configFile, backup); fs.chmodSync(backup, 0o600);
  fs.writeFileSync(configFile + '.tmp', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(configFile + '.tmp', configFile);
  console.log(JSON.stringify({ services: installed.map(s => s.id), engine: 'dsh-video-storyboard@0.5.4', ffmpeg: version(ffmpeg), ffprobe: version(ffprobe), backup }));
}
