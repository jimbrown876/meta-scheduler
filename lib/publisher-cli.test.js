import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPublisher, loadConfig, safeFailure, summarizePlan } from './publisher-cli.js';
import { initialState } from './inventory.js';
import { PublisherError } from './catalog-source.js';

function setup(t, count = 5) {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-worker-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const config = { stateDirectory: dir, stateFile: join(dir, 'state.json'), profileDir: join(dir, 'browser-profile'), browserExecutable: '/fixture/chrome', tenantId: 'fixture', pageId: '123', pageProfileId: '456', websiteOrigin: 'https://georgiawoodtools.com', availableUrl: 'https://georgiawoodtools.com/', liveEnabled: true };
  const items = Array.from({ length: count }, (_, i) => ({ id: `${100 + i}`, revision: 1, status: 'available', title: 'Fixture', description: 'Fixture', price: '$10', url: `https://georgiawoodtools.com/equipment/${100 + i}/fixture` }));
  const snapshot = { version: 1, source: 'crm', tenantId: 'fixture', items };
  let launches = 0, closed = 0, writes = 0;
  const receipt = op => { writes++; return { pageId: '123', postId: `pfbid${op.id}`, businessContentId: op.id, url: `https://www.facebook.com/permalink.php?story_fbid=pfbid${op.id}&id=456`, action: op.action, operationId: op.operationId, contentHash: op.item.contentHash, verified: true }; };
  const deps = { loadCatalog: async () => snapshot, launch: async () => { launches++; return { setDefaultTimeout() {}, newPage: async () => ({}), close: async () => { closed++; } }; }, adapter: { status: async () => ({ status: 'ready', pageId: '123' }), verifyDestination: async () => {}, create: async op => receipt(op), update: async op => receipt(op) } };
  return { config, deps, snapshot, stats: () => ({ launches, closed, writes }) };
}

test('plan and status perform no inventory mutation; disabled sync cannot launch a browser', async t => {
  const { config, deps, stats } = setup(t);
  assert.equal((await runPublisher('plan', config, deps)).counts.create, 5);
  assert.equal(stats().launches, 0);
  assert.equal((await runPublisher('status', config, deps)).status, 'ready');
  assert.equal(existsSync(config.stateFile), false);
  await assert.rejects(runPublisher('sync', { ...config, liveEnabled: false }, deps), /PUBLISHING_DISABLED/);
  assert.deepEqual(stats(), { launches: 1, closed: 1, writes: 0 });
});

test('bounded runs carry all remaining listings forward and prefer sold updates', async t => {
  const { config, deps, snapshot, stats } = setup(t);
  const first = await runPublisher('sync', config, deps);
  assert.equal(first.verifiedWrites, 3); assert.equal(first.remainingWrites, 2);
  snapshot.items[0] = { ...snapshot.items[0], revision: 2, status: 'sold' };
  const second = await runPublisher('sync', config, deps);
  assert.equal(second.verifiedWrites, 3); assert.equal(second.remainingWrites, 0);
  assert.equal(JSON.parse(readFileSync(config.stateFile)).records['machine:100'].status, 'sold');
  assert.equal((await runPublisher('sync', config, deps)).verifiedWrites, 0);
  assert.equal(stats().writes, 6);
});

test('uncertain output remains blocked even if the source listing disappears', async t => {
  const { config, deps, snapshot, stats } = setup(t, 1);
  deps.adapter.create = async () => { throw new Error('Unknown result'); };
  await assert.rejects(runPublisher('sync', config, deps), /needs reconciliation/);
  snapshot.items = [];
  await assert.rejects(runPublisher('sync', config, deps), /FACEBOOK_RECONCILIATION_REQUIRED/);
  assert.equal(stats().closed, 2);
});

test('login failures close the browser and cannot become successful no-change runs', async t => {
  const { config, deps, stats } = setup(t);
  deps.adapter.status = async () => { throw new PublisherError('FACEBOOK_LOGIN_REQUIRED'); };
  await assert.rejects(runPublisher('sync', config, deps), /FACEBOOK_LOGIN_REQUIRED/);
  assert.equal(existsSync(config.stateFile), false);
  assert.equal(stats().closed, 1);
  assert.equal(safeFailure(new Error('private page content/token here')), 'PUBLISHER_CHECK_FAILED');
});

test('missing published listings are reported for review and not silently marked sold', () => {
  const state = { ...initialState({ tenantId: 'fixture', pageId: '123' }), records: { 'machine:100': { receipt: {}, deleted: false } } };
  assert.equal(summarizePlan([], state, { items: [] }).missingPublished, 1);
});

test('configuration pins Page and tenant identity and requires private runtime paths', t => {
  const { config } = setup(t);
  mkdirSync(config.profileDir, { mode: 0o700 });
  const path = join(config.stateDirectory, 'config.json');
  const raw = { tenantId: '01M41C0XR04Y9DXGAJ9Q52C1E1', stateDirectory: config.stateDirectory, browserExecutable: '/fixture/chrome', pageId: 'evil', liveEnabled: false };
  writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
  assert.equal(loadConfig(path).pageId, '1332515199955989');
  chmodSync(path, 0o644);
  assert.throws(() => loadConfig(path), /CONFIG_NOT_PRIVATE/);
  chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify({ ...raw, tenantId: 'other' }));
  assert.throws(() => loadConfig(path), /CONFIG_INVALID/);
});
