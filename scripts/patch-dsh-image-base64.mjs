// Narrow, reversible compatibility fix for known DSH MCP image projection code.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const OLD_REGEX = 'const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;';
const NEW_REGEX = 'const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;';
const OLD_GUARD = 'if (!CANONICAL_BASE64.test(block.data))';
const NEW_GUARD = 'if (typeof block.data !== "string" || block.data.length % 4 !== 0 || !CANONICAL_BASE64.test(block.data))';
export function patchedSource(source) {
  if (source.includes(NEW_REGEX) && source.includes(NEW_GUARD)) return source;
  if (source.split(OLD_REGEX).length !== 2 || source.split(OLD_GUARD).length !== 2
    || !source.includes('if (data.toString("base64") !== block.data)')) throw Error('DSH实现与已验证版本不一致，拒绝修改；请先检查上游是否已修复');
  return source.replace(OLD_REGEX, NEW_REGEX).replace(OLD_GUARD, NEW_GUARD);
}
export function patchFile(file) {
  file = fs.realpathSync(file);
  if (path.basename(file) !== 'index.js' || path.basename(path.dirname(file)) !== 'lib'
    || path.basename(path.dirname(path.dirname(file))) !== 'dsh-mcp-client') throw Error('目标必须是 dsh-mcp-client/lib/index.js');
  const source = fs.readFileSync(file, 'utf8'), result = patchedSource(source);
  if (result === source) return { changed: false, file };
  const backup = file + '.qq-bridge-base64-' + Date.now() + '.bak';
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  const temp = file + '.qq-bridge-base64.tmp';
  try { fs.writeFileSync(temp, result, { flag: 'wx', mode: fs.statSync(file).mode }); fs.renameSync(temp, file); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  return { changed: true, file, backup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--file')) throw Error('用法：node scripts/patch-dsh-image-base64.mjs [--file /path/to/dsh-mcp-client/lib/index.js]');
  const file = args[1] || path.join(dshModulesDir(), '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js');
  console.log(JSON.stringify(patchFile(file)));
}
