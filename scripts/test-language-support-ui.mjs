// Real bridge HTTP routes and a real browser; isolated files and fake QQ/DSH peers.
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
const h = await bridgeHarness({ config: { slang: { enabled: true, referenceFallback: true, autoResearch: false } },
  files: { 'public/console.html': fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8') } });
const server = h.startConsoleServer();
if (!server.listening) await new Promise(r => server.once('listening', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  await page.goto(baseUrl + '/?token=fixture-console-token');
  await page.locator('[data-view="slang"]').first().click();
  const checkbox = page.locator('#slangReferenceFallback');
  for (const ancestor of await checkbox.locator('xpath=ancestor::details').all()) {
    if (await ancestor.getAttribute('open') === null) await ancestor.locator(':scope > summary').click();
  }
  await checkbox.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#slangReferenceFallback').checked === true);
  assert.equal(await page.locator('#fishTonePanel').count(), 0);
  for (const value of [false, true]) {
    await checkbox.setChecked(value);
    const saved = page.waitForResponse(r => r.url().endsWith('/api/slang/config') && r.request().method() === 'POST');
    await page.locator('#slangConfigSave').click();
    assert.equal((await saved).status(), 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))).slang.referenceFallback, value);
  }
  // The console removes the URL token after storing it; a fresh HTML request
  // still needs the URL credential before browser JavaScript can run.
  await page.goto(baseUrl + '/?token=fixture-console-token');
  await page.locator('[data-view="slang"]').first().click();
  for (const ancestor of await checkbox.locator('xpath=ancestor::details').all()) {
    if (await ancestor.getAttribute('open') === null) await ancestor.locator(':scope > summary').click();
  }
  await page.waitForFunction(() => document.querySelector('#slangReferenceFallback').checked === true);
  const screenshot = process.argv.find(v => v.startsWith('--screenshot='))?.slice('--screenshot='.length);
  if (screenshot) { await checkbox.scrollIntoViewIfNeeded(); await page.screenshot({ path: screenshot }); }
  assert.deepEqual(errors, []); assert.equal(h.calls.sent.length, 0);
  console.log('PASS existing slang console: fallback save/reload, no duplicate style panel, no QQ sends');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close();
}
