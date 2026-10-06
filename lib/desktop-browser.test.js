import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpCli, parseToolResult, ownedTabSetup, ownedTabClose, ownedTabUrl, closeOwnedTab } from './desktop-browser.js';
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
  const call = code => client.callTool({ name: 'browser_run_code_unsafe', arguments: { code } });
  // Preserve a pre-existing user tab with the same origin as the worker.
  const userTab = await call(`async page => { await page.goto('https://business.facebook.com/user-draft'); return {version:1,result:{ok:true}}; }`);
  assert.equal(userTab.isError, undefined, JSON.stringify(userTab));
  parseToolResult(userTab);
  const created = await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: ownedTabUrl('fixture-owned') } });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.deepEqual(parseToolResult(await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: ownedTabSetup('fixture-owned') } })), { ok: true });
  const result = await call(`async page => { if (page.url() !== ${JSON.stringify(ownedTabUrl('fixture-owned'))}) throw new Error('unexpected tab'); return {version:1,result:await page.runGwtDesktop('status')}; }`);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(parseToolResult(result), { ok: true, mode: 'status', publishingEnabled: false, status: 'ready', pageId: '1332515199955989' });
  const wrong = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: ownedTabClose('wrong-owner') } });
  assert.equal(wrong.isError, true);
  assert.deepEqual(await closeOwnedTab(call, 'fixture-owned'), { ok: true, closed: 1, remaining: 0 });
  assert.deepEqual(parseToolResult(await call(`async page => { return {version:1,result:{ok:true,urls:page.context().pages().map(p=>p.url())}}; }`)), { ok: true, urls: ['https://business.facebook.com/user-draft'] });
  // A thrown operation must still close its tab, even when selection changed.
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: ownedTabUrl('failed-run') } });
  parseToolResult(await call(ownedTabSetup('failed-run')));
  const failed = await call(`async page => { await page.goto('https://business.facebook.com/failed-worker'); throw new Error('fixture failure'); }`);
  assert.equal(failed.isError, true);
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 0 } });
  assert.deepEqual(await closeOwnedTab(call, 'failed-run'), { ok: true, closed: 1, remaining: 0 });
  // Failure before setup still has an exact per-run URL, not a generic blank.
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: ownedTabUrl('setup-failed') } });
  assert.deepEqual(await closeOwnedTab(call, 'setup-failed'), { ok: true, closed: 1, remaining: 0 });
  parseToolResult(await call(`async page => { if (page.url()!=='https://business.facebook.com/user-draft') throw new Error('user tab changed'); await page.close(); return {version:1,result:{ok:true}}; }`));
  // Closing the final task tab must not create a replacement blank tab. A
  // second close fails without creating a page (unlike browser_tabs/list).
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: ownedTabUrl('last-owned') } });
  parseToolResult(await call(ownedTabSetup('last-owned')));
  assert.deepEqual(await closeOwnedTab(call, 'last-owned'), { ok: true, closed: 1, remaining: 0 });
  const empty = await client.callTool({ name: 'browser_tabs', arguments: { action: 'close', index: 0 } });
  assert.equal(empty.isError, true);
  assert.match(empty.content.map(x=>x.text || '').join('\n'), /Tab 0 not found/);
});

test('cleanup requires positive close evidence and never dismisses a dialog or lists tabs', async () => {
  for (const response of [
    { isError: true, content: [] },
    { content: [{type:'text',text:'### Modal state\n- ["beforeunload" dialog'}] },
    { content: [{type:'text',text:'### Result\n{"version":1,"result":{"ok":true,"closed":0,"remaining":1}}'}] },
  ]) {
    let calls = 0;
    await assert.rejects(closeOwnedTab(async () => { calls++; return response; }, 'test'));
    assert.equal(calls, 1);
  }
});
