import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BILIBILI_SOURCE } from './media-provider.mjs';
import { mediaPaths } from './media-engine.mjs';

export function buildMediaServices({ entry = fileURLToPath(new URL('./media-provider.mjs', import.meta.url)), upstream = DEFAULT_BILIBILI_SOURCE,
  ffmpeg = mediaPaths().ffmpeg, ffprobe = mediaPaths().ffprobe, asrModule, asrModel } = {}) {
  const args = [entry, `--upstream=${path.resolve(upstream)}`, `--ffmpeg=${path.resolve(ffmpeg)}`, `--ffprobe=${path.resolve(ffprobe)}`,
    ...(asrModule ? [`--asr-module=${path.resolve(asrModule)}`] : []), ...(asrModel ? [`--asr-model=${path.resolve(asrModel)}`] : [])];
  const transport = { type: 'stdio', command: process.execPath, args };
  const window = { startSeconds: { type: 'number' }, durationSeconds: { type: 'number' } };
  const frames = { properties: { maxFrames: { type: 'number' }, timestamps: { type: 'string', maxLength: 160 },
    sampling: { type: 'string', enum: ['uniform', 'scene'] }, ...window } };
  const transcript = { properties: { ...window, segmentSeconds: { type: 'number' } } };
  return [
    { id: 'bilibili.transcript', tool: 'bilibili_transcript', description: 'B站字幕与可选转写，不读取画面', accepts: ['link'], hosts: ['bilibili.com', 'b23.tv'],
      inputSchema: { properties: { asr: { type: 'boolean' }, ...transcript.properties } },
      inputHint: '先读字幕；asr默认true，无字幕时本机转写。默认0–120秒，单次最多180秒，segmentSeconds默认30、范围5–60，返回带起止时间的timeline。指定时间区间也筛选字幕。用同一sourceId和nextInput继续下一段；audio.status=partial需继续或说明缺口，失败不代表静音。asr=false只读字幕。' },
    { id: 'bilibili.frames', tool: 'bilibili_frames', description: '按需获取B站视频的抽样画面，不代表看过全片', accepts: ['link'], hosts: ['bilibili.com', 'b23.tv'],
      inputSchema: frames, inputHint: 'maxFrames 1–6默认4；sampling=scene检测场景切换，默认扫描0–120秒，startSeconds/durationSeconds指定区间、单次最多180秒，nextInput继续。timestamps逗号分隔的绝对秒数可精查，例如12.5,35，优先于场景选帧。默认uniform均匀抽样。最多30分钟/96MiB；抽样不代表全片，声音另调用bilibili.transcript。' },
    { id: 'media.frames', tool: 'media_frames', description: '从收到的视频、GIF或WebP动图抽取有时间顺序的画面', accepts: ['video', 'image', 'sticker', 'file'], inputMode: 'bytes',
      inputSchema: frames, inputHint: '只处理当前会话sourceId；maxFrames 1–6；sampling=scene按场景选帧，默认扫描前120秒、单次最多180秒，可用startSeconds/durationSeconds和nextInput继续。timestamps为绝对秒数，精查动作前后画面；不要只看动图首帧推断整个动作。' },
    { id: 'media.transcript', tool: 'media_transcript', description: '本机 SenseVoice 识别收到的视频音轨或语音', accepts: ['video', 'voice', 'file'], inputMode: 'bytes',
      inputSchema: transcript,
      inputHint: '默认0–120秒、单次最多180秒；segmentSeconds默认30、范围5–60，返回segments及实际覆盖范围，时间为片段边界。用同一sourceId和nextInput继续；status=partial说明中途失败，不声称完整识别。无音轨明确失败，不推测声音。' },
  ].map(service => ({ ...service, effect: 'read', timeoutMs: 180000, transport }));
}
