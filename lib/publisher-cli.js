import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { gwtConfig } from './gwt-config.js';
import { loadCatalog, fail } from './catalog-source.js';
import { initialState, planInventory, syncInventory, reconcileReceipt, recoverPreparedIntent } from './inventory.js';
import { readState } from './durable-state.js';
import { MetaPageAdapter } from './meta-page-adapter.js';
import { withPublisherLock } from './desktop-lock.js';
import { connectionLost } from './desktop-errors.js';

export function loadConfig(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || ![0, process.getuid()].includes(st.uid)) fail('CONFIG_NOT_PRIVATE');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const config = { ...raw, ...gwtConfig, liveEnabled: raw.liveEnabled === true, businessId: '971586039238770', crmOrigin: 'https://login.jimdoes.it' };
  if (config.tenantId !== '01M41C0XR04Y9DXGAJ9Q52C1E1' || !config.stateDirectory?.startsWith('/')) fail('CONFIG_INVALID');
  if (raw.browserMode !== undefined && !['persistent', 'extension'].includes(raw.browserMode)) fail('CONFIG_INVALID');
  if (raw.browserMode !== 'extension' && !config.browserExecutable?.startsWith('/')) fail('CONFIG_INVALID');
  const state = lstatSync(config.stateDirectory);
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) || state.uid !== process.getuid()) fail('STATE_NOT_PRIVATE');
  config.stateDirectory = realpathSync(config.stateDirectory);
  config.profileDir = join(config.stateDirectory, 'browser-profile');
  if (raw.browserMode !== 'extension') {
    const profile = lstatSync(config.profileDir);
    if (!profile.isDirectory() || profile.isSymbolicLink() || (profile.mode & 0o077) || profile.uid !== process.getuid()) fail('PROFILE_NOT_PRIVATE');
  }
  config.stateFile = join(config.stateDirectory, 'inventory-posts.json');
  return config;
}

export function summarizePlan(operations, state, snapshot) {
  const counts = { create: 0, update: 0, delete: 0, unchanged: 0, hold: 0 };
  const reasons = {};
  for (const op of operations) { counts[op.action]++; if (op.reason) reasons[op.reason] = (reasons[op.reason] || 0) + 1; }
  const seen = new Set(snapshot.items.map(x => `machine:${x.id}`));
  const missingPublished = Object.entries(state.records).filter(([k, v]) => !seen.has(k) && v.receipt && !v.deleted).length;
  return { counts, reasons, missingPublished, catalogCount: snapshot.items.length };
}

export async function runPublisher(mode, config, deps = {}) {
  if (!['plan', 'status', 'sync'].includes(mode)) fail('MODE_INVALID');
  if (mode === 'sync' && !config.liveEnabled) fail('PUBLISHING_DISABLED');
  if (config.browserMode === 'extension' && mode !== 'plan' && !deps.launch) fail('FACEBOOK_DESKTOP_CONNECTION_REQUIRED');
  const load = deps.loadCatalog || loadCatalog;
  if (mode === 'plan') {
    const snapshot = await load(config);
    const state = readState(config.stateFile, initialState(config));
    return { ok: true, mode, publishingEnabled: config.liveEnabled, ...summarizePlan(planInventory(state, snapshot, config), state, snapshot) };
  }
  return withPublisherLock(join(config.stateDirectory, 'publisher-run.lock'), config, async () => {
    const context = await (deps.launch || chromium.launchPersistentContext.bind(chromium))(config.profileDir, {
      executablePath: config.browserExecutable, headless: true, viewport: { width: 1440, height: 1000 }, timeout: 30000,
    });
    try {
      context.setDefaultTimeout(15000);
      const page = await context.newPage();
      const adapter = deps.adapter || new MetaPageAdapter(page, config, { verifyLease: deps.verifyLease });
      const session = await adapter.status();
      if (mode === 'status') return { ok: true, mode, publishingEnabled: config.liveEnabled, ...session };
      const snapshot = await load(config);
      let state = readState(config.stateFile, initialState(config));
      if (config.browserMode === 'extension') {
        for (const record of Object.values(state.records).filter(x => x.pending)) {
          if (record.pending.phase === 'preparing') {
            await recoverPreparedIntent({ path: config.stateFile, config, machineId: record.pending.id });
            continue;
          }
          if (typeof adapter.reconcilePending !== 'function') fail('FACEBOOK_RECONCILIATION_REQUIRED');
          let receipt;
          try { receipt = await adapter.reconcilePending(record.pending, record.receipt); }
          catch (error) {
            if (connectionLost(error) || ['FACEBOOK_LOGIN_REQUIRED', 'FACEBOOK_VERIFICATION_REQUIRED', 'FACEBOOK_ACCESS_RESTRICTED', 'FACEBOOK_READBACK_PENDING'].includes(error.code)) throw error;
            const blocked = new Error('FACEBOOK_RECONCILIATION_REQUIRED', { cause: error });
            blocked.code = 'FACEBOOK_RECONCILIATION_REQUIRED';
            throw blocked;
          }
          await reconcileReceipt({ path: config.stateFile, config, receipt, machineId: record.pending.id });
        }
        state = readState(config.stateFile, initialState(config));
      }
      const operations = planInventory(state, snapshot, config);
      if (operations.some(x => x.reason === 'uncertain-outcome') || Object.values(state.records).some(x => x.pending)) fail('FACEBOOK_RECONCILIATION_REQUIRED');
      if (operations.some(x => ['stale-revision', 'revision-conflict'].includes(x.reason))) fail('CATALOG_REVISION_CONFLICT');
      const plan = summarizePlan(operations, state, snapshot);
      // Preserve unprocessed work in the next fresh catalog; no volume-based discard.
      const selected = new Set(operations.filter(x => ['create', 'update'].includes(x.action)).sort((a, b) => Number(b.action === 'update') - Number(a.action === 'update')).slice(0, 3).map(x => x.id));
      const batch = { ...snapshot, items: snapshot.items.filter(x => selected.has(x.id) || !operations.some(op => op.id === x.id && ['create', 'update'].includes(op.action))) };
      const result = await syncInventory({ path: config.stateFile, snapshot: batch, config, adapter, dryRun: false });
      return { ok: true, mode, ...plan, verifiedWrites: result.operations.filter(x => ['create', 'update', 'delete'].includes(x.action)).length, remainingWrites: Math.max(0, plan.counts.create + plan.counts.update - selected.size) };
    } finally { await context.close(); }
  });
}

export function safeFailure(error) {
  const code = error?.code;
  if (typeof code === 'string' && /^(FACEBOOK_|CATALOG_|SITEMAP_|MACHINE_|INQUIRY_|CONFIG_|STATE_|PROFILE_|PUBLISHING_|MODE_)[A-Z_]+$/.test(code)) return code;
  if (/Runner lock exists|ProcessSingleton|SingletonLock/.test(error?.message || '')) return 'FACEBOOK_BROWSER_BUSY';
  if (/needs reconciliation/.test(error?.message || '')) return 'FACEBOOK_RECONCILIATION_REQUIRED';
  return 'PUBLISHER_CHECK_FAILED';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[1] !== '--config') fail('CONFIG_INVALID');
    const result = await runPublisher(args[0], loadConfig(args[2]));
    process.stdout.write(JSON.stringify({ ...result, observedAt: new Date().toISOString() }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: safeFailure(error), observedAt: new Date().toISOString() }) + '\n');
    process.exitCode = 1;
  }
}
