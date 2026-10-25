// Usage: node examples/debate-worker.mjs <local-task-credential.json>
// The file is the admin task-creation response. Never pass a console token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DebateClient } from '../src/debate-client.mjs';
import { DshDebateAnalyzer } from '../src/framework/debate-analyzer.mjs';

async function main() {
  if (!process.argv[2]) throw new Error('需要本机任务凭据 JSON 文件路径');
  const credential = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const client = new DebateClient({ baseUrl: credential.baseUrl, taskId: credential.task.id, token: credential.token });
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-debate-'));
  const analyzer = new DshDebateAnalyzer({ dsh: config.dsh, cwd });
  let after = 0;
  let requestSeq = (await client.task()).task.lastRequestSeq;
  let window = [];
  const previousResponses = [];
  const stop = new AbortController();
  const quit = () => stop.abort();
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  try {
    const first = (await client.task()).task;
    after = Math.max(first.processedThrough, (first.oldestEventId ?? 1) - 1);
    window = (await client.events((first.oldestEventId ?? 1) - 1)).events;
    console.log('争论分析插件已连接；发送方式由管理员任务授权决定。');
    while (!stop.signal.aborted) {
      const { events, task } = await client.events(after);
      if (!events.length) { await delay(1000, undefined, { signal: stop.signal }); continue; }
      window = [...new Map([...window, ...events].map(event => [event.id, event])).values()].slice(-200);
      const latest = events.at(-1).id;
      const operation = new AbortController();
      const abort = () => operation.abort();
      stop.signal.addEventListener('abort', abort, { once: true });
      // Revocation also cancels an in-flight model turn, not just final delivery.
      let checking = false;
      const health = setInterval(async () => {
        if (checking) return; checking = true;
        try { if ((await client.task()).task.revision !== task.revision) operation.abort(); } catch { operation.abort(); } finally { checking = false; }
      }, 1000);
      try {
        const draft = await analyzer.analyze(task, window, { signal: operation.signal, previousResponses });
        operation.signal.throwIfAborted();
        await client.task();
        const payload = { ...draft, taskRevision: task.revision, throughEventId: latest, requestId: randomUUID(), requestSeq: ++requestSeq };
        const result = await client.submit(payload);
        previousResponses.push({ ...draft, status: result.draft.status });
        if (previousResponses.length > 5) previousResponses.shift();
        console.log(`分析完成：${result.draft.status}`);
        after = latest;
      } finally {
        clearInterval(health); stop.signal.removeEventListener('abort', abort);
      }
    }
  } finally {
    process.off('SIGINT', quit); process.off('SIGTERM', quit);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(`争论插件已停止：${error.message}`); process.exitCode = 1; });
