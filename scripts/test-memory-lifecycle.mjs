import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WorkingMemory } from '../src/core/working-memory.mjs';
import { TaskMemory } from '../src/core/task-memory.mjs';
import { temporalMetadata, selectTemporal } from '../src/core/temporal-memory.mjs';
import { TemporalRecall } from '../src/core/temporal-recall.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { QQBridgeClient } from '../src/bridge-client.mjs';
import { startMemoryProvider } from '../examples/memory-provider.mjs';
const KEY = 'group:456';
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lifecycle-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function source(n, text = '测试材料', extra = {}) { return { id: `qq:${n}`, seq: n, userId: '234', sender: '成员', plain: text, time: Date.now(), ...extra }; }
const fact = (id, from = 100, to = 200, more = {}) => ({ id, text: '本周临时出差', subject: '234', metadata: { temporal: {
  validFrom: from, validTo: to, eventAt: null, timeZone: 'Asia/Shanghai', precision: 'range', sources: ['qq:1'], assertionType: 'reported', ...more } } });

test('long-message backlog advances without new arrivals and records unprocessed eviction', t => {
  const wm = new WorkingMemory(temporary(t), { maxMessages: 25 });
  for (let n = 1; n <= 25; n++) wm.record(KEY, source(n, '长'.repeat(1400)));
  for (let n = 1; n <= 25 && wm.snapshot(KEY).pendingCount; n++) {
    const before = wm.snapshot(KEY); assert.ok(JSON.stringify(before).length <= 10000);
    const oldest = wm.get(KEY).messages.find(m => !wm.get(KEY).consideredIds.includes(m.id));
    assert.ok(before.messages.some(m => m.id === oldest.id)); wm.offered(KEY,before);
    wm.update(KEY, { revision: before.revision, decision: { action: 'observe', note: '本批已看', sources: [oldest.id] } });
    assert.ok(wm.snapshot(KEY).pendingCount < before.pendingCount);
  }
  assert.equal(wm.snapshot(KEY).pendingCount, 0);
  for (let n = 26; n <= 52; n++) wm.record(KEY, source(n));
  assert.equal(wm.snapshot(KEY).evictedPending, 2);
});

test('discard immediately revokes receipts, rejects late batches and remains revoked on restart', t => {
  const dir = temporary(t), wm = new WorkingMemory(dir);
  wm.record(KEY,source(1)); const packet = wm.snapshot(KEY); wm.offered(KEY,packet);
  wm.update(KEY,{revision:0,discardMessageIds:['qq:1']});
  assert.throws(() => wm.update(KEY,{revision:1,facts:[{text:'旧内容',status:'active',certainty:'reported',sources:['qq:1']}]}), /来源/);
  wm.offered(KEY,packet); assert.throws(() => wm.requireEvidence(KEY,['qq:1']), /来源/);
  const restarted = new WorkingMemory(dir); restarted.record(KEY,source(1));
  assert.equal(restarted.get(KEY).messages.length,0);
});

test('unchanged items keep stable IDs and times, assistant claims cannot confirm user facts', t => {
  let now = 100; const wm = new WorkingMemory(temporary(t), {now:()=>now});
  wm.record(KEY,source(1,'测试材料',{time:now})); wm.record(KEY,source(2,'机器人的推断',{isSelf:true,time:now})); wm.offered(KEY,wm.snapshot(KEY));
  const item = {text:'旧话题',status:'active',certainty:'reported',sources:['qq:1']};
  wm.update(KEY,{revision:0,topics:[item]}); const old = wm.get(KEY).topics[0]; now += 3600001;
  wm.update(KEY,{revision:1,topics:[old,{...item,text:'新话题'}]});
  assert.equal(wm.get(KEY).topics[0].id,old.id); assert.equal(wm.get(KEY).topics[0].updatedAt,100);
  assert.equal(wm.snapshot(KEY).topics[0].status,'dormant');
  assert.throws(() => wm.update(KEY,{revision:2,facts:[{...item,certainty:'confirmed',sources:['qq:2']}]}), /自述/);
  wm.reset(KEY); assert.throws(() => wm.requireEvidence(KEY,['qq:1']), /来源/);
});

test('temporal current/history selection preserves uncertainty, boundaries and correction chains', () => {
  const a = fact('a',100,null), b = fact('b',150,null,{supersedes:'a'}), future = fact('future',300,400);
  assert.deepEqual(selectTemporal([a,b,future],{},125).map(m=>m.id),['a']);
  assert.deepEqual(selectTemporal([a,b,future],{},150).map(m=>m.id),['b']);
  assert.equal(selectTemporal([fact('ends')],{},200).length,0);
  assert.equal(selectTemporal([fact('unknown',null,null)],{},200).length,1);
  assert.equal(selectTemporal([a,b,future],{temporal:{mode:'history'}}).length,3);
  assert.deepEqual(selectTemporal([a,b],{temporal:{mode:'history',at:125}}).map(m=>m.id),['a']);
  assert.throws(()=>temporalMetadata(fact('bad',200,100).metadata),/区间/);
  assert.throws(()=>temporalMetadata({...a.metadata,temporal:{...a.metadata.temporal,timeZone:'invalid-zone'}}),/时区/);
});

test('unfinished tasks survive restart, expire as overdue rather than complete, and remain scoped', t => {
  const dir = temporary(t), tasks = new TaskMemory(dir,{now:()=>150});
  const input = {revision:0,text:'等截图继续诊断',ownerId:'234',kind:'continuation',status:'waiting',waitingFor:'截图',dueAt:100,sources:['qq:1']};
  const created = tasks.update(KEY,input,{evidence:[source(1)]});
  assert.equal(created.item.overdue,true); assert.equal(created.item.status,'waiting'); assert.equal(created.item.reminderScheduled,false);
  const restored = new TaskMemory(dir,{now:()=>200});
  assert.equal(restored.list(KEY).items[0].id,created.item.id); assert.equal(restored.list('group:789').total,0);
  assert.equal(restored.select(KEY,[source(2)]).items.length,1);
  assert.equal(restored.select(KEY,[source(2,'截图',{userId:'345'})]).items.length,0);
  assert.throws(()=>restored.update(KEY,{revision:0,id:created.item.id,status:'completed',sources:['qq:2']},{evidence:[source(2)]}),/版本/);
  assert.throws(()=>restored.update(KEY,{revision:1,id:created.item.id,status:'completed',sources:['qq:1']},{evidence:[source(1)]}),/新消息/);
  assert.throws(()=>restored.update(KEY,{revision:1,id:created.item.id,status:'cancelled',sources:['qq:2']},{evidence:[source(2,'取消',{userId:'345'})]}),/负责人/);
  const done = restored.update(KEY,{revision:1,id:created.item.id,status:'completed',sources:['qq:2']},{evidence:[source(2)]});
  assert.equal(done.item.completionEvidence,'owner-reported'); assert.equal(restored.select(KEY,[source(3)]).items.length,0);
});

test('task removal follows deleted provenance even after interruption; corrupt data stays intact', t => {
  const dir = temporary(t), deleted = new Set(), tasks = new TaskMemory(dir,{isSourceDeleted:(_key,id)=>deleted.has(id)});
  tasks.update(KEY,{revision:0,text:'等结果',ownerId:'234',kind:'continuation',sources:['qq:1']},{evidence:[source(1)]});
  deleted.add('qq:1'); assert.equal(tasks.list(KEY).total,0);
  assert.equal(new TaskMemory(dir).list(KEY).total,0);
  fs.writeFileSync(tasks.file(KEY),'bad');
  assert.throws(()=>new TaskMemory(dir).get(KEY),/保留/); assert.equal(fs.readFileSync(tasks.file(KEY),'utf8'),'bad');
});

test('local temporal projection never calls providers and invalidates late reads, expiry and deletion', () => {
  let now=125; const deleted = new Set(); const cache=new TemporalRecall({now:()=>now,isSourceDeleted:(_k,id)=>deleted.has(id)});
  const read=cache.begin(KEY,'p','query'); cache.remember(read,'query',{}, {items:[fact('a')]});
  assert.equal(cache.select(KEY,'p',[source(1)]).items.length,1);
  assert.equal(cache.select('group:789','p',[source(1)]).items.length,0);
  const stale=cache.begin(KEY,'p','query'); cache.begin(KEY,'p','delete'); cache.remember(stale,'query',{}, {items:[fact('a')]});
  assert.equal(cache.select(KEY,'p',[source(1)]).items.length,0);
  const fresh=cache.begin(KEY,'p','query'); cache.remember(fresh,'query',{}, {items:[fact('a')]});
  deleted.add('qq:1'); assert.equal(cache.select(KEY,'p',[source(1)]).items.length,0); deleted.clear();
  now=200; assert.equal(cache.select(KEY,'p',[source(1)]).items.length,0);
  now=125; const empty=cache.begin(KEY,'p','query'); cache.remember(empty,'query',{}, {items:[]});
  assert.equal(cache.select(KEY,'p',[source(1)]).items.length,0);
});

async function fixture(t, {provider=false}={}) {
  const plugin=provider ? await startMemoryProvider() : null;
  const h=await bridgeHarness({config:{dualMode:{enabled:true,ownerPreset:'standard'},allow:{groups:['456','789'],private:['123']},
    ...(plugin ? {memory:{provider:'local',providers:[{id:'local',approvalMode:'automatic',features:['temporal-v1'],operations:['query','write','clear'],transport:{type:'http',url:plugin.url}}]}} : {}),
    socialV2:{workingMemory:{enabled:true},proactive:{enabled:false},wake:{preSleepWaitEnabled:false},sticker:{enabled:false}}}});
  const session=await h.ensureSession(KEY), st=h.getSocialV2State(KEY);
  const server=h.startConsoleServer(); if(!server.listening) await new Promise(r=>server.once('listening',r));
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();await plugin?.close();});
  const client=new QQBridgeClient({baseUrl,key:KEY,token:st.agentToken});
  const receive=(n,text='测试材料',user='234')=>h.appendSocialV2Message(KEY,'成员',text,text,false,false,n,[],user);
  return {h,st,client,receive,plugin,baseUrl,session};
}

test('wait/recent/unread delivery yields canonical, usable working-memory sources', async t => {
  const {client,receive}=await fixture(t);
  receive(1); const first=await client.wait({purpose:'messages'}); assert.equal(first.newMessages[0].id,'qq:1');
  await client.updateWorkingContext({revision:0,facts:[{text:'测试材料待处理',status:'active',certainty:'reported',sources:['qq:1']}]});
  receive(2); await client.recent(); await client.updateWorkingContext({revision:1,topics:[{text:'继续诊断',status:'active',certainty:'reported',sources:['qq:2']}]});
  receive(3); await client.unread(); await client.updateWorkingContext({revision:2,questions:[{text:'还有问题',status:'active',certainty:'reported',sources:['qq:3']}]});
});

test('task HTTP interface scopes tokens, has admin editing, live switches and source cleanup', async t => {
  const {h,st,client,receive,baseUrl}=await fixture(t);
  receive(1,'等我发截图'); await client.unread();
  const created=await client.updateTask({revision:0,text:'诊断截图',ownerId:'234',kind:'continuation',sources:['qq:1']});
  assert.equal((await client.recent()).taskMemory.items[0].id,created.item.id);
  const foreign=new QQBridgeClient({baseUrl,key:'group:789',token:st.agentToken}); await assert.rejects(foreign.tasks(),/会话|令牌|目标/);
  h.socialV2.paused=true; await assert.rejects(client.tasks(),/启用|无效|暂停/); h.socialV2.paused=false;
  h.cfg.socialV2.workingMemory.tasksEnabled=false; await assert.rejects(client.tasks(),/启用|无效/); h.cfg.socialV2.workingMemory.tasksEnabled=true;
  const admin=await fetch(baseUrl+'/api/socialV2/task-memory',{method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token'},body:JSON.stringify({key:KEY,revision:1,id:created.item.id,waitingFor:'新的截图'})});
  assert.equal(admin.status,200);
  await client.updateWorkingContext({revision:0,discardMessageIds:['qq:1']});
  assert.equal((await client.tasks()).total,0);
  await assert.rejects(client.updateTask({revision:3,text:'复活',ownerId:'234',kind:'continuation',sources:['qq:1']}),/来源/);
  assert.equal(h.calls.sent.length,0);
});

test('gateway event time survives delayed delivery independently from receipt time', async t => {
  const {h,client}=await fixture(t);
  const eventTime=Math.floor(Date.now()/1000)-86400;
  await h.handleIncoming('group',456,{self_id:999,user_id:234,group_id:456,message_id:99,time:eventTime,sender:{nickname:'成员'},message:[{type:'text',data:{text:'明天测试'}}]},h.cfg);
  assert.ok(!(await client.workingContext()).snapshot.messages.some(m=>m.id==='qq:99'));
  const m=(await client.workingContext({messageId:'qq:99'})).snapshot.messages[0];
  assert.equal(m.eventAt,eventTime*1000); assert.ok(m.receivedAt>m.eventAt); assert.equal(m.time,m.receivedAt);
});

test('a rejected wake never grants source visibility or a read watermark', async t => {
  const {h,receive,st}=await fixture(t);receive(1);
  h.api.sessions.prompt=async()=>({result:{ok:false,error:{code:'fixture',message:'not accepted'}}});
  const result=await h.deliverPrompt(KEY,'',{wakeReason:'observation',silent:true});
  assert.equal(result.ok,false);assert.equal(st.modelSeenSeqs?.size || 0,0);
  assert.throws(()=>h.workingMemory.requireEvidence(KEY,['qq:1']),/来源/);
});

test('temporal writes require sources and capability; local recall does not issue background provider queries', async t => {
  const {h,client,receive,plugin}=await fixture(t,{provider:true});
  let queries=0; const original=plugin.store.handle.bind(plugin.store); plugin.store.handle=request=>{if(request.operation==='query') queries++; return original(request);};
  receive(1); await client.unread(); assert.equal(queries,0);
  const record=fact('time-a',Date.now()-1000,Date.now()+60000);
  await client.memory('write',record);
  const recent=await client.recent(); assert.equal(recent.temporalMemory.items.length,1); assert.equal(queries,0);
  await client.memory('query'); assert.equal(queries,1);
  await client.memory('clear'); assert.equal((await client.recent()).temporalMemory.items.length,0);
  h.memoryProviders.providers[0].features=[];
  await assert.rejects(client.memory('write',fact('time-b')),/temporal-v1/);
  assert.equal(h.calls.sent.length,0);
});
