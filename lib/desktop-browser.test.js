import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpCli, parseToolResult, ownedTabSetup, ownedTabClose, closeOwnedTab } from './desktop-browser.js';
import { chromium } from 'playwright';

test('pinned MCP init-page hook runs the real publisher against an isolated routed fixture', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gwt-mcp-fixture-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({ tenantId: '01M41C0XR04Y9DXGAJ9Q52C1E1', stateDirectory: directory, browserMode: 'extension', liveEnabled: false }), { mode: 0o600 });
  const productionHook = fileURLToPath(new URL('./desktop-init.cjs', import.meta.url));
  const hook = join(directory, 'fixture.cjs');
  const html = `<h1>Create post</h1>
    <div role="combobox" aria-label="Post to Georgia Wood Tools" tabindex="0" onclick="document.querySelector('[role=listbox]').hidden=false"><img alt="Facebook"></div>
    <div role="listbox" aria-label="Post to" hidden><div role="option" aria-selected="true"><img alt="Facebook">Georgia Wood Tools</div></div>
    <script>document.addEventListener('keydown', e=>{if(e.key==='Escape')document.querySelector('[role=listbox]').hidden=true});window.addEventListener('beforeunload',e=>{e.preventDefault();e.returnValue='Unsaved fixture draft';});</script>`;
  writeFileSync(hook, `exports.default = async ({page}) => {
    await require(${JSON.stringify(productionHook)}).default({page});
    await page.route('**/*', route => route.fulfill({contentType:'text/html',body:${JSON.stringify(html)}}));
  };`);
  const client = new Client({ name: 'gwt-offline-characterization', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    // Hosted Linux CI restricts unprivileged namespaces. Only this ephemeral,
    // fully routed fixture uses the same sandbox setting as Playwright tests.
    args: [mcpCli, '--headless', '--isolated', ...(process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox'] : []), '--executable-path', process.env.META_TEST_BROWSER || chromium.executablePath(), '--init-page', hook, '--no-webmcp', '--snapshot-mode', 'none', '--image-responses', 'omit'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), GWT_DESKTOP_CONFIG: configPath },
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(x => x.name === 'browser_run_code_unsafe'));
  const created = await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.deepEqual(parseToolResult(await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: ownedTabSetup('fixture-owned') } })), { ok: true });
  const result = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async page => { if (page.url() !== 'about:blank') throw new Error('unexpected tab'); Object.defineProperty(page,'gwtFixtureOwned',{value:true}); return {version:1,result:await page.runGwtDesktop('status')}; }` } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(parseToolResult(result), { ok: true, mode: 'status', publishingEnabled: false, status: 'ready', pageId: '1332515199955989' });
  const wrong = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: ownedTabClose('wrong-owner') } });
  assert.equal(wrong.isError, true);
  await closeOwnedTab(client, code => client.callTool({ name: 'browser_run_code_unsafe', arguments: { code } }), 'fixture-owned');
  const tabs = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const listing = tabs.content.map(x => x.text || '').join('\n');
  assert.doesNotMatch(listing, /business\.facebook\.com|beforeunload/, listing);
});
