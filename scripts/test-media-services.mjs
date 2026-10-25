import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { LocalMediaEngine, mediaPaths, runMedia, decodeSource, frameTimes } from '../integrations/media-engine.mjs';
import { BridgeMediaProvider, bilibiliSourceUrl, mediaFailure, MAX_BILIBILI_VIDEO_BYTES } from '../integrations/media-provider.mjs';
import { bilibiliFetch, mediaRequestHeaders } from '../integrations/media-network.mjs';
import { buildMediaServices } from '../integrations/media-services.mjs';
import { ContentServiceRuntime } from '../src/framework/services.mjs';
import { ExtensionPermissions } from '../src/framework/permissions.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';

const runtime = mediaPaths();
const installed = fss.existsSync(runtime.ffmpeg) && fss.existsSync(runtime.ffprobe);
async function fixtures(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-media-test-'));
  const engine = new LocalMediaEngine({ temporaryRoot: directory });
  try {
    const raw = Buffer.concat([[240, 10, 10], [10, 240, 10], [10, 10, 240]].map(color => {
      const b = Buffer.alloc(64 * 64 * 3); for (let i = 0; i < b.length; i += 3) for (let j = 0; j < 3; j++) b[i + j] = color[j]; return b;
    }));
    await fs.writeFile(path.join(directory, 'frames.rgb'), raw);
    const video = path.join(directory, 'clip.mp4'), gif = path.join(directory, 'clip.gif');
    await runMedia(runtime.ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '64x64', '-r', '1', '-i', path.join(directory, 'frames.rgb'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-y', video]);
    await runMedia(runtime.ffmpeg, ['-v', 'error', '-i', video, '-threads', '1', '-y', gif]);
    const wav = Buffer.alloc(44 + 16000 * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    await run({ engine, directory, video: await fs.readFile(video), gif: await fs.readFile(gif), wav });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('media inputs reject arbitrary paths, invalid URLs, malformed bytes and unbounded sampling', () => {
  for (const url of ['https://bilibili.com.evil.test/video/BV1xx411c7mD', 'http://www.bilibili.com/video/BV1xx411c7mD', 'https://user:pass@www.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/read/1']) {
    assert.throws(() => bilibiliSourceUrl({ type: 'link', url }));
  }
  assert.throws(() => decodeSource({ file: 'C:/private/video.mp4' }), /base64/);
  assert.throws(() => decodeSource({ data: Buffer.from('#EXTM3U\nfile:///private/file').toString('base64') }), /格式/);
  assert.throws(() => frameTimes(10, { maxFrames: 7 }), /1–6/);
  assert.throws(() => frameTimes(10, { timestamps: '2,NaN' }), /范围/);
  assert.throws(() => frameTimes(10, { timestamps: '10' }), /范围/);
  assert.deepEqual(frameTimes(10, { maxFrames: 4 }), [0, 2.5, 5, 7.5]);
});

test('native media subprocesses stop on timeout and oversized output', async () => {
  await assert.rejects(runMedia(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 80 }), /超时|取消/);
  await assert.rejects(runMedia(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], { maxOutput: 100, timeoutMs: 2000 }), /超时|取消/);
});

test('multi-megabyte GIF base64 validates without stack overflow while malformed padding stays rejected', () => {
  const bytes = Buffer.alloc(7 * 1024 * 1024); bytes.write('GIF89a');
  assert.ok(decodeSource({ data: bytes.toString('base64') }).equals(bytes));
  for (const data of ['R0lGODlh=', 'R0lGODlhAB==', 'R0lG=DhhaQ==', 'R0lGODlh\n']) {
    assert.throws(() => decodeSource({ data }), /base64/);
  }
});

test('B站 transport pins checked addresses, strips CDN cookies and rejects foreign redirect hops', async () => {
  assert.equal(mediaRequestHeaders(new URL('https://api.bilibili.com/x'), { Cookie: 'session-fixture' }).cookie, 'session-fixture');
  assert.equal(mediaRequestHeaders(new URL('https://a.bilivideo.com/file'), { Cookie: 'session-fixture', Authorization: 'private' }).cookie, undefined);
  assert.equal(mediaRequestHeaders(new URL('https://a.bilivideo.com/file'), { Authorization: 'private' }).authorization, undefined);
  const seen = [];
  const validate = async raw => ({ url: new URL(raw), addresses: ['93.184.216.34'] });
  const requestImpl = async (url, address) => { seen.push([url.host, address]); return { status: 302, location: 'https://127.0.0.1/private' }; };
  await assert.rejects(bilibiliFetch('https://b23.tv/fixture', {}, { validate, requestImpl }), /非允许/);
  assert.deepEqual(seen, [['b23.tv', '93.184.216.34']]);
  await assert.rejects(bilibiliFetch('https://api.bilibili.com/x', { method: 'POST', body: '{}' }, { validate, requestImpl }), /转写接口/);
  await assert.rejects(bilibiliFetch('https://api.bilibili.com/x', {}, { validate: async () => { throw Error('private DNS'); }, requestImpl }), /private DNS/);
});

test('B站 text-first extraction disables frames/vision and declares no picture evidence', async () => {
  let options;
  const provider = new BridgeMediaProvider({ extractAll: async value => { options = value; return { success: true, metadata: { title: '测试', duration: 20, uploader: { name: '作者' } }, transcript: { source: 'subtitle', text: '字幕只描述了一部分画面' } }; } });
  const result = await provider.call('bilibili_transcript', { source: { type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, input: { asr: false } });
  assert.equal(options.extractFrames, false); assert.equal(options.visionProvider, 'none'); assert.equal(options.asrProvider, 'none');
  assert.deepEqual(result.evidence, ['metadata', 'transcript']);
  assert.match(result.content[0].text, /未读取画面/);
  assert.equal(JSON.parse(result.content[0].text).title, '测试');
  assert.equal(JSON.parse(result.content[0].text).uploader, '作者');
  await assert.rejects(fs.access(options.framesDir));
  await assert.rejects(provider.call('bilibili_transcript', { source: {}, input: { command: 'pwsh' } }), /未声明参数/);
});

test('B站 missing subtitles use bounded local audio fallback and disclose partial coverage', async () => {
  let calls = 0;
  const provider = new BridgeMediaProvider({
    extractAll: async () => ({ success: true, video: { duration: 300 }, transcript: {} }),
    engine: { transcript: async (bytes, input) => {
      calls++; assert.equal(bytes.toString(), 'audio'); assert.equal(input.durationSeconds, 120);
      return { content: [{ type: 'text', text: JSON.stringify({ text: '识别结果', startSeconds: 0, endSeconds: 120, totalDuration: 300, truncated: true }) }] };
    } },
    fetchImpl: async (url, _options, limits) => {
      if (url.includes('/view?')) return Response.json({ code: 0, data: { cid: 42, duration: 300 } });
      if (url.includes('/playurl?')) return Response.json({ code: 0, data: { dash: { audio: [{ baseUrl: 'https://foreign.test/audio', backupUrl: ['https://cdn.bilivideo.com/audio'] }] } } });
      assert.equal(new URL(url).hostname, 'cdn.bilivideo.com'); assert.equal(limits.maxBytes, 16 * 1024 * 1024);
      return new Response('audio');
    }
  });
  const source = { type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' };
  const result = await provider.call('bilibili_transcript', { source });
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.transcript.source, 'sensevoice-local'); assert.match(value.transcript.note, /仅覆盖部分音轨/);
  assert.equal(value.transcript.timeline[0].end, 120); assert.equal(calls, 1);
  assert.equal(value.audio.status, 'processed'); assert.ok(result.evidence.includes('audio'));
  const disabled = await provider.call('bilibili_transcript', { source, input: { asr: false } });
  assert.deepEqual(disabled.evidence, ['metadata']); assert.equal(calls, 1);
  assert.equal(JSON.parse(disabled.content[0].text).audio.status, 'not_requested');
});

test('Bilibili audio selects the smallest track and passes explicit recognition windows', async () => {
  const provider = new BridgeMediaProvider({ extractAll: async options => {
    assert.equal(options.asrProvider, 'none'); return { success: true, metadata: { duration: 1494 }, transcript: {} };
  }, engine: { transcript: async (_bytes, input) => {
    assert.deepEqual(input, { startSeconds: 500, durationSeconds: 30 });
    return { content: [{ type: 'text', text: JSON.stringify({ text: '片段识别', startSeconds: 500, endSeconds: 530, totalDuration: 1494, truncated: true }) }] };
  } }, fetchImpl: async url => {
    if (url.includes('/view?')) return Response.json({ code: 0, data: { cid: 42, duration: 1494 } });
    if (url.includes('/playurl?')) return Response.json({ code: 0, data: { dash: { audio: [
      { bandwidth: 219805, baseUrl: 'https://cdn.bilivideo.com/large' },
      { bandwidth: 65559, baseUrl: 'https://cdn.bilivideo.com/small' },
    ] } } });
    assert.equal(url, 'https://cdn.bilivideo.com/small'); return new Response('audio');
  } });
  const result = await provider.call('bilibili_transcript', { source: { type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, input: { startSeconds: 500, durationSeconds: 30 } });
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.audio.startSeconds, 500); assert.equal(value.audio.endSeconds, 530); assert.equal(value.audio.partial, true);
  await assert.rejects(provider.call('bilibili_transcript', { source: { type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, input: { durationSeconds: 181 } }), /时间范围/);
});

test('failed Bilibili audio recognition is distinct from silence and cannot be cached as success', async () => {
  const provider = new BridgeMediaProvider({ extractAll: async () => ({ success: true, metadata: { title: '测试' }, transcript: {} }) });
  provider.localTranscript = async () => { throw Error('private signed URL'); };
  const result = await provider.call('bilibili_transcript', { source: { type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' } });
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.audio.status, 'failed'); assert.match(value.transcript.note, /不表示原视频没有声音/);
  assert.equal(result.cacheable, false); assert.ok(!JSON.stringify(result).includes('private'));
  const permissions = new ExtensionPermissions({ policy: { rules: [{ key: 'group:456', capability: 'audio.test', decision: 'allow', dataScopes: ['source-reference'] }] } });
  const runtime = new ContentServiceRuntime({ permissions, services: [{ id: 'audio.test', effect: 'read', accepts: ['link'], transport: { type: 'http', url: 'http://127.0.0.1:9871/test' } }], fetchImpl: async () => Response.json(result) });
  try { await runtime.call({ key: 'group:456', scope: 'test', serviceId: 'audio.test', source: { type: 'link', sourceId: 'a'.repeat(32), url: 'https://example.com' } }); assert.equal(runtime.cache.size, 0); }
  finally { await runtime.close(); }
});

test('B站 frame mode downloads bounded public media before decoding, never hands URLs to FFmpeg', async () => {
  let received;
  const fakeVideo = Buffer.alloc(16); fakeVideo.write('ftyp', 4);
  const provider = new BridgeMediaProvider({ engine: { frames: async (bytes, input) => { received = { bytes, input }; return { content: [], evidence: ['frames'] }; } },
    fetchImpl: async (url, _options, limits) => {
      if (url.includes('/view?')) return Response.json({ code: 0, data: { cid: 42, duration: 30 } });
      if (url.includes('/playurl?')) return Response.json({ code: 0, data: { durl: [{ url: 'https://untrusted-cdn.test/sample.mp4', backup_url: ['https://cdn.bilivideo.com/sample.mp4'], size: 16 }] } });
      assert.equal(new URL(url).hostname, 'cdn.bilivideo.com');
      assert.equal(limits.maxBytes, 32 * 1024 * 1024); return new Response(fakeVideo);
    } });
  await provider.call('bilibili_frames', { source: { type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, input: { timestamps: '3' } });
  assert.ok(Buffer.isBuffer(received.bytes)); assert.deepEqual(received.input, { timestamps: '3' });
});

test('long Bilibili videos choose the smallest H.264 video-only track and skip PCDN ports', async () => {
  let download = 0; let decoded = 0;
  const provider = new BridgeMediaProvider({ engine: { frames: async bytes => { assert.equal(bytes.toString(), 'video-only'); decoded++; return { content: [{ type: 'text', text: JSON.stringify({ hasAudio: false }) }] }; } },
    fetchImpl: async (url, _options, limits) => {
      if (url.includes('/view?')) return Response.json({ code: 0, data: { cid: 42, duration: 1494 } });
      if (url.includes('fnval=1&')) return Response.json({ code: 0, data: { durl: [{ url: 'https://cdn.bilivideo.com/muxed', size: 97320214 }] } });
      if (url.includes('fnval=16&')) return Response.json({ code: 0, data: { dash: { video: [
        { codecid: 12, bandwidth: 100000, baseUrl: 'https://cdn.bilivideo.com/hevc' },
        { codecid: 7, bandwidth: 700000, baseUrl: 'https://cdn.bilivideo.com/large' },
        { codecid: 7, bandwidth: 450231, baseUrl: 'https://mcdn.bilivideo.cn:8082/video', backupUrl: ['https://cdn.bilivideo.com/small'] },
      ] } } });
      assert.equal(url, 'https://cdn.bilivideo.com/small'); assert.equal(limits.maxBytes, MAX_BILIBILI_VIDEO_BYTES);
      download++; return new Response('video-only');
    }
  });
  const result = await provider.frames({ type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, { maxFrames: 3 });
  const metadata = JSON.parse(result.content[0].text);
  assert.equal(metadata.hasAudio, undefined); assert.equal(metadata.audio.status, 'not_requested');
  assert.equal(metadata.audio.nextService, 'bilibili.transcript'); assert.match(metadata.note, /不代表原视频静音/);
  assert.equal(download, 1); assert.equal(decoded, 1);
});

test('oversized Bilibili tracks return a typed limit before downloading and never expose raw error text', async () => {
  const provider = new BridgeMediaProvider({ fetchImpl: async url => {
    if (url.includes('/view?')) return Response.json({ code: 0, data: { cid: 42, duration: 1494 } });
    if (url.includes('fnval=1&')) return Response.json({ code: 0, data: { durl: [{ url: 'https://cdn.bilivideo.com/muxed', size: 200000000 }] } });
    if (url.includes('fnval=16&')) return Response.json({ code: 0, data: { dash: { video: [{ codecid: 7, bandwidth: 1000000 }] } } });
    assert.fail('Oversized tracks must not be downloaded');
  } });
  await assert.rejects(provider.frames({ type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }), error => {
    assert.equal(error.code, 'MEDIA_DOWNLOAD_LIMIT'); assert.equal(mediaFailure(error).limitMiB, 96); return true;
  });
  assert.ok(!JSON.stringify(mediaFailure(Error('private signed URL or credential'))).includes('private'));
  const permissions = new ExtensionPermissions({ policy: { rules: [{ key: 'group:456', capability: 'video.test', decision: 'allow', dataScopes: ['source-reference'] }] } });
  const runtime = new ContentServiceRuntime({ permissions, services: [{ id: 'video.test', effect: 'read', accepts: ['link'], transport: { type: 'http', url: 'http://127.0.0.1:9871/test' } }],
    fetchImpl: async () => Response.json({ isError: true, content: [{ type: 'text', text: JSON.stringify({ protocol: 'qq-bridge.media-error/v1', code: 'MEDIA_DOWNLOAD_LIMIT', limitMiB: 96, message: 'private signed URL' }) }] }) });
  try { await assert.rejects(runtime.call({ key: 'group:456', scope: 'test', serviceId: 'video.test', source: { type: 'link', sourceId: 'a'.repeat(32), url: 'https://example.com' } }), error => {
    assert.match(error.message, /MEDIA_DOWNLOAD_LIMIT.*96 MiB/); assert.ok(!error.message.includes('private')); return true;
  }); } finally { await runtime.close(); }
});

test('real FFmpeg samples changing MP4 and GIF frames, returns PNGs and cleans private job files', { skip: !installed }, () => fixtures(async ({ engine, directory, video, gif }) => {
  for (const bytes of [video, gif]) {
    assert.ok((await engine.frames(bytes)).content.length >= 2, 'default sampling must work without timestamps');
    const result = await engine.frames(bytes, { maxFrames: 3, timestamps: '0,1,2' });
    assert.equal(result.content.length, 4);
    const images = result.content.slice(1).map(block => PNG.sync.read(Buffer.from(block.data, 'base64')));
    assert.ok(images[0].data[0] > images[0].data[1]);
    assert.ok(images[1].data[1] > images[1].data[0]);
    assert.ok(images[2].data[2] > images[2].data[1]);
    assert.match(result.content[0].text, /不能据此声称/);
    assert.deepEqual(result.evidence, ['metadata', 'frames']);
  }
  assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('qq-media-')));
  assert.equal((await engine.frames(gif, { timestamps: '2.9' })).content.length, 2);
  await assert.rejects(engine.frames(video, { timestamps: '1000' }), /范围/);
}));

test('real local SenseVoice can process a bounded video/audio track with no API account', { skip: !installed }, () => fixtures(async ({ engine, wav }) => {
  const result = await engine.transcript(wav, { durationSeconds: 1 });
  assert.deepEqual(result.evidence, ['metadata', 'transcript', 'audio']);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.startSeconds, 0); assert.equal(value.endSeconds, 1); assert.equal(typeof value.text, 'string');
}));

test('services remain default-deny, and approval is checked before reading source bytes', async () => {
  let reads = 0;
  const permissions = new ExtensionPermissions();
  const runtime = new ContentServiceRuntime({ services: buildMediaServices(), permissions, readSource: async () => { reads++; throw Error('should not read'); } });
  const source = { type: 'video', sourceId: 'a'.repeat(32) };
  try {
    assert.deepEqual(runtime.list(source, { key: 'group:456' }), []);
    await assert.rejects(runtime.call({ key: 'group:456', scope: 'test', serviceId: 'media.frames', source }), /未获/);
    permissions.replacePolicy({ rules: [{ key: 'group:456', capability: 'media.frames', decision: 'ask', dataScopes: ['source-bytes'] }] });
    assert.equal((await runtime.call({ key: 'group:456', scope: 'test', serviceId: 'media.frames', source })).status, 'approval_required');
    assert.equal(reads, 0);
  } finally { await runtime.close(); }
});

test('actual framework API invokes real stdio/FFmpeg/SenseVoice for scoped frames and gateway voice bytes', { skip: !installed }, () => fixtures(async ({ gif, wav, directory }) => {
  const services = buildMediaServices();
  const rules = ['media.frames', 'media.transcript'].map(capability => ({ key: 'group:456', capability, decision: 'allow', dataScopes: ['source-bytes', 'input'], maxInputChars: 8000 }));
  const h = await bridgeHarness({ config: { ownerQQ: 123, dualMode: { enabled: true, ownerPreset: 'standard' },
    allow: { groups: ['456', '789'], private: ['123'] }, framework: { services, permissions: { rules }, mediaRoots: [directory] } } });
  const local = path.join(directory, 'received.gif'); await fs.writeFile(local, gif);
  await h.ensureSession('group:456'); await h.ensureSession('group:789');
  h.contentSources.register('group:456', { sources: [{ type: 'sticker', sourceId: 'a'.repeat(32), messageId: '42', file: local }] });
  h.contentSources.register('group:456', { sources: [{ type: 'voice', sourceId: 'b'.repeat(32), messageId: '43', file: 'received.amr', url: 'https://never-download.invalid/silk' }] });
  h.bot.raw = async (action, args) => {
    assert.equal(action, 'get_record'); assert.equal(args.out_format, 'wav');
    return { base64: wav.toString('base64'), file: '/container-only/audio.wav' };
  };
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const a = new QQBridgeClient({ baseUrl, key: 'group:456', token: h.getSocialV2State('group:456').agentToken });
  const b = new QQBridgeClient({ baseUrl, key: 'group:789', token: h.getSocialV2State('group:789').agentToken });
  try {
    const result = await a.processContent('media.frames', { sourceId: 'a'.repeat(32), input: { timestamps: '0,1,2', maxFrames: 3 } });
    assert.equal(result.content.filter(block => block.type === 'image').length, 3);
    assert.equal(result.media.length, 3); assert.deepEqual(result.evidence, ['metadata', 'frames']);
    assert.ok(result.media.every(media => /^[a-f0-9]{32}$/.test(media.mediaId)));
    await assert.rejects(b.processContent('media.frames', { sourceId: 'a'.repeat(32) }), /会话|引用/);
    assert.ok(!JSON.stringify(result).includes('private-job'));
    const voice = await a.processContent('media.transcript', { sourceId: 'b'.repeat(32), input: { durationSeconds: 1 } });
    assert.deepEqual(voice.evidence, ['metadata', 'transcript', 'audio']);
    assert.equal(JSON.parse(voice.content[0].text).endSeconds, 1);
    await assert.rejects(b.processContent('media.transcript', { sourceId: 'b'.repeat(32) }), /会话|引用/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); }
}));
