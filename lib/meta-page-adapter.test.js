import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaPageAdapter } from './meta-page-adapter.js';
import { initialState, planInventory, syncInventory } from './inventory.js';

const config = { tenantId: 'fixture', pageId: '123', pageProfileId: '456', businessId: '789', pageName: 'Fixture Page', websiteOrigin: 'https://georgiawoodtools.com', availableUrl: 'https://georgiawoodtools.com/', liveEnabled: true };
const item = { id: '100', revision: 1, title: 'Fixture machine', description: 'Synthetic browser test', price: '$10', url: 'https://georgiawoodtools.com/equipment/100/fixture', status: 'available' };
const snapshot = item => ({ version: 1, source: 'crm', tenantId: config.tenantId, items: [item] });
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

async function fixture(t, options = {}) {
  const browser = await chromium.launch({ headless: true, ...(process.env.META_TEST_BROWSER ? { executablePath: process.env.META_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const state = { caption: options.caption || '', publishes: 0, current: snapshot(item) };
  const publishedPath = '/latest/posts/published_posts/?asset_id=123&business_id=789';
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    assert.equal(u.origin, 'https://business.facebook.com', 'fixture must not access an external origin');
    if (u.pathname === '/fixture-submit') {
      options.onSubmit?.();
      state.publishes++;
      state.caption = route.request().postDataJSON().caption;
      return route.fulfill({ json: { ok: true } });
    }
    let html;
    if (u.pathname.includes('/composer/')) {
      const edit = u.searchParams.has('business_content_id');
      html = `<h1>${edit ? 'Edit published post' : 'Create post'}</h1>
        <div role="combobox" aria-label="Post to Fixture Page" ${edit ? 'aria-disabled="true"' : 'tabindex="0" onclick="document.querySelector(\'[role=listbox]\').hidden=false"'}><img alt="Facebook"></div>
        <div role="listbox" aria-label="Post to" hidden><div role="option" aria-selected="true"><img alt="Facebook">${options.wrongPage ? 'Other Page' : 'Fixture Page'}</div></div>
        <button role="switch" aria-label="Boost" aria-checked="${Boolean(options.boost)}"></button>
        <div role="combobox" contenteditable="true" aria-label="Write into the dialogue box to include text with your post.">${escape(edit ? state.caption : '')}</div>
        <button id="publish">Publish</button>
        <script>
        document.addEventListener('keydown', e=>{if(e.key==='Escape')document.querySelector('[role=listbox]').hidden=true});
        document.querySelector('#publish').onclick=async()=>{await fetch('/fixture-submit',{method:'POST',body:JSON.stringify({caption:document.querySelector('[contenteditable]').innerText})});location.href='${publishedPath}'};
        </script>`;
    } else if (u.pathname.includes('published_posts')) {
      html = `<input aria-label="Search by ID or caption"><div role="grid" aria-label="Published posts" style="min-height:40px">${state.caption ? `<div role="row"><input type="checkbox" aria-label="Select item with id 999"><div role="gridcell">${escape(state.caption)}</div></div>` : ''}</div>`;
    } else if (u.pathname.includes('object_insights')) {
      html = `<div role="dialog"><h3>${escape(options.badReceipt ? 'Unrelated caption' : state.caption)}</h3><p>Post · Published on October 4, 2026</p><article><h2><a href="https://www.facebook.com/profile.php?id=${options.wrongOwner ? '000' : '456'}">Fixture Page</a></h2></article><a href="https://facebook.com/permalink.php?story_fbid=pfbidFixture&id=456">View post on Facebook</a></div>`;
    } else assert.fail(`Unexpected fixture route ${u.pathname}`);
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  const page = await context.newPage();
  const adapter = new MetaPageAdapter(page, config, { loadCatalog: async () => state.current });
  adapter.verifyDestination = async () => {}; // Independently covered by catalog-source tests.
  return { page, adapter, state };
}

test('observed Meta controls create and update the same post through reserve and sold, with durable intent before each submit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-meta-fixture-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'state.json');
  const { adapter, state } = await fixture(t, { onSubmit: () => assert.ok(JSON.parse(readFileSync(path)).records['machine:100'].pending) });
  assert.equal((await adapter.status()).status, 'ready');
  for (const [i, status] of ['available', 'reserved', 'sold'].entries()) {
    state.current = snapshot({ ...item, status, revision: i + 1 });
    await syncInventory({ path, snapshot: state.current, config, adapter, dryRun: false });
    const record = JSON.parse(readFileSync(path)).records['machine:100'];
    assert.equal(record.receipt.businessContentId, '999');
    assert.equal(record.receipt.postId, 'pfbidFixture');
    assert.equal(record.pending, null);
    assert.ok(state.caption.includes(`${item.url}#inquire`));
  }
  assert.ok(state.caption.startsWith('SOLD — '));
  await syncInventory({ path, snapshot: state.current, config, adapter, dryRun: false });
  assert.equal(state.publishes, 3, 'unchanged runs cannot duplicate a verified post');
});

test('unexpected destination or boost blocks publication', async t => {
  for (const options of [{ wrongPage: true }, { boost: true }]) {
    const { adapter, state } = await fixture(t, options);
    await assert.rejects(adapter.status(), /FACEBOOK_PAGE_MISMATCH|FACEBOOK_UNEXPECTED_DISTRIBUTION/);
    assert.equal(state.publishes, 0);
  }
});

test('an existing untracked machine link blocks a second post', async t => {
  const { adapter, state } = await fixture(t, { caption: `Already listed ${item.url}#inquire` });
  const operation = planInventory(initialState(config), snapshot(item), config)[0];
  await assert.rejects(adapter.create(operation), /FACEBOOK_UNTRACKED_EXISTING_POST/);
  assert.equal(state.publishes, 0);
});

test('CRM change during composition blocks the single Publish click', async t => {
  const { adapter, state } = await fixture(t);
  state.current = snapshot({ ...item, revision: 2, status: 'sold' });
  const operation = planInventory(initialState(config), snapshot(item), config)[0];
  await assert.rejects(adapter.create(operation), /CATALOG_CHANGED_DURING_RUN/);
  assert.equal(state.publishes, 0);
});

test('a successful click with a mismatched receipt stays uncertain and is never clicked twice', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-uncertain-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'state.json');
  const { adapter, state } = await fixture(t, { badReceipt: true });
  await assert.rejects(syncInventory({ path, snapshot: snapshot(item), config, adapter, dryRun: false }), /needs reconciliation/);
  assert.ok(JSON.parse(readFileSync(path)).records['machine:100'].pending);
  const second = await syncInventory({ path, snapshot: snapshot(item), config, adapter, dryRun: false });
  assert.equal(second.operations[0].reason, 'uncertain-outcome');
  assert.equal(state.publishes, 1);
});

test('post owner and account verification are independently checked', async t => {
  const { adapter, page } = await fixture(t, { caption: 'old', wrongOwner: true });
  const operation = planInventory(initialState(config), snapshot(item), config)[0];
  await page.goto(adapter.route('composer'));
  await page.setContent('<h1>We sent a code</h1>');
  await assert.rejects(adapter.checkAccess(), /FACEBOOK_VERIFICATION_REQUIRED/);
  await page.setContent('<h1>Log in to Facebook</h1>');
  await assert.rejects(adapter.checkAccess(), /FACEBOOK_LOGIN_REQUIRED/);
  // Supply matching content so this specifically tests owner verification.
  const other = await fixture(t, { caption: operation.item.caption, wrongOwner: true });
  await assert.rejects(other.adapter.receipt(operation, '999'), /FACEBOOK_OWNER_NOT_CONFIRMED/);
});
