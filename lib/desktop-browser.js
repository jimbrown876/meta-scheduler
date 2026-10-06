import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureDesktopBridge } from './desktop-bridge.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const mcpCli = join(root, 'node_modules/@playwright/mcp/cli.js');
const hook = join(root, 'lib/desktop-init.cjs');

export function ownedTabSetup(owned) {
  return `async page => { if (page.url() !== 'about:blank' || typeof page.runGwtDesktop !== 'function') throw new Error('DESKTOP_TAB_NOT_OWNED'); Object.defineProperty(page, 'gwtDesktopOwnedTab', {value:${JSON.stringify(owned)}}); return {version:1,result:{ok:true}}; }`;
}

export function ownedTabClose(owned) {
  // The current tab can change after a popup. Match the per-run ownership
  // marker instead of closing whatever MCP currently has selected. Unmarked
  // blank tabs are never assumed to belong to this worker.
  return `async page => {
    const context = page.context();
    const isOwned = candidate => candidate.gwtDesktopOwnedTab === ${JSON.stringify(owned)};
    const owned = context.pages().filter(isOwned);
    if (!owned.length) throw new Error('DESKTOP_TAB_NOT_OWNED');
    for (const tab of owned) {
      await tab.close({runBeforeUnload:false});
      if (!tab.isClosed()) throw new Error('DESKTOP_TAB_CLEANUP_FAILED');
    }
    if (context.pages().some(isOwned)) throw new Error('DESKTOP_TAB_CLEANUP_FAILED');
    return {version:1,result:{ok:true,closed:owned.length,remaining:0}};
  }`;
}

export async function closeOwnedTab(call, owned) {
  const result = parseToolResult(await call(ownedTabClose(owned), 10000));
  if (!result.ok || !Number.isInteger(result.closed) || result.closed < 1 || result.remaining !== 0) throw new Error('DESKTOP_TAB_CLEANUP_FAILED');
  // Do not call browser_tabs/list here: MCP creates a new blank tab when the
  // last tab was closed. The close operation itself supplies the readback.
  return result;
}

export function parseToolResult(response) {
  if (response?.isError || !Array.isArray(response?.content)) throw new Error('FACEBOOK_DESKTOP_UNAVAILABLE');
  const results = response.content.filter(x => x.type === 'text').flatMap(x => [...x.text.matchAll(/(?:^|\n)### Result\r?\n([\s\S]*?)(?=\r?\n### |$)/g)]);
  if (results.length !== 1) throw new Error('DESKTOP_RESULT_INVALID');
  let envelope;
  try { envelope = JSON.parse(results[0][1]); } catch { throw new Error('DESKTOP_RESULT_INVALID'); }
  if (envelope?.version !== 1 || !envelope.result || typeof envelope.result.ok !== 'boolean') throw new Error('DESKTOP_RESULT_INVALID');
  return envelope.result;
}

export function readExtensionToken(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('DESKTOP_CONNECTION_NOT_CONFIGURED');
  let st;
  try { st = lstatSync(path); } catch { throw new Error('DESKTOP_CONNECTION_NOT_CONFIGURED'); }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('DESKTOP_TOKEN_NOT_PRIVATE');
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(token)) throw new Error('DESKTOP_CONNECTION_NOT_CONFIGURED');
  return token;
}

export async function runDesktopBrowser(mode, configPath, config, lease = null) {
  if (!['status', 'sync', 'canary'].includes(mode) || !/^(Default|Profile \d+)$/.test(config.chromeProfileDirectory || '')) throw new Error('DESKTOP_CONFIG_INVALID');
  const token = readExtensionToken(config.extensionTokenFile);
  ensureDesktopBridge(mcpCli);
  const client = new Client({ name: 'Georgia Wood Tools Publisher', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpCli, '--extension', '--profile-dir-name', config.chromeProfileDirectory, '--init-page', hook, '--no-webmcp', '--snapshot-mode', 'none', '--image-responses', 'omit'],
    cwd: root,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR || '/tmp', PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, GWT_DESKTOP_CONFIG: configPath, GWT_DESKTOP_LEASE: JSON.stringify(lease) },
    stderr: 'pipe',
  });
  // Never retain connection URLs, authentication material, or page diagnostics.
  transport.stderr?.resume();
  const owned = randomUUID();
  let created = false;
  let result;
  const call = (code, timeout = 60000) => client.callTool({ name: 'browser_run_code_unsafe', arguments: { code } }, undefined, { timeout, maxTotalTimeout: timeout });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(x => x.name);
    if (!names.includes('browser_tabs') || !names.includes('browser_run_code_unsafe')) throw new Error('DESKTOP_PROTOCOL_CHANGED');
    // Keep the extension's supported new-tab handshake. Navigating the new tab
    // to an about:blank fragment disconnects the pinned Mac extension bridge.
    const tab = await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
    if (tab.isError) throw new Error('FACEBOOK_DESKTOP_UNAVAILABLE');
    created = true;
    parseToolResult(await call(ownedTabSetup(owned)));
    result = parseToolResult(await call(`async page => { if (page.gwtDesktopOwnedTab !== ${JSON.stringify(owned)}) throw new Error('DESKTOP_TAB_NOT_OWNED'); return {version:1,result:await page.runGwtDesktop(${JSON.stringify(mode)})}; }`, mode === 'status' ? 90000 : 480000));
    return result;
  } finally {
    let cleanupFailed = false;
    if (created) {
      try {
        const cleanup = await closeOwnedTab(call, owned);
        if (result) result.tabCleanup = { closed: cleanup.closed, remaining: cleanup.remaining };
      } catch { cleanupFailed = true; }
    }
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    // Existing durable submission receipts still prevent a second Publish.
    if (cleanupFailed) throw new Error('DESKTOP_TAB_CLEANUP_FAILED');
  }
}
