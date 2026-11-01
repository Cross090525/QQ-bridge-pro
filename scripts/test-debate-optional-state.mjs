import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshDebateAnalyzer, parseDebateOutput } from '../src/framework/debate-analyzer.mjs';
test('uncited optional memory is dropped without discarding a cited analysis', () => {
 const claim = { text: 'claim', side: 'target', status: 'open', evidenceIds: [] };
 const output = { text: 'reply', analysis: 'analysis', verdict: 'uncertain', evidenceIds: [1], state: { claims: [claim,{...claim,evidenceIds:[1]}], questions: [claim], position: 'summary' } };
 const input = { messages: [{id:1}] };
 const result = parseDebateOutput(JSON.stringify(output), input);
 assert.equal(result.state.claims.length,1); assert.equal(result.state.questions.length,0);
 output.evidenceIds = [2]; assert.throws(()=>parseDebateOutput(JSON.stringify(output), input));
 output.evidenceIds=[1]; output.state.claims=[{...claim,evidenceIds:[2]}]; assert.throws(()=>parseDebateOutput(JSON.stringify(output),input));
});

test('invalid optional personality output preserves the validated analysis draft', async () => {
 const a = new DshDebateAnalyzer({ api: {} });
 const draft = { text: 'validated', analysis: 'supported', verdict: 'uncertain', evidenceIds: [1] };
 a.run = async input => { if (input.phase === 'expression') throw Object.assign(new SyntaxError('invalid JSON'), {code:'DEBATE_OUTPUT_INVALID'}); return draft; };
 assert.deepEqual(await a.analyze({topic:'topic'},[{id:1,text:'source'}],{context:{persona:'role'}}),draft);
 a.run = async () => { throw Object.assign(Error('cancelled'), {code:'ABORT_ERR'}); };
 await assert.rejects(a.analyze({topic:'topic'},[{id:1,text:'source'}]),{code:'ABORT_ERR'});
});
