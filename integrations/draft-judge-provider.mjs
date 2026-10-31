import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assess } from './vendor/dsh-fish-tone/lib/judge.js';

export function judgeDraft(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'text')
    || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 6000) throw Error('草稿须为1–6000字符，只接受text参数');
  const result = assess(input.text), count = result.hits.length;
  result.hits = result.hits.slice(0, 20).map(h => ({ ...h, sentence: h.sentence.slice(0, 240) }));
  const text = JSON.stringify({ original: input.text, ...result, hitCount: count, hitsTruncated: count > 20,
    note: '只读句式建议，不是AI文本鉴定；不修改草稿，不决定人格与语气。' });
  if (text.length > 15500) throw Error('结果过长，请缩短草稿');
  return { content: [{ type: 'text', text }] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'qq-bridge-draft-judge', version: '1.0.0' });
  server.tool('text_judge', 'Read-only local draft analysis', { input: z.record(z.string(), z.unknown()), source: z.record(z.string(), z.unknown()).optional() }, async ({ input }) => {
    try { return judgeDraft(input); }
    catch { return { isError: true, content: [{ type: 'text', text: '草稿检查未执行，请检查文本长度和参数。' }] }; }
  });
  await server.connect(new StdioServerTransport());
}
