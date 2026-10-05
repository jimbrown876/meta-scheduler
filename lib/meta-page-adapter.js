import { fail, loadCatalog, verifyMachinePage } from './catalog-source.js';
import { normalizeSnapshot } from './inventory.js';
import { validateReceipt } from './publishing-guards.js';

const tidy = value => value.replace(/\s+/g, ' ').trim();
const editorName = 'Write into the dialogue box to include text with your post.';

export class MetaPageAdapter {
  constructor(page, config, deps = {}) { this.page = page; this.config = config; this.loadCatalog = deps.loadCatalog || loadCatalog; this.verifyLease = deps.verifyLease || (async () => {}); this.durableSubmissionPhases = true; }

  route(path, extra = {}) {
    return `https://business.facebook.com/latest/${path}/?${new URLSearchParams({ asset_id: this.config.pageId, business_id: this.config.businessId, ...extra })}`;
  }

  async checkAccess() {
    const url = new URL(this.page.url());
    const body = await this.page.locator('body').innerText();
    if (/\/checkpoint|\/recover|\/two_step_verification/.test(url.pathname) || /confirm your identity|security check|enter (?:the )?(?:login |security )?code|we sent a code/i.test(body)) fail('FACEBOOK_VERIFICATION_REQUIRED');
    if (/\/login|\/signin/.test(url.pathname) || /log in to facebook|log into facebook/i.test(body)) fail('FACEBOOK_LOGIN_REQUIRED');
    if (/you cannot access this service|unable to access meta business suite|does not have access to any facebook pages|account (?:has been |is )?restricted/i.test(body)) fail('FACEBOOK_ACCESS_RESTRICTED');
    if (url.origin !== 'https://business.facebook.com' || url.searchParams.get('asset_id') !== this.config.pageId || url.searchParams.get('business_id') !== this.config.businessId) fail('FACEBOOK_PAGE_MISMATCH');
  }

  async go(url, ready) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await ready.waitFor({ state: 'visible', timeout: 20000 }); }
    catch { await this.checkAccess(); fail('FACEBOOK_UI_CHANGED'); }
    await this.checkAccess();
  }

  async destination({ editing = false } = {}) {
    const selector = this.page.getByRole('combobox', { name: `Post to ${this.config.pageName}`, exact: true });
    if (await selector.count() !== 1 || await selector.getByRole('img', { name: 'Facebook', exact: true }).count() !== 1) fail('FACEBOOK_PAGE_MISMATCH');
    if (editing) {
      if (await selector.isEnabled()) fail('FACEBOOK_EDIT_DESTINATION_CHANGED');
    } else {
      await selector.click();
      const choices = this.page.getByRole('listbox', { name: 'Post to', exact: true });
      const selected = choices.getByRole('option', { selected: true });
      if (await choices.count() !== 1 || await selected.count() !== 1 || tidy(await selected.innerText()) !== this.config.pageName || await selected.getByRole('img', { name: 'Facebook', exact: true }).count() !== 1) fail('FACEBOOK_PAGE_MISMATCH');
      await selector.press('Escape');
    }
    for (const name of ['Make this an ad post', 'Set date and time', 'Share to Facebook Story', 'Boost']) {
      const toggle = this.page.getByRole('switch', { name, exact: true });
      if (await toggle.count() > 1 || (await toggle.count() === 1 && await toggle.isChecked())) fail('FACEBOOK_UNEXPECTED_DISTRIBUTION');
    }
  }

  async status() {
    await this.go(this.route('composer'), this.page.getByRole('heading', { name: 'Create post', exact: true }));
    await this.destination();
    return { status: 'ready', pageId: this.config.pageId };
  }

  async findPublished(query) {
    await this.go(this.route('posts/published_posts'), this.page.getByRole('grid', { name: 'Published posts', exact: true }));
    const search = this.page.getByRole('textbox', { name: 'Search by ID or caption', exact: true });
    await search.fill(query);
    await search.press('Enter');
    // Meta debounces the server-side search; only read, never retry Publish.
    await this.page.waitForTimeout(1500);
    await this.checkAccess();
    const grid = this.page.getByRole('grid', { name: 'Published posts', exact: true });
    return grid.getByRole('row').filter({ has: this.page.getByRole('checkbox', { name: /^Select item with id \d+$/ }) }).filter({ hasText: query });
  }

  async receipt(operation, contentId) {
    if (!/^\d{1,30}$/.test(contentId || '')) fail('FACEBOOK_RECEIPT_INVALID');
    await this.go(this.route('insights/object_insights', { content_id: contentId, nav_ref: 'bizweb_published_posts_table' }), this.page.getByRole('link', { name: 'View post on Facebook', exact: true }));
    const dialog = await this.readbackRoot();
    const title = dialog.getByRole('heading', { level: 3 });
    if (await title.count() !== 1 || tidy(await title.innerText()) !== tidy(operation.item.caption)) fail('FACEBOOK_CONTENT_NOT_CONFIRMED');
    if (!/Post\s*·\s*Published on/.test(await dialog.innerText())) fail('FACEBOOK_CONTENT_NOT_CONFIRMED');
    const owner = dialog.getByRole('article').getByRole('heading', { name: this.config.pageName, exact: true }).getByRole('link', { name: this.config.pageName, exact: true });
    if (await owner.count() !== 1) fail('FACEBOOK_OWNER_NOT_CONFIRMED');
    const ownerUrl = new URL(await owner.getAttribute('href'));
    if (ownerUrl.origin !== 'https://www.facebook.com' || ownerUrl.pathname !== '/profile.php' || ownerUrl.searchParams.get('id') !== this.config.pageProfileId) fail('FACEBOOK_OWNER_NOT_CONFIRMED');
    const link = dialog.getByRole('link', { name: 'View post on Facebook', exact: true });
    const url = new URL(await link.getAttribute('href'));
    if (!['facebook.com', 'www.facebook.com'].includes(url.hostname) || url.protocol !== 'https:') fail('FACEBOOK_RECEIPT_INVALID');
    url.hostname = 'www.facebook.com';
    const receipt = { pageId: this.config.pageId, postId: url.searchParams.get('story_fbid'), businessContentId: contentId, url: url.href, verified: true, action: operation.action, operationId: operation.operationId, contentHash: operation.item.contentHash };
    return validateReceipt(receipt, this.config.pageId, this.config.pageProfileId);
  }

  async readbackRoot() {
    const dialog = this.page.getByRole('dialog');
    const count = await dialog.count();
    if (count > 1) fail('FACEBOOK_RECEIPT_INVALID');
    // Meta also renders the same insights content as a full page. Both layouts
    // still require one exact caption, Page-owner link and canonical permalink.
    return count === 1 ? dialog : this.page.locator('body');
  }

  async verifyDestination(url, id) { await verifyMachinePage(url, id, this.config); }

  async reconcilePending(operation, previous) {
    const rows = await this.findPublished(`${operation.item.url}#inquire`);
    if (await rows.count() === 0) fail('FACEBOOK_READBACK_PENDING');
    if (await rows.count() !== 1) fail('FACEBOOK_RECONCILIATION_REQUIRED');
    const match = /^Select item with id (\d+)$/.exec(await rows.getByRole('checkbox', { name: /^Select item with id \d+$/ }).getAttribute('aria-label') || '');
    if (!match || (previous && previous.businessContentId !== match[1])) fail('FACEBOOK_RECONCILIATION_REQUIRED');
    try { return await this.receipt(operation, match[1]); }
    catch (error) { if (error.code === 'FACEBOOK_CONTENT_NOT_CONFIRMED') fail('FACEBOOK_READBACK_PENDING'); throw error; }
  }

  async verifyCurrent(operation) {
    const snapshot = await this.loadCatalog(this.config);
    const current = normalizeSnapshot(snapshot, this.config).find(item => item.id === operation.id);
    if (!current || current.revision !== operation.revision || current.contentHash !== operation.item.contentHash) fail('CATALOG_CHANGED_DURING_RUN');
  }

  async replaceCaption(editor, caption) {
    // The official extension bridge reports a generic Browser.getVersion UA,
    // so Playwright classifies its Mac keyboard as Linux. Use the documented
    // CDP editing commands only for this worker-owned tab on a Mac extension
    // connection. No debugger listener, user-profile export or arbitrary job
    // commands are introduced.
    const macBridge = this.config.browserMode === 'extension' && process.platform === 'darwin';
    const session = macBridge ? await this.page.context().newCDPSession(this.page) : null;
    const command = async (key, code, virtualKey, editingCommand, modifiers = 0) => {
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers, commands: [editingCommand] });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers: 0 });
    };
    try {
      await editor.click();
      if (session) {
        await command('a', 'KeyA', 65, 'selectAll', 4);
        await command('Backspace', 'Backspace', 8, 'deleteBackward');
      } else {
        await editor.press('ControlOrMeta+A');
        await editor.press('Backspace');
      }
      for (let attempt = 0; attempt < 20 && tidy(await editor.innerText()); attempt++) await this.page.waitForTimeout(100);
      if (tidy(await editor.innerText())) fail('FACEBOOK_COMPOSER_NOT_CLEARED');
      const lines = caption.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i) {
          if (session) await command('Enter', 'Enter', 13, 'insertNewline');
          else await editor.press('Enter');
        }
        if (lines[i]) await this.page.keyboard.insertText(lines[i]);
      }
      await editor.press('Tab');
    } finally { if (session) await session.detach(); }
  }

  async publish(operation, editing) {
    let submitted = false;
    let preparedCaption;
    try {
    if (this.config.liveEnabled !== true) fail('PUBLISHING_DISABLED');
    const contentId = operation.previous?.businessContentId;
    if (editing && !/^\d{1,30}$/.test(contentId || '')) fail('FACEBOOK_RECEIPT_INVALID');
    if (!editing && await (await this.findPublished(`${operation.item.url}#inquire`)).count()) fail('FACEBOOK_UNTRACKED_EXISTING_POST');
    const heading = editing ? 'Edit published post' : 'Create post';
    // The UI's Edit post action supplies this ref. A content ID without it
    // opens a prefilled Create post form, which must never be submitted as an edit.
    await this.go(this.route('composer', editing ? { ir_qe_exposed: '1', business_content_id: contentId, nav_ref: 'internal_nav', ref: 'biz_tools_published_fb_posts_tab_edit_composer', context_ref: 'POSTS' } : {}), this.page.getByRole('heading', { name: heading, exact: true }));
    await this.destination({ editing });
    const editor = this.page.getByRole('combobox', { name: editorName, exact: true });
    if (await editor.count() !== 1) fail('FACEBOOK_UI_CHANGED');
    if (editing && !tidy(await editor.innerText()).includes(`${operation.item.url}#inquire`)) fail('FACEBOOK_EXISTING_POST_MISMATCH');
    const existingText = tidy(await editor.innerText());
    if (!editing && existingText && existingText !== tidy(operation.ownedDraftCaption || '')) fail('FACEBOOK_EXISTING_DRAFT');
    await this.replaceCaption(editor, operation.item.caption);
    if (tidy(await editor.innerText()) !== tidy(operation.item.caption)) fail('FACEBOOK_COMPOSER_MISMATCH');
    preparedCaption = operation.item.caption;
    operation.persistDraft?.(preparedCaption);
    await this.destination({ editing });
    await this.checkAccess();
    const button = this.page.getByRole('button', { name: 'Publish', exact: true });
    if (await button.count() !== 1 || !await button.isEnabled()) fail('FACEBOOK_PUBLISH_UNAVAILABLE');
    // Refresh effective CRM state immediately before the single submit action.
    await this.verifyCurrent(operation);
    await this.verifyLease();
    // syncInventory has persisted intent before entering this adapter.
    operation.markSubmission?.();
    submitted = true;
    await button.click();
    await this.page.getByRole('heading', { name: heading, exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
    if (editing) return this.receipt(operation, contentId);
    const rows = await this.findPublished(`${operation.item.url}#inquire`);
    if (await rows.count() !== 1) fail('FACEBOOK_CONTENT_NOT_CONFIRMED');
    const checkbox = rows.getByRole('checkbox', { name: /^Select item with id \d+$/ });
    const match = /^Select item with id (\d+)$/.exec(await checkbox.getAttribute('aria-label') || '');
    if (!match) fail('FACEBOOK_RECEIPT_INVALID');
    return this.receipt(operation, match[1]);
    } catch (error) {
      if (!submitted) { error.beforeSubmission = true; error.ownedDraftCaption = preparedCaption; }
      throw error;
    }
  }

  create(operation) { return this.publish(operation, false); }
  update(operation) { return this.publish(operation, true); }
  async delete() { fail('FACEBOOK_REMOVAL_REQUIRES_REVIEW'); }
}
