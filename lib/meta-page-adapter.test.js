import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaPageAdapter } from './meta-page-adapter.js';
import { initialState, planInventory, syncInventory } from './inventory.js';

const config = { tenantId: 'fixture', pageId: '123', pageProfileId: '456', businessId: '789', pageName: 'Fixture Page', browserMode: 'extension', websiteOrigin: 'https://georgiawoodtools.com', availableUrl: 'https://georgiawoodtools.com/', liveEnabled: true };
const item = { id: '100', revision: 1, title: 'Fixture machine', description: 'Synthetic browser test', price: '$10', url: 'https://georgiawoodtools.com/equipment/100/fixture', status: 'available' };
const snapshot = item => ({ version: 1, source: 'crm', tenantId: config.tenantId, items: [item] });
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const photo = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="green"/></svg>').toString('base64')}`;

async function fixture(t, options = {}) {
  const browser = await chromium.launch({ headless: true, ...(process.env.META_TEST_BROWSER ? { executablePath: process.env.META_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const state = { caption: options.caption || '', draft: '', preview: '', publishes: 0, current: snapshot(item) };
  const publishedPath = '/latest/posts/published_posts/?asset_id=123&business_id=789';
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    assert.equal(u.origin, 'https://business.facebook.com', 'fixture must not access an external origin');
    if (u.pathname === '/fixture-submit') {
      options.onSubmit?.();
      state.publishes++;
      state.caption = route.request().postDataJSON().caption;
      state.preview = route.request().postDataJSON().preview || '';
      return route.fulfill({ json: { ok: true } });
    }
    let html;
    if (u.pathname.includes('/composer/')) {
      const edit = u.searchParams.has('business_content_id') && u.searchParams.get('ref') === 'biz_tools_published_fb_posts_tab_edit_composer' && u.searchParams.get('context_ref') === 'POSTS';
      html = `<h1>${edit ? 'Edit published post' : 'Create post'}</h1>
        <div role="combobox" aria-label="Post to Fixture Page" ${edit ? 'aria-disabled="true"' : 'tabindex="0" onclick="document.querySelector(\'[role=listbox]\').hidden=false"'}><img alt="Facebook"></div>
        <div role="listbox" aria-label="Post to" hidden><div role="option" aria-selected="true"><img alt="Facebook">${options.wrongPage ? 'Other Page' : 'Fixture Page'}</div></div>
        <button role="switch" aria-label="Boost" aria-checked="${Boolean(options.boost)}"></button>
        <div role="combobox" contenteditable="true" aria-label="Write into the dialogue box to include text with your post.">${escape(edit ? state.caption : state.draft)}</div>
        ${options.requirePreview ? `<button id="openPreview">Link preview</button><div role="dialog" aria-label="Edit link" id="previewDialog" hidden><input id="previewUrl" placeholder="Enter a link"><button id="clearPreview" hidden>Clear</button><button id="savePreview">Save</button></div><a href="#" id="previewChip"></a><article><h2>Fixture Page</h2><div id="previewCard" hidden>${options.missingImage ? '' : `<img alt="${item.title}" src="${photo}">`}</div></article>` : ''}
        <button id="publish">Publish</button>
        <script>
        ${options.requirePreview ? "let committedPreview='';document.querySelector('#openPreview').onclick=()=>document.querySelector('#previewDialog').hidden=false;document.querySelector('#previewUrl').oninput=()=>{document.querySelector('#clearPreview').hidden=!document.querySelector('#previewUrl').value;setTimeout(()=>{committedPreview=document.querySelector('#previewUrl').value;},750);};document.querySelector('#savePreview').onclick=()=>{document.querySelector('#previewChip').textContent=committedPreview;document.querySelector('#previewCard').hidden=!committedPreview;document.querySelector('#previewDialog').hidden=true;};" : ''}
        document.addEventListener('keydown', e=>{if(e.key==='Escape')document.querySelector('[role=listbox]').hidden=true});
        document.querySelector('#publish').onclick=async()=>{await fetch('/fixture-submit',{method:'POST',body:JSON.stringify({caption:document.querySelector('[contenteditable]').innerText,preview:document.querySelector('#previewUrl')?.value||''})});${options.keepEditor ? (edit ? "document.body.insertAdjacentHTML('beforeend','<p>Your post has been edited.</p>')" : "document.body.insertAdjacentHTML('beforeend','<p>Published</p>')") : `location.href='${publishedPath}'`}};
        </script>`;
    } else if (u.pathname.includes('published_posts')) {
      html = `<input aria-label="Search by ID or caption"><div role="grid" aria-label="Published posts" style="min-height:40px">${state.caption ? `<div role="row"><input type="checkbox" aria-label="Select item with id 999"><div role="gridcell">${escape(state.caption)}</div></div>` : ''}</div>`;
    } else if (u.pathname.includes('object_insights')) {
      html = `<div ${options.fullPage ? '' : 'role="dialog"'}><h3>${escape(options.badReceipt ? 'Unrelated caption' : state.caption)}</h3><p>Post · Published on October 4, 2026</p>${options.emptyInsights ? '<h3>No activity during selected date range</h3>' : ''}<article><h2><a href="https://www.facebook.com/profile.php?id=${options.wrongOwner ? '000' : '456'}">Fixture Page</a></h2></article><a href="https://facebook.com/permalink.php?story_fbid=pfbidFixture&id=456">View post on Facebook</a></div>`;
      if (options.delayOwner) html += `<script>const article=document.querySelector('article');const parent=article.parentNode;article.remove();setTimeout(()=>parent.append(article),500);</script>`;
      if (state.preview) {
        const picture = options.lostImage ? '' : `<img alt="${item.title}" src="${photo}" style="width:200px;height:160px">`;
        const target = escape(options.wrongPreviewLink ? 'https://georgiawoodtools.com/' : state.preview);
        const card = options.portraitPreview ? `<div style="position:relative;width:200px;height:160px">${picture}<a aria-label="Machine image" href="${target}" style="position:absolute;inset:0"></a></div>` : `<a href="${target}">${picture}</a>`;
        html = html.replace('</h2></article>', `</h2><a href="${escape(state.preview)}">Caption inquiry link</a>${card}</article>`);
      }
    } else assert.fail(`Unexpected fixture route ${u.pathname}`);
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  const page = await context.newPage();
  const adapter = new MetaPageAdapter(page, { ...config, requireLinkPreview: Boolean(options.requirePreview) }, { loadCatalog: async () => state.current, confirmationTimeoutMs: options.keepEditor ? 150 : undefined, previewTimeoutMs: 1000 });
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

test('connection loss before Publish preserves its owned draft and retries safely', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-before-submit-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'state.json');
  const { adapter, state } = await fixture(t);
  adapter.verifyLease = async () => { throw new Error('DESKTOP_OFFLINE'); };
  await assert.rejects(syncInventory({ path, snapshot: snapshot(item), config, adapter, dryRun: false }), /DESKTOP_OFFLINE/);
  const record = JSON.parse(readFileSync(path)).records['machine:100'];
  assert.equal(record.pending, null); assert.equal(state.publishes, 0);
  assert.ok(record.ownedDraftCaption.includes(`${item.url}#inquire`));
  state.draft = record.ownedDraftCaption;
  adapter.verifyLease = async () => {};
  await syncInventory({ path, snapshot: snapshot(item), config, adapter, dryRun: false });
  assert.equal(state.publishes, 1);
  assert.equal(JSON.parse(readFileSync(path)).records['machine:100'].pending, null);
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

test('full-page insights verify the exact caption and owner as strictly as the dialog layout', async t => {
  const operation = planInventory(initialState(config), snapshot(item), config)[0];
  const good = await fixture(t, { fullPage: true, caption: operation.item.caption });
  assert.equal((await good.adapter.receipt(operation, '999')).verified, true);
  const wrong = await fixture(t, { fullPage: true, caption: operation.item.caption, wrongOwner: true });
  await assert.rejects(wrong.adapter.receipt(operation, '999'), /FACEBOOK_OWNER_NOT_CONFIRMED/);
  const mismatch = await fixture(t, { fullPage: true, caption: 'Other caption' });
  await assert.rejects(mismatch.adapter.receipt(operation, '999'), /FACEBOOK_CONTENT_NOT_CONFIRMED/);
});

test('an edit confirmation and delayed owner preview still produce one verified receipt', async t => {
  const operation = planInventory(initialState(config), snapshot(item), config)[0];
  const { adapter, state } = await fixture(t, { caption: `Old listing ${item.url}#inquire`, fullPage: true, delayOwner: true, keepEditor: true });
  const receipt = await adapter.update({ ...operation, action: 'update', previous: { businessContentId: '999' } });
  assert.equal(receipt.verified, true);
  assert.equal(state.publishes, 1);
  assert.equal(state.caption.replace(/\s+/g, ' ').trim(), operation.item.caption.replace(/\s+/g, ' ').trim());
});

test('a create that leaves its composer open is verified from the saved post without a second Publish click', async t => {
  const operation = planInventory(initialState(config), snapshot(item), config)[0];
  const { adapter, state } = await fixture(t, { keepEditor: true, delayOwner: true, emptyInsights: true });
  const receipt = await adapter.create(operation);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.businessContentId, '999');
  assert.equal(state.publishes, 1);
});

test('image preview is explicitly attached and verified on create and the same-post sold update', async t => {
  const cfg = { ...config, requireLinkPreview: true };
  const dir = mkdtempSync(join(tmpdir(), 'gwt-image-fixture-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'state.json');
  const { adapter, state } = await fixture(t, { requirePreview: true });
  for (const current of [item, { ...item, revision: 2, status: 'sold' }]) {
    state.current = snapshot(current);
    await syncInventory({ path, snapshot: state.current, config: cfg, adapter, dryRun: false });
    const receipt = JSON.parse(readFileSync(path)).records['machine:100'].receipt;
    assert.deepEqual(receipt.linkPreview, { version: 1, verified: true, url: `${item.url}#inquire` });
    assert.equal(receipt.businessContentId, '999');
  }
  await syncInventory({ path, snapshot: state.current, config: cfg, adapter, dryRun: false });
  assert.equal(state.publishes, 2);
});

test('a missing image blocks Publish and a wrong saved preview link cannot receive a verified receipt', async t => {
  const operation = planInventory(initialState(config), snapshot(item), config)[0];
  const missing = await fixture(t, { requirePreview: true, missingImage: true });
  await assert.rejects(missing.adapter.create(operation), /FACEBOOK_PREVIEW_IMAGE_NOT_CONFIRMED/);
  assert.equal(missing.state.publishes, 0);
  for (const options of [{ lostImage: true }, { wrongPreviewLink: true }]) {
    const wrong = await fixture(t, { requirePreview: true, ...options });
    await assert.rejects(wrong.adapter.create(operation), /FACEBOOK_PREVIEW_(?:IMAGE|LINK)_NOT_CONFIRMED/);
    assert.equal(wrong.state.publishes, 1);
  }
});

test('portrait image cards verify their real sibling-overlay click target', async t => {
  const operation = planInventory(initialState(config), snapshot(item), config)[0];
  const { adapter, state } = await fixture(t, { requirePreview: true, portraitPreview: true });
  const receipt = await adapter.create(operation);
  assert.deepEqual(receipt.linkPreview, { version: 1, verified: true, url: `${item.url}#inquire` });
  assert.equal(state.publishes, 1);
  const wrong = await fixture(t, { requirePreview: true, portraitPreview: true, wrongPreviewLink: true });
  await assert.rejects(wrong.adapter.create(operation), /FACEBOOK_PREVIEW_LINK_NOT_CONFIRMED/);
});
