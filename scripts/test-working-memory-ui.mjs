import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(file => fs.existsSync(file));
const h = await bridgeHarness({ config: { dualMode: { enabled: true, ownerPreset: 'standard' },
  socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false } } },
  files: { 'public/console.html': fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8') } });
h.workingMemory.record('group:456', { id: 'm1', sender: '<img src=x onerror=alert(1)>', plain: '群友先发了视频，正在讨论剧情。' });
const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await page.route('**/*', route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  await page.goto(baseUrl + '/?token=fixture-console-token');
  await page.locator('[data-view="social-v2"]').first().click();
  const panel = page.locator('#workingMemoryPanel');
  for (const d of await panel.locator('xpath=ancestor-or-self::details').all()) if (await d.getAttribute('open') === null) await d.locator(':scope > summary').click();
  await page.locator('#workingMemoryKey').fill('group:456');
  await page.locator('#workingMemoryLoad').click();
  await page.waitForFunction(() => document.querySelector('#workingMemoryOutput').textContent.includes('讨论剧情'));
  assert.equal(await page.locator('#workingMemoryOutput img').count(), 0);
  assert.ok((await page.locator('#workingMemoryOutput').textContent()).includes('<img src=x'));
  assert.equal(h.workingMemory.receipts.size, 0, 'admin preview is not a model visibility receipt');
  for (const enabled of [false, true]) {
    await page.locator('#workingMemoryEnabled').setChecked(enabled);
    const saved = page.waitForResponse(r => r.url().endsWith('/api/socialV2/config') && r.request().method() === 'POST');
    await page.locator('#workingMemorySave').click(); assert.equal((await saved).status(), 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))).socialV2.workingMemory.enabled, enabled);
  }
  const screenshot = process.argv.find(v => v.startsWith('--screenshot='))?.split('=', 2)[1];
  if (screenshot) await panel.screenshot({ path: screenshot });
  assert.deepEqual(errors, []); assert.equal(h.calls.sent.length, 0);
  console.log('PASS real working-memory console: scoped view, escaped content, live switch, durable save, no QQ sends');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close(); }
