// Usage: node examples/debate-worker.mjs <local-task-credential.json>
// The file is the admin task-creation response. Never pass a console token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDebateWorker } from '../src/framework/debate-runner.mjs';
import { DebateClient } from '../src/debate-client.mjs';
import { DshDebateAnalyzer } from '../src/framework/debate-analyzer.mjs';

async function main() {
  if (!process.argv[2]) throw new Error('需要本机任务凭据 JSON 文件路径');
  const credential = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const client = new DebateClient({ baseUrl: credential.baseUrl, taskId: credential.task.id, token: credential.token });
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-debate-'));
  const analyzer = new DshDebateAnalyzer({ dsh: config.dsh, cwd });
  const stop = new AbortController();
  const quit = () => stop.abort();
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  try {
    console.log('争论worker已启动，普通观察仍继续；发送方式由管理员任务授权决定。');
    await runDebateWorker({ client, analyzer, signal: stop.signal, onResult: result => {
      if (result.draft) console.log(`分析完成：${result.draft.status}`);
    } });
  } finally {
    process.off('SIGINT', quit); process.off('SIGTERM', quit);
    const resolved = path.resolve(cwd);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('qq-debate-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(`争论插件已停止：${error.message}`); process.exitCode = 1; });
