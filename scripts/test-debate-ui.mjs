// Real browser against the actual isolated bridge HTTP handler. No QQ/model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { DebateClient } from '../src/debate-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const h = await bridgeHarness({ config: { ownerQQ: 123, dualMode: { enabled: true, ownerPreset: 'standard' },
  socialV2: { proactive: { enabled: false }, sticker: { enabled: false } } } });
fs.mkdirSync(path.join(h.temp, 'public'));
fs.copyFileSync(new URL('../public/debate.html', import.meta.url), path.join(h.temp, 'public/debate.html'));
await h.ensureSession('group:456');
const server = h.startConsoleServer();
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  await page.goto(baseUrl + '/debate?token=fixture-console-token');
  await page.locator('[name=group]').fill('456');
  await page.locator('[name=target]').fill('234');
  await page.locator('[name=topic]').fill('电池 <img src=x onerror=window.injected=1>');
  await page.locator('[name=keywords]').fill('电池,事故');
  assert.equal(await page.locator('[name=sendMode]').inputValue(), 'auto');
  await page.getByRole('button', { name: '授权并创建任务', exact: true }).click();
  await page.locator('#credential').filter({ hasText: '任务已创建' }).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载本机插件任务凭据' }).click()]);
  const saved = path.join(h.temp, 'task-credential.json');
  await download.saveAs(saved);
  const downloaded = JSON.parse(fs.readFileSync(saved, 'utf8'));
  const credential = downloaded;
  assert.equal(downloaded.baseUrl, baseUrl);
  assert.ok(!JSON.stringify(downloaded).includes('fixture-console-token'));
  const client = new DebateClient({ baseUrl, taskId: credential.task.id, token: credential.token });
  h.appendSocialV2Message('group:456', '成员', '电池需要数据', '电池需要数据', false, false, 'm1', [], '234');
  const payload = { requestId: 'ui-1', requestSeq: 1, taskRevision: 0, text: '请说明数据来源。', analysis: '<img src=x onerror=window.injected=1>', verdict: 'uncertain', evidenceIds: [1] };
  assert.equal((await client.submit(payload)).draft.status, 'sent');
  await page.getByRole('button', { name: '刷新任务与分析', exact: true }).click();
  await page.getByRole('heading', { name: /分析 · 已发送/ }).waitFor();
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(h.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('#tasks').filter({ hasText: '已暂停' }).waitFor();
  await assert.rejects(client.events(), /暂停/);
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.locator('#tasks').filter({ hasText: '进行中' }).waitFor();
  await assert.rejects(client.submit({ ...payload, requestId: 'ui-2', requestSeq: 2 }), /版本/);
  await page.getByRole('button', { name: '结束并撤销令牌', exact: true }).click();
  await page.locator('#tasks').filter({ hasText: '已结束' }).waitFor();
  await assert.rejects(client.task(), /令牌/);
  assert.deepEqual(errors, []);
  const screenshot = process.argv.find(arg => arg.startsWith('--screenshot='))?.slice(13);
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
  console.log('PASS real debate console: automatic-send grant, scoped credential, XSS-safe rendering, pause/resume revision and stop revocation');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await h.close();
}
