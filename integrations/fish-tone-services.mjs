import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
export function buildFishToneServices({ entry = fileURLToPath(new URL('./fish-tone-provider.mjs', import.meta.url)),
  settingsFile = path.join(root, 'state/fish-tone.json'), roleFile = path.join(root, 'state/current-role.json'), command = process.execPath } = {}) {
  const transport = { type: 'stdio', command, args: [entry, `--settings=${settingsFile}`, `--role=${roleFile}`] };
  const text = { type: 'string', maxLength: 6000 };
  return [
    { id: 'text.judge', tool: 'text_judge', effect: 'read', description: '本地分析中文草稿的模板句式、密度和扎堆，只给建议，不改原文',
      inputSchema: { properties: { text }, required: ['text'] }, inputHint: 'input.text为草稿，最多6000字符。按需调用；结果是规则启发，不是AI文本鉴定，不强迫删掉有真实作用的句式。' },
    { id: 'text.meme', tool: 'text_meme', effect: 'read', description: '本地查询1000个梗词与24个句式；未考据词条明确标注',
      inputSchema: { properties: { text: { type: 'string', maxLength: 100 }, kind: { type: 'string', enum: ['word', 'construction'] },
        vibe: { type: 'string', enum: ['cute', 'abstract', 'ironic', 'broken', 'work', 'heal', 'hype', 'retro', 'slacker', 'fun'] }, limit: { type: 'number' }, random: { type: 'boolean' }, seed: { type: 'number' } }, required: ['text'] },
      inputHint: 'input.text为原词或查梗意图；random=true随机抽一条，可指定vibe/kind/seed；limit 1–8。词义未考据时不自行编造。按需使用，不例行查库。' },
    { id: 'text.tone', tool: 'text_tone', effect: 'generate', description: '可选的本地草稿润色：默认关闭，需管理员启用且获内容服务授权',
      inputSchema: { properties: { text, strength: { type: 'string', enum: ['off', 'light', 'normal', 'max'] },
        mode: { type: 'string', enum: ['neutral', 'cute', 'abstract', 'shock'] }, seed: { type: 'number' } }, required: ['text'] },
      inputHint: '管理员启用该会话rewriteEnabled并授权后才可用。只返回建议稿，不发送QQ；默认轻度，保留原文供核对。strength=off完全原样返回。保护代码、数字、路径、引文、事实陈述；不注入错字和也/好像/根本等语义标记。' },
  ].map(service => ({ ...service, accepts: ['text'], cache: false, timeoutMs: 10000, transport,
    arguments: { input: '$input', context: { key: '$context.key' } } }));
}
