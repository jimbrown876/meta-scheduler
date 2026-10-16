import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { macBridgeSource, dialogBridgeSource } from './desktop-bridge.js';
import { mcpCli } from './desktop-browser.js';

test('the exact pinned bridge receives one local Mac platform correction, idempotently', () => {
  const require = createRequire(mcpCli);
  const path = join(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js');
  const original = readFileSync(path, 'utf8');
  const patched = macBridgeSource(original);
  assert.ok(patched.includes('userAgent: "CDP-Bridge-Server/1.0.0 (Macintosh)"'));
  assert.equal(macBridgeSource(patched), patched);
  assert.throws(() => macBridgeSource(`${original}\n`), /DESKTOP_BRIDGE_VERSION_CHANGED/);
  assert.equal(patched.replace('userAgent: "CDP-Bridge-Server/1.0.0 (Macintosh)"', 'userAgent: "CDP-Bridge-Server/1.0.0"'), original.replace('userAgent: "CDP-Bridge-Server/1.0.0 (Macintosh)"', 'userAgent: "CDP-Bridge-Server/1.0.0"'));
});

test('the pinned dialog bridge exempts only the owned helper unload scope and rejects dependency drift', () => {
  const require = createRequire(mcpCli);
  const path = join(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js');
  const source = readFileSync(path, 'utf8');
  const patched = dialogBridgeSource(source);
  assert.equal(dialogBridgeSource(patched), patched);
  assert.throws(() => dialogBridgeSource(`${source}\n`), /DESKTOP_BRIDGE_VERSION_CHANGED/);
  const body = /      _dialogShown\(dialog\) \{([\s\S]*?)\n      \}\n      _dialogClosed/.exec(patched)[1];
  const shown = new Function('dialog', 'handleDialog', body);
  for (const [scope, type, owner, url, tracked] of [
    [{ owner: 'run', source: 'helper' }, 'beforeunload', 'run', 'helper', 0],
    [undefined, 'beforeunload', 'run', 'helper', 1],
    [{ owner: 'run', source: 'helper' }, 'confirm', 'run', 'helper', 1],
    [{ owner: 'run', source: 'helper' }, 'beforeunload', 'other-run', 'helper', 1],
    [{ owner: 'run', source: 'helper' }, 'beforeunload', 'run', 'another-page', 1],
    [{ owner: undefined, source: 'helper' }, 'beforeunload', undefined, 'helper', 1],
  ]) {
    let modalStates = 0;
    const tab = { page: { gwtDesktopHelperExit: scope, gwtDesktopOwnedTab: owner, url: () => url }, setModalState: () => { modalStates++; } };
    shown.call(tab, { type: () => type, message: () => '' }, { schema: { name: 'browser_handle_dialog' } });
    assert.equal(modalStates, tracked);
  }
});
