import { createHash } from 'node:crypto';
import { readState, writeState, withLock } from './durable-state.js';
import { validateReceipt } from './publishing-guards.js';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const statuses = ['available', 'reserved', 'sold', 'hidden', 'removed', 'draft'];
const blocked = ['hidden', 'removed', 'draft'];

export function initialState(config) {
  return { version: 1, tenantId: config.tenantId, pageId: config.pageId, records: {} };
}

function checkState(state, config) {
  if (!identifier(config.tenantId) || !/^\d+$/.test(config.pageId) || state.version !== 1 || state.tenantId !== config.tenantId || state.pageId !== config.pageId || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) throw new Error('State/account/tenant mismatch.');
}

function canonicalMachineUrl(value, id, config) {
  const url = new URL(value);
  if (url.origin !== config.websiteOrigin || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !new RegExp(`^/equipment/${id}/[^/]+/?$`).test(url.pathname)) throw new Error('Machine URL must be its exact canonical website page.');
  return url.href;
}

export function normalizeSnapshot(snapshot, config) {
  if (snapshot.version !== 1 || snapshot.source !== 'crm' || snapshot.tenantId !== config.tenantId || !Array.isArray(snapshot.items) || snapshot.items.length > 10000) throw new Error('Expected a tenant-scoped, effective CRM snapshot.');
  const ids = new Set();
  return snapshot.items.map(item => {
    if (!identifier(item.id) || ids.has(item.id)) throw new Error('Invalid or duplicate equipment ID.');
    ids.add(item.id);
    if (!Number.isSafeInteger(item.revision) || item.revision < 1 || !statuses.includes(item.status)) throw new Error('Invalid equipment revision/status.');
    for (const flag of ['hold', 'suppressed', 'removeFromFacebook', 'saleReopened']) if (item[flag] !== undefined && typeof item[flag] !== 'boolean') throw new Error(`Invalid ${flag} flag.`);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300 || typeof item.description !== 'string' || item.description.length > 4000 || typeof item.price !== 'string' || item.price.length > 80) throw new Error('Invalid effective listing copy.');
    const url = canonicalMachineUrl(item.url, item.id, config);
    // This version uses the canonical page's link preview; media uploads are not silently replaced.
    const prefix = item.status === 'sold' ? 'SOLD — ' : item.status === 'reserved' ? 'RESERVED — ' : '';
    const caption = `${prefix}${item.title.trim()}${item.price ? ` — ${item.price}` : ''}\n\n${item.description.trim()}\n\nSee photos and ask about this machine:\n${url}#inquire${item.status === 'sold' ? `\n\nBrowse available machines: ${config.availableUrl}` : '\n\nAvailability is confirmed when we reply.'}`;
    return { ...item, url, caption, contentHash: hash({ caption, url, status: item.status }) };
  });
}

export function planInventory(state, snapshot, config) {
  checkState(state, config);
  const normalized = normalizeSnapshot(snapshot, config);
  return normalized.map(item => {
    const key = `machine:${item.id}`;
    const old = state.records[key];
    const result = { id: item.id, key, revision: item.revision, item };
    if (old?.pending) return { ...result, action: 'hold', reason: 'uncertain-outcome' };
    if (old && item.revision < old.revision) return { ...result, action: 'hold', reason: 'stale-revision' };
    if (old && item.revision === old.revision && hash(item) !== old.sourceHash) return { ...result, action: 'hold', reason: 'revision-conflict' };
    if (item.hold || item.suppressed) return { ...result, action: 'hold', reason: 'operator-hold' };
    if ((old?.soldLatch || old?.status === 'sold') && item.status !== 'sold' && !blocked.includes(item.status) && !item.saleReopened) return { ...result, action: 'hold', reason: 'sold-latch' };
    if (blocked.includes(item.status)) {
      return { ...result, action: old?.receipt && !old.deleted && item.removeFromFacebook ? 'delete' : 'hold', reason: 'not-public' };
    }
    if ((!old?.receipt || old.deleted) && item.status === 'sold') return { ...result, action: 'hold', reason: 'sold-without-post' };
    if (old?.receipt && !old.deleted && old.contentHash === item.contentHash) return { ...result, action: 'unchanged' };
    const action = old?.receipt && !old.deleted ? 'update' : 'create';
    return { ...result, action, operationId: hash({ tenant: config.tenantId, page: config.pageId, id: item.id, revision: item.revision, content: item.contentHash, action }) };
  }).map(operation => operation.action === 'delete' ? { ...operation, operationId: hash({ tenant: config.tenantId, page: config.pageId, id: operation.id, revision: operation.revision, action: 'delete' }) } : operation);
}

export function applyReceipt(state, operation, receipt, config) {
  const old = state.records[operation.key];
  if (old?.pending?.operationId !== operation.operationId) throw new Error('Pending operation changed; receipt rejected.');
  validateReceipt(receipt, config.pageId, config.pageProfileId);
  if (operation.action !== 'create' && (receipt.postId !== old.receipt.postId || receipt.url !== old.receipt.url)) throw new Error('Update/delete returned another post identity.');
  if (receipt.operationId !== operation.operationId || receipt.contentHash !== operation.item.contentHash || receipt.action !== operation.action) throw new Error('Receipt does not confirm this operation.');
  state.records[operation.key] = {
    revision: operation.revision, sourceHash: hash(operation.item), contentHash: operation.item.contentHash,
    status: operation.item.status, receipt, deleted: operation.action === 'delete', pending: null,
    soldLatch: operation.item.status === 'sold' || (!operation.item.saleReopened && Boolean(old?.soldLatch || old?.status === 'sold')),
  };
}

// Adapter contract: verifyDestination, create, update, delete. Mutations return read-back receipts.
// No live provider is bundled until its permitted access and UI/API contract are verified.
export async function syncInventory({ path, snapshot, config, adapter, dryRun = true }) {
  if (dryRun) return { operations: planInventory(readState(path, initialState(config)), snapshot, config), dryRun: true };
  if (!config.liveEnabled || !adapter) throw new Error('Live inventory sync requires an enabled, verified publishing adapter.');
  return withLock(`${path}.lock`, async () => {
    const state = readState(path, initialState(config));
    const operations = planInventory(state, snapshot, config);
    for (const operation of operations) {
      if (operation.action === 'unchanged') {
        Object.assign(state.records[operation.key], { revision: operation.revision, sourceHash: hash(operation.item) });
        writeState(path, state);
        continue;
      }
      if (operation.action === 'hold' && ['operator-hold', 'not-public', 'sold-without-post', 'sold-latch'].includes(operation.reason)) {
        const previous = state.records[operation.key] || {};
        state.records[operation.key] = { ...previous, revision: operation.revision, sourceHash: hash(operation.item), status: operation.item.status,
          soldLatch: Boolean(previous.soldLatch || previous.status === 'sold' || operation.item.status === 'sold') };
        writeState(path, state);
      }
      if (!['create', 'update', 'delete'].includes(operation.action)) continue;
      if (typeof adapter[operation.action] !== 'function') throw new Error(`Adapter cannot ${operation.action}.`);
      if (operation.action !== 'delete') await adapter.verifyDestination(operation.item.url, operation.id);
      const previous = state.records[operation.key] || {};
      state.records[operation.key] = { ...previous, pending: operation };
      writeState(path, state);
      try {
        const receipt = await adapter[operation.action]({ ...operation, pageId: config.pageId, previous: previous.receipt });
        applyReceipt(state, operation, receipt, config);
        writeState(path, state);
      } catch (cause) {
        // Keep the persisted intent even for a crash or malformed receipt. Never guess whether Meta accepted it.
        throw new Error(`Machine ${operation.id} needs reconciliation; no automatic retry.`, { cause });
      }
    }
    return { operations, dryRun: false };
  });
}

export async function reconcileReceipt({ path, config, receipt, machineId }) {
  return withLock(`${path}.lock`, async () => {
    const state = readState(path, initialState(config));
    checkState(state, config);
    const pending = state.records[`machine:${machineId}`]?.pending;
    if (!pending) throw new Error('No pending operation for this machine.');
    applyReceipt(state, pending, receipt, config);
    writeState(path, state);
  });
}
