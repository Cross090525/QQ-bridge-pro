import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
test('busy wake backlog collapses to newest unread event and discards consumed events', async () => {
 const h = await bridgeHarness({ config: { dualMode: { enabled: true }, allow: { groups: ['456'] }, socialV2: { proactive: { enabled: false } } } });
 try {
  const st = h.getSocialV2State('group:456');
  st.pendingWakeReasons = [1,2,3].map(seq => ({ reason: 'observation', seq }));
  st.unread = [{seq: 4}];
  assert.equal(h.replayPendingWakeReasonsV2('group:456').action, 'skipped');
  assert.equal(st.pendingWakeReasons.length, 0);
 } finally { await h.close(); }
});
