import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomInt } from 'node:crypto';
import { applyTone } from './vendor/dsh-fish-tone/lib/tone.js';
import { assess } from './vendor/dsh-fish-tone/lib/judge.js';
import { searchMemes, randomMeme, flavor } from './vendor/dsh-fish-tone/lib/flavor.js';
import { loadFishToneSettings, resolveFishTone } from '../src/fish-tone.mjs';

function encoded(value) {
  const text = JSON.stringify(value);
  if (text.length > 15500) throw Error('结果过长，请缩短输入');
  return { content: [{ type: 'text', text }] };
}
export function runFishTone(tool, { input = {}, context = {} } = {}, { settings = {}, role = null } = {}) {
  if (!context || !/^(group|private):[1-9]\d{0,15}$/.test(context.key ?? '')) throw Error('需要桥接提供的当前会话');
  const allowed = tool === 'text_judge' ? ['text'] : tool === 'text_meme' ? ['text', 'kind', 'vibe', 'limit', 'random', 'seed']
    : tool === 'text_tone' ? ['text', 'strength', 'mode', 'seed'] : [];
  if (!allowed.length || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))
    || typeof input.text !== 'string' || !input.text.trim() || input.text.length > (tool === 'text_meme' ? 100 : 6000)) throw Error('文本参数无效');
  if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4294967295)) throw Error('seed无效');
  if (tool === 'text_judge') {
    const result = assess(input.text);
    const count = result.hits.length;
    result.hits = result.hits.slice(0, 20).map(h => ({ ...h, sentence: h.sentence.slice(0, 240) }));
    return encoded({ engine: 'dsh-fish-tone', original: input.text, ...result, hitCount: count, hitsTruncated: count > 20,
      note: '仅为本地句式规则建议，不是AI鉴定；保留有实际逻辑作用的表达，勿机械删改。' });
  }
  if (tool === 'text_meme') {
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 8)
      || input.random !== undefined && typeof input.random !== 'boolean'
      || input.kind !== undefined && !['word', 'construction'].includes(input.kind)
      || input.vibe !== undefined && !['cute', 'abstract', 'ironic', 'broken', 'work', 'heal', 'hype', 'retro', 'slacker', 'fun'].includes(input.vibe)) throw Error('查梗参数无效');
    const options = { query: input.random ? '' : input.text, kind: input.kind, vibe: input.vibe, limit: input.limit ?? 5 };
    const memes = input.random ? [randomMeme(input.seed ?? randomInt(0, 0x100000000), options)].filter(Boolean) : searchMemes(options);
    return encoded({ engine: 'dsh-fish-tone', memes: memes.map(m => ({ term: m.term, kind: m.kind, template: m.template,
      gloss: m.gloss || '尚未考据，勿自行编造词义', known: !!m.gloss, usage: m.usage, vibes: m.vibes, source: m.source })),
      note: '静态本地词库；不保证时效、词义或使用场合正确，不自动学习聊天内容。' });
  }
  const options = resolveFishTone(settings, { key: context.key, role });
  if (!options.enabled || !options.rewriteEnabled) throw Error('当前会话润色未启用');
  const strength = input.strength ?? options.strength, mode = input.mode ?? options.style;
  if (!['off', 'light', 'normal', 'max'].includes(strength) || !['neutral', 'cute', 'abstract', 'shock'].includes(mode)) throw Error('润色参数无效');
  if (strength === 'off') return encoded({ original: input.text, text: input.text, changed: false });
  // Protect whole lines containing factual/numeric material; stylistic rules have no semantic understanding.
  let inFence = false, protectedLines = 0;
  const output = input.text.split('\n').map((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; protectedLines++; return line; }
    if (inFence || /\d|[`"“”「」]|https?:|[A-Za-z]:\\|\/[\w.-]+\/|--[\w-]+|(?:确认|证实|证明|事实|结论|必须|禁止|不得|不能|不应|已经|已完成)/.test(line)) { protectedLines++; return line; }
    const seed = ((input.seed ?? 7) + i) >>> 0;
    return mode === 'neutral' ? applyTone(line, { strength, seed, protect: true }).text
      : flavor(line, { mode, rate: { light: 'low', normal: 'normal', max: 'high' }[strength], seed, protect: true }).text;
  }).join('\n');
  return encoded({ engine: 'dsh-fish-tone', original: input.text, text: output, changed: output !== input.text,
    protectedLines, note: '建议稿未经语义证明；请核对原意后自行采用。未运行错字注入、语义微标记或QQ发送。' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'qq-bridge-fish-tone', version: '1.0.0' });
  for (const tool of ['text_judge', 'text_meme', 'text_tone']) server.tool(tool, 'Scoped local draft or meme assistance',
    { input: z.record(z.string(), z.unknown()), context: z.object({ key: z.string() }) }, async args => {
      try {
        let role = null;
        try { role = JSON.parse(fs.readFileSync(arg('role'), 'utf8')).role; } catch {}
        return runFishTone(tool, args, { settings: loadFishToneSettings(arg('settings')), role });
      } catch { return { isError: true, content: [{ type: 'text', text: '本地表达服务未执行：请检查参数、会话润色开关与配置。' }] }; }
    });
  await server.connect(new StdioServerTransport());
}
