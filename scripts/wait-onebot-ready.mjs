// A systemd preflight. Read-only probes, no QQ messages or configuration writes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function probeOneBotReady(cfg, { discover, timeoutMs = 4000, signal, WebSocketCtor = globalThis.WebSocket } = {}) {
  const connection = await discover({ cfg, timeoutMs });
  if (!connection.ok || signal?.aborted) return false;
  const endpoint = new URL(cfg.snowluma?.followDiscoveredEndpoint === false ? cfg.snowluma.wsUrl : connection.wsUrl || cfg.snowluma.wsUrl);
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('Invalid OneBot WebSocket endpoint');
  const token = connection.wsToken || connection.token;
  if (token) endpoint.searchParams.set('access_token', token);
  return new Promise(resolve => {
    let socket, settled = false;
    const echo = 'qq-bridge-startup-readiness';
    const finish = ready => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (socket) {
        socket.removeEventListener('open', opened); socket.removeEventListener('message', message);
        socket.removeEventListener('error', failed); socket.removeEventListener('close', failed);
        try { socket.close(); } catch {}
      }
      resolve(ready);
    };
    const failed = () => finish(false), aborted = () => finish(false);
    const opened = () => {
      try { socket.send(JSON.stringify({ action: 'get_status', params: {}, echo })); } catch { finish(false); }
    };
    const message = event => {
      let body;
      try { body = JSON.parse(String(event.data)); } catch { return; }
      if (body.echo === echo) finish(body.status === 'ok' && body.retcode === 0 && body.data?.online === true && body.data?.good === true);
    };
    const timer = setTimeout(failed, timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { finish(false); return; }
    try {
      socket = new WebSocketCtor(endpoint.href);
      socket.addEventListener('open', opened); socket.addEventListener('message', message);
      socket.addEventListener('error', failed); socket.addEventListener('close', failed);
    } catch { finish(false); }
  });
}

export async function waitForOneBot({ root, configPath = path.join(root, 'config.json'), waitMs = 120000, retryMs = 2000, discover } = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || !Number.isSafeInteger(retryMs) || retryMs < 1) throw new Error('Invalid wait duration');
  discover ??= (await import(pathToFileURL(path.join(root, 'src/snowluma-conn.js')).href)).discoverSnowLumaConnection;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), waitMs);
  const expired = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(false), { once: true }));
  try {
    while (!controller.signal.aborted) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const ready = await Promise.race([probeOneBotReady(cfg, { discover, signal: controller.signal }), expired]);
      if (ready) return true;
      if (!controller.signal.aborted) await Promise.race([new Promise(resolve => setTimeout(resolve, retryMs)), expired]);
    }
    return false;
  } finally { clearTimeout(timeout); controller.abort(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(process.argv.find(arg => arg.startsWith('--root='))?.slice(7) || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  try {
    const ready = await waitForOneBot({ root });
    console.log(ready ? '[qq-bridge] Authenticated OneBot WebSocket and QQ receive status are ready.'
      : '[qq-bridge] OneBot did not become ready within 120 seconds.');
    process.exit(ready ? 0 : 1);
  } catch {
    console.error('[qq-bridge] OneBot readiness check failed. Check the configuration and runtime.'); process.exit(1);
  }
}
