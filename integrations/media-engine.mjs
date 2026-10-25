import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const repo = fileURLToPath(new URL('..', import.meta.url));
export function mediaPaths() {
  const root = path.resolve(repo, '../media-runtime-fast/node_modules');
  return {
    ffmpeg: process.env.FFMPEG_PATH || path.join(root, '@clayzo/ffmpeg-win32-x64/ffmpeg.exe'),
    ffprobe: process.env.FFPROBE_PATH || path.join(root, '@ffprobe-installer/win32-x64/ffprobe.exe'),
  };
}
export function runMedia(binary, args, { timeoutMs = 20000, maxOutput = 2 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    const child = spawn(binary, args, { windowsHide: true, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let bytes = 0, spawnError;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutput) abort(); else stdout.push(chunk); });
    child.stderr.on('data', chunk => { if (stderr.reduce((n, b) => n + b.length, 0) < 4096) stderr.push(chunk); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      cleanup();
      if (spawnError?.code === 'ENOENT') reject(Error('媒体运行时尚未安装'));
      else if (code !== 0 || controller.signal.aborted || spawnError) reject(Error('媒体处理取消、超时或格式不受支持'));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}
export function mediaExtension(buffer) {
  const head = buffer.toString('ascii', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return '.gif';
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return '.webp';
  if (buffer.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) return '.png';
  if (buffer[0] === 255 && buffer[1] === 216) return '.jpg';
  if (head.slice(4, 8) === 'ftyp') return '.mp4';
  if (buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return '.webm';
  if (head.startsWith('RIFF') && head.slice(8) === 'WAVE') return '.wav';
  if (head.startsWith('OggS')) return '.ogg';
  if (head.startsWith('fLaC')) return '.flac';
  if (head.startsWith('ID3') || buffer[0] === 255 && (buffer[1] & 224) === 224) return '.mp3';
  throw Error('不是支持的视频、动图、图片或音频格式');
}
export function decodeSource(source) {
  if (!source || typeof source.data !== 'string' || source.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4
      || source.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(source.data)) throw Error('媒体必须由框架提供有界 base64 字节');
  const buffer = Buffer.from(source.data, 'base64');
  if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) throw Error('媒体为空或超过 8 MiB');
  // A repeated-group regex over multi-megabyte base64 can exhaust V8's stack.
  // Canonical re-encoding validates padding/unused bits without recursion.
  if (buffer.toString('base64') !== source.data) throw Error('媒体必须由框架提供规范 base64 字节');
  mediaExtension(buffer); return buffer;
}
export function mediaWindow(duration, input = {}, defaultSeconds = 120) {
  const start = input.startSeconds ?? 0, seconds = input.durationSeconds ?? defaultSeconds;
  if (!Number.isFinite(start) || start < 0 || start >= duration || !Number.isFinite(seconds) || seconds < 1 || seconds > 180) throw Error('处理时间范围无效，单次最多180秒');
  return { start, end: Math.min(duration, start + seconds) };
}
export function continuation(end, duration, input = {}) {
  return end < duration - 0.001 ? { ...input, startSeconds: end, durationSeconds: Math.min(180, Math.max(1, input.durationSeconds ?? 120)) } : null;
}
export function fitTranscript(value, nested = false) {
  const target = nested ? value.transcript : value;
  const timeline = nested ? target.timeline : target.segments;
  // The framework accepts at most 16k text characters, including JSON escaping.
  while (JSON.stringify(value).length > 15000) {
    target.text = target.text.slice(0, Math.floor(target.text.length / 2));
    for (const segment of timeline || []) segment.text = segment.text.slice(0, Math.floor(segment.text.length / 2));
    target.textTruncated = true;
    target.timelineTruncated = true;
  }
  return value;
}
export function frameTimes(duration, input = {}, lastFrameTime = Math.max(0, duration - 0.1)) {
  const count = input.maxFrames ?? 4;
  if (!Number.isSafeInteger(count) || count < 1 || count > 6) throw Error('maxFrames 须为 1–6');
  if (input.sampling !== undefined && !['uniform', 'scene'].includes(input.sampling)) throw Error('sampling 须为 uniform 或 scene');
  if (input.timestamps !== undefined && (typeof input.timestamps !== 'string' || !input.timestamps.trim() || input.timestamps.length > 160)) throw Error('抽帧时间不能为空或过长');
  const windowed = input.startSeconds !== undefined || input.durationSeconds !== undefined || input.sampling === 'scene';
  const { start, end } = windowed ? mediaWindow(duration, input) : { start: 0, end: duration };
  if (typeof input.timestamps === 'string' && input.timestamps.trim()) {
    if (input.timestamps.split(',').some(value => !value.trim())) throw Error('抽帧时间不能为空');
    const times = input.timestamps.split(',').map(value => Number(value.trim()));
    if (times.length > count || times.some(n => !Number.isFinite(n) || n < start || n >= end)) throw Error('抽帧时间超出视频或数量范围');
    return [...new Set(times.map(time => Math.min(time, lastFrameTime)))].sort((a, b) => a - b);
  }
  if (end - start <= 0.2) return [Math.min(start, lastFrameTime)];
  // Container duration may include audio/padding after the last decodable video
  // frame. Default samples cover the timeline without seeking to that tail.
  return [...new Set(Array.from({ length: count }, (_, i) => Math.floor(Math.min(lastFrameTime, start + (end - start) * i / count) * 1000) / 1000))];
}
export class LocalMediaEngine {
  constructor({ ffmpeg, ffprobe, temporaryRoot = os.tmpdir(), asrModule, asrModel } = {}) {
    const defaults = mediaPaths();
    this.ffmpeg = ffmpeg || defaults.ffmpeg; this.ffprobe = ffprobe || defaults.ffprobe;
    this.temporaryRoot = temporaryRoot;
    this.asrModule = asrModule || path.resolve(repo, '../dsh-runtime/node_modules/sherpa-onnx-node/sherpa-onnx.js');
    this.asrModel = asrModel || path.resolve(repo, '../external-media/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
  }
  async job(buffer, operation) {
    const ext = mediaExtension(buffer);
    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, 'qq-media-'));
    const file = path.join(directory, 'input' + ext);
    try { await fs.writeFile(file, buffer); return await operation({ directory, file }); }
    finally {
      if (path.dirname(directory) === path.resolve(this.temporaryRoot) && path.basename(directory).startsWith('qq-media-')) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  async probe(file) {
    const raw = await runMedia(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,width,height,duration,nb_frames,avg_frame_rate,r_frame_rate', '-of', 'json', file]);
    const result = JSON.parse(raw);
    const video = result.streams?.find(s => s.codec_type === 'video');
    const duration = Number(result.format?.duration || video?.duration || 0.1);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 1800 || video && (!video.width || !video.height || video.width > 8192 || video.height > 8192 || video.width * video.height > 16777216)) throw Error('媒体时长或画面尺寸超出处理范围');
    const rational = value => { const [a, b] = String(value || '').split('/').map(Number); return Number.isFinite(a / b) && a / b > 0 ? a / b : 0; };
    const frameRate = rational(video?.avg_frame_rate) || rational(video?.r_frame_rate) || Number(video?.nb_frames) / duration || 25;
    return { duration, width: video?.width, height: video?.height, frameRate, hasVideo: !!video, hasAudio: !!result.streams?.some(s => s.codec_type === 'audio') };
  }
  async frames(buffer, input = {}) {
    return this.job(buffer, async ({ directory, file }) => {
      const info = await this.probe(file);
      if (!info.hasVideo) throw Error('媒体没有可读取的画面');
      const ext = mediaExtension(buffer);
      if (['.png', '.jpg'].includes(ext)) return { content: [{ type: 'text', text: JSON.stringify({ ...info, sampledTimes: [0], note: '此资源为静态图片，没有动态画面证据。' }) },
        { type: 'image', mimeType: ext === '.png' ? 'image/png' : 'image/jpeg', data: buffer.toString('base64') }], evidence: ['metadata', 'frames'] };
      let times = frameTimes(info.duration, input, Math.max(0, info.duration - 1 / info.frameRate)); const images = [];
      const windowed = input.startSeconds !== undefined || input.durationSeconds !== undefined || input.sampling === 'scene';
      const window = windowed ? mediaWindow(info.duration, input) : { start: 0, end: info.duration };
      let sceneTimes = [];
      if (input.sampling === 'scene' && input.timestamps === undefined) {
        // Decode only the requested window at low resolution; FFmpeg never receives a URL.
        const scanFile = path.join(directory, 'scene-scan.rgb'), frameSize = 64 * 36 * 3;
        await runMedia(this.ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', String(window.start), '-i', file,
          '-t', String(window.end - window.start), '-an', '-vf', 'scale=64:36,fps=2', '-frames:v', '360',
          '-pix_fmt', 'rgb24', '-c:v', 'rawvideo', '-f', 'rawvideo', '-threads', '1', '-y', scanFile], { timeoutMs: 30000 });
        if ((await fs.stat(scanFile)).size > frameSize * 360) throw Error('场景检测输出超限');
        const scan = await fs.readFile(scanFile);
        let previous;
        for (let offset = 0; offset + frameSize <= scan.length; offset += frameSize) {
          const histogram = new Uint32Array(48);
          for (let p = 0; p < frameSize; p++) histogram[p % 3 * 16 + (scan[offset + p] >> 4)]++;
          const delta = previous ? histogram.reduce((sum, count, i) => sum + Math.abs(count - previous[i]), 0) / (2 * frameSize) : 0;
          const time = window.start + offset / frameSize / 2;
          if (delta > 0.35 && time < window.end && time <= info.duration - 1 / info.frameRate) sceneTimes.push(time);
          previous = histogram;
        }
        // One candidate per time bin keeps a burst of cuts from hiding the rest of the window.
        times = times.map((fallback, i) => sceneTimes.find(time => time >= window.start + (window.end - window.start) * i / times.length
          && time < window.start + (window.end - window.start) * (i + 1) / times.length) ?? fallback);
        times = [...new Set(times)].sort((a, b) => a - b);
      }
      const factor = Math.min(1, 640 / info.width, 640 / info.height);
      const width = Math.max(1, Math.floor(info.width * factor)), height = Math.max(1, Math.floor(info.height * factor));
      for (const [index, time] of times.entries()) {
        const output = path.join(directory, `frame-${index}.rgb`);
        await runMedia(this.ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', String(time), '-i', file,
          '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-pix_fmt', 'rgb24', '-c:v', 'rawvideo', '-f', 'rawvideo', '-threads', '1', '-y', output]);
        const bytes = await fs.readFile(output);
        if (bytes.length !== width * height * 3) throw Error('抽帧结果不完整');
        const image = new PNG({ width, height });
        for (let i = 0; i < width * height; i++) { image.data[i * 4] = bytes[i * 3]; image.data[i * 4 + 1] = bytes[i * 3 + 1]; image.data[i * 4 + 2] = bytes[i * 3 + 2]; image.data[i * 4 + 3] = 255; }
        images.push({ type: 'image', mimeType: 'image/png', data: PNG.sync.write(image).toString('base64') });
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...info, sampledTimes: times, evidence: 'sampled_frames',
        sampling: input.timestamps !== undefined ? 'timestamps' : input.sampling ?? 'uniform', sceneTimes: sceneTimes.slice(0, 60), sceneTimesTruncated: sceneTimes.length > 60,
        coverage: { startSeconds: window.start, endSeconds: window.end, partial: window.start > 0 || window.end < info.duration, sampledOnly: true },
        nextInput: windowed ? continuation(window.end, info.duration, { sampling: input.sampling ?? 'uniform', maxFrames: input.maxFrames ?? 4, durationSeconds: input.durationSeconds ?? 120 }) : null,
        note: '图片按 sampledTimes 请求时间顺序排列，时间可有一个编码帧的偏差；仅看到抽样画面，不能据此声称看过完整视频或听到音轨。' }) }, ...images], evidence: ['metadata', 'frames'] };
    });
  }
  async transcript(buffer, input = {}) {
    const start = input.startSeconds ?? 0, seconds = input.durationSeconds ?? 120;
    const segmentSeconds = input.segmentSeconds ?? 30;
    if (!Number.isFinite(segmentSeconds) || segmentSeconds < 5 || segmentSeconds > 60) throw Error('segmentSeconds 须为5–60秒');
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(seconds) || seconds < 1 || seconds > 180) throw Error('转写时间范围无效，单次最多 180 秒');
    await fs.access(path.join(this.asrModel, 'model.int8.onnx'));
    return this.job(buffer, async ({ directory, file }) => {
      const info = await this.probe(file);
      if (!info.hasAudio || start >= info.duration) throw Error('媒体没有音轨或起始时间超出范围');
      const end = Math.min(start + seconds, info.duration), segments = [], deadline = Date.now() + 130000;
      let failed = false;
      for (let position = start; position < end; position += segmentSeconds) {
        try { segments.push(await this.recognizeSegment(file, directory, position, Math.min(end, position + segmentSeconds), deadline)); }
        catch (error) { if (!segments.length) throw error; failed = true; break; }
      }
      const coveredEnd = segments.at(-1).end;
      const fullText = segments.map(segment => segment.text).join('\n');
      return { content: [{ type: 'text', text: JSON.stringify(fitTranscript({ text: fullText.slice(0, 12000), segments, startSeconds: start,
        endSeconds: coveredEnd, totalDuration: info.duration, truncated: start > 0 || coveredEnd < info.duration,
        textTruncated: fullText.length > 12000 || segments.some(s => s.textTruncated), status: failed ? 'partial' : 'processed',
        nextInput: continuation(coveredEnd, info.duration, { segmentSeconds, durationSeconds: seconds }),
        note: '本机 SenseVoice 分段语音识别，时间戳为片段边界而非逐字对齐；可能有识别错误，不包含画面分析。' })) }],
        evidence: ['metadata', 'transcript', 'audio'], ...(failed ? { cacheable: false } : {}) };
    });
  }
  async recognizeSegment(file, directory, start, end, deadline) {
    const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw Error('分段识别超时'); return ms; };
    const wav = path.join(directory, 'audio.f32');
    await runMedia(this.ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', file,
      '-t', String(end - start), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_f32le', '-f', 'f32le', '-threads', '1', '-y', wav], { timeoutMs: Math.min(20000, remaining()) });
    const raw = await runMedia(process.execPath, [fileURLToPath(new URL('./media-asr-worker.mjs', import.meta.url)), this.asrModule, this.asrModel, wav], { timeoutMs: remaining() });
    const text = String(JSON.parse(raw).text || '');
    return { start, end, text: text.slice(0, 12000), ...(text.length > 12000 ? { textTruncated: true } : {}) };
  }
}
