import { readState, writeState, withLock } from './durable-state.js';
import { validateReceipt } from './publishing-guards.js';

export async function runBatch({ path, entries, account, fingerprint, run, dryRun = false }) {
  const ids = new Set();
  const plan = entries.map(entry => {
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Plan IDs must be unique and nonempty.');
    ids.add(entry.id);
    return { ...entry, fingerprint: fingerprint(entry) };
  });
  if (dryRun) return plan.map(entry => ({ id: entry.id, status: 'validated' }));
  return withLock(`${path}.lock`, async () => {
    const state = readState(path, { version: 2, pageId: account.pageId, runs: {} });
    if (state.version !== 2 || state.pageId !== account.pageId || !state.runs) throw new Error('Legacy or mismatched batch state requires reconciliation before use.');
    const results = [];
    for (const entry of plan) {
      const key = `job:${entry.id}`;
      const old = state.runs[key];
      if (old?.status === 'completed') {
        if (old.fingerprint !== entry.fingerprint) throw new Error(`Completed job ${entry.id} changed; update the existing post through the inventory adapter.`);
        validateReceipt(old.receipt, account.pageId);
        results.push({ id: entry.id, status: 'skipped' });
        continue;
      }
      if (old && old.status !== 'failed_precommit') throw new Error(`Job ${entry.id} has an uncertain result; reconcile before retrying.`);
      state.runs[key] = { fingerprint: entry.fingerprint, status: 'in_progress' };
      writeState(path, state);
      let result;
      try { result = await run(entry); } catch { result = { status: 'uncertain' }; }
      if (result.status !== 'scheduled') {
        state.runs[key].status = result.status === 'failed_precommit' ? 'failed_precommit' : 'uncertain';
        writeState(path, state);
        throw new Error(`Job ${entry.id} did not confirm scheduling (${state.runs[key].status}).`);
      }
      try { validateReceipt(result.receipt, account.pageId); }
      catch (error) { state.runs[key].status = 'uncertain'; writeState(path, state); throw error; }
      state.runs[key] = { fingerprint: entry.fingerprint, status: 'completed', receipt: result.receipt };
      writeState(path, state);
      results.push({ id: entry.id, status: 'scheduled' });
    }
    return results;
  });
}
