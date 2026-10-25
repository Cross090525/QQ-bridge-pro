// Real DSH boot/preset/session probe in a fresh home. No model prompt or QQ.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';
import { dshModulesDir } from './dsh-modules.mjs';

const modules = dshModulesDir();
const repo = fileURLToPath(new URL('..', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-debate-dsh-probe-'));
const profile = path.join(home, 'profiles/web');
fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
fs.symlinkSync(path.join(repo, 'plugins/qq-agent-presets'), path.join(profile, 'node_modules/qq-agent-presets'), process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ private: true,
  dependencies: { 'qq-agent-presets': 'link:' + path.join(repo, 'plugins/qq-agent-presets').replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'qq-agent-presets'] } } }));
fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
const child = spawn(process.execPath, [path.join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: home, env: { ...process.env, DSH_HOME: home, DSH_INSTALL_MODULES: modules }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const originalHome = process.env.DSH_HOME;
let api, sessionId;
let timer;
try {
  const baseUrl = await new Promise((resolve, reject) => {
    let output = '';
    timer = setTimeout(() => reject(Error('隔离 DSH 启动超时')), 45000);
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-12000);
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) resolve(match[0]);
    });
    child.stderr.on('data', () => {}); // Never echo launch credentials.
    child.once('error', reject);
    child.once('exit', code => reject(Error(`隔离 DSH 退出：${code}`)));
  });
  clearTimeout(timer);
  process.env.DSH_HOME = home;
  api = new NodeApiClient(baseUrl, 15000);
  const presets = unwrap(await api.agentPresets.list({}), 'agentPresets/list').presets;
  assert.ok(presets.some(preset => preset.id === 'qq-debate'));
  const created = unwrap(await api.sessions.create({ cwd: home, agentPreset: 'qq-debate' }), 'session/create');
  sessionId = created.sessionId;
  assert.ok(sessionId);
  const projections = unwrap(await api.callUnary('session/projections', { sessionId }), 'session/projections');
  assert.ok(projections);
  console.log('PASS real isolated DSH 0.2.0 boot, qq-debate registration and session creation; no model/QQ calls');
} finally {
  clearTimeout(timer);
  if (sessionId) {
    try { await api.stopSessionWork(sessionId); await api.workspace.archiveSession({ sessionId }); } catch {}
  }
  const exited = new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  child.kill(); await exited;
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
  // Only remove this newly created test directory; junction targets are retained.
  if (path.dirname(home) === path.resolve(os.tmpdir()) && path.basename(home).startsWith('qq-debate-dsh-probe-')) fs.rmSync(home, { recursive: true, force: true });
}
