// Isolated actual bridge + browser, with fake image download and QQ transport.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const h = await bridgeHarness({ config: { dualMode: { enabled: true }, sendDelayMs: 0,
  socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false }, sticker: { enabled: false } } } });
fs.mkdirSync(path.join(h.temp, 'public'));
fs.copyFileSync(new URL('../public/quotas.html', import.meta.url), path.join(h.temp, 'public/quotas.html'));
const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  await page.goto(baseUrl + '/quotas?token=fixture-console-token');
  await page.getByText('尚无计数。', { exact: true }).waitFor();
  await page.locator('#enabled').check(); await page.locator('#inherit').uncheck();
  await page.getByRole('button', { name: '添加额度', exact: true }).click();
  const row = page.locator('#rules tr').first();
  await row.getByLabel('资源', { exact: true }).fill('media.image'); await row.getByLabel('次数', { exact: true }).fill('2'); await row.getByLabel('窗口分钟', { exact: true }).fill('60');
  await page.getByRole('button', { name: '添加额度', exact: true }).click();
  const video = page.locator('#rules tr').last(); await video.getByLabel('资源', { exact: true }).fill('media.video'); await video.getByLabel('次数', { exact: true }).fill('1'); await video.getByLabel('窗口分钟', { exact: true }).fill('30');
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/quotas/config') && r.request().method() === 'POST'), page.getByRole('button', { name: '保存额度配置', exact: true }).click()]);
  assert.equal(h.cfg.quotas.rules.length, 2); assert.equal(h.cfg.quotas.enabled, true);
  h.usageQuotas.consume('group:456', 'media.image'); h.usageQuotas.consume('group:456', 'media.image');
  await page.getByRole('button', { name: '刷新用量', exact: true }).click();
  await page.locator('#usage').filter({ hasText: '额度暂满' }).waitFor();
  assert.match(await page.locator('#usage').innerText(), /恢复时间.*剩余/);
  await page.getByRole('button', { name: '批准一次提前重置', exact: true }).click();
  await page.locator('#usage').filter({ hasText: '0/2' }).waitFor();
  h.usageQuotas.consume('group:456', 'media.video');
  await page.getByRole('button', { name: '刷新用量', exact: true }).click();
  await page.getByRole('button', { name: '拒绝提前重置', exact: true }).click();
  await page.locator('#usage').filter({ hasText: '已拒绝提前重置' }).waitFor();
  h.usageQuotas.now = () => Date.now() + 3600001;
  await page.getByRole('button', { name: '刷新用量', exact: true }).click();
  await page.locator('#usage').filter({ hasText: '0/1' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '批准一次提前重置', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  const screenshot = process.argv.find(a => a.startsWith('--screenshot='))?.slice(13); if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
  console.log('PASS real quota console: configurable limits, remaining time, early approval/denial and automatic window renewal');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
