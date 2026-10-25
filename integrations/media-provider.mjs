import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { bilibiliFetch, bilibiliNetworkHost } from './media-network.mjs';
import { LocalMediaEngine, decodeSource } from './media-engine.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_BILIBILI_SOURCE = path.resolve(repo, '../external-media/dsh-bilibili');
export const MAX_BILIBILI_VIDEO_BYTES = 96 * 1024 * 1024;
const mediaError = (code, message) => Object.assign(new Error(message), { code });
export function mediaFailure(error) {
  const allowed = ['MEDIA_DOWNLOAD_LIMIT', 'MEDIA_DURATION_LIMIT', 'MEDIA_NO_VIDEO_TRACK', 'MEDIA_FRAME_DECODE'];
  const code = allowed.includes(error?.code) ? error.code : error?.message === '抽帧结果不完整' ? 'MEDIA_FRAME_DECODE' : 'MEDIA_PROCESSING_FAILED';
  return { protocol: 'qq-bridge.media-error/v1', code, ...(code === 'MEDIA_DOWNLOAD_LIMIT' ? { limitMiB: Number.isSafeInteger(error.limitMiB) ? error.limitMiB : MAX_BILIBILI_VIDEO_BYTES / 1048576 } : {}) };
}

export function bilibiliSourceUrl(source) {
  const url = new URL(source?.url);
  if (source?.type !== 'link' || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(url.hostname)) throw Error('须使用当前会话的B站视频链接');
  if (url.hostname !== 'b23.tv' && !/^\/video\/BV[A-Za-z0-9]{10}\/?$/.test(url.pathname)) throw Error('仅支持B站 BV 视频页');
  return url;
}

export class BridgeMediaProvider {
  constructor({ upstream = DEFAULT_BILIBILI_SOURCE, engine = new LocalMediaEngine(), fetchImpl = bilibiliFetch, extractAll, sessdata = '' } = {}) {
    this.upstream = upstream; this.engine = engine; this.fetch = fetchImpl; this.extractAll = extractAll;
    this.sessdata = sessdata;
  }
  async bvid(source) {
    const url = bilibiliSourceUrl(source);
    let resolved = url;
    if (url.hostname === 'b23.tv') resolved = new URL((await this.fetch(url.href)).url);
    if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(resolved.hostname)) throw Error('B站短链未跳转到视频页');
    const id = /^\/video\/(BV[A-Za-z0-9]{10})\/?$/.exec(resolved.pathname)?.[1];
    if (!id) throw Error('B站链接不是视频页');
    return id;
  }
  headers() { return this.sessdata ? { cookie: `SESSDATA=${this.sessdata}` } : {}; }
  async json(url) {
    const response = await this.fetch(url, { headers: this.headers() });
    if (!response.ok) throw Error(`B站接口 HTTP ${response.status}`);
    const data = await response.json();
    if (data.code !== 0) throw Error('B站接口不可用、需要登录或受到风控');
    return data.data;
  }
  mediaAddress(values) {
    const address = values.find(value => {
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && bilibiliNetworkHost(url.hostname); } catch { return false; }
    });
    if (!address) throw Error('视频没有受支持的官方CDN直链');
    return address;
  }
  async localTranscript(bvid) {
    const info = await this.json(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (!Number.isSafeInteger(info.cid) || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 1800) throw Error('视频时长超限');
    const play = await this.json(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${info.cid}&qn=16&fnval=16&fnver=0&fourk=0`);
    const audio = play.dash?.audio?.[0];
    if (!audio) throw Error('没有可用音轨');
    const address = this.mediaAddress([audio.baseUrl, audio.base_url, ...(audio.backupUrl || audio.backup_url || [])]);
    const response = await this.fetch(address, {}, { maxBytes: 16 * 1024 * 1024, timeoutMs: 60000 });
    if (!response.ok) throw Error('音轨下载失败');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 16 * 1024 * 1024) throw Error('音轨过大');
    const result = await this.engine.transcript(bytes, { durationSeconds: 120 });
    const transcript = JSON.parse(result.content[0].text);
    return { source: 'sensevoice-local', text: transcript.text, segments: [{ start: transcript.startSeconds, end: transcript.endSeconds, text: transcript.text }],
      note: `本机转写 ${transcript.startSeconds}–${transcript.endSeconds} 秒，总时长 ${transcript.totalDuration} 秒；${transcript.truncated ? '仅覆盖部分音轨' : '已覆盖音轨'}，可能有识别错误。` };
  }
  async transcript(source, input = {}) {
    const bvid = await this.bvid(source);
    if (input.asr !== undefined && typeof input.asr !== 'boolean') throw Error('asr 必须为布尔值');
    const extractAll = this.extractAll || (await import(pathToFileURL(path.join(this.upstream, 'lib/extractor.js')).href)).extractAll;
    // A private job directory avoids sharing account-dependent transcript caches
    // between conversations. Nothing is written inside the upstream checkout.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-bili-text-'));
    try {
      const result = await extractAll({ url: bvid, extractFrames: false, commentLimit: 5, framesDir: directory,
        asrProvider: input.asr === false ? 'none' : 'bcut', sessdata: this.sessdata, visionProvider: 'none', signal: AbortSignal.timeout(70000) });
      if (!result.success) throw Error('B站视频文字提取失败，请检查链接、网络或登录状态');
      let transcript = result.transcript || {};
      if (!transcript.text && input.asr !== false) {
        try { transcript = await this.localTranscript(bvid); }
        catch { transcript = { ...transcript, note: String(transcript.note || '') + '；本机音轨转写也未取得可用结果。' }; }
      }
      const text = String(transcript.text || '').slice(0, 8000);
      const timeline = [];
      for (const segment of (transcript.segments || []).slice(0, 200)) {
        const item = { start: Number(segment.start) || 0, end: Number(segment.end) || 0, text: String(segment.text || '').slice(0, 180) };
        if (JSON.stringify([...timeline, item]).length > 4000) break;
        timeline.push(item);
      }
      const metadata = result.metadata || result.video || {};
      const value = { bvid, title: String(metadata.title || '').slice(0, 300), duration: metadata.duration,
        uploader: String(metadata.uploader?.name || '').slice(0, 200), description: String(metadata.description || '').slice(0, 500),
        transcript: { source: transcript.source || 'none', text, timeline, timelineTruncated: timeline.length < (transcript.segments || []).length, truncated: String(transcript.text || '').length > text.length,
          note: String(transcript.note || '').slice(0, 400) },
        note: text ? '仅取得字幕或语音转写，未读取画面。需要画面时另调用 bilibili.frames。' : '未取得字幕或转写；仅有视频元信息，不能声称看过视频内容。' };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], evidence: ['metadata', ...(text ? ['transcript'] : [])] };
    } finally {
      if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('qq-bili-text-')) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  async frames(source, input = {}) {
    const bvid = await this.bvid(source);
    const info = await this.json(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (!Number.isSafeInteger(info.cid) || !Number.isFinite(info.duration) || info.duration > 1800) throw mediaError('MEDIA_DURATION_LIMIT', '视频元数据异常或超过30分钟');
    const play = await this.json(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${info.cid}&qn=16&fnval=1&fnver=0&fourk=0`);
    const stream = play.durl?.[0];
    let address; let maxBytes = 32 * 1024 * 1024;
    if (stream?.url && play.durl.length === 1 && stream.size <= maxBytes) {
      address = this.mediaAddress([stream.url, ...(Array.isArray(stream.backup_url) ? stream.backup_url : [])]);
    } else {
      // Long muxed videos include an audio track that frame extraction never
      // needs. Request the smallest H.264 DASH video-only representation; this
      // codec also works with the bundled Windows decoder.
      const dash = await this.json(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${info.cid}&qn=16&fnval=16&fnver=0&fourk=0`);
      const tracks = (dash.dash?.video || []).filter(track => track.codecid === 7 && Number.isFinite(track.bandwidth) && track.bandwidth > 0)
        .sort((a, b) => a.bandwidth - b.bandwidth);
      const track = tracks[0];
      if (!track) throw mediaError('MEDIA_NO_VIDEO_TRACK', '没有可用的H.264纯视频轨');
      maxBytes = MAX_BILIBILI_VIDEO_BYTES;
      if (track.bandwidth * info.duration / 8 > maxBytes) throw mediaError('MEDIA_DOWNLOAD_LIMIT', '低清纯视频轨预计超过96 MiB');
      address = this.mediaAddress([track.baseUrl, track.base_url, ...(Array.isArray(track.backupUrl || track.backup_url) ? track.backupUrl || track.backup_url : [])]);
    }
    const url = new URL(address);
    // Never give FFmpeg a URL. DNS/IP/redirect checks run before a bounded local
    // download, and the decoder is restricted to file/pipe protocols.
    const response = await this.fetch(url.href, { headers: { referer: 'https://www.bilibili.com/' } }, { maxBytes, timeoutMs: 120000 });
    if (!response.ok) throw Error('B站视频下载失败');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw Object.assign(mediaError('MEDIA_DOWNLOAD_LIMIT', '视频下载超过体积上限'), { limitMiB: maxBytes / 1048576 });
    return this.engine.frames(buffer, input);
  }
  async call(tool, { source, input = {} } = {}) {
    if (!input || Array.isArray(input) || typeof input !== 'object') throw Error('input 无效');
    const allowed = tool === 'bilibili_transcript' ? ['asr'] : tool === 'media_transcript' ? ['startSeconds', 'durationSeconds'] : ['timestamps', 'maxFrames'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw Error('不允许自定义路径、命令或未声明参数');
    if (tool === 'bilibili_transcript') return this.transcript(source, input);
    if (tool === 'bilibili_frames') return this.frames(source, input);
    if (!['image', 'sticker', 'video', 'voice', 'file'].includes(source?.type)) throw Error('该服务需要会话媒体');
    if (tool === 'media_frames') return this.engine.frames(decodeSource(source), input);
    if (tool === 'media_transcript') return this.engine.transcript(decodeSource(source), input);
    throw Error('未知媒体工具');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  // The upstream extraction module uses global fetch; replace it only in this
  // separate provider process with the restricted, pinned transport above.
  globalThis.fetch = bilibiliFetch;
  const engine = new LocalMediaEngine({ ffmpeg: arg('ffmpeg'), ffprobe: arg('ffprobe'), asrModule: arg('asr-module'), asrModel: arg('asr-model') });
  const provider = new BridgeMediaProvider({ upstream: arg('upstream') || DEFAULT_BILIBILI_SOURCE, engine, sessdata: process.env.BILIBILI_SESSDATA || '' });
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'qq-bridge-media', version: '1.0.0' });
  for (const tool of ['bilibili_transcript', 'bilibili_frames', 'media_frames', 'media_transcript']) {
    server.tool(tool, 'Bounded media evidence via the bridge content-service interface', { source: z.record(z.string(), z.unknown()), input: z.record(z.string(), z.unknown()).optional() }, async args => {
      try { return await provider.call(tool, args); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(mediaFailure(error)) }] }; }
    });
  }
  await server.connect(new StdioServerTransport());
}
