import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaPaths } from './media-engine.mjs';

export function buildMediaServices({ entry = fileURLToPath(new URL('./media-provider.mjs', import.meta.url)),
  ffmpeg = mediaPaths().ffmpeg, ffprobe = mediaPaths().ffprobe, asrModule, asrModel } = {}) {
  const args = [entry, `--ffmpeg=${ffmpeg}`, `--ffprobe=${ffprobe}`,
    ...(asrModule ? [`--asr-module=${path.resolve(asrModule)}`] : []), ...(asrModel ? [`--asr-model=${path.resolve(asrModel)}`] : [])];
  const transport = { type: 'stdio', command: process.execPath, args };
  const window = { startSeconds: { type: 'number' }, durationSeconds: { type: 'number' } };
  const storyboard = { properties: { ...window, cells: { type: 'number' }, need: { type: 'string', enum: ['shot', 'scene', 'text'] },
    detail: { type: 'string', enum: ['low', 'med', 'high'] }, mode: { type: 'string', enum: ['board', 'zoom'] }, asr: { type: 'boolean' } } };
  const inputHint = 'dsh-video-storyboard分镜+时间码+台词。默认前120秒，单次最多180秒；cells 1–9；need=scene/shot/text，detail=low/med/high。按nextInput续看。精查同一sourceId传mode=zoom、startSeconds和durationSeconds（最多30秒），少格更清晰。asr默认true，本机转写；不取得音轨不能推测静音。仅为抽样画面，不能声称逐帧看过全片。';
  return [
    { id: 'bilibili.storyboard', tool: 'bilibili_storyboard', description: '使用dsh-video-storyboard理解B站视频：编号分镜、时间码、字幕或本机转写',
      accepts: ['link'], hosts: ['bilibili.com', 'b23.tv'], inputSchema: storyboard, inputHint },
    { id: 'media.storyboard', tool: 'media_storyboard', description: '使用dsh-video-storyboard处理收到的视频、GIF和WebP：编号分镜与音轨台词',
      accepts: ['video', 'image', 'sticker', 'file'], inputMode: 'bytes', inputSchema: storyboard, inputHint },
    { id: 'media.transcript', tool: 'media_transcript', description: '本机SenseVoice识别收到的语音或独立音频', accepts: ['voice', 'file'], inputMode: 'bytes',
      inputSchema: { properties: { ...window, segmentSeconds: { type: 'number' } } },
      inputHint: '语音或独立音频使用此服务；视频使用media.storyboard。默认0–120秒、最多180秒，segmentSeconds 5–60。返回分段时间与nextInput，partial须说明缺口。' },
  ].map(service => ({ ...service, effect: 'read', timeoutMs: 180000, transport }));
}
