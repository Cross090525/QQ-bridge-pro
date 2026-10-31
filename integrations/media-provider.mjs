import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bilibiliFetch, bilibiliNetworkHost } from './media-network.mjs';
import { decodeSource } from './media-engine.mjs';
import { StoryboardMediaEngine, validateStoryboardInput } from './storyboard-engine.mjs';

export const MAX_BILIBILI_VIDEO_BYTES = 96 * 1024 * 1024;
const mediaError = (code, message) => Object.assign(new Error(message), { code });
export function mediaFailure(error) {
  const allowed = ['MEDIA_DOWNLOAD_LIMIT', 'MEDIA_DURATION_LIMIT', 'MEDIA_NO_VIDEO_TRACK', 'MEDIA_FRAME_DECODE'];
  const code = allowed.includes(error?.code) ? error.code : 'MEDIA_PROCESSING_FAILED';
  return { protocol: 'qq-bridge.media-error/v1', code, ...(code === 'MEDIA_DOWNLOAD_LIMIT' ? { limitMiB: error.limitMiB || 96 } : {}) };
}
export function bilibiliSourceUrl(source) {
  const url = new URL(source?.url);
  if (source?.type !== 'link' || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(url.hostname)) throw Error('须使用当前会话的B站视频链接');
  if (url.hostname !== 'b23.tv' && !/^\/video\/BV[A-Za-z0-9]{10}\/?$/.test(url.pathname)) throw Error('仅支持B站 BV 视频页');
  return url;
}
// Transport only: downloads stay under the existing DNS/CDN/size checks.
// No legacy dsh-bilibili extractor or legacy frame sampler is loaded.
export class BridgeMediaProvider {
  constructor({ engine = new StoryboardMediaEngine(), fetchImpl = bilibiliFetch, sessdata = '' } = {}) {
    this.engine = engine; this.fetch = fetchImpl; this.sessdata = sessdata;
  }
  async bvid(source) {
    const url = bilibiliSourceUrl(source);
    const resolved = url.hostname === 'b23.tv' ? new URL((await this.fetch(url.href)).url) : url;
    return /^\/video\/(BV[A-Za-z0-9]{10})\/?$/.exec(bilibiliSourceUrl({ type: 'link', url: resolved.href }).pathname)?.[1]
      || (() => { throw Error('B站短链未跳转到视频页'); })();
  }
  async json(url) {
    const response = await this.fetch(url, { headers: this.sessdata ? { cookie: `SESSDATA=${this.sessdata}` } : {} });
    if (!response.ok) throw Error('B站接口不可用');
    const data = await response.json(); if (data.code !== 0) throw Error('B站接口不可用、需要登录或受到风控');
    return data.data;
  }
  mediaAddress(values) {
    const address = values.find(value => {
      try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && bilibiliNetworkHost(u.hostname); } catch { return false; }
    });
    if (!address) throw Error('没有受支持的官方CDN直链'); return address;
  }
  async download(track, maxBytes, duration) {
    if (track.bandwidth && track.bandwidth * duration / 8 > maxBytes || track.size > maxBytes) throw Object.assign(mediaError('MEDIA_DOWNLOAD_LIMIT', '媒体预计超限'), { limitMiB: maxBytes / 1048576 });
    const address = this.mediaAddress([track.baseUrl, track.base_url, track.url, ...(track.backupUrl || track.backup_url || [])]);
    const response = await this.fetch(address, { headers: { referer: 'https://www.bilibili.com/' } }, { maxBytes, timeoutMs: 90000 });
    if (!response.ok) throw Error('媒体下载失败');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw Object.assign(mediaError('MEDIA_DOWNLOAD_LIMIT', '媒体超过体积上限'), { limitMiB: maxBytes / 1048576 });
    return bytes;
  }
  async subtitles(bvid, cid) {
    const player = await this.json(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`);
    const tracks = player.subtitle?.subtitles ?? [];
    const track = tracks.find(s => /zh/.test(s.lan)) ?? tracks[0];
    if (!track?.subtitle_url) return undefined;
    const url = new URL(track.subtitle_url, 'https://www.bilibili.com');
    if (url.protocol !== 'https:' || !bilibiliNetworkHost(url.hostname)) throw Error('字幕域名不受支持');
    const response = await this.fetch(url.href, {}, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 });
    if (!response.ok) throw Error('字幕下载失败');
    const data = await response.json();
    return Array.isArray(data.body) && data.body.length ? data.body.map(s => ({ start: s.from, end: s.to, text: String(s.content ?? '') })) : undefined;
  }
  async storyboard(source, rawInput = {}) {
    const input = validateStoryboardInput(rawInput), bvid = await this.bvid(source);
    const info = await this.json(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (!Number.isSafeInteger(info.cid) || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 1800) throw mediaError('MEDIA_DURATION_LIMIT', '视频超过30分钟或元数据无效');
    const play = await this.json(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${info.cid}&qn=32&fnval=16&fnver=0&fourk=0`);
    const tracks = (play.dash?.video || []).filter(t => t.codecid === 7 && t.bandwidth > 0)
      .sort((a, b) => (b.height || 0) - (a.height || 0) || a.bandwidth - b.bandwidth);
    const affordable = tracks.filter(t => (!t.height || t.height <= 720) && t.bandwidth * info.duration / 8 <= MAX_BILIBILI_VIDEO_BYTES);
    const track = affordable[0] ?? tracks.at(-1) ?? (play.durl?.length === 1 ? play.durl[0] : null);
    if (!track) throw mediaError('MEDIA_NO_VIDEO_TRACK', '没有可用视频轨');
    const bytes = await this.download(track, MAX_BILIBILI_VIDEO_BYTES, info.duration);
    const transcriptSegments = await this.subtitles(bvid, info.cid).catch(() => undefined);
    let audioBuffer, audioStatus = 'not_requested';
    if (input.asr !== false && play.dash) {
      const audioTrack = [...(play.dash.audio || [])].sort((a, b) => a.bandwidth - b.bandwidth)[0];
      if (audioTrack) {
        try { audioBuffer = await this.download(audioTrack, 16 * 1024 * 1024, info.duration); }
        catch { audioStatus = 'failed'; }
      } else audioStatus = 'unavailable';
    }
    const result = await this.engine.storyboard(bytes, input, { transcriptSegments, audioBuffer, audioStatus });
    const metadata = JSON.parse(result.content[0].text);
    metadata.bvid = bvid; metadata.title = String(info.title || '').slice(0, 300);
    result.content[0].text = JSON.stringify(metadata);
    return result;
  }
  async call(tool, { source, input = {} } = {}) {
    if (tool === 'bilibili_storyboard') return this.storyboard(source, input);
    if (tool === 'media_storyboard' && ['image', 'sticker', 'video', 'file'].includes(source?.type)) {
      validateStoryboardInput(input); return this.engine.storyboard(decodeSource(source), input);
    }
    if (tool === 'media_transcript' && ['voice', 'file'].includes(source?.type)) {
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(k => !['startSeconds', 'durationSeconds', 'segmentSeconds'].includes(k))) throw Error('未声明参数');
      return this.engine.transcript(decodeSource(source), input);
    }
    throw Error('未知媒体工具或来源类型不匹配');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
  const engine = new StoryboardMediaEngine({ ffmpeg: arg('ffmpeg'), ffprobe: arg('ffprobe'), asrModule: arg('asr-module'), asrModel: arg('asr-model') });
  const provider = new BridgeMediaProvider({ engine, sessdata: process.env.BILIBILI_SESSDATA || '' });
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'qq-bridge-storyboard', version: '2.0.0' });
  for (const tool of ['bilibili_storyboard', 'media_storyboard', 'media_transcript']) server.tool(tool, 'Scoped storyboard or audio evidence',
    { source: z.record(z.string(), z.unknown()), input: z.record(z.string(), z.unknown()).optional() }, async args => {
      try { return await provider.call(tool, args); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(mediaFailure(error)) }] }; }
    });
  await server.connect(new StdioServerTransport());
}
