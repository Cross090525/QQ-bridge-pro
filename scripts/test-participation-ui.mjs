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
const h = await bridgeHarness({ config: { dualMode: { enabled: true }, socialV2: { proactive: { enabled: false } } },
  files: { 'public/console.html': fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8') } });
h.getSocialV2State('group:456').participation = { turns: [], history: [{ at: Date.now(), action: 'observe', reason: 'other', sources: ['<img src=x onerror=alert(1)>'] }] };
let server, browser;
try {
  server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  await page.goto(baseUrl + '/?token=fixture-console-token');
  await page.locator('[data-view="social-v2"]').first().click();
  const panel = page.locator('#participationPanel');
  for (const d of await panel.locator('xpath=ancestor-or-self::details').all()) if (await d.getAttribute('open') === null) await d.locator(':scope > summary').click();
  await page.locator('#participationMsg').filter({ hasText: '全局默认' }).waitFor();
  assert.equal(await page.locator('#participationStyle').inputValue(), 'natural');
  const key = page.locator('#participationKey');
  const waitMessage = text => page.locator('#participationMsg').filter({ hasText: text }).waitFor();
  const load = async value => { await key.fill(value); await page.locator('#participationLoad').click(); await waitMessage('已加载'); };
  const save = async () => { const response = page.waitForResponse(r => r.url().endsWith('/api/socialV2/participation') && r.request().method() === 'POST'); await page.locator('#participationSave').click(); assert.equal((await response).status(), 200); await waitMessage('已保存'); };
  await load('456');
  assert.equal(await key.inputValue(), 'group:456');
  assert.ok((await page.locator('#participationStatus').textContent()).includes('<img src=x'));
  assert.equal(await panel.locator('img').count(), 0, 'source handles must render as text');
  await page.locator('#participationStyle').selectOption('active');
  await page.locator('#participationHumor').setChecked(false); await save();
  const config = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))).socialV2.participation;
  assert.equal(config().groups['group:456'].style, 'active');
  assert.equal(config().groups['group:456'].allowHumor, false);
  await key.fill('789'); await page.locator('#participationSave').click(); await waitMessage('请先加载');
  assert.equal(config().groups['group:789'], undefined, 'scope changes cannot accidentally save another group policy');
  await load(''); await page.locator('#participationStyle').selectOption('cautious'); await save();
  await load('456'); assert.equal(await page.locator('#participationStyle').inputValue(), 'active');
  await page.locator('#participationInherit').click(); await waitMessage('继承全局');
  assert.equal(await page.locator('#participationStyle').inputValue(), 'cautious');
  assert.equal(config().groups['group:456'], undefined);
  await key.fill('private:123'); await page.locator('#participationLoad').click(); await waitMessage('私聊按当前来信自然回应');
  await load('456');
  const screenshot = process.argv.find(v => v.startsWith('--screenshot='))?.slice('--screenshot='.length);
  if (screenshot) await panel.screenshot({ path: screenshot });
  assert.deepEqual(errors, []); assert.equal(h.calls.sent.length, 0);
  console.log('PASS participation console: global/group policy, inheritance, scope changes, escaped records, durable save; no QQ sends');
} finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } await h.close(); }
