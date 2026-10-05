import { createHash } from 'node:crypto';
import { readState, writeState } from './durable-state.js';
import { validateReceipt } from './publishing-guards.js';
import { withPublisherLock } from './desktop-lock.js';
import { listingCaption, listingCopyVersion, legacyFacebookCaption } from './listing-copy.js';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const statuses = ['available', 'reserved', 'sold', 'hidden', 'removed', 'draft'];
const blocked = ['hidden', 'removed', 'draft'];

const sourceFacts = ({ caption, contentHash, copyVersion, ...facts }) => facts;
const recordedSource = item => item.copyVersion === listingCopyVersion
  ? { sourceHashVersion: 2, sourceHash: hash(sourceFacts(item)), copyVersion: listingCopyVersion }
  // A submitted operation may predate this release. Preserve its original
  // representation until reconciliation is followed by a fresh catalog plan.
  : { sourceHashVersion: 1, sourceHash: hash(item), copyVersion: 1 };
function matchesRecordedSource(record, item, config) {
  if (record.sourceHashVersion === 2) return record.sourceHash === hash(sourceFacts(item));
  // The original journal hashed generated copy together with CRM facts. Verify
  // its exact old representation before upgrading; never invent a CRM revision.
  const { location, ...legacy } = sourceFacts(item);
  const caption = legacyFacebookCaption(legacy, config);
  return record.sourceHash === hash({ ...legacy, caption, contentHash: hash({ caption, url: legacy.url, status: legacy.status }) });
}

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
    if (item.location !== undefined && (typeof item.location !== 'string' || item.location.length > 160 || /[\r\n]/.test(item.location))) throw new Error('Invalid effective listing location.');
    const url = canonicalMachineUrl(item.url, item.id, config);
    const caption = listingCaption({ ...item, url }, config);
    return { ...item, url, caption, copyVersion: listingCopyVersion, contentHash: hash({ caption, url, status: item.status }) };
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
    if (old && item.revision === old.revision && !matchesRecordedSource(old, item, config)) return { ...result, action: 'hold', reason: 'revision-conflict' };
    if (item.hold || item.suppressed) return { ...result, action: 'hold', reason: 'operator-hold' };
    if ((old?.soldLatch || old?.status === 'sold') && item.status !== 'sold' && !blocked.includes(item.status) && !item.saleReopened) return { ...result, action: 'hold', reason: 'sold-latch' };
    if (blocked.includes(item.status)) {
      return { ...result, action: old?.receipt && !old.deleted && item.removeFromFacebook ? 'delete' : 'hold', reason: 'not-public' };
    }
    if ((!old?.receipt || old.deleted) && item.status === 'sold') return { ...result, action: 'hold', reason: 'sold-without-post' };
    const missingPreview = config.requireLinkPreview && old?.receipt && (old.receipt.linkPreview?.version !== 1 || old.receipt.linkPreview?.verified !== true || old.receipt.linkPreview?.url !== `${item.url}#inquire`);
    if (old?.receipt && !old.deleted && old.contentHash === item.contentHash && !missingPreview) {
      const button = old.receipt.postButton;
      if (config.requirePostButton && (button?.version !== 1 || button?.verified !== true || button?.type !== 'LEARN_MORE' || button?.url !== `${item.url}#inquire`)) {
        return { ...result, action: 'button', reason: 'native-button-required', operationId: hash({ tenant: config.tenantId, page: config.pageId, id: item.id, revision: item.revision, content: item.contentHash, postId: old.receipt.postId, action: 'button', buttonVersion: 1 }) };
      }
      return { ...result, action: 'unchanged' };
    }
    const action = old?.receipt && !old.deleted ? 'update' : 'create';
    return { ...result, action, ...(missingPreview ? { reason: 'link-preview-required' } : {}), operationId: hash({ tenant: config.tenantId, page: config.pageId, id: item.id, revision: item.revision, content: item.contentHash, action, ...(config.requireLinkPreview ? { previewVersion: 1 } : {}) }) };
  }).map(operation => operation.action === 'delete' ? { ...operation, operationId: hash({ tenant: config.tenantId, page: config.pageId, id: operation.id, revision: operation.revision, action: 'delete' }) } : operation);
}

export function applyReceipt(state, operation, receipt, config) {
  const old = state.records[operation.key];
  if (old?.pending?.operationId !== operation.operationId) throw new Error('Pending operation changed; receipt rejected.');
  validateReceipt(receipt, config.pageId, config.pageProfileId);
  if (config.requireLinkPreview && operation.action !== 'delete' && (receipt.linkPreview?.version !== 1 || receipt.linkPreview?.verified !== true || receipt.linkPreview?.url !== `${operation.item.url}#inquire`)) throw new Error('Receipt does not confirm the machine image preview.');
  if (operation.action === 'button' && (receipt.postButton?.version !== 1 || receipt.postButton?.verified !== true || receipt.postButton?.type !== 'LEARN_MORE' || receipt.postButton?.url !== `${operation.item.url}#inquire`)) throw new Error('Receipt does not confirm the native website button.');
  if (operation.action !== 'create' && (receipt.postId !== old.receipt.postId || receipt.url !== old.receipt.url)) throw new Error('Update/delete returned another post identity.');
  if (receipt.operationId !== operation.operationId || receipt.contentHash !== operation.item.contentHash || receipt.action !== operation.action) throw new Error('Receipt does not confirm this operation.');
  state.records[operation.key] = {
    revision: operation.revision, ...recordedSource(operation.item), contentHash: operation.item.contentHash,
    status: operation.item.status, receipt, deleted: operation.action === 'delete', pending: null,
    soldLatch: operation.item.status === 'sold' || (!operation.item.saleReopened && Boolean(old?.soldLatch || old?.status === 'sold')),
  };
}

// Adapter contract: verifyDestination, create, update, delete. Mutations return read-back receipts.
// The default remains a dry run; a provider must independently verify live outcomes.
export async function syncInventory({ path, snapshot, config, adapter, dryRun = true }) {
  if (dryRun) return { operations: planInventory(readState(path, initialState(config)), snapshot, config), dryRun: true };
  if (!config.liveEnabled || !adapter) throw new Error('Live inventory sync requires an enabled, verified publishing adapter.');
  return withPublisherLock(`${path}.lock`, config, async () => {
    const state = readState(path, initialState(config));
    const operations = planInventory(state, snapshot, config);
    for (const operation of operations) {
      if (operation.action === 'unchanged') {
        Object.assign(state.records[operation.key], { revision: operation.revision, ...recordedSource(operation.item) });
        writeState(path, state);
        continue;
      }
      if (operation.action === 'hold' && ['operator-hold', 'not-public', 'sold-without-post', 'sold-latch'].includes(operation.reason)) {
        const previous = state.records[operation.key] || {};
        state.records[operation.key] = { ...previous, revision: operation.revision, ...recordedSource(operation.item), status: operation.item.status,
          soldLatch: Boolean(previous.soldLatch || previous.status === 'sold' || operation.item.status === 'sold') };
        writeState(path, state);
      }
      if (!['create', 'update', 'delete', 'button'].includes(operation.action)) continue;
      if (typeof adapter[operation.action] !== 'function') throw new Error(`Adapter cannot ${operation.action}.`);
      if (operation.action !== 'delete') await adapter.verifyDestination(operation.item.url, operation.id);
      const previous = state.records[operation.key] || {};
      state.records[operation.key] = { ...previous, pending: { ...operation, ...(adapter.durableSubmissionPhases ? { phase: 'preparing' } : {}) } };
      writeState(path, state);
      try {
        const receipt = await adapter[operation.action]({ ...operation, pageId: config.pageId, previous: previous.receipt, ownedDraftCaption: previous.ownedDraftCaption,
          persistDraft: caption => { state.records[operation.key].ownedDraftCaption = caption; writeState(path, state); },
          markSubmission: () => { state.records[operation.key].pending.phase = 'submitting'; writeState(path, state); },
        });
        applyReceipt(state, operation, receipt, config);
        writeState(path, state);
      } catch (cause) {
        if (cause.beforeSubmission === true) {
          // This adapter never reached Publish. Retain only a draft it verified
          // itself; a retry may replace that exact draft after refreshing CRM.
          state.records[operation.key] = { ...previous, pending: null };
          if (typeof cause.ownedDraftCaption === 'string') state.records[operation.key].ownedDraftCaption = cause.ownedDraftCaption;
          writeState(path, state);
          throw cause;
        }
        // Keep the persisted intent even for a crash or malformed receipt. Never guess whether Meta accepted it.
        throw new Error(`Machine ${operation.id} needs reconciliation; no automatic retry.`, { cause });
      }
    }
    return { operations, dryRun: false };
  });
}

export async function reconcileReceipt({ path, config, receipt, machineId }) {
  return withPublisherLock(`${path}.lock`, config, async () => {
    const state = readState(path, initialState(config));
    checkState(state, config);
    const pending = state.records[`machine:${machineId}`]?.pending;
    if (!pending) throw new Error('No pending operation for this machine.');
    applyReceipt(state, pending, receipt, config);
    writeState(path, state);
  });
}

export async function recoverPreparedIntent({ path, config, machineId }) {
  return withPublisherLock(`${path}.lock`, config, async () => {
    const state = readState(path, initialState(config));
    checkState(state, config);
    const record = state.records[`machine:${machineId}`];
    if (record?.pending?.phase !== 'preparing') throw new Error('Intent may have reached submission.');
    record.pending = null;
    writeState(path, state);
  });
}
