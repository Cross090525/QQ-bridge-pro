import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// One server-issued batch, one analysis, one exact submission. Safe to test without a model or QQ.
export async function processDebateBatch({ client, analyzer, workerId, signal, previousResponses = [], onBatch = () => {} }) {
  const { batch, task } = await client.batch(workerId);
  signal?.throwIfAborted();
  if (!batch) return { idle: true };
  onBatch(batch);
  const draft = await analyzer.analyze(task, batch.messages, { signal, previousResponses: batch.recentResponses || previousResponses,
    context: batch.context, debateState: batch.debateState, hasMore: batch.hasMore });
  signal?.throwIfAborted();
  const { task: current } = await client.task();
  signal?.throwIfAborted();
  if (current.revision !== batch.taskRevision) throw Object.assign(Error('任务授权已变化'), { statusCode: 403 });
  if (draft.verdict !== 'skip' && (current.lastEventId !== batch.eventVersion || current.contextVersion !== batch.contextVersion)) {
    return { stale: true };
  }
  // A backlog batch may update state, but cannot speak based on incomplete context.
  const result = await client.submit({ ...draft, ...(batch.hasMore ? { verdict: 'skip', text: '' } : {}),
    batchId: batch.id, taskRevision: batch.taskRevision, throughEventId: batch.throughEventId,
    requestId: randomUUID(), requestSeq: current.lastRequestSeq + 1 });
  previousResponses.push({ text: result.draft.text, verdict: result.draft.verdict, status: result.draft.status });
  if (previousResponses.length > 5) previousResponses.shift();
  return result;
}

export async function runDebateWorker({ client, analyzer, signal, onResult = () => {} }) {
  const workerId = randomUUID();
  let state = 'idle', error = '', active, activeBatch, healthError, checking = false, sequence = 0;
  const previousResponses = [];
  const ping = async () => {
    if (checking) return; checking = true;
    try {
      const { task } = await client.heartbeat({ workerId, state, error, sequence: ++sequence });
      if (activeBatch && (task.revision !== activeBatch.taskRevision || !activeBatch.hasMore
        && (task.lastEventId !== activeBatch.eventVersion || task.contextVersion !== activeBatch.contextVersion))) {
        active?.abort(Object.assign(Error('分析期间上下文已变化'), { stale: true }));
      }
    } catch (failure) { healthError = failure; active?.abort(failure); }
    finally { checking = false; }
  };
  await ping(); if (healthError) throw healthError;
  const heartbeat = setInterval(ping, 1000); heartbeat.unref?.();
  const stopWorker = () => {
    state = 'stopped'; active?.abort(signal?.reason);
    void client.heartbeat({ workerId, state: 'stopped', error, sequence: ++sequence }).catch(() => {});
  };
  signal?.addEventListener('abort', stopWorker, { once: true });
  if (signal?.aborted) stopWorker();
  try {
    while (!signal?.aborted) {
      if (healthError) throw healthError;
      active = new AbortController(); activeBatch = null;
      const abort = () => active?.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const wasQuotaBlocked = state === 'blocked' && error === 'quota_exhausted';
        state = 'analyzing'; error = '';
        if (wasQuotaBlocked) await client.heartbeat({ workerId, state, error, sequence: ++sequence });
        const result = await processDebateBatch({ client, analyzer, workerId, signal: active.signal, previousResponses,
          onBatch: batch => { activeBatch = batch; } });
        state = 'idle'; onResult(result);
        if (result.idle) await delay(1000, undefined, { signal });
      } catch (failure) {
        if (signal?.aborted) break;
        if (healthError) throw healthError;
        if (active.signal.reason?.stale) { state = 'idle'; continue; }
        if (failure.statusCode === 429 && failure.code === 'QUOTA_EXHAUSTED') {
          state = 'blocked'; error = 'quota_exhausted'; await ping();
          if (healthError) throw healthError;
          await delay(5000, undefined, { signal }); continue;
        }
        if (failure.statusCode === 409) {
          error = /淘汰/.test(failure.message) ? 'context_gap' : '';
          state = error ? 'blocked' : 'idle';
          await ping(); if (healthError) throw healthError;
          await delay(1000, undefined, { signal }); continue;
        }
        state = 'error'; error = failure.statusCode ? 'transport_failed' : 'analysis_failed';
        await ping(); throw failure;
      } finally { signal?.removeEventListener('abort', abort); active = null; activeBatch = null; }
    }
  } catch (failure) {
    if (!signal?.aborted) throw failure;
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', stopWorker);
    // Keep error diagnostics visible. A healthy shutdown explicitly releases the lease.
    if (!error) try { await client.heartbeat({ workerId, state: 'stopped', error: '', sequence: ++sequence }); } catch {}
  }
}
