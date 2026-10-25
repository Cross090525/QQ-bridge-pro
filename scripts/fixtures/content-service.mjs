// Offline MCP provider used only by framework regression tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'fixture-content', version: '1.0.0' });
server.tool('inspect_video', 'Fixture captions, not a real Bilibili request.', { url: z.string() }, async ({ url }) => ({
  content: [{ type: 'text', text: `fixture transcript for ${url}: 一段关于摄影的视频。` }],
}));
server.tool('synthesize', 'Generate a short test waveform.', { text: z.string() }, async () => {
  const bytes = Buffer.alloc(44 + 1600);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
  return { content: [{ type: 'audio', mimeType: 'audio/wav', data: bytes.toString('base64') }] };
});
await server.connect(new StdioServerTransport());
