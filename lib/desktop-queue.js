import { randomUUID } from 'node:crypto';
import { readState, writeState } from './durable-state.js';
import { withAdvisoryLock } from './desktop-lock.js';

export const retryMinutes = [1, 5, 15, 60];
export const retryDelay = failures => retryMinutes[Math.min(Math.max(failures - 1, 0), retryMinutes.length - 1)] * 60000;
export const retryable = code => ['DESKTOP_OFFLINE', 'FACEBOOK_DESKTOP_UNAVAILABLE', 'FACEBOOK_BROWSER_BUSY', 'FACEBOOK_READBACK_PENDING', 'CATALOG_UNAVAILABLE', 'CATALOG_CHANGED_DURING_RUN'].includes(code);
const minute = 60000;
const validCode = code => typeof code === 'string' && /^[A-Z][A-Z_]{1,79}$/.test(code);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };

export function initialQueue() {
  return { version: 1, requested: 0, completed: 0, requestedAt: null, nextAttemptAt: 0, failures: 0, lease: null, blocked: null, lastHeartbeatAt: null, lastResult: null };
}

export function validateQueue(state) {
  if (state?.version !== 1 || !Number.isSafeInteger(state.requested) || !Number.isSafeInteger(state.completed) || state.completed < 0 || state.requested < state.completed || !Number.isSafeInteger(state.failures) || state.failures < 0 || !Number.isFinite(state.nextAttemptAt)) fail('QUEUE_INVALID');
  if (state.lease && (!id(state.lease.id) || !id(state.lease.worker) || !Number.isSafeInteger(state.lease.generation) || !Number.isFinite(state.lease.expiresAt))) fail('QUEUE_INVALID');
  if (state.blocked !== null && !validCode(state.blocked)) fail('QUEUE_INVALID');
  return state;
}

export function queueSummary(state, now) {
  validateQueue(state);
  return { ok: true, pending: state.requested > state.completed, requested: state.requested, completed: state.completed, requestedAt: state.requestedAt, nextAttemptAt: state.nextAttemptAt, failures: state.failures, blocked: state.blocked, workerRecentlySeen: Boolean(state.lastHeartbeatAt && now - state.lastHeartbeatAt < 3 * minute), lastHeartbeatAt: state.lastHeartbeatAt, lastResult: state.lastResult, leaseActive: Boolean(state.lease && state.lease.expiresAt > now) };
}

// One durable "reconcile latest catalog" job coalesces clock ticks. Listing-level
// IDs/revisions and verified receipts stay in the publisher's private journal.
export function transitionQueue(state, action, input = {}, now = Date.now(), uuid = randomUUID) {
  validateQueue(state);
  if (!Number.isSafeInteger(now) || now < 1) fail('QUEUE_CLOCK_INVALID');
  if (action === 'enqueue') {
    const generation = Math.floor(now / (15 * minute));
    if (generation > state.requested) { state.requested = generation; state.requestedAt = now; }
    const attention = state.blocked || (state.failures >= 3 && state.lastResult?.code === 'FACEBOOK_READBACK_PENDING' ? 'FACEBOOK_READBACK_PENDING' : null);
    const notifyCode = attention && state.lastNotifiedCode !== attention ? attention : null;
    if (notifyCode) state.lastNotifiedCode = notifyCode;
    return { ...queueSummary(state, now), notifyCode };
  }
  if (action === 'status') return queueSummary(state, now);
  if (!id(input.worker)) fail('QUEUE_WORKER_INVALID');
  state.lastHeartbeatAt = now;
  if (action === 'claim') {
    if (state.blocked || state.requested <= state.completed || state.nextAttemptAt > now || (state.lease && state.lease.expiresAt > now)) return { ...queueSummary(state, now), job: null };
    state.lease = { id: uuid(), worker: input.worker, generation: state.requested, expiresAt: now + 15 * minute };
    return { ok: true, job: { ...state.lease } };
  }
  if (action === 'finish') {
    const lease = state.lease;
    if (!lease || lease.id !== input.lease || lease.worker !== input.worker) fail('QUEUE_LEASE_CHANGED');
    const result = input.result;
    if (result?.ok === true) {
      if (result.mode !== 'sync' || !Number.isInteger(result.verifiedWrites) || result.verifiedWrites < 0 || result.verifiedWrites > 3 || !Number.isInteger(result.remainingWrites) || result.remainingWrites < 0 || result.remainingWrites > 10000) fail('QUEUE_RESULT_INVALID');
      state.completed = result.remainingWrites ? state.completed : Math.max(state.completed, lease.generation);
      state.failures = 0;
      state.nextAttemptAt = result.remainingWrites ? now + minute : 0;
      state.lastResult = { ok: true, verifiedWrites: result.verifiedWrites, remainingWrites: result.remainingWrites, observedAt: now };
    } else {
      if (result?.ok !== false || !validCode(result.code)) fail('QUEUE_RESULT_INVALID');
      state.failures++;
      state.nextAttemptAt = now + retryDelay(state.failures);
      state.blocked = retryable(result.code) ? null : result.code;
      state.lastResult = { ok: false, code: result.code, observedAt: now };
    }
    state.lease = null;
    return queueSummary(state, now);
  }
  if (action === 'check') {
    if (!state.lease || state.lease.id !== input.lease || state.lease.worker !== input.worker || state.lease.expiresAt <= now) fail('QUEUE_LEASE_CHANGED');
    return { ok: true, generation: state.lease.generation };
  }
  if (action === 'resume') {
    if (state.lease && state.lease.expiresAt > now) fail('QUEUE_LEASE_ACTIVE');
    state.blocked = null; state.lastNotifiedCode = null; state.nextAttemptAt = 0; state.failures = 0; state.lease = null;
    return queueSummary(state, now);
  }
  fail('QUEUE_ACTION_INVALID');
}

export async function updateQueue(path, action, input = {}, now = Date.now()) {
  return withAdvisoryLock(`${path}.advisory`, async () => {
    const state = readState(path, initialQueue());
    const result = transitionQueue(state, action, input, now);
    if (action !== 'status') writeState(path, state);
    return result;
  });
}
