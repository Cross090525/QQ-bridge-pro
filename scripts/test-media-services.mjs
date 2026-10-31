import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { LocalMediaEngine, mediaPaths, runMedia, decodeSource } from '../integrations/media-engine.mjs';
import { StoryboardMediaEngine, validateStoryboardInput } from '../integrations/storyboard-engine.mjs';
import { BridgeMediaProvider, bilibiliSourceUrl, mediaFailure } from '../integrations/media-provider.mjs';
import { bilibiliFetch, mediaRequestHeaders } from '../integrations/media-network.mjs';
import { buildMediaServices } from '../integrations/media-services.mjs';
import { migrateMediaServices } from './setup-media-services.mjs';
import { ContentServiceRuntime } from '../src/framework/services.mjs';
import { ExtensionPermissions } from '../src/framework/permissions.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';

const binaries = mediaPaths();
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-storyboard-test-'));
  const engine = new StoryboardMediaEngine({ temporaryRoot: directory });
  try {
    // Three different scenes plus an audio track exercise actual upstream HSV scan,
    // sharp frame selection, audio filters and PNG encoding without external media.
    const video = path.join(directory, 'clip.mp4'), gif = path.join(directory, 'clip.gif');
    await runMedia(binaries.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=2',
      '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=6', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-threads', '1', '-y', video]);
    await runMedia(binaries.ffmpeg, ['-v', 'error', '-i', video, '-an', '-threads', '1', '-y', gif]);
    const wav = Buffer.alloc(44 + 16000 * 2); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    await run({ engine, directory, video: await fs.readFile(video), gif: await fs.readFile(gif), wav });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('retired video tools are absent; storyboard inputs cannot select paths, URLs, backends or unbounded work', async () => {
  assert.deepEqual(buildMediaServices().map(s => s.id), ['bilibili.storyboard', 'media.storyboard', 'media.transcript']);
  for (const input of [{ input: '/private/video' }, { url: 'https://evil.test' }, { ffmpegPath: 'sh' }, { cells: 10 },
    { durationSeconds: 181 }, { mode: 'zoom', durationSeconds: 31 }, { startSeconds: -1 }, { asr: 'true' }]) assert.throws(() => validateStoryboardInput(input));
  for (const url of ['https://bilibili.com.evil.test/video/BV1xx411c7mD', 'http://bilibili.com/video/BV1xx411c7mD', 'https://a:b@bilibili.com/video/BV1xx411c7mD']) assert.throws(() => bilibiliSourceUrl({ type: 'link', url }));
  const provider = new BridgeMediaProvider();
  for (const tool of ['media_frames', 'bilibili_frames', 'bilibili_transcript']) await assert.rejects(provider.call(tool, { source: { type: 'video' } }), /未知/);
  assert.throws(() => decodeSource({ file: '/private/file' }), /base64/);
  const bytes = Buffer.alloc(7 * 1024 * 1024); bytes.write('GIF89a'); assert.ok(decodeSource({ data: bytes.toString('base64') }).equals(bytes));
  for (const data of ['R0lGODlh=', 'R0lGODlhAB==', 'R0lGODlh\n']) assert.throws(() => decodeSource({ data }), /base64/);
});

test('migration removes legacy services, preserves unrelated extensions, existing deny/ask and account env mapping', () => {
  const old = { allow: { groups: ['456'] }, framework: { services: [{ id: 'media.frames' }, { id: 'custom.service' },
    { id: 'bilibili.frames', transport: { envFrom: { BILIBILI_SESSDATA: 'MY_BILI_COOKIE' } } }], permissions: { rules: [
      { key: 'group:456', capability: 'bilibili.frames', decision: 'allow' }, { key: 'group:456', capability: 'bilibili.transcript', decision: 'deny' },
      { key: 'group:456', capability: 'media.frames', decision: 'ask', maxCallsPerMinute: 2 } ] } } };
  const updated = migrateMediaServices(old, buildMediaServices());
  assert.ok(updated.framework.services.some(s => s.id === 'custom.service'));
  assert.ok(!updated.framework.services.some(s => s.id === 'media.frames'));
  assert.equal(updated.framework.permissions.rules.find(r => r.capability === 'bilibili.storyboard').decision, 'deny');
  assert.equal(updated.framework.permissions.rules.find(r => r.capability === 'media.storyboard').decision, 'ask');
  assert.equal(updated.framework.permissions.rules.find(r => r.capability === 'media.storyboard').maxCallsPerMinute, 2);
  assert.deepEqual(updated.framework.services.find(s => s.id === 'bilibili.storyboard').transport.envFrom, { BILIBILI_SESSDATA: 'MY_BILI_COOKIE' });
  assert.deepEqual(migrateMediaServices(updated, buildMediaServices()), updated);
  assert.equal(migrateMediaServices({}, buildMediaServices()).framework.permissions.rules.length, 0);
});

test('B站 transport pins public addresses, rejects foreign redirects and never forwards account cookies to CDN', async () => {
  assert.equal(mediaRequestHeaders(new URL('https://api.bilibili.com/x'), { Cookie: 'fixture' }).cookie, 'fixture');
  assert.equal(mediaRequestHeaders(new URL('https://cdn.bilivideo.com/file'), { Cookie: 'fixture', Authorization: 'private' }).cookie, undefined);
  const seen = [];
  await assert.rejects(bilibiliFetch('https://b23.tv/fixture', {}, { validate: async raw => ({ url: new URL(raw), addresses: ['93.184.216.34'] }),
    requestImpl: async (url, address) => { seen.push([url.hostname, address]); return { status: 302, location: 'https://127.0.0.1/private' }; } }), /非允许/);
  assert.deepEqual(seen, [['b23.tv', '93.184.216.34']]);
  assert.equal(mediaFailure(Error('https://secret:password@private')).code, 'MEDIA_PROCESSING_FAILED');
  assert.ok(!JSON.stringify(mediaFailure(Error('password'))).includes('password'));
});

test('B站 download hands local bytes and site subtitles to the new engine; no legacy extractor or URL reaches decoder', async () => {
  const calls = [];
  const provider = new BridgeMediaProvider({ sessdata: 'fixture-cookie', engine: { storyboard: async (bytes, input, extra) => {
    assert.equal(bytes.toString(), 'video'); assert.equal(input.startSeconds, 12); assert.equal(extra.transcriptSegments[0].text, '字幕原文');
    return { content: [{ type: 'text', text: '{}' }], evidence: ['frames', 'transcript'] };
  } }, fetchImpl: async (url, options, limits) => {
    calls.push(url);
    if (url.includes('/view?')) return Response.json({ code: 0, data: { cid: 42, duration: 60, title: '片名' } });
    if (url.includes('/playurl?')) return Response.json({ code: 0, data: { dash: { video: [{ codecid: 7, bandwidth: 1000, baseUrl: 'https://cdn.bilivideo.com/video' }] } } });
    if (url.includes('/player/v2?')) return Response.json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://aisubtitle.hdslb.com/sub.json' }] } } });
    assert.equal(options?.headers?.cookie, undefined);
    if (url.includes('sub.json')) return Response.json({ body: [{ from: 12, to: 14, content: '字幕原文' }] });
    assert.equal(limits.maxBytes, 96 * 1048576); return new Response('video');
  } });
  const result = await provider.call('bilibili_storyboard', { source: { type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, input: { startSeconds: 12 } });
  assert.equal(JSON.parse(result.content[0].text).title, '片名'); assert.equal(calls.length, 5);
});

test('B站 oversized streams fail before downloading and never expose signed URLs', async () => {
  let downloads = 0;
  const provider = new BridgeMediaProvider({ fetchImpl: async url => {
    if (url.includes('/view?')) return Response.json({ code: 0, data: { cid: 42, duration: 1200 } });
    if (url.includes('/playurl?')) return Response.json({ code: 0, data: { dash: { video: [{ codecid: 7, bandwidth: 9000000, baseUrl: 'https://cdn.bilivideo.com/secret' }] } } });
    downloads++; throw Error('must not download');
  } });
  await assert.rejects(provider.storyboard({ type: 'link', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }), e => e.code === 'MEDIA_DOWNLOAD_LIMIT');
  assert.equal(downloads, 0);
});

test('permissions remain default deny; ask is checked before source bytes are read', async () => {
  let reads = 0; const permissions = new ExtensionPermissions();
  const runtime = new ContentServiceRuntime({ services: buildMediaServices(), permissions, readSource: async () => { reads++; throw Error('unexpected'); } });
  const source = { type: 'video', sourceId: 'a'.repeat(32) };
  try {
    assert.deepEqual(runtime.list(source, { key: 'group:456' }), []);
    await assert.rejects(runtime.call({ key: 'group:456', scope: 'test', serviceId: 'media.storyboard', source }), /未获/);
    permissions.replacePolicy({ rules: [{ key: 'group:456', capability: 'media.storyboard', decision: 'ask', dataScopes: ['source-bytes'] }] });
    assert.equal((await runtime.call({ key: 'group:456', scope: 'test', serviceId: 'media.storyboard', source })).status, 'approval_required');
    assert.equal(reads, 0);
  } finally { await runtime.close(); }
});

test('real upstream storyboard scans scenes, aligns subtitle times, emits numbered PNG, zooms and cleans caches', () => fixture(async ({ engine, video, gif, directory }) => {
  const result = await engine.storyboard(video, { asr: false, cells: 3, durationSeconds: 4 }, { transcriptSegments: [{ start: 0, end: 2, text: '红色场景' }, { start: 2, end: 4, text: '绿色场景' }] });
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.engine, 'dsh-video-storyboard'); assert.ok(value.cuts >= 1); assert.equal(value.coverage.endSeconds, 4);
  assert.equal(value.nextInput.startSeconds, 4); assert.ok(value.sheets[0].cells.some(c => c.text?.includes('红色')));
  assert.ok(value.sheets[0].cells.every(c => c.i > 0 && c.t_end > c.t_start));
  const image = PNG.sync.read(Buffer.from(result.content[1].data, 'base64')); assert.ok(image.width > 100 && image.height > 100);
  assert.ok(!JSON.stringify(result).includes(directory)); assert.ok(value.audio.envelope);
  const zoom = await engine.storyboard(gif, { asr: false, mode: 'zoom', startSeconds: 2, durationSeconds: 2, cells: 2 });
  const detail = JSON.parse(zoom.content[0].text); assert.equal(detail.coverage.startSeconds, 2);
  assert.ok(detail.sheets[0].cells.every(c => !c.sub && c.t_start >= 2 && c.t_end <= 4));
  assert.deepEqual((await fs.readdir(directory)).sort(), ['clip.gif', 'clip.mp4']);
}));

test('real bridge API and stdio return scoped storyboard image handles; another conversation cannot reuse source', () => fixture(async ({ directory, gif }) => {
  const services = buildMediaServices();
  const rules = [{ key: 'group:456', capability: 'media.storyboard', decision: 'allow', dataScopes: ['source-bytes', 'input'] }];
  const h = await bridgeHarness({ config: { ownerQQ: 123, dualMode: { enabled: true, ownerPreset: 'standard' }, allow: { groups: ['456', '789'], private: ['123'] },
    framework: { services, permissions: { rules }, mediaRoots: [directory] } } });
  const local = path.join(directory, 'received.gif'); await fs.writeFile(local, gif);
  await h.ensureSession('group:456'); await h.ensureSession('group:789');
  h.contentSources.register('group:456', { sources: [{ type: 'sticker', sourceId: 'a'.repeat(32), messageId: '42', file: local }] });
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const a = new QQBridgeClient({ baseUrl, key: 'group:456', token: h.getSocialV2State('group:456').agentToken });
  const b = new QQBridgeClient({ baseUrl, key: 'group:789', token: h.getSocialV2State('group:789').agentToken });
  try {
    const result = await a.processContent('media.storyboard', { sourceId: 'a'.repeat(32), input: { asr: false, cells: 3, durationSeconds: 4 } });
    assert.equal(result.content.filter(c => c.type === 'image').length, 1); assert.equal(result.media.length, 1);
    assert.match(result.media[0].mediaId, /^[a-f0-9]{32}$/); assert.deepEqual(result.evidence, ['metadata', 'frames']);
    await assert.rejects(b.processContent('media.storyboard', { sourceId: 'a'.repeat(32) }), /会话|引用/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close(); }
}));

test('standalone QQ voice keeps real local SenseVoice; storyboard marks failed ASR without claiming silence', () => fixture(async ({ engine, wav, video }) => {
  const voice = await engine.transcript(wav, { durationSeconds: 1 });
  assert.equal(JSON.parse(voice.content[0].text).endSeconds, 1); assert.ok(voice.evidence.includes('audio'));
  engine.transcript = async () => { throw Error('unavailable'); };
  const result = await engine.storyboard(video, { durationSeconds: 2, cells: 1 });
  const value = JSON.parse(result.content[0].text); assert.equal(value.audio.status, 'failed'); assert.equal(result.cacheable, false);
  assert.ok(!result.evidence.includes('audio')); assert.match(value.audio.note, /不能/);
}));

test('native subprocesses stop on timeout and oversized output', async () => {
  await assert.rejects(runMedia(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 80 }), /超时|取消/);
  await assert.rejects(runMedia(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], { maxOutput: 100 }), /超时|取消/);
});
