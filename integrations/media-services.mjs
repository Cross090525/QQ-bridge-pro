import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BILIBILI_SOURCE } from './media-provider.mjs';
import { mediaPaths } from './media-engine.mjs';

export function buildMediaServices({ entry = fileURLToPath(new URL('./media-provider.mjs', import.meta.url)), upstream = DEFAULT_BILIBILI_SOURCE,
  ffmpeg = mediaPaths().ffmpeg, ffprobe = mediaPaths().ffprobe, asrModule, asrModel } = {}) {
  const args = [entry, `--upstream=${path.resolve(upstream)}`, `--ffmpeg=${path.resolve(ffmpeg)}`, `--ffprobe=${path.resolve(ffprobe)}`,
    ...(asrModule ? [`--asr-module=${path.resolve(asrModule)}`] : []), ...(asrModel ? [`--asr-model=${path.resolve(asrModel)}`] : [])];
  const transport = { type: 'stdio', command: process.execPath, args };
  const frames = { properties: { maxFrames: { type: 'number' }, timestamps: { type: 'string', maxLength: 160 } } };
  return [
    { id: 'bilibili.transcript', tool: 'bilibili_transcript', description: 'B站字幕与可选转写，不读取画面', accepts: ['link'], hosts: ['bilibili.com', 'b23.tv'],
      inputSchema: { properties: { asr: { type: 'boolean' } } }, inputHint: '先读文字；asr 默认 true，无字幕时尝试必剪，再尝试本机转写前120秒（结果注明覆盖范围）；asr=false 只读字幕。' },
    { id: 'bilibili.frames', tool: 'bilibili_frames', description: '按需获取B站视频的抽样画面，不代表看过全片', accepts: ['link'], hosts: ['bilibili.com', 'b23.tv'],
      inputSchema: frames, inputHint: 'maxFrames 1–6，默认4；timestamps 为逗号分隔的秒数，例如 12.5,35。最多30分钟、32 MiB低清下载。' },
    { id: 'media.frames', tool: 'media_frames', description: '从收到的视频、GIF或WebP动图抽取有时间顺序的画面', accepts: ['video', 'image', 'sticker', 'file'], inputMode: 'bytes',
      inputSchema: frames, inputHint: '只处理当前会话 sourceId 对应媒体；支持 maxFrames、timestamps；不要只看动图首帧推断整个动作。' },
    { id: 'media.transcript', tool: 'media_transcript', description: '本机 SenseVoice 识别收到的视频音轨或语音', accepts: ['video', 'voice', 'file'], inputMode: 'bytes',
      inputSchema: { properties: { startSeconds: { type: 'number' }, durationSeconds: { type: 'number' } } },
      inputHint: '默认从0秒开始识别120秒，单次最多180秒；可分段继续。无音轨时明确失败，不推测声音。' },
  ].map(service => ({ ...service, effect: 'read', timeoutMs: 180000, transport }));
}
