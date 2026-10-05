import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buttonDestination, preparePostButton } from './meta-post-button.js';
import { MetaPageAdapter } from './meta-page-adapter.js';
import { initialState, planInventory, syncInventory, reconcileReceipt } from './inventory.js';

const config = { tenantId: 'fixture', pageId: '123', pageProfileId: '456', pageName: 'Fixture Page', websiteOrigin: 'https://example.com', availableUrl: 'https://example.com/', liveEnabled: true, requirePostButton: true,
  postButtonDraft: { accountId: '10', campaignId: '20', adsetId: '30', adId: '40', campaignName: 'Fixture inactive campaign', adsetName: 'Fixture inactive ad set', adName: 'Fixture inactive ad' } };
const item = { id: '100', revision: 1, status: 'available', title: 'Fixture saw', description: 'Fixture facts', price: '$10', url: 'https://example.com/equipment/100/fixture-saw' };
const snapshot = { version: 1, source: 'crm', tenantId: 'fixture', items: [item] };
const previous = { pageId: '123', postId: 'pfbidFixture', businessContentId: '999', url: 'https://www.facebook.com/permalink.php?story_fbid=pfbidFixture&id=456', verified: true };
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-button-fixture-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'state.json');
  const browser = await chromium.launch({ headless: true, ...(process.env.META_TEST_BROWSER ? { executablePath: process.env.META_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const state = { button: options.existing || '', updates: 0, unsafe: 0, ids: [], current: snapshot };
  const original = planInventory(initialState(config), snapshot, config)[0];
  const baseReceipt = op => ({ ...previous, action: op.action, operationId: op.operationId, contentHash: op.item.contentHash });
  await syncInventory({ path, snapshot, config, dryRun: false, adapter: { verifyDestination: async () => {}, create: async op => baseReceipt(op) } });
  const operation = { ...planInventory(JSON.parse(readFileSync(path)), snapshot, config)[0], previous };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.ok(['https://www.facebook.com', 'https://adsmanager.facebook.com'].includes(url.origin), 'all network is intercepted and unexpected origins fail');
    if (url.pathname === '/fixture-update') {
      state.updates++;
      assert.equal(JSON.parse(readFileSync(path)).records['machine:100'].pending?.phase, 'submitting', 'intent must precede the only update click');
      const data = route.request().postDataJSON();
      assert.equal(data.id, '999'); assert.equal(data.type, 'Learn more');
      if (!options.lostResult) state.button = data.url;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/fixture-unsafe') { state.unsafe++; assert.fail('Publish, Boost and enable must never be clicked'); }
    if (url.origin === 'https://www.facebook.com') {
      assert.equal(url.pathname, '/permalink.php');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div role="dialog" aria-label="Fixture Page's Post"><h3><a href="/profile.php?id=${options.wrongOwner ? '000' : '456'}">Fixture Page</a></h3><p>${escape(original.item.caption)}</p><div style="height:150px">Photograph remains unchanged</div>${state.button ? `<a href="${escape(state.button)}" style="display:inline-block;min-width:100px;height:35px"><span aria-labelledby="label"></span><b aria-hidden="true">Learn more</b></a><span hidden id="label">Learn more</span>` : '<a href="https://example.com/">Photo/link card only</a><span hidden>Learn more</span>'}<p style="margin-top:1000px"><a href="/ad_center/create/boostpost/?target_id=${options.wrongPost ? '888' : '999'}&page_id=123">Boost post</a></p></div>` });
    }
    const level = url.pathname.split('/')[3];
    assert.ok(['campaigns', 'adsets', 'ads'].includes(level));
    const name = config.postButtonDraft[{ campaigns: 'campaignName', adsets: 'adsetName', ads: 'adName' }[level]];
    const common = `<h4>${name}</h4><p>${options.published ? 'Active' : 'In draft'}</p><button role="switch" aria-label="On/off" aria-checked="${options.activeLevel === level}"></button><button onclick="fetch('/fixture-unsafe')">Publish</button>`;
    if (level !== 'ads') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: common });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `${common}
      <section id="setup" style="margin-top:1200px"><button>Ad setup</button><div role="combobox" id="virtualized" style="visibility:hidden" aria-label="Select an existing post or create a new one">Use existing post</div></section>
      <h3>Ad creative</h3>
      <a href="#" id="enter">Enter post ID</a><div id="entry" hidden><input aria-label="Enter post ID"><button id="submit">Submit</button></div>
      <p id="selected"></p><p>${escape(original.item.caption)}</p><button id="add" hidden>Add button</button>
      <div role="dialog" aria-label="Add a call to action to your post" hidden id="dialog"><p>Adding a call to action will update your original post.</p><div role="combobox" id="cta" tabindex="0">See details</div><div role="option" id="learn" hidden>Learn more</div><input aria-label="Website URL (required)" id="url"><button id="save" disabled>Update post</button></div>
      <script>
      new IntersectionObserver(entries=>{if(entries.some(x=>x.isIntersecting))document.querySelector('#virtualized').style.visibility='visible';}).observe(document.querySelector('#setup'));
      const q=s=>document.querySelector(s);q('#enter').onclick=()=>q('#entry').hidden=false;
      q('#submit').onclick=()=>{q('#selected').textContent=${JSON.stringify(options.wrongSelection ? '888' : '999')}+' - Oct 5, 2026';q('#entry').hidden=true;q('#add').hidden=false;};
      q('#add').onclick=()=>q('#dialog').hidden=false;q('#cta').onclick=()=>q('#learn').hidden=false;
      q('#learn').onclick=()=>{q('#cta').textContent='Learn more';q('#learn').hidden=true;};
      q('#url').onblur=()=>setTimeout(()=>q('#save').disabled=false,100);
      q('#save').onclick=async()=>{await fetch('/fixture-update',{method:'POST',body:JSON.stringify({id:q('[aria-label="Enter post ID"]').value,type:q('#cta').textContent,url:q('#url').value})});q('#dialog').hidden=true;};
      </script>` });
  });
  const page = await context.newPage(); page.setDefaultTimeout(1500);
  const adapter = new MetaPageAdapter(page, config, { loadCatalog: async () => state.current, previewTimeoutMs: 500, confirmationTimeoutMs: 300 });
  adapter.receipt = async op => baseReceipt(op); // Caption/image receipts are independently exercised in meta-page-adapter.test.js.
  adapter.verifyDestination = async () => {};
  return { page, adapter, path, state, operation };
}

test('a native button is a separate durable action; a link card does not complete it', async t => {
  const f = await fixture(t);
  assert.equal(f.operation.action, 'button');
  await syncInventory({ path: f.path, snapshot, config, adapter: f.adapter, dryRun: false });
  const record = JSON.parse(readFileSync(f.path)).records['machine:100'];
  assert.equal(record.receipt.postId, previous.postId); assert.equal(record.receipt.postButton.url, item.url + '#inquire');
  assert.equal(record.pending, null); assert.equal(f.state.updates, 1); assert.equal(f.state.unsafe, 0);
  await syncInventory({ path: f.path, snapshot, config, adapter: f.adapter, dryRun: false });
  assert.equal(f.state.updates, 1);
});

test('adopts an independently verified existing button without changing the draft or post', async t => {
  const f = await fixture(t, { existing: item.url + '?fbclid=fixture#inquire' });
  await syncInventory({ path: f.path, snapshot, config, adapter: f.adapter, dryRun: false });
  assert.equal(f.state.updates, 0); assert.equal(planInventory(JSON.parse(readFileSync(f.path)), snapshot, config)[0].action, 'unchanged');
});

test('wrong button destination, post identity or owner cannot be acknowledged or overwritten', async t => {
  for (const options of [{ existing: 'https://example.com/#inquire' }, { wrongPost: true }, { wrongOwner: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(syncInventory({ path: f.path, snapshot, config, adapter: f.adapter, dryRun: false }), /FACEBOOK_BUTTON_DESTINATION_CHANGED|FACEBOOK_POST_IDENTITY_NOT_CONFIRMED/);
    assert.equal(f.state.updates, 0); assert.equal(JSON.parse(readFileSync(f.path)).records['machine:100'].pending, null);
  }
});

test('all helper levels must be inactive drafts before the post can be modified', async t => {
  for (const activeLevel of ['campaigns', 'adsets', 'ads']) {
    const f = await fixture(t, { activeLevel });
    await assert.rejects(preparePostButton(f.page, f.operation, config), /FACEBOOK_BUTTON_HELPER_NOT_INACTIVE/);
    assert.equal(f.state.updates, 0); assert.equal(f.state.unsafe, 0);
  }
});

test('lost update result keeps submitting intent and permits readback only', async t => {
  const f = await fixture(t, { lostResult: true });
  await assert.rejects(syncInventory({ path: f.path, snapshot, config, adapter: f.adapter, dryRun: false }), /needs reconciliation/);
  const record = JSON.parse(readFileSync(f.path)).records['machine:100'];
  assert.equal(record.pending.phase, 'submitting');
  await syncInventory({ path: f.path, snapshot, config, adapter: f.adapter, dryRun: false });
  assert.equal(f.state.updates, 1);
  await assert.rejects(f.adapter.buttonReceipt(record.pending, { ...record.receipt, action: 'button', operationId: record.pending.operationId, contentHash: record.pending.item.contentHash }, 100), /FACEBOOK_READBACK_PENDING/);
  f.state.button = item.url + '#inquire';
  const receipt = await f.adapter.buttonReceipt(record.pending, { ...record.receipt, action: 'button', operationId: record.pending.operationId, contentHash: record.pending.item.contentHash }, 100);
  await reconcileReceipt({ path: f.path, config, machineId: item.id, receipt });
  assert.equal(f.state.updates, 1); assert.equal(planInventory(JSON.parse(readFileSync(f.path)), snapshot, config)[0].action, 'unchanged');
});

test('changed CRM facts or an expired lease stop before the button update', async t => {
  for (const change of ['crm', 'lease']) {
    const f = await fixture(t);
    if (change === 'crm') f.state.current = { ...snapshot, items: [{ ...item, revision: 2, status: 'sold' }] };
    else f.adapter.verifyLease = async () => { throw new Error('QUEUE_LEASE_CHANGED'); };
    await assert.rejects(syncInventory({ path: f.path, snapshot, config, adapter: f.adapter, dryRun: false }), /CATALOG_CHANGED_DURING_RUN|QUEUE_LEASE_CHANGED/);
    assert.equal(f.state.updates, 0);
  }
});

test('button destination accepts only the exact HTTPS machine link and optional Facebook click ID', () => {
  assert.equal(buttonDestination('https://l.facebook.com/l.php?u=' + encodeURIComponent(item.url + '?fbclid=x#inquire')), item.url + '#inquire');
  for (const url of ['javascript:alert(1)', item.url + '?secret=x#inquire', 'https://user:password@example.com/equipment/100/fixture-saw#inquire']) assert.equal(buttonDestination(url), null);
});
