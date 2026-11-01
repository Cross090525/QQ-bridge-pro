import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDebateOutput } from '../src/framework/debate-analyzer.mjs';
test('uncited optional memory is dropped without discarding a cited analysis', () => {
 const claim = { text: 'claim', side: 'target', status: 'open', evidenceIds: [] };
 const output = { text: 'reply', analysis: 'analysis', verdict: 'uncertain', evidenceIds: [1], state: { claims: [claim,{...claim,evidenceIds:[1]}], questions: [claim], position: 'summary' } };
 const input = { messages: [{id:1}] };
 const result = parseDebateOutput(JSON.stringify(output), input);
 assert.equal(result.state.claims.length,1); assert.equal(result.state.questions.length,0);
 output.evidenceIds = [2]; assert.throws(()=>parseDebateOutput(JSON.stringify(output), input));
 output.evidenceIds=[1]; output.state.claims=[{...claim,evidenceIds:[2]}]; assert.throws(()=>parseDebateOutput(JSON.stringify(output),input));
});
