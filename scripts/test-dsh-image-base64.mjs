import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { patchedSource, patchFile } from './patch-dsh-image-base64.mjs';
const fixture = 'const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;\n'
  + 'function decodeImage(block) { if (!CANONICAL_BASE64.test(block.data)) throw Error("invalid"); const data = Buffer.from(block.data, "base64"); if (data.toString("base64") !== block.data) throw Error("invalid"); return data; }';
const patched = patchedSource(fixture), ctx = { Buffer }; vm.createContext(ctx); vm.runInContext(patched + '\nglobalThis.decode = decodeImage;', ctx);
test('large valid base64 is accepted without stack overflow and round-trips exactly', () => {
  for (const size of [0, 1, 2, 3, 1024, 2 ** 22, 2 ** 23]) {
    const original = Buffer.alloc(size, 97); assert.deepEqual(ctx.decode({ data: original.toString('base64') }), original);
  }
});
test('malformed, aliased and non-canonical encodings remain rejected', () => {
  for (const data of [null, undefined, 123, {}, 'a', 'aaa', '====', 'a===', 'Zg=', 'Zg===', 'Zg==\n', 'Zm 8=', 'Zm-8', 'Zm_8', 'Zh==', 'Zm9=', 'éééé', 'Zm=8']) assert.throws(() => ctx.decode({ data }));
  for (const data of ['Zg==', 'Zm8=', 'Zm9v']) assert.equal(ctx.decode({ data }).toString('base64'), data);
  const large = Buffer.alloc(2 ** 23, 97).toString('base64');
  assert.throws(() => ctx.decode({ data: large.slice(0, -4) + '!!!!' }), /invalid/);
});
test('patch backs up original bytes, is idempotent, and refuses unfamiliar layouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-base64-test-')), dir = path.join(root, 'dsh-mcp-client', 'lib'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.js'); fs.writeFileSync(file, fixture);
  let backup;
  try {
    const result = patchFile(file); backup = result.backup; assert.equal(fs.readFileSync(backup, 'utf8'), fixture);
    assert.equal(patchFile(file).changed, false); assert.equal(fs.readFileSync(file, 'utf8'), patched);
    assert.throws(() => patchedSource('unfamiliar code'), /拒绝修改/);
    assert.throws(() => patchFile(backup), /目标必须/);
  } finally { fs.unlinkSync(file); if (backup) fs.unlinkSync(backup); fs.rmdirSync(dir); fs.rmdirSync(path.dirname(dir)); fs.rmdirSync(root); }
});
