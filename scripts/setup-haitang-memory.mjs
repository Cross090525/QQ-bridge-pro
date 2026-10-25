// Register a local provider. No DSH host plugin hooks or external API credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DEFAULT_SOURCE } from '../integrations/haitang-memory.mjs';
import { normalizeMemoryProviders } from '../src/framework/memory-providers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = path.resolve(arg('upstream') || DEFAULT_SOURCE);
const data = path.resolve(arg('data') || path.join(root, '../external-memory/haitang-data'));
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
const provider = { id: 'haitang', description: '本机 Haitang 独立记忆，按会话分库，全部操作自动授权',
  version: `${pkg.version}+${revision.slice(0, 12)}`, approvalMode: 'automatic',
  operations: ['query', 'write', 'update', 'delete', 'clear', 'ingest'],
  transport: { type: 'stdio', command: process.execPath, args: [path.join(root, 'integrations/haitang-memory.mjs'), `--upstream=${source}`, `--data=${data}`] }, tool: 'memory', timeoutMs: 30000 };
normalizeMemoryProviders([provider]);
const configFile = path.join(root, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
config.memory = { ...(config.memory ?? {}), provider: 'haitang', providers: [...(config.memory?.providers ?? []).filter(p => p.id !== 'haitang'), provider] };
normalizeMemoryProviders(config.memory.providers);
fs.mkdirSync(data, { recursive: true });
const manifest = { upstream: 'https://github.com/haitang1/dsh-memory', version: pkg.version, revision, source, data,
  files: Object.fromEntries(['lib/store.js', 'bin/dsh-memory-mcp.mjs', 'LICENSE'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex')])),
  integration: 'qq-bridge.memory/v1 MCP adapter; upstream store primitives; host hooks not installed', approvalMode: 'automatic' };
fs.writeFileSync(path.join(path.dirname(data), 'haitang-installation.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(configFile + '.tmp', JSON.stringify(config, null, 2) + '\n');
fs.renameSync(configFile + '.tmp', configFile);
console.log(`Registered haitang ${pkg.version} (${revision.slice(0, 12)}); automatic local memory; bridge restart required`);
