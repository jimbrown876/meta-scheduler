import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canaryIdentity, canarySnapshot, runDesktopCanary } from './desktop-canary.js';
import { initialState, normalizeSnapshot } from './inventory.js';
import { readState, writeState } from './durable-state.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-canary-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const config = { tenantId: 'fixture', pageId: '123', pageProfileId: '456', pageName: 'Georgia Wood Tools', browserMode: 'extension', liveEnabled: false, canaryEnabled: true, stateDirectory: dir, stateFile: join(dir, 'inventory-posts.json'), websiteOrigin: 'https://georgiawoodtools.com', availableUrl: 'https://georgiawoodtools.com/' };
  const machine = { id: canaryIdentity.machineId, url: `https://georgiawoodtools.com/equipment/${canaryIdentity.machineId}/jet-20-thickness-planer`, title: 'Actual Jet planer', description: 'Current effective CRM copy', price: '$2,200', revision: 42, status: 'available' };
  const catalog = { version: 1, source: 'crm', tenantId: 'fixture', items: [machine, { ...machine, id: 'other', url: 'https://georgiawoodtools.com/equipment/other/other' }] };
  const original = structuredClone(catalog);
  const caption = `TEMPORARY AUTOMATION TEST — ${canaryIdentity.marker}\nSOLD STATUS TEST ONLY — not an actual sale.\n${machine.url}#inquire`;
  const heading = { innerText: async () => caption };
  const page = { setDefaultTimeout() {}, getByRole: () => ({ ...heading, getByRole: () => heading }) };
  const writes = [];
  const receipt = op => ({ pageId: '123', postId: 'pfbidCanary', businessContentId: canaryIdentity.contentId, url: 'https://www.facebook.com/permalink.php?story_fbid=pfbidCanary&id=456', verified: true, action: op.action, operationId: op.operationId, contentHash: op.item.contentHash });
  const deps = { loadCatalog: async () => catalog, adapterFactory: (cfg, source) => ({
    route: () => '', go: async () => {}, readbackRoot: async () => ({ getByRole: () => heading }), receipt: async op => receipt(op), status: async () => ({ status: 'ready', pageId: '123' }),
    verifyDestination: async (url, id) => { assert.equal(id, machine.id); assert.equal(url, machine.url); },
    create: async () => { throw new Error('Canary must reuse the exact existing test post'); },
    update: async op => {
      const current = normalizeSnapshot(await source(cfg), cfg).find(item => item.id === op.id);
      assert.equal(current.contentHash, op.item.contentHash);
      assert.equal(op.previous.businessContentId, canaryIdentity.contentId);
      writes.push({ status: op.item.status, caption: op.item.caption });
      return receipt(op);
    },
  }) };
  return { config, catalog, original, page, deps, writes, machine };
}

test('live canary edits only its existing labelled post, checks no-change, then restores fresh CRM copy', async t => {
  const f = fixture(t);
  const result = await runDesktopCanary(f.page, f.config, f.deps);
  assert.equal(result.restored, true);
  assert.equal(result.noChangeWrites, 0);
  assert.deepEqual(result.stages.map(x => x.phase), [1, 2, 3]);
  assert.deepEqual(f.writes.map(x => x.status), ['available', 'available', 'sold', 'available']);
  for (const operation of f.writes.slice(0, 3)) assert.match(operation.caption, /TEST ONLY — not an equipment offer or an actual sale/);
  assert.match(f.writes[3].caption, /Actual Jet planer/);
  const state = readState(f.config.stateFile, null);
  assert.deepEqual(Object.keys(state.records), [`machine:${f.machine.id}`]);
  assert.equal(state.records[`machine:${f.machine.id}`].soldLatch, false);
  assert.equal(state.records[`machine:${f.machine.id}`].revision, 42);
  assert.deepEqual(f.catalog, f.original);
  assert.equal(f.config.liveEnabled, false);
  assert.equal((await runDesktopCanary(f.page, f.config, f.deps)).restored, true);
  assert.equal(f.writes.length, 4);
});

test('canary requires an explicit separate opt-in and general publishing disabled', async t => {
  const f = fixture(t);
  await assert.rejects(runDesktopCanary(f.page, { ...f.config, canaryEnabled: false }, f.deps), /CONFIG_CANARY_DISABLED/);
  await assert.rejects(runDesktopCanary(f.page, { ...f.config, liveEnabled: true }, f.deps), /CONFIG_CANARY_DISABLED/);
  assert.equal(f.writes.length, 0);
});

test('canary cannot overwrite an existing unrelated production receipt', async t => {
  const f = fixture(t);
  const state = initialState(f.config);
  state.records[`machine:${f.machine.id}`] = { receipt: { businessContentId: '999' } };
  writeState(f.config.stateFile, state);
  await assert.rejects(runDesktopCanary(f.page, f.config, f.deps), /STATE_CANARY_ADOPTION_CONFLICT/);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(readState(f.config.stateFile, null), state);
});

test('canary input cannot choose another machine or silently mutate the source catalog', async t => {
  const f = fixture(t);
  assert.throws(() => canarySnapshot(f.catalog, 4), /CONFIG_CANARY_INVALID/);
  assert.throws(() => canarySnapshot({ ...f.catalog, items: [] }, 1), /CATALOG_CANARY_MISSING/);
  assert.equal(canarySnapshot(f.catalog, 3).items[0].status, 'sold');
  assert.deepEqual(f.catalog, f.original);
});

test('a submitted second phase resumes at that phase, reconciles once, and never regresses to phase one', async t => {
  const f = fixture(t);
  const factory = f.deps.adapterFactory;
  let delayedReceipt;
  f.deps.adapterFactory = (cfg, source) => {
    const adapter = factory(cfg, source);
    const update = adapter.update;
    adapter.update = async operation => {
      const receipt = await update(operation);
      if (operation.revision === 2 && !delayedReceipt) {
        delayedReceipt = receipt;
        throw new Error('Fixture connection lost after submission');
      }
      return receipt;
    };
    adapter.reconcilePending = async operation => {
      assert.equal(operation.revision, 2);
      assert.equal(operation.item.contentHash, delayedReceipt.contentHash);
      return delayedReceipt;
    };
    return adapter;
  };
  await assert.rejects(runDesktopCanary(f.page, f.config, f.deps), /needs reconciliation/);
  const result = await runDesktopCanary(f.page, f.config, f.deps);
  assert.equal(result.restored, true);
  assert.equal(result.stages.find(stage => stage.phase === 2).verifiedWrites, 0);
  assert.deepEqual(f.writes.map(write => write.status), ['available', 'available', 'sold', 'available']);
});
