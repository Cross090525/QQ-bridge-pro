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
  // Manage bundled references through the actual console and HTTP handlers.
  const search = async text => {
    await page.locator('#memeSearch').fill(text);
    const response = page.waitForResponse(r => r.url().includes('/api/slang/reference?') && r.request().method() === 'GET');
    await page.locator('#memeRefresh').click();
    assert.equal((await response).status(), 200);
  };
  const save = async action => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/slang/reference/' + action) && r.request().method() === 'POST');
    await page.locator(action === 'save' ? '#memeSave' : action === 'reset' ? '#memeReset' : '#memeDelete').click();
    const saved = await response; assert.equal(saved.status(), 200);
    await page.locator('#memeEditor').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#memeMessage').textContent.includes('已'));
  };
  await page.locator('#memeList [data-meme-edit]').first().waitFor();
  await search('233');
  await page.locator('[data-meme-edit="word:m0001"]').click();
  await page.locator('#memeMeaning').fill('界面修改的释义');
  await page.locator('#memeAliases').fill('界面别名XYZ');
  await page.locator('#memeKnown').check();
  await save('save');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/slang-reference.json'))).entries[0].meaning, '界面修改的释义');
  await page.goto(baseUrl + '/?token=fixture-console-token');
  await page.locator('[data-view="slang"]').first().click();
  await search('界面别名XYZ');
  await page.locator('#memeList').getByText('界面修改的释义', { exact: true }).waitFor();
  await page.locator('[data-meme-edit="word:m0001"]').click();
  const current = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/slang-reference.json')));
  const { id, ...stored } = current.entries[0];
  const other = await fetch(baseUrl + '/api/slang/reference/save', { method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' },
    body: JSON.stringify({ id, revision: current.revision, entry: { ...stored, usage: '另一窗口更新' } }) });
  assert.equal(other.status, 200);
  await page.locator('#memeUsage').fill('过期页面改动');
  const conflict = page.waitForResponse(r => r.url().endsWith('/api/slang/reference/save') && r.request().method() === 'POST');
  await page.locator('#memeSave').click(); assert.equal((await conflict).status(), 409);
  await page.locator('#memeEditorMessage').getByText('梗库已被修改，请刷新列表后重新编辑', { exact: true }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/slang-reference.json'))).entries[0].usage, '另一窗口更新');
  await page.locator('#memeCancel').click(); await search('界面别名XYZ');
  await page.locator('[data-meme-edit="word:m0001"]').click();
  await page.locator('#memeEnabled').uncheck();
  await save('save');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/slang-reference.json'))).entries[0].enabled, false);
  await page.locator('[data-meme-edit="word:m0001"]').click();
  await save('reset');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/slang-reference.json'))).entries.length, 0);
  await page.locator('#memeNew').click();
  await page.locator('#memeTerm').fill('<img src=x onerror="window.__memeXss=true">');
  await page.locator('#memeMeaning').fill('界面新增词条');
  await page.locator('#memeAliases').fill('界面新词XYZ');
  await save('save');
  await search('界面新词XYZ');
  await page.locator('#memeList').getByText('界面新增词条', { exact: true }).waitFor();
  assert.equal(await page.locator('#memeList img').count(), 0);
  assert.notEqual(await page.evaluate(() => window.__memeXss), true);
  await page.locator('#memeList [data-meme-edit]').click();
  await save('delete');
  await page.locator('#memeList').getByText('没有符合条件的词条。', { exact: true }).waitFor();
  await search('');
  await page.locator('#memeNext').click();
  await page.waitForFunction(() => document.querySelector('#memePage').textContent.includes('第 2 /'));
  await page.locator('#memePrev').click();
  await page.waitForFunction(() => document.querySelector('#memePage').textContent.includes('第 1 /'));
  await page.locator('#memeKind').selectOption('construction');
  await page.waitForFunction(() => [...document.querySelectorAll('#memeList tbody tr')].every(tr => tr.cells[1].textContent.includes('句式')));
  await page.locator('#memeKind').selectOption('');
  await search('233');
  const screenshot = process.argv.find(v => v.startsWith('--screenshot='))?.slice('--screenshot='.length);
  if (screenshot) {
    await page.locator('#section-meme-library').scrollIntoViewIfNeeded(); await page.screenshot({ path: screenshot });
    await page.locator('[data-meme-edit="word:m0001"]').click();
    await page.locator('#memeEditor').scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-editor.png') });
  }
  assert.deepEqual(errors, []); assert.equal(h.calls.sent.length, 0);
  console.log('PASS slang console: reference search/paging, edit/reload, disable/reset, add/delete, HTML escaping, fallback save/reload; no QQ sends');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await h.close();
}
