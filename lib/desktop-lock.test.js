import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAdvisoryLock } from './desktop-lock.js';

test('OS lock excludes concurrent work and recovers after a killed owner without deleting its inode', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gwt-lock-fixture-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'process.lock');
  const moduleUrl = new URL('./desktop-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withAdvisoryLock} from ${JSON.stringify(moduleUrl)}; await withAdvisoryLock(${JSON.stringify(path)}, async()=>{process.stdout.write('READY'); await new Promise(()=>{});});`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  child.stderr.resume();
  assert.equal((await once(child.stdout, 'data'))[0].toString(), 'READY');
  const inode = statSync(path).ino;
  await assert.rejects(withAdvisoryLock(path, () => assert.fail('must remain excluded')), /Runner lock exists/);
  const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  let obtained = false;
  for (let i = 0; i < 20 && !obtained; i++) {
    try { await withAdvisoryLock(path, () => { obtained = true; }); }
    catch (error) { if (!/Runner lock exists/.test(error.message)) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(obtained, true);
  assert.equal(statSync(path).ino, inode);
});
