import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { macBridgeSource } from './desktop-bridge.js';
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
