import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpCli, parseToolResult, ownedTabSetup, ownedTabClose, closeOwnedTab, desktopClientName } from './desktop-browser.js';
import { chromium } from 'playwright';
import { ensureDesktopBridge } from './desktop-bridge.js';

test('pinned MCP init-page hook runs the real publisher against an isolated routed fixture', { timeout: 60000 }, async t => {
  ensureDesktopBridge(mcpCli);
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
  const helperConfig = { postButtonDraft: { accountId: '10', campaignId: '20', adsetId: '30', adId: '40', campaignName: 'Fixture campaign', adsetName: 'Fixture ad set', adName: 'Fixture inactive ad' } };
  const helperUrl = 'https://adsmanager.facebook.com/adsmanager/manage/ads/edit/standalone?act=10&selected_ad_ids=40&selected_adset_ids=30&selected_campaign_ids=20&treenav=true&simplified_creation=true';
  const helperHtml = `<h4>Fixture inactive ad</h4><p>In draft</p><button role="switch" aria-label="On/off" aria-checked="false"></button><button>Touch inactive draft</button><script>window.addEventListener('beforeunload',e=>{e.preventDefault();e.returnValue='Unsaved inactive fixture helper';});</script>`;
  const buttonModule = new URL('./meta-post-button.js', import.meta.url).href;
  writeFileSync(hook, `exports.default = async ({page}) => {
    await require(${JSON.stringify(productionHook)}).default({page});
    const {leavePostButtonHelper} = await import(${JSON.stringify(buttonModule)});
    await page.route('**/*', route => route.fulfill({contentType:'text/html',body:route.request().url().startsWith('https://adsmanager.facebook.com/')?${JSON.stringify(helperHtml)}:${JSON.stringify(html)}}));
    page.exerciseHelperExit = async () => {
      await page.goto(${JSON.stringify(helperUrl)});
      await page.getByRole('button',{name:'Touch inactive draft',exact:true}).click();
      let unloads=0;const observe=dialog=>{if(dialog.type()==='beforeunload')unloads++;};page.on('dialog',observe);
      try {
        await leavePostButtonHelper(page,${JSON.stringify(helperConfig)},()=>page.goto('https://business.facebook.com/readonly-worker'));
        return {ok:true,unloads,readbackReady:await page.getByRole('heading',{name:'Create post',exact:true}).count()===1,scopeCleared:!Object.hasOwn(page,'gwtDesktopHelperExit')};
      } finally {page.off('dialog',observe);}
    };
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
  const created = await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.deepEqual(parseToolResult(await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: ownedTabSetup('fixture-owned') } })), { ok: true });
  const result = await call(`async page => { if (page.url() !== 'about:blank') throw new Error('unexpected tab'); return {version:1,result:await page.runGwtDesktop('status')}; }`);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(parseToolResult(result), { ok: true, mode: 'status', publishingEnabled: false, status: 'ready', pageId: '1332515199955989' });
  const wrong = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: ownedTabClose('wrong-owner') } });
  assert.equal(wrong.isError, true);
  assert.deepEqual(await closeOwnedTab(call, 'fixture-owned'), { ok: true, closed: 1, remaining: 0 });
  assert.deepEqual(parseToolResult(await call(`async page => { return {version:1,result:{ok:true,urls:page.context().pages().map(p=>p.url())}}; }`)), { ok: true, urls: ['https://business.facebook.com/user-draft'] });
  // A thrown operation must still close its tab, even when selection changed.
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
  parseToolResult(await call(ownedTabSetup('failed-run')));
  const failed = await call(`async page => { await page.goto('https://business.facebook.com/failed-worker'); throw new Error('fixture failure'); }`);
  assert.equal(failed.isError, true);
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 0 } });
  assert.deepEqual(await closeOwnedTab(call, 'failed-run'), { ok: true, closed: 1, remaining: 0 });
  // Failed ownership setup must not close an unmarked blank user tab.
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
  await assert.rejects(closeOwnedTab(call, 'setup-failed'));
  assert.deepEqual(parseToolResult(await call(`async page => { return {version:1,result:{ok:true,count:page.context().pages().length,url:page.url()}}; }`)), {ok:true,count:2,url:'about:blank'});
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'close' } });
  parseToolResult(await call(`async page => { if (page.url()!=='https://business.facebook.com/user-draft') throw new Error('user tab changed'); await page.close(); return {version:1,result:{ok:true}}; }`));
  // Closing the final task tab must not create a replacement blank tab. A
  // second close fails without creating a page (unlike browser_tabs/list).
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
  parseToolResult(await call(ownedTabSetup('last-owned')));
  // Exercise the real pinned MCP dialog observer as well as plain Playwright:
  // the helper must leave without a modal blocking readback or tab cleanup.
  const exitResponse = await call('async page => { const result = await page.exerciseHelperExit(); return {version:1,result}; }');
  assert.match(exitResponse.content.map(x=>x.text || '').join('\n'), /### Result/, JSON.stringify(exitResponse));
  assert.deepEqual(parseToolResult(exitResponse), {ok:true,unloads:1,readbackReady:true,scopeCleared:true});
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

test('only this run\'s official loopback connection tab is owned and cleaned', async () => {
  const owned = 'fixture-run';
  const url = new URL('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html');
  url.searchParams.set('client', JSON.stringify({name:desktopClientName(owned)}));
  url.searchParams.set('mcpRelayUrl', 'ws://127.0.0.1:12345/extension/12345678-1234-1234-1234-123456789abc');
  const other = new URL(url); other.searchParams.set('client', JSON.stringify({name:desktopClientName('other-run')}));
  const remote = new URL(url); remote.searchParams.set('mcpRelayUrl', 'ws://example.com/extension/12345678-1234-1234-1234-123456789abc');
  const impostor = new URL(url); impostor.hostname = 'different-extension';
  const pages = [String(url), String(other), String(remote), String(impostor), 'about:blank'].map(address => ({
    closed:false, url:()=>address, context:()=>({pages:()=>pages.filter(p=>!p.closed)}), runGwtDesktop:()=>{},
    async close() { this.closed=true; }, isClosed() { return this.closed; }
  }));
  const page = pages.at(-1);
  await runInNewContext(`(${ownedTabSetup(owned)})(page)`, {page,URL});
  assert.deepEqual(pages.map(p=>p.gwtDesktopOwnedTab===owned), [true,false,false,false,true]);
  const result = await runInNewContext(`(${ownedTabClose(owned)})(page)`, {page});
  assert.equal(result.result.closed, 2);
  assert.deepEqual(pages.map(p=>p.closed), [true,false,false,false,true]);
});
