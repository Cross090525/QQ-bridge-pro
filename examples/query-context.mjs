// For an external skill runner. The runner supplies the CURRENT session binding.
// Usage: node examples/query-context.mjs memory 摄影
import { QQBridgeClient } from '../src/bridge-client.mjs';

try {
  const client = new QQBridgeClient({
    baseUrl: process.env.QQ_BRIDGE_URL,
    key: process.env.QQ_BRIDGE_CONVERSATION,
    token: process.env.QQ_BRIDGE_SESSION_TOKEN,
  });
  const [kind = 'memory', query = ''] = process.argv.slice(2);
  const result = await client.queryContext({ kind, query, limit: 5, maxChars: 3000 });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(`上下文查询失败：${error.message}\n`);
  process.exitCode = 1;
}
