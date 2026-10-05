import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCatalog, fail } from './catalog-source.js';
import { initialState } from './inventory.js';
import { readState, writeState } from './durable-state.js';
import { MetaPageAdapter } from './meta-page-adapter.js';
import { runPublisher } from './publisher-cli.js';
import { withPublisherLock } from './desktop-lock.js';

// A single pre-existing, explicitly labelled test post. This cannot select a
// customer post or write a simulated availability status back to the CRM.
export const canaryIdentity = Object.freeze({ machineId: '1305265591590002', contentId: '122102629941496386', marker: 'GWT-SYNC-TEST-20261004-01' });

export function canarySnapshot(catalog, phase) {
  if (![1, 2, 3].includes(phase)) fail('CONFIG_CANARY_INVALID');
  const source = catalog.items.find(item => item.id === canaryIdentity.machineId);
  if (!source) fail('CATALOG_CANARY_MISSING');
  return { ...catalog, items: [{ id: source.id, url: source.url, revision: phase, status: phase === 3 ? 'sold' : 'available', price: '',
    previewTitle: source.title,
    title: `TEMPORARY AUTOMATION TEST — ${canaryIdentity.marker}`,
    description: `TEST ONLY — not an equipment offer or an actual sale. The machine's real CRM availability is unchanged. Desktop worker phase ${phase}: ${phase === 1 ? 'caption update' : phase === 2 ? 'second edit' : 'simulated sold update'}. This post will return to the current CRM listing after verification.`,
  }] };
}

export async function runDesktopCanary(page, config, deps = {}) {
  if (config.canaryEnabled !== true || config.liveEnabled || config.browserMode !== 'extension') fail('CONFIG_CANARY_DISABLED');
  page.setDefaultTimeout(15000);
  const load = deps.loadCatalog || loadCatalog;
  const run = deps.runPublisher || runPublisher;
  const adapterFactory = deps.adapterFactory || ((cfg, source) => new MetaPageAdapter(page, cfg, { loadCatalog: source }));
  const launch = async () => ({ setDefaultTimeout: value => page.setDefaultTimeout(value), newPage: async () => page, close: async () => {} });
  return withPublisherLock(join(config.stateDirectory, 'desktop-canary.lock'), config, async () => {
    const dir = join(config.stateDirectory, 'canary');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const proofPath = join(dir, 'proof.json');
    const proof = readState(proofPath, { version: 1, stages: [], restored: false });
    if (proof.version !== 1 || !Array.isArray(proof.stages)) fail('STATE_CANARY_INVALID');
    if (proof.restored) return { ok: true, mode: 'canary', ...proof };
    const catalog = await load(config);
    const scoped = { ...config, stateDirectory: dir, stateFile: join(dir, 'inventory-posts.json'), liveEnabled: true };
    let state = readState(scoped.stateFile, initialState(config));
    const key = `machine:${canaryIdentity.machineId}`;
    const productionBefore = readState(config.stateFile, initialState(config)).records[key];
    if (productionBefore && productionBefore.receipt?.businessContentId !== canaryIdentity.contentId) fail('STATE_CANARY_ADOPTION_CONFLICT');
    if (!state.records[key]?.receipt) {
      const adapter = adapterFactory(scoped, () => catalog);
      await adapter.go(adapter.route('insights/object_insights', { content_id: canaryIdentity.contentId }), page.getByRole('link', { name: 'View post on Facebook', exact: true }));
      const caption = await (await adapter.readbackRoot()).getByRole('heading', { level: 3, name: new RegExp(canaryIdentity.marker) }).innerText();
      const machine = catalog.items.find(item => item.id === canaryIdentity.machineId);
      if (!machine || !caption.includes(canaryIdentity.marker) || !caption.includes('TEMPORARY AUTOMATION TEST') || !caption.includes('not an actual sale') || !caption.includes(`${machine.url}#inquire`)) fail('FACEBOOK_CANARY_BASELINE_MISMATCH');
      const operation = { action: 'update', operationId: 'canary-baseline', item: { title: machine.title, url: machine.url, caption, contentHash: createHash('sha256').update(caption).digest('hex') } };
      const receipt = await adapter.receipt(operation, canaryIdentity.contentId);
      state.records[key] = { revision: 0, sourceHash: '', contentHash: '', status: 'available', receipt, pending: null, soldLatch: false };
      writeState(scoped.stateFile, state);
    }
    for (let phase = 1; phase <= 3; phase++) {
      state = readState(scoped.stateFile, initialState(config));
      if (state.records[key].revision >= phase) continue;
      const fixture = canarySnapshot(catalog, phase);
      const result = await run('sync', scoped, { launch, loadCatalog: async () => fixture, adapter: adapterFactory(scoped, async () => fixture) });
      state = readState(scoped.stateFile, initialState(config));
      if (!result.ok || state.records[key]?.revision !== phase || state.records[key]?.receipt?.businessContentId !== canaryIdentity.contentId || state.records[key]?.pending) fail('FACEBOOK_CANARY_NOT_CONFIRMED');
      proof.stages.push({ phase, verifiedWrites: result.verifiedWrites, postId: state.records[key].receipt.postId });
      writeState(proofPath, proof);
    }
    const sold = canarySnapshot(catalog, 3);
    const repeat = await run('sync', scoped, { launch, loadCatalog: async () => sold, adapter: adapterFactory(scoped, async () => sold) });
    if (repeat.verifiedWrites !== 0) fail('FACEBOOK_CANARY_DUPLICATE');
    proof.noChangeWrites = 0;
    // The test's simulated sold latch belongs only to its separate journal.
    // Adoption into the production journal is one-time and cannot overwrite a
    // real publication record. The ordinary adapter then restores fresh CRM copy.
    await withPublisherLock(`${config.stateFile}.lock`, config, async () => {
      const production = readState(config.stateFile, initialState(config));
      const existing = production.records[key];
      const receipt = readState(scoped.stateFile, initialState(config)).records[key].receipt;
      if (existing && existing.receipt?.businessContentId !== canaryIdentity.contentId) fail('STATE_CANARY_ADOPTION_CONFLICT');
      if (!existing) {
        production.records[key] = { revision: 0, sourceHash: '', contentHash: '', status: 'available', receipt, pending: null, soldLatch: false };
        writeState(config.stateFile, production);
      }
    });
    const live = { ...config, liveEnabled: true };
    const current = async () => { const fresh = await load(config); return { ...fresh, items: fresh.items.filter(item => item.id === canaryIdentity.machineId) }; };
    const restoration = await run('sync', live, { launch, loadCatalog: current, adapter: adapterFactory(live, load) });
    const restored = readState(config.stateFile, initialState(config)).records[key];
    const fresh = (await current()).items[0];
    if (!fresh || restored.pending || restored.status !== fresh.status || restored.receipt?.businessContentId !== canaryIdentity.contentId || !restoration.ok) fail('FACEBOOK_CANARY_RESTORE_PENDING');
    proof.restored = true; proof.realStatus = restored.status; proof.url = restored.receipt.url; proof.completedAt = new Date().toISOString();
    writeState(proofPath, proof);
    return { ok: true, mode: 'canary', ...proof };
  });
}
