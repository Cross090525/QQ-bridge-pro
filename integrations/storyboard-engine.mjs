import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalMediaEngine, mediaExtension, mediaWindow, continuation, runMedia } from './media-engine.mjs';

export function validateStoryboardInput(input = {}) {
  const allowed = ['startSeconds', 'durationSeconds', 'cells', 'need', 'detail', 'asr', 'mode'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw Error('不允许自定义路径、URL、命令或未声明参数');
  if (input.cells !== undefined && (!Number.isSafeInteger(input.cells) || input.cells < 1 || input.cells > 9)) throw Error('cells 须为1–9');
  if (input.need !== undefined && !['shot', 'scene', 'text'].includes(input.need)) throw Error('need 无效');
  if (input.detail !== undefined && !['low', 'med', 'high'].includes(input.detail)) throw Error('detail 无效');
  if (input.mode !== undefined && !['board', 'zoom'].includes(input.mode)) throw Error('mode 无效');
  if (input.asr !== undefined && typeof input.asr !== 'boolean') throw Error('asr 须为布尔值');
  const start = input.startSeconds ?? 0, seconds = input.durationSeconds ?? (input.mode === 'zoom' ? 15 : 120);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(seconds) || seconds < 1 || seconds > (input.mode === 'zoom' ? 30 : 180)) throw Error('处理时间范围无效，board最多180秒，zoom最多30秒');
  return { ...input, startSeconds: start, durationSeconds: seconds };
}

export class StoryboardMediaEngine extends LocalMediaEngine {
  async storyboard(buffer, rawInput = {}, { transcriptSegments, audioBuffer, audioStatus } = {}) {
    const input = validateStoryboardInput(rawInput);
    return this.job(buffer, async ({ directory, file: sourceFile }) => {
      let file = sourceFile, info = await this.probe(file);
      if (!info.hasVideo) throw Error('媒体没有可读取的画面');
      if (audioBuffer && !info.hasAudio) {
        const audioFile = path.join(directory, 'audio' + mediaExtension(audioBuffer));
        const muxed = path.join(directory, 'combined.mp4');
        await fs.writeFile(audioFile, audioBuffer);
        await runMedia(this.ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', file,
          '-protocol_whitelist', 'file,pipe', '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-y', muxed], { timeoutMs: 30000 });
        file = muxed; info = await this.probe(file);
      }
      const ext = mediaExtension(buffer);
      if (['.png', '.jpg'].includes(ext)) return { content: [{ type: 'text', text: JSON.stringify({ engine: 'dsh-video-storyboard', static: true,
        note: '此资源为静态图片，不包含动态画面或音频证据。' }) }, { type: 'image', mimeType: ext === '.png' ? 'image/png' : 'image/jpeg', data: buffer.toString('base64') }], evidence: ['metadata', 'frames'] };
      const window = mediaWindow(info.duration, input);
      let segments = transcriptSegments, audio = { status: audioStatus ?? 'not_requested' };
      if (!segments && input.asr !== false && (audioBuffer || info.hasAudio)) {
        try {
          const result = await this.transcript(audioBuffer || buffer, { startSeconds: window.start, durationSeconds: window.end - window.start, segmentSeconds: 30 });
          const value = JSON.parse(result.content[0].text);
          segments = value.segments;
          audio = { status: value.status, startSeconds: value.startSeconds, endSeconds: value.endSeconds,
            timestampPrecision: 'chunk', note: '本机SenseVoice转写，时间为片段边界，非逐字对齐。' };
        } catch { audio = { status: 'failed', note: '本机转写失败；不能据此判断原视频静音。' }; }
      }
      let transcriptFile;
      if (segments) {
        transcriptFile = path.join(directory, 'transcript.json');
        await fs.writeFile(transcriptFile, JSON.stringify(segments));
      }
      const zoom = input.mode === 'zoom';
      await fs.writeFile(path.join(directory, 'options.json'), JSON.stringify({ input: file, from: window.start, to: window.end,
        cells: input.cells ?? (zoom ? 4 : 0), sheets: 1, maxPerSheet: 9, budget: 1200000,
        need: input.need ?? (zoom ? 'text' : 'scene'), adaptive: !zoom, noTile: zoom,
        pick: 'sharp', minGap: zoom ? 0.3 : 1.2, transcript: 'off', transcriptFile,
        audioStrip: info.hasAudio, textChars: { low: 60, med: 120, high: 400 }[input.detail ?? 'med'],
        ffmpegPath: this.ffmpeg, ffprobePath: this.ffprobe }));
      const raw = await runMedia(process.execPath, [fileURLToPath(new URL('./storyboard-worker.mjs', import.meta.url)), directory], { timeoutMs: 140000, maxOutput: 128000 });
      const result = JSON.parse(raw);
      const images = await Promise.all(result.sheets.map(async (_, i) => ({ type: 'image', mimeType: 'image/png', data: (await fs.readFile(path.join(directory, `sheet-${i}.png`))).toString('base64') })));
      const value = { engine: 'dsh-video-storyboard', version: '0.5.4', mode: input.mode ?? 'board',
        duration: info.duration, coverage: { startSeconds: window.start, endSeconds: window.end, sampledOnly: true,
          partial: window.start > 0 || window.end < info.duration },
        nextInput: continuation(window.end, info.duration, input),
        transcript: { source: transcriptSegments ? 'site-subtitles' : segments ? 'sensevoice-local' : 'none' }, ...result,
        // Audio envelopes describe loudness only; speech status is reported separately.
        audio: { ...audio, envelope: result.audio },
        note: '按sheet和格号对照图片；t_start/t_end是覆盖范围，t_frame是取帧时刻，sub表示格内子图。仅为抽样证据；需要细节用同一sourceId传mode=zoom及明确时间段。未取得台词不表示没有声音。' };
      let text = JSON.stringify(value);
      if (text.length > 15500) {
        for (const sheet of value.sheets) for (const cell of sheet.cells) if (cell.text) cell.text = cell.text.slice(0, 60);
        value.textTruncated = true; text = JSON.stringify(value);
      }
      if (text.length > 16000) throw Error('分镜文本超过框架上限，请缩短区间');
      return { content: [{ type: 'text', text }, ...images], evidence: ['metadata', 'frames', ...(segments?.length ? ['transcript'] : []),
        ...(['processed', 'partial'].includes(audio.status) ? ['audio'] : [])],
        ...(['failed', 'partial'].includes(audio.status) ? { cacheable: false } : {}) };
    });
  }
}
