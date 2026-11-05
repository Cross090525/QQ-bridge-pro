import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { HaitangMemoryProvider, DEFAULT_SOURCE } from '../integrations/haitang-memory.mjs';
import { MEMORY_PROTOCOL } from '../src/framework/memory-providers.mjs';
const source=process.env.HAITANG_SOURCE || DEFAULT_SOURCE;
const installed=fss.existsSync(path.join(source,'lib/store.js'));
const namespace='a'.repeat(64);
const request=(operation,input)=>({protocol:MEMORY_PROTOCOL,namespace,operation,input,requestId:crypto.createHash('sha256').update(JSON.stringify([operation,input])).digest('hex')});
async function fixture(run) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'temporal-provider-'));
  const provider=new HaitangMemoryProvider({source,directory});
  try {await run(provider,directory);} finally {await provider.close();await fs.rm(directory,{recursive:true,force:true});}
}
const fact=(id,text,from,to=null,supersedes)=>({id,text,category:'temporary',subject:'234',metadata:{temporal:{validFrom:from,validTo:to,eventAt:null,
  sources:['qq:1'],timeZone:'Asia/Shanghai',precision:'range',assertionType:'reported',...(supersedes?{supersedes}:{})}}});

test('real Haitang preserves correction history, closes previous validity and never revives it on delete', {skip:!installed}, ()=>fixture(async provider=>{
  const now=Date.now();
  await provider.handle(request('write',fact('old','原来周五开会',now-2000)));
  await provider.handle(request('write',fact('new','改为下周一开会',now-1000,null,'old')));
  const current=await provider.handle(request('query',{})); assert.deepEqual(current.items.map(m=>m.id),['new']);
  const history=await provider.handle(request('query',{options:{temporal:{mode:'history'}}})); assert.equal(history.items.length,2);
  assert.equal(history.items.find(m=>m.id==='old').metadata.temporal.validTo,now-1000);
  assert.deepEqual((await provider.handle(request('query',{options:{temporal:{mode:'history',at:now-1500}}}))).items.map(m=>m.id),['old']);
  await assert.rejects(provider.handle(request('write',fact('new','覆盖历史',now))),/不可覆盖/);
  await assert.rejects(provider.handle(request('update',{selector:{id:'new'},patch:{text:'伪装普通更新'}})),/不可覆盖/);
  await provider.handle(request('delete',{selector:{id:'new'}}));
  assert.equal((await provider.handle(request('query',{}))).items.length,0);
}));

test('real Haitang returns expired history explicitly, preserves unknown time, filters before ranking and pagination', {skip:!installed}, ()=>fixture(async provider=>{
  const now=Date.now();
  await provider.handle(request('write',{...fact('expired','已过去的出差',now-3000,now-2000),expiresAt:now-1000}));
  await provider.handle(request('write',fact('unknown','还没确定时间的出差',null)));
  await provider.handle(request('write',fact('future','将来才成立的出差',now+60000)));
  assert.deepEqual((await provider.handle(request('query',{query:'出差'}))).items.map(m=>m.id),['unknown']);
  const history=await provider.handle(request('query',{limit:1,options:{temporal:{mode:'history'}}}));
  assert.equal(history.items.length,1); assert.equal(history.nextCursor,'1');
  const more=await provider.handle(request('query',{cursor:history.nextCursor,options:{temporal:{mode:'history'}}}));
  assert.equal(more.items.length,2);
}));

test('real Haitang no-op retry keeps bytes and timestamps unchanged', {skip:!installed}, ()=>fixture(async(provider,directory)=>{
  const input=fact('same','临时状态',Date.now()-1000);
  await provider.handle(request('write',input));
  const file=path.join(directory,namespace,'raw_memories.md'), before=await fs.readFile(file,'utf8');
  const retry=await provider.handle(request('write',input)); assert.equal(retry.affectedCount,0);
  assert.equal(await fs.readFile(file,'utf8'),before);
}));
