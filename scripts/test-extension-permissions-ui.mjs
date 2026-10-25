// Real browser, isolated synthetic console; never launches a provider or QQ/DSH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(file => fs.existsSync(file));
const fixture = await startConsoleFixture();
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(fixture.url).origin ? route.continue() : route.abort());
  await page.goto(fixture.url);
  await page.locator('[data-view="social-v2"]').first().click();
  const panel = page.locator('#extensionPermissionPanel');
  for (const ancestor of await panel.locator('xpath=ancestor::details').all()) if (await ancestor.getAttribute('open') === null) await ancestor.locator(':scope > summary').click();
  await panel.locator(':scope > summary').click();
  await page.locator('#extensionPermissionsLoad').click();
  await page.locator('#extensionApprovals summary').filter({ hasText: 'pending' }).waitFor();
  await page.locator('#extensionApprovals details').first().locator('summary').click();
  assert.match(await page.locator('#extensionApprovals pre').textContent(), /<img src=x/);
  assert.equal(await page.locator('#extensionApprovals img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  const screenshot = process.argv.find(value => value.startsWith('--screenshot='))?.slice('--screenshot='.length);
  if (screenshot) { await panel.scrollIntoViewIfNeeded(); await panel.screenshot({ path: screenshot }); }
  await page.getByRole('button', { name: '批准这一次', exact: true }).click();
  await page.locator('#extensionPermissionsMsg').filter({ hasText: '已批准一次' }).waitFor();
  assert.equal(fixture.state.extensionApprovals[0].status, 'approved');
  await page.locator('#extensionApprovals details').first().locator('summary').click();
  await page.getByRole('button', { name: '拒绝 / 撤销', exact: true }).click();
  await page.locator('#extensionPermissionsMsg').filter({ hasText: '已拒绝' }).waitFor();
  assert.equal(fixture.state.extensionApprovals[0].status, 'denied');
  await page.locator('#extensionPermissionsJson').fill(JSON.stringify({ rules: [{ key: 'group:123456789', capability: 'video.inspect', decision: 'ask', dataScopes: ['source-reference'] }] }));
  await page.locator('#extensionPermissionsSave').click();
  await page.locator('#extensionPermissionsMsg').filter({ hasText: '策略已生效' }).waitFor();
  assert.equal(fixture.state.extensionPolicy.rules[0].decision, 'ask');
  await page.locator('#extensionAuditLoad').click();
  await page.locator('#extensionAudit').filter({ hasText: 'requested' }).waitFor();
  const memoryKey = page.locator('#v2MemoryKey');
  for (const ancestor of await memoryKey.locator('xpath=ancestor::details').all()) if (await ancestor.getAttribute('open') === null) await ancestor.locator(':scope > summary').click();
  await memoryKey.fill('group:123456789');
  await page.locator('#v2MemoryLoad').click();
  await page.locator('#v2MemoryOutput').filter({ hasText: '周末的阅读计划' }).waitFor();
  await page.locator('#v2MemoryClearAll').click();
  await page.locator('#v2MemoryMsg').filter({ hasText: '尚未执行' }).waitFor();
  assert.equal(fixture.state.memoryRecords.length, 1);
  await page.locator('#extensionPermissionsLoad').click();
  const memoryApproval = page.locator('#extensionApprovals details').filter({ hasText: 'memory.example.clear' });
  await memoryApproval.locator('summary').click();
  await memoryApproval.getByRole('button', { name: '批准这一次', exact: true }).click();
  await page.locator('#extensionPermissionsMsg').filter({ hasText: '已批准一次' }).waitFor();
  await page.locator('#v2MemoryClearAll').click();
  await page.locator('#v2MemoryOutput').filter({ hasText: '暂无匹配记忆' }).waitFor();
  assert.equal(fixture.state.memoryRecords.length, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(fixture.unknownRequests, []);
  console.log('PASS permission and open-memory panels: approve once, revoke, save policy, audit, provider query and clear only after approved retry');
} finally { await browser?.close(); await fixture.close(); }
