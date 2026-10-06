import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const originalHash = 'cd6730be1bbcff00771a0fc1390f200306d28428ce68e305420ca623cb39cdeb';
const patchedHash = '7c60af70908b148ab6a61f5174c0c7653cc8200f5f363bb8d89c9194c4afa6b6';
const hash = text => createHash('sha256').update(text).digest('hex');

export function macBridgeSource(source) {
  const current = hash(source);
  if (current === patchedHash) return source;
  if (current !== originalHash) throw new Error('DESKTOP_BRIDGE_VERSION_CHANGED');
  // @playwright/mcp 0.0.83's bridge reports a generic platform to its local
  // Playwright client, causing Mac editing keys to be interpreted as Linux.
  // Correct only that local protocol response. This does not alter the web
  // browser's user agent, fingerprint, authentication or extension permissions.
  const patched = source.replace('userAgent: "CDP-Bridge-Server/1.0.0"', 'userAgent: "CDP-Bridge-Server/1.0.0 (Macintosh)"');
  if (hash(patched) !== patchedHash) throw new Error('DESKTOP_BRIDGE_VERSION_CHANGED');
  return patched;
}

export function ensureDesktopBridge(mcpCli, platform = process.platform) {
  if (platform !== 'darwin') return;
  const localRequire = createRequire(mcpCli);
  const packagePath = localRequire.resolve('playwright-core/package.json');
  const path = join(dirname(packagePath), 'lib/coreBundle.js');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('DESKTOP_BRIDGE_NOT_OWNED');
  const source = readFileSync(path, 'utf8');
  const patched = macBridgeSource(source);
  if (patched === source) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, patched, { mode: stat.mode & 0o777, flag: 'wx' });
  renameSync(temporary, path);
}
