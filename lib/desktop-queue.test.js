import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialQueue, transitionQueue, retryDelay, updateQueue } from './desktop-queue.js';
import { runDesktopTick } from './desktop-runner.js';
import { parseToolResult } from './desktop-browser.js';
import { launchAgent } from './desktop-launchagent.js';

const start = 1791162000000, minute = 60000;
const success = { ok: true, mode: 'sync', verifiedWrites: 1, remainingWrites: 0 };
function state(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-desktop-fixture-'));
  t.after(() => rmSync(dir, { recursive: true }));
  return { dir, config: { stateDirectory: dir, workerId: 'fixture-mac', browserMode: 'extension', liveEnabled: true } };
}

test('offline clock ticks retain latest work without accumulating stale posts', () => {
  const q = initialQueue();
  for (let i = 0; i < 96; i++) transitionQueue(q, 'enqueue', {}, start + i * 15 * minute);
  const now = start + 96 * 15 * minute;
  const { job } = transitionQueue(q, 'claim', { worker: 'mac' }, now, () => 'lease-1');
  assert.equal(job.generation, Math.floor((now - 15 * minute) / (15 * minute)));
  assert.equal(transitionQueue(q, 'claim', { worker: 'mac' }, now).job, null);
  transitionQueue(q, 'finish', { worker: 'mac', lease: job.id, result: success }, now);
  assert.equal(q.completed, q.requested);
});

test('retry delay is 1, 5, 15, then 60 minutes; new ticks never reset it', () => {
  const q = initialQueue(); let now = start;
  transitionQueue(q, 'enqueue', {}, now);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const { job } = transitionQueue(q, 'claim', { worker: 'mac' }, now, () => `lease-${attempt}`);
    transitionQueue(q, 'finish', { worker: 'mac', lease: job.id, result: { ok: false, code: 'FACEBOOK_DESKTOP_UNAVAILABLE' } }, now);
    assert.equal(q.nextAttemptAt - now, [1, 5, 15, 60, 60, 60][attempt - 1] * minute);
    const before = q.nextAttemptAt;
    transitionQueue(q, 'enqueue', {}, now + 1000);
    assert.equal(q.nextAttemptAt, before);
    assert.equal(transitionQueue(q, 'claim', { worker: 'mac' }, before - 1).job, null);
    now = before;
  }
  assert.equal(q.blocked, null); assert.equal(q.completed, 0);
});

test('lease fencing prevents a sleeping worker acknowledging another run', () => {
  const q = initialQueue(); transitionQueue(q, 'enqueue', {}, start);
  transitionQueue(q, 'claim', { worker: 'mac' }, start, () => 'old');
  assert.throws(() => transitionQueue(q, 'check', { worker: 'mac', lease: 'old' }, start + 16 * minute), /QUEUE_LEASE_CHANGED/);
  transitionQueue(q, 'claim', { worker: 'mac' }, start + 16 * minute, () => 'new');
  assert.throws(() => transitionQueue(q, 'finish', { worker: 'mac', lease: 'old', result: success }, start + 16 * minute), /QUEUE_LEASE_CHANGED/);
  assert.equal(q.completed, 0); assert.equal(q.lease.id, 'new');
});

test('a tick during a run and a partial batch both preserve pending work', () => {
  const q = initialQueue(); transitionQueue(q, 'enqueue', {}, start);
  const { job } = transitionQueue(q, 'claim', { worker: 'mac' }, start, () => 'first');
  transitionQueue(q, 'enqueue', {}, start + 15 * minute);
  const done = transitionQueue(q, 'finish', { worker: 'mac', lease: job.id, result: success }, start + 15 * minute);
  assert.equal(done.pending, true);
  const next = transitionQueue(q, 'claim', { worker: 'mac' }, start + 16 * minute, () => 'next');
  transitionQueue(q, 'finish', { worker: 'mac', lease: next.job.id, result: { ...success, remainingWrites: 4 } }, start + 16 * minute);
  assert.equal(q.nextAttemptAt, start + 17 * minute); assert.ok(q.requested > q.completed);
});

test('login/challenges pause and notify once, never become automatic credential attempts', () => {
  const q = initialQueue(); transitionQueue(q, 'enqueue', {}, start);
  transitionQueue(q, 'claim', { worker: 'mac' }, start, () => 'first');
  transitionQueue(q, 'finish', { worker: 'mac', lease: 'first', result: { ok: false, code: 'FACEBOOK_VERIFICATION_REQUIRED' } }, start);
  assert.equal(transitionQueue(q, 'enqueue', {}, start + minute).notifyCode, 'FACEBOOK_VERIFICATION_REQUIRED');
  assert.equal(transitionQueue(q, 'enqueue', {}, start + 2 * minute).notifyCode, null);
  assert.equal(transitionQueue(q, 'claim', { worker: 'mac' }, start + 100 * minute).job, null);
  transitionQueue(q, 'resume', { worker: 'mac' }, start + 101 * minute);
  assert.ok(transitionQueue(q, 'claim', { worker: 'mac' }, start + 101 * minute).job);
});

test('delayed readback retains work, retries and alerts once without permitting a second publish', () => {
  const q = initialQueue(); let now = start;
  transitionQueue(q, 'enqueue', {}, now);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { job } = transitionQueue(q, 'claim', { worker: 'mac' }, now, () => `readback-${attempt}`);
    transitionQueue(q, 'finish', { worker: 'mac', lease: job.id, result: { ok: false, code: 'FACEBOOK_READBACK_PENDING' } }, now);
    assert.equal(q.blocked, null); assert.equal(q.completed, 0);
    now = q.nextAttemptAt;
  }
  assert.equal(transitionQueue(q, 'enqueue', {}, now).notifyCode, 'FACEBOOK_READBACK_PENDING');
  assert.equal(transitionQueue(q, 'enqueue', {}, now).notifyCode, null);
  assert.ok(transitionQueue(q, 'claim', { worker: 'mac' }, now).job);
});

test('corrupt persisted queue and malformed success cannot discard work', async t => {
  const { dir } = state(t), path = join(dir, 'queue.json');
  writeFileSync(path, '{broken');
  await assert.rejects(updateQueue(path, 'enqueue'), SyntaxError);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  const q = initialQueue(); transitionQueue(q, 'enqueue', {}, start); transitionQueue(q, 'claim', { worker: 'mac' }, start, () => 'x');
  assert.throws(() => transitionQueue(q, 'finish', { worker: 'mac', lease: 'x', result: { ok: true } }, start), /QUEUE_RESULT_INVALID/);
  assert.equal(q.completed, 0); assert.equal(q.lease.id, 'x');
});

test('offline Mac preserves local retry state across restart and never opens Chrome', async t => {
  const { config } = state(t); let now = start, calls = 0;
  const deps = { now: () => now, remote: async () => { calls++; throw new Error('DESKTOP_OFFLINE'); }, browser: async () => { throw new Error('must not open'); } };
  let result = await runDesktopTick('/fixture', config, deps);
  assert.equal(result.nextAttemptAt, now + minute);
  now += 30000; assert.equal((await runDesktopTick('/fixture', config, deps)).status, 'waiting'); assert.equal(calls, 1);
  now += 30000; result = await runDesktopTick('/fixture', config, deps);
  assert.equal(result.nextAttemptAt, now + 5 * minute); assert.equal(calls, 2);
});

test('lost completion acknowledgement retries the acknowledgement without reposting', async t => {
  const { config, dir } = state(t); let now = start, writes = 0, finish = 0, claims = 0;
  const deps = { now: () => now, browser: async () => { writes++; return success; }, remote: async action => {
    if (action === 'claim') return ++claims === 1 ? { job: { id: 'lease', worker: config.workerId } } : { job: null };
    if (++finish === 1) throw new Error('DESKTOP_OFFLINE');
    return { nextAttemptAt: 0 };
  } };
  assert.equal((await runDesktopTick('/fixture', config, deps)).status, 'retrying');
  assert.ok(JSON.parse(readFileSync(join(dir, 'desktop-runner.json'))).outbox);
  now += minute; await runDesktopTick('/fixture', config, deps);
  assert.equal(writes, 1); assert.equal(finish, 2); assert.equal(JSON.parse(readFileSync(join(dir, 'desktop-runner.json'))).outbox, null);
});

test('invalid browser outcome is reported as blocked instead of false completion', async t => {
  const { config } = state(t); let received;
  await runDesktopTick('/fixture', config, { now: () => start, browser: async () => ({ ok: true }), remote: async (action, data) => {
    if (action === 'claim') return { job: { id: 'x', worker: config.workerId } };
    received = data.result; return { blocked: data.result.code };
  } });
  assert.deepEqual(received, { ok: false, code: 'DESKTOP_RESULT_INVALID' });
});

test('MCP parser rejects echoed code, duplicate results and failures', () => {
  assert.deepEqual(parseToolResult({ content: [{ type: 'text', text: '### Result\n{\n "version":1,\n "result":{"ok":true}\n}\n### Ran Playwright code\n...' }] }), { ok: true });
  for (const response of [
    { content: [{ type: 'text', text: '### Ran Playwright code\nreturn {ok:true};' }] },
    { isError: true, content: [{ type: 'text', text: '### Result\n{"version":1,"result":{"ok":true}}' }] },
    { content: [{ type: 'text', text: '### Result\n{}\n### Result\n{}' }] },
  ]) assert.throws(() => parseToolResult(response));
});

test('LaunchAgent runs once per minute on login without a KeepAlive loop', () => {
  const xml = launchAgent({ node: '/opt/node', releaseDirectory: '/Users/Jim/Release & Test', configPath: '/Users/Jim/private.json', stateDirectory: '/Users/Jim/state' });
  assert.match(xml, /StartInterval<\/key><integer>60/); assert.match(xml, /RunAtLoad<\/key><true/); assert.match(xml, /Release &amp; Test/); assert.doesNotMatch(xml, /KeepAlive|Password|TOKEN/);
  assert.equal(retryDelay(100), 60 * minute);
});
