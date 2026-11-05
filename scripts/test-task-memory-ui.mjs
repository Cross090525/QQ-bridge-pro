import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(file=>fs.existsSync(file));
const h=await bridgeHarness({config:{dualMode:{enabled:true},allow:{groups:['456','789']},socialV2:{proactive:{enabled:false}}},
  files:{'public/console.html':fs.readFileSync(new URL('../public/console.html',import.meta.url),'utf8')}});
let browser,server;
try {
  server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath});
  const page=await browser.newPage({viewport:{width:1440,height:1200}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===baseUrl?route.continue():route.abort());
  await page.goto(baseUrl+'/?token=fixture-console-token');await page.locator('[data-view="social-v2"]').first().click();
  const panel=page.locator('#taskMemoryPanel');
  for(const d of await panel.locator('xpath=ancestor-or-self::details').all())if(await d.getAttribute('open')===null)await d.locator(':scope > summary').click();
  await page.locator('#taskMemoryKey').fill('456');await page.locator('#taskMemoryLoad').click();
  await page.locator('#taskMemoryMsg').filter({hasText:'共 0 项'}).waitFor();
  await page.locator('#taskMemoryNew').click();await page.locator('#taskMemoryOwner').fill('234');
  await page.locator('#taskMemoryText').fill('<img src=x onerror=alert(1)> 等测试结果');
  await page.locator('#taskMemoryWaiting').fill('运行隔离测试');await page.locator('#taskMemorySave').click();
  await page.locator('#taskMemoryMsg').filter({hasText:'已保存'}).waitFor();
  assert.equal(await page.locator('#taskMemoryList img').count(),0);assert.match(await page.locator('#taskMemoryList').textContent(),/<img src=x/);
  await page.locator('#taskMemoryList button').first().click();await page.locator('#taskMemoryWaiting').fill('补充日志');
  await page.locator('#taskMemorySave').click();await page.locator('#taskMemoryMsg').filter({hasText:'已保存'}).waitFor();
  assert.equal(h.taskMemory.list('group:456').items[0].waitingFor,'补充日志');
  await page.locator('#taskMemoryList button').first().click();await page.locator('#taskMemoryKey').fill('789');await page.locator('#taskMemorySave').click();
  await page.locator('#taskMemoryMsg').filter({hasText:'会话已变化'}).waitFor();assert.equal(h.taskMemory.list('group:789').total,0);
  await page.locator('#taskMemoryKey').fill('456');await page.locator('#taskMemoryLoad').click();await page.locator('#taskMemoryMsg').filter({hasText:'共 1 项'}).waitFor();
  await page.locator('#taskMemoryList button').first().click();await page.locator('#taskMemoryStatus').selectOption('completed');await page.locator('#taskMemorySave').click();
  await page.locator('#taskMemoryMsg').filter({hasText:'已保存'}).waitFor();assert.equal(h.taskMemory.list('group:456').items[0].completionEvidence,'admin-reported');
  await page.locator('#taskMemoryList button').first().click();assert.equal(await page.locator('#taskMemorySave').isDisabled(),true);
  await page.locator('#taskMemoryDelete').click();await page.locator('#taskMemoryMsg').filter({hasText:'事项已删除'}).waitFor();
  for(let n=0;n<21;n++)h.taskMemory.update('group:456',{revision:h.taskMemory.get('group:456').revision,text:'分页事项'+n,ownerId:'234',kind:'user_plan'},{admin:true});
  await page.locator('#taskMemoryLoad').click();await page.locator('#taskMemoryMsg').filter({hasText:'共 21 项'}).waitFor();
  assert.equal(await page.locator('#taskMemoryList .memory-section').count(),20);await page.locator('#taskMemoryNext').click();
  await page.waitForFunction(()=>document.querySelectorAll('#taskMemoryList .memory-section').length===1);
  const screenshot=process.argv.find(v=>v.startsWith('--screenshot='))?.slice(13);if(screenshot)await panel.screenshot({path:screenshot});
  assert.deepEqual(errors,[]);assert.equal(h.workingMemory.receipts.size,0);assert.equal(h.calls.sent.length,0);
  console.log('PASS task console: creation, edit, completion, deletion, pagination, scope changes, escaped text, no model receipt or QQ sends');
} finally {await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await h.close();}
