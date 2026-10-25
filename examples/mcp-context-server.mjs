// Example external MCP: no console token, production config reads, or plugin loader.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { QQBridgeClient } from '../src/bridge-client.mjs';

const server = new McpServer({ name: 'qq-context-example', version: '1.0.0' });
server.tool('qq_extension_context', '按需查询当前 QQ 会话的相关上下文，不获取其他会话或控制台权限。', {
  key: z.string(), token: z.string().min(1),
  kind: z.enum(['memory', 'slang', 'history', 'role']),
  query: z.string().max(256).optional(), member: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}, async ({ key, token, ...query }) => {
  try {
    const client = new QQBridgeClient({ baseUrl: process.env.QQ_BRIDGE_URL, key, token });
    const result = await client.queryContext(query);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
