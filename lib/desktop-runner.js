import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './publisher-cli.js';
import { readState, writeState } from './durable-state.js';
import { retryDelay } from './desktop-queue.js';
import { sshQueue } from './desktop-transport.js';
import { runDesktopBrowser } from './desktop-browser.js';
import { withPublisherLock } from './desktop-lock.js';

export function desktopFailure(error) {
  const message = error?.message || '';
  if (/^(?:DESKTOP|FACEBOOK|CATALOG|QUEUE|CONFIG|STATE|PROFILE|PUBLISHING)_[A-Z_]{1,79}$/.test(message)) return message;
  return 'FACEBOOK_DESKTOP_UNAVAILABLE';
}

export async function runDesktopTick(configPath, config, deps = {}) {
  const now = (deps.now || Date.now)();
  const remote = deps.remote || ((action, input) => sshQueue(config, action, input));
  const browser = deps.browser || ((mode, lease) => runDesktopBrowser(mode, configPath, config, lease));
  const worker = config.workerId;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(worker || '') || config.browserMode !== 'extension') throw new Error('DESKTOP_CONFIG_INVALID');
  if (!config.liveEnabled) return { ok: true, status: 'disabled' };
  const path = join(config.stateDirectory, 'desktop-runner.json');
  return withPublisherLock(join(config.stateDirectory, 'desktop-runner.lock'), config, async () => {
    const state = readState(path, { version: 1, failures: 0, nextAttemptAt: 0, outbox: null });
    if (state.version !== 1 || !Number.isSafeInteger(state.failures) || state.failures < 0 || !Number.isFinite(state.nextAttemptAt)) throw new Error('STATE_INVALID');
    if (state.nextAttemptAt > now) return { ok: true, status: 'waiting', nextAttemptAt: state.nextAttemptAt };
    try {
      // A completed local write is acknowledged before another job is claimed.
      // If the server lease expired, the inventory journal still prevents reposts.
      if (state.outbox) {
        try { await remote('finish', state.outbox); }
        catch (error) { if (error.message !== 'QUEUE_LEASE_CHANGED') throw error; }
        state.outbox = null; state.failures = 0; state.nextAttemptAt = 0; writeState(path, state);
      }
      const claim = await remote('claim', { worker });
      if (!claim.job) {
        state.failures = 0; state.nextAttemptAt = Math.max(now + 60000, claim.nextAttemptAt || 0); writeState(path, state);
        return { ok: true, status: claim.blocked ? 'needs_attention' : 'idle', blocked: claim.blocked || null, nextAttemptAt: state.nextAttemptAt };
      }
      const job = claim.job;
      if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(job.id) || job.worker !== worker) throw new Error('QUEUE_RESULT_INVALID');
      let result;
      try { result = await browser('sync', { worker, lease: job.id }); }
      catch (error) { result = { ok: false, code: desktopFailure(error) }; }
      if (result?.ok === true && (result.mode !== 'sync' || !Number.isInteger(result.verifiedWrites) || result.verifiedWrites < 0 || result.verifiedWrites > 3 || !Number.isInteger(result.remainingWrites) || result.remainingWrites < 0 || result.remainingWrites > 10000)) result = { ok: false, code: 'DESKTOP_RESULT_INVALID' };
      if (typeof result?.ok !== 'boolean' || (result.ok === false && !/^[A-Z][A-Z_]{1,79}$/.test(result.code || ''))) result = { ok: false, code: 'DESKTOP_RESULT_INVALID' };
      state.outbox = { worker, lease: job.id, result };
      writeState(path, state);
      const finished = await remote('finish', state.outbox);
      state.outbox = null; state.failures = 0; state.nextAttemptAt = Math.max(now + 60000, finished.nextAttemptAt || 0); writeState(path, state);
      return { ok: true, status: finished.blocked ? 'needs_attention' : result.ok ? 'completed' : 'retrying', result, nextAttemptAt: state.nextAttemptAt };
    } catch (error) {
      const code = desktopFailure(error);
      state.failures++; state.nextAttemptAt = now + retryDelay(state.failures); state.lastFailure = code;
      writeState(path, state);
      return { ok: false, status: 'retrying', code, nextAttemptAt: state.nextAttemptAt };
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, flag, configPath, ...extra] = process.argv.slice(2);
    if (flag !== '--config' || extra.length || !['tick', 'status', 'queue'].includes(mode)) throw new Error('DESKTOP_CONFIG_INVALID');
    const config = loadConfig(configPath);
    const result = mode === 'tick' ? await runDesktopTick(configPath, config) : mode === 'queue' ? await sshQueue(config, 'status') : await runDesktopBrowser('status', configPath, config);
    process.stdout.write(JSON.stringify({ ...result, observedAt: new Date().toISOString() }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: desktopFailure(error), observedAt: new Date().toISOString() }) + '\n'); process.exitCode = 1; }
}
