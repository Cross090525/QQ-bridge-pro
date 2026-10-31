import { fileURLToPath } from 'node:url';
export function buildDraftJudgeServices({ entry = fileURLToPath(new URL('./draft-judge-provider.mjs', import.meta.url)), command = process.execPath } = {}) {
  return [{ id: 'text.judge', tool: 'text_judge', effect: 'read', accepts: ['text'], cache: false, timeoutMs: 10000,
    description: '按需检查草稿的句式密度与扎堆，只给建议，不改写原文',
    inputSchema: { properties: { text: { type: 'string', maxLength: 6000 } }, required: ['text'] },
    inputHint: 'input.text为草稿，最多6000字符。只在表达明显生硬时按需调用，不例行检查；不是AI文本鉴定，不要求机械删除有实际逻辑作用的句式。',
    transport: { type: 'stdio', command, args: [entry] } }];
}
