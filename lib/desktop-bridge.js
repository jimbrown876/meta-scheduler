import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const originalHash = 'cd6730be1bbcff00771a0fc1390f200306d28428ce68e305420ca623cb39cdeb';
const patchedHash = '7c60af70908b148ab6a61f5174c0c7653cc8200f5f363bb8d89c9194c4afa6b6';
const dialogPatchedHash = 'a4ac440aba9e34cb6a940d6e55900d849e5b11c5e3d7a8f658947b7e58458424';
const combinedHash = 'fef8ac847b0a79e4f2c9b5b8ccd4009728e77b40f194fc6efa2b57d4ea6f1188';
const hash = text => createHash('sha256').update(text).digest('hex');

export function macBridgeSource(source) {
  const current = hash(source);
  if ([patchedHash, combinedHash].includes(current)) return source;
  if (![originalHash, dialogPatchedHash].includes(current)) throw new Error('DESKTOP_BRIDGE_VERSION_CHANGED');
  // @playwright/mcp 0.0.83's bridge reports a generic platform to its local
  // Playwright client, causing Mac editing keys to be interpreted as Linux.
  // Correct only that local protocol response. This does not alter the web
  // browser's user agent, fingerprint, authentication or extension permissions.
  const patched = source.replace('userAgent: "CDP-Bridge-Server/1.0.0"', 'userAgent: "CDP-Bridge-Server/1.0.0 (Macintosh)"');
  if (hash(patched) !== (current === dialogPatchedHash ? combinedHash : patchedHash)) throw new Error('DESKTOP_BRIDGE_VERSION_CHANGED');
  return patched;
}

export function dialogBridgeSource(source) {
  const current = hash(source);
  if ([dialogPatchedHash, combinedHash].includes(current)) return source;
  if (![originalHash, patchedHash].includes(current)) throw new Error('DESKTOP_BRIDGE_VERSION_CHANGED');
  // The pinned MCP reports a modal before the Page's own handler runs, which
  // prematurely ends a running tool. Only the verified helper-exit scope on
  // this worker's owned Page bypasses tracking;
  // the publisher's narrow handler still accepts the physical unload prompt.
  const patched = source.replace('      _dialogShown(dialog) {\n        this.setModalState({', '      _dialogShown(dialog) {\n        const expected = this.page.gwtDesktopHelperExit;\n        if (dialog.type() === "beforeunload" && expected && typeof expected.owner === "string" && expected.owner && expected.owner === this.page.gwtDesktopOwnedTab && expected.source === this.page.url())\n          return;\n        this.setModalState({');
  if (hash(patched) !== (current === patchedHash ? combinedHash : dialogPatchedHash)) throw new Error('DESKTOP_BRIDGE_VERSION_CHANGED');
  return patched;
}

function patchOwnedFile(path, transform) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('DESKTOP_BRIDGE_NOT_OWNED');
  const source = readFileSync(path, 'utf8');
  const patched = transform(source);
  if (patched === source) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, patched, { mode: stat.mode & 0o777, flag: 'wx' });
  renameSync(temporary, path);
}

export function ensureDesktopBridge(mcpCli, platform = process.platform) {
  const localRequire = createRequire(mcpCli);
  const packagePath = localRequire.resolve('playwright-core/package.json');
  patchOwnedFile(join(dirname(packagePath), 'lib/coreBundle.js'), source => {
    const dialogSource = dialogBridgeSource(source);
    return platform === 'darwin' ? macBridgeSource(dialogSource) : dialogSource;
  });
}
