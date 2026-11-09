import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { startMemoryProvider } from '../examples/memory-provider.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(file => fs.existsSync(file));
const plugin = await startMemoryProvider();
const h = await bridgeHarness({ config: { dualMode: { enabled: true }, allow: { groups: ['456','789'] },
  socialV2: { workingMemory: { enabled: true }, proactive: { enabled: false } },
  memory: { provider: 'local', providers: [{ id: 'local', features: ['consolidation-v1'], approvalMode: 'automatic',
    operations: ['query','write','clear'], transport: { type: 'http', url: plugin.url } }] } },
  files: { 'public/console.html': fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8') } });
let server, browser;
try {
  for (let n = 0; n < 22; n++) {
    const text = n ? `候选偏好${n}` : '<img src=x onerror=alert(1)> 偏好';
    h.memoryConsolidation.stage('group:456', { text, subject: '234', category: 'preference', assertion: 'self_report', providerId: 'local',
      sources: [{ id: 'qq:' + (n + 1), quote: text }] }, [{ id: 'qq:' + (n + 1), text, userId: '234', receivedAt: Date.now() }]);
  }
  server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } }); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  await page.goto(baseUrl + '/?token=fixture-console-token'); await page.locator('[data-view="social-v2"]').first().click();
  const panel = page.locator('#memoryCandidatesPanel');
  for (const details of await panel.locator('xpath=ancestor-or-self::details').all()) if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  await page.locator('#memoryCandidatesKey').fill('456'); await page.locator('#memoryCandidatesLoad').click();
  await page.locator('#memoryCandidatesMsg').filter({ hasText: '共 22 项' }).waitFor();
  assert.equal(await page.locator('#memoryCandidatesList .memory-section').count(), 20);
  assert.equal(await page.locator('#memoryCandidatesList img').count(), 0);
  assert.match(await panel.textContent(), /<img src=x/);
  await panel.getByRole('button', { name: '提交写入', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('#memoryCandidatesList p')?.textContent.startsWith('结果待核验'));
  await panel.getByRole('button', { name: '核验存储', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('#memoryCandidatesList p')?.textContent.startsWith('已核验'));
  assert.equal(h.memoryConsolidation.list('group:456').items[0].status, 'applied');
  await panel.getByRole('button', { name: '拒绝候选', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('#memoryCandidatesList p')[1]?.textContent.startsWith('已拒绝'));
  await page.locator('#memoryCandidatesNext').click();
  await page.waitForFunction(() => document.querySelectorAll('#memoryCandidatesList .memory-section').length === 2);
  await page.locator('#memoryCandidatesPrevious').click();
  await page.waitForFunction(() => document.querySelectorAll('#memoryCandidatesList .memory-section').length === 20);
  await page.locator('#memoryCandidatesKey').fill('789');
  await panel.getByRole('button', { name: '清理本地记录', exact: true }).first().click();
  await page.locator('#memoryCandidatesMsg').filter({ hasText: '已变化' }).waitFor();
  assert.equal(h.memoryConsolidation.list('group:456').total, 22); assert.equal(h.memoryConsolidation.list('group:789').total, 0);
  await page.locator('#memoryCandidatesLoad').click(); await page.locator('#memoryCandidatesMsg').filter({ hasText: '共 0 项' }).waitFor();
  await page.locator('#memoryCandidatesKey').fill('456'); await page.locator('#memoryCandidatesFilter').selectOption('rejected');
  await page.locator('#memoryCandidatesMsg').filter({ hasText: '共 1 项' }).waitFor();
  await panel.getByRole('button', { name: '清理本地记录', exact: true }).click();
  await page.locator('#memoryCandidatesMsg').filter({ hasText: '共 0 项' }).waitFor();
  const screenshot = process.argv.find(value => value.startsWith('--screenshot='))?.slice(13);
  if (screenshot) { await page.locator('#memoryCandidatesFilter').selectOption(''); await page.locator('#memoryCandidatesMsg').filter({ hasText: '共 21 项' }).waitFor(); await panel.screenshot({ path: screenshot }); }
  assert.deepEqual(errors, []); assert.equal(h.workingMemory.receipts.size, 0); assert.equal(h.calls.sent.length, 0);
  console.log('PASS memory candidates UI: local evidence, commit, verify, reject, cleanup, pagination, scope changes, escaped text, no read receipts or QQ sends');
} finally {
  await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await h.close(); await plugin.close();
}
