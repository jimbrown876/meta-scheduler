import { fail, loadCatalog, verifyMachinePage } from './catalog-source.js';
import { normalizeSnapshot } from './inventory.js';
import { validateReceipt } from './publishing-guards.js';
import { preparePostButton, readPostButton } from './meta-post-button.js';

const tidy = value => value.replace(/\s+/g, ' ').trim();
const editorName = 'Write into the dialogue box to include text with your post.';

export class MetaPageAdapter {
  constructor(page, config, deps = {}) { this.page = page; this.config = config; this.loadCatalog = deps.loadCatalog || loadCatalog; this.verifyLease = deps.verifyLease || (async () => {}); this.confirmationTimeoutMs = deps.confirmationTimeoutMs || 20000; this.previewTimeoutMs = deps.previewTimeoutMs || 15000; this.durableSubmissionPhases = true; }

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

  async receipt(operation, contentId, previous = operation.previous) {
    if (!/^\d{1,30}$/.test(contentId || '')) fail('FACEBOOK_RECEIPT_INVALID');
    await this.go(this.route('insights/object_insights', { content_id: contentId, nav_ref: 'bizweb_published_posts_table' }), this.page.getByRole('link', { name: 'View post on Facebook', exact: true }));
    const dialog = await this.readbackRoot();
    // New posts also have a level-three "No activity" analytics heading.
    // Bind the exact expected caption rather than assuming all H3s are posts.
    const title = dialog.getByRole('heading', { level: 3, name: tidy(operation.item.caption), exact: true });
    if (await title.count() !== 1 || tidy(await title.innerText()) !== tidy(operation.item.caption)) fail('FACEBOOK_CONTENT_NOT_CONFIRMED');
    if (!/Post\s*·\s*Published on/.test(await dialog.innerText())) fail('FACEBOOK_CONTENT_NOT_CONFIRMED');
    const owner = dialog.getByRole('article').getByRole('heading', { name: this.config.pageName, exact: true }).getByRole('link', { name: this.config.pageName, exact: true });
    // The permalink and caption can render before the independent Feed preview.
    // Wait for its identity evidence instead of treating that loading state as
    // a contradictory owner. The exact profile ID check remains mandatory.
    try { await owner.waitFor({ state: 'visible', timeout: 15000 }); }
    catch { fail('FACEBOOK_OWNER_NOT_CONFIRMED'); }
    if (await owner.count() !== 1) fail('FACEBOOK_OWNER_NOT_CONFIRMED');
    const ownerUrl = new URL(await owner.getAttribute('href'));
    if (ownerUrl.origin !== 'https://www.facebook.com' || ownerUrl.pathname !== '/profile.php' || ownerUrl.searchParams.get('id') !== this.config.pageProfileId) fail('FACEBOOK_OWNER_NOT_CONFIRMED');
    const link = dialog.getByRole('link', { name: 'View post on Facebook', exact: true });
    const url = new URL(await link.getAttribute('href'));
    if (!['facebook.com', 'www.facebook.com'].includes(url.hostname) || url.protocol !== 'https:') fail('FACEBOOK_RECEIPT_INVALID');
    url.hostname = 'www.facebook.com';
    const receipt = { pageId: this.config.pageId, postId: url.searchParams.get('story_fbid'), businessContentId: contentId, url: url.href, verified: true, action: operation.action, operationId: operation.operationId, contentHash: operation.item.contentHash };
    if (this.config.requireLinkPreview) {
      const article = dialog.getByRole('article');
      if (await article.count() !== 1) fail('FACEBOOK_OWNER_NOT_CONFIRMED');
      const image = await this.verifyPreviewImage(article, operation);
      await image.scrollIntoViewIfNeeded();
      // Portrait cards use a sibling link overlay; landscape cards wrap the
      // image in an anchor. Verify the actual click target in both layouts.
      const imageLink = await image.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('a')?.href;
      });
      const expected = `${operation.item.url}#inquire`;
      const matches = (() => {
        try {
          let target = new URL(imageLink);
          if (target.origin === 'https://l.facebook.com' && target.pathname === '/l.php') target = new URL(target.searchParams.get('u'));
          if ([...target.searchParams.keys()].some(key => key !== 'fbclid')) return false;
          target.search = '';
          return target.href === expected;
        } catch { return false; }
      })();
      if (!matches) fail('FACEBOOK_PREVIEW_LINK_NOT_CONFIRMED');
      receipt.linkPreview = { version: 1, verified: true, url: expected };
    }
    return this.preserveReceiptIdentity(receipt, previous);
  }

  async verifyPublicPostIdentity(receipt) {
    // Read the existing public post's own UI link; never click Boost or infer
    // identity only from a navigation argument or a matching caption.
    await this.page.goto(receipt.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const boost = this.page.getByRole('link', { name: 'Boost post', exact: true });
    try { await boost.waitFor({ state: 'visible', timeout: this.previewTimeoutMs }); }
    catch { fail('FACEBOOK_POST_IDENTITY_NOT_CONFIRMED'); }
    const owner = this.page.getByRole('heading', { name: this.config.pageName, exact: true }).getByRole('link', { name: this.config.pageName, exact: true });
    if (new URL(this.page.url()).origin !== 'https://www.facebook.com' || await boost.count() !== 1 || await owner.count() !== 1) fail('FACEBOOK_POST_IDENTITY_NOT_CONFIRMED');
    const target = new URL(await boost.getAttribute('href'), this.page.url());
    const ownerUrl = new URL(await owner.getAttribute('href'), this.page.url());
    if (target.origin !== 'https://www.facebook.com' || target.pathname !== '/ad_center/create/boostpost/' || target.searchParams.get('target_id') !== receipt.businessContentId || target.searchParams.get('page_id') !== this.config.pageId) fail('FACEBOOK_POST_IDENTITY_NOT_CONFIRMED');
    if (ownerUrl.origin !== 'https://www.facebook.com' || ownerUrl.pathname !== '/profile.php' || ownerUrl.searchParams.get('id') !== this.config.pageProfileId) fail('FACEBOOK_POST_IDENTITY_NOT_CONFIRMED');
  }

  async preserveReceiptIdentity(receipt, previous) {
    validateReceipt(receipt, this.config.pageId, this.config.pageProfileId);
    if (!previous) return receipt;
    validateReceipt(previous, this.config.pageId, this.config.pageProfileId);
    if (!/^\d{1,30}$/.test(previous.businessContentId || '') || receipt.businessContentId !== previous.businessContentId) fail('FACEBOOK_POST_IDENTITY_NOT_CONFIRMED');
    if (receipt.postId === previous.postId && receipt.url === previous.url) return receipt;
    // Facebook rotates PFBID share-link aliases. Keep the durable original
    // link only after BOTH public URLs independently identify the exact same
    // numeric post and Page. Never weaken inventory's same-receipt guard.
    if (![previous.postId, receipt.postId].every(id => /^pfbid[A-Za-z0-9]+$/.test(id))) fail('FACEBOOK_POST_IDENTITY_NOT_CONFIRMED');
    await this.verifyPublicPostIdentity(previous);
    await this.verifyPublicPostIdentity(receipt);
    return validateReceipt({ ...receipt, postId: previous.postId, url: previous.url,
      permalinkAlias: { version: 1, verified: true, businessContentId: receipt.businessContentId, observedPostId: receipt.postId, observedUrl: receipt.url },
    }, this.config.pageId, this.config.pageProfileId);
  }

  async verifyPreviewImage(root, operation) {
    const image = root.getByRole('img', { name: operation.item.previewTitle || operation.item.title, exact: true });
    try { await image.waitFor({ state: 'visible', timeout: this.previewTimeoutMs }); }
    catch { fail('FACEBOOK_PREVIEW_IMAGE_NOT_CONFIRMED'); }
    if (await image.count() !== 1) fail('FACEBOOK_PREVIEW_IMAGE_NOT_CONFIRMED');
    const until = Date.now() + this.previewTimeoutMs;
    while (!await image.evaluate(img => img.complete && img.naturalWidth >= 64 && img.naturalHeight >= 64)) {
      if (Date.now() >= until) fail('FACEBOOK_PREVIEW_IMAGE_NOT_CONFIRMED');
      await this.page.waitForTimeout(100);
    }
    return image;
  }

  async useAttachedLinkPreview(operation) {
    const expected = `${operation.item.url}#inquire`;
    const attached = this.page.getByRole('button', { name: 'Click to remove this feature from your post.', exact: true });
    if (await attached.count() === 1) {
      // Reuse the exact existing card during caption/sold edits and receipt
      // migration. Reopening its editor can hide the preview controls.
      try { await this.page.getByRole('link', { name: expected, exact: true }).waitFor({ state: 'visible', timeout: this.previewTimeoutMs }); }
      catch { fail('FACEBOOK_PREVIEW_DESTINATION_CHANGED'); }
      const preview = this.page.getByRole('article').filter({ has: this.page.getByRole('heading', { name: this.config.pageName, exact: true }) });
      await this.verifyPreviewImage(preview, operation);
      return true;
    }
    return false;
  }

  async attachLinkPreview(operation) {
    if (await this.useAttachedLinkPreview(operation)) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.attachLinkPreviewOnce(operation, attempt ? 5000 : 1500); }
      catch (error) {
        // A new caption can finish generating its card after our first check,
        // replacing Link preview while the click is waiting. Verify that exact
        // card before proceeding; this path never retries Publish.
        if (error.code === 'FACEBOOK_PREVIEW_BUTTON_NOT_READY' && await this.useAttachedLinkPreview(operation)) return;
        const state = error.previewDiagnostics;
        // Meta can discard an early Save while fetching a new URL's preview.
        // Retry only this reversible, empty draft attachment, never Publish.
        if (attempt === 0 && error.code === 'FACEBOOK_PREVIEW_LINK_NOT_CONFIRMED' && state?.editDialogCount === 0 && state.attachmentCount === 0 && state.imageCount === 0) continue;
        throw error;
      }
    }
  }

  async attachLinkPreviewOnce(operation, settleMs) {
    let stage = 'FACEBOOK_PREVIEW_BUTTON_NOT_READY';
    try {
    await this.page.getByRole('button', { name: 'Link preview', exact: true }).click({ timeout: this.previewTimeoutMs });
    stage = 'FACEBOOK_PREVIEW_DIALOG_NOT_READY';
    const dialog = this.page.getByRole('dialog', { name: 'Edit link', exact: true });
    // Meta's floating accessible label disappears during empty-field updates.
    // The observed placeholder remains stable throughout focus and typing.
    const input = dialog.getByPlaceholder('Enter a link', { exact: true });
    const expected = `${operation.item.url}#inquire`;
    await input.waitFor({ state: 'visible' });
    const prior = await input.inputValue();
    if (prior && prior !== expected && prior !== operation.item.url) fail('FACEBOOK_PREVIEW_DESTINATION_CHANGED');
    stage = 'FACEBOOK_PREVIEW_INPUT_NOT_READY';
    await input.fill(expected);
    await input.press('Tab');
    if (await input.inputValue() !== expected) fail('FACEBOOK_PREVIEW_DESTINATION_CHANGED');
    // The native value updates before Meta's controlled field commits it.
    // Clear appears only after the field has registered a nonempty value.
    await dialog.getByRole('button', { name: 'Clear', exact: true }).waitFor({ state: 'visible', timeout: this.previewTimeoutMs });
    // Meta debounces the link model separately from the displayed input. A
    // fast Save closes this dialog without attaching anything (observed live).
    await this.page.waitForTimeout(settleMs);
    if (await input.inputValue() !== expected) fail('FACEBOOK_PREVIEW_DESTINATION_CHANGED');
    stage = 'FACEBOOK_PREVIEW_SAVE_NOT_CONFIRMED';
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const chip = this.page.getByRole('link', { name: expected, exact: true });
    try { await chip.waitFor({ state: 'visible', timeout: this.previewTimeoutMs }); }
    catch { fail('FACEBOOK_PREVIEW_LINK_NOT_CONFIRMED'); }
    if (await chip.count() !== 1) fail('FACEBOOK_PREVIEW_LINK_NOT_CONFIRMED');
    const preview = this.page.getByRole('article').filter({ has: this.page.getByRole('heading', { name: this.config.pageName, exact: true }) });
    await this.verifyPreviewImage(preview, operation);
    } catch (error) {
      if (error.name === 'TimeoutError' && !error.code) error.code = stage;
      if (/^FACEBOOK_PREVIEW_/.test(error.code || '')) {
        error.previewDiagnostics = {
          buttonCount: await this.page.getByRole('button', { name: 'Link preview', exact: true }).count(),
          editDialogCount: await this.page.getByRole('dialog', { name: 'Edit link', exact: true }).count(),
          inputCount: await this.page.getByPlaceholder('Enter a link', { exact: true }).count(),
          attachmentCount: await this.page.getByRole('button', { name: 'Click to remove this feature from your post.', exact: true }).count(),
          imageCount: await this.page.getByRole('img', { name: operation.item.previewTitle || operation.item.title, exact: true }).count(),
        };
      }
      throw error;
    }
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
    try {
      const receipt = await this.receipt(operation, match[1], previous);
      if (operation.action === 'button') return this.buttonReceipt(operation, receipt, this.confirmationTimeoutMs);
      return receipt;
    }
    catch (error) { if (error.code === 'FACEBOOK_CONTENT_NOT_CONFIRMED') fail('FACEBOOK_READBACK_PENDING'); throw error; }
  }

  async verifyCurrent(operation) {
    const snapshot = await this.loadCatalog(this.config);
    const current = normalizeSnapshot(snapshot, this.config).find(item => item.id === operation.id);
    if (!current || current.revision !== operation.revision || current.contentHash !== operation.item.contentHash) fail('CATALOG_CHANGED_DURING_RUN');
  }

  async replaceCaption(editor, caption) {
    await editor.click();
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    for (let attempt = 0; attempt < 20 && tidy(await editor.innerText()); attempt++) await this.page.waitForTimeout(100);
    if (tidy(await editor.innerText())) fail('FACEBOOK_COMPOSER_NOT_CLEARED');
    const lines = caption.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) await editor.press('Enter');
      if (lines[i]) await this.page.keyboard.insertText(lines[i]);
    }
    await editor.press('Tab');
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
    if (existingText !== tidy(operation.item.caption)) await this.replaceCaption(editor, operation.item.caption);
    if (tidy(await editor.innerText()) !== tidy(operation.item.caption)) fail('FACEBOOK_COMPOSER_MISMATCH');
    preparedCaption = operation.item.caption;
    operation.persistDraft?.(preparedCaption);
    if (this.config.requireLinkPreview) await this.attachLinkPreview(operation);
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
    const departure = this.page.getByRole('heading', { name: heading, exact: true }).waitFor({ state: 'hidden', timeout: this.confirmationTimeoutMs });
    try {
      if (editing) await Promise.any([departure, this.page.getByText(/^Your post has been edited\.?$/).waitFor({ state: 'visible', timeout: this.confirmationTimeoutMs })]);
      else await departure;
    } catch (error) {
      // Meta can leave its composer open after saving. A UI timeout is not
      // evidence of failure or success: read back the exact published post.
      // This never clicks Publish again; missing/mismatched receipts preserve
      // the submitting intent for later reconciliation.
      const errors = error instanceof AggregateError ? error.errors : [error];
      if (!errors.length || errors.some(e => e.name !== 'TimeoutError')) throw error;
    }
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
  async buttonReceipt(operation, receipt, timeoutMs) {
    await this.verifyPublicPostIdentity(receipt);
    const postButton = await readPostButton(this.page, { ...operation, pageName: this.config.pageName }, timeoutMs);
    if (!postButton) fail('FACEBOOK_READBACK_PENDING');
    return { ...receipt, postButton };
  }

  async button(operation) {
    let submitted = false;
    try {
      if (this.config.liveEnabled !== true) fail('PUBLISHING_DISABLED');
      const receipt = await this.receipt(operation, operation.previous?.businessContentId);
      await this.verifyPublicPostIdentity(receipt);
      const existing = await readPostButton(this.page, { ...operation, pageName: this.config.pageName });
      if (existing) return { ...receipt, postButton: existing };
      const prepared = await preparePostButton(this.page, operation, this.config);
      await this.verifyCurrent(operation);
      await this.verifyLease();
      await prepared.verify();
      operation.markSubmission?.();
      submitted = true;
      await prepared.save.click();
      try { await prepared.dialog.waitFor({ state: 'hidden', timeout: this.confirmationTimeoutMs }); }
      catch (error) { if (error.name !== 'TimeoutError') throw error; }
      return this.buttonReceipt(operation, receipt, this.confirmationTimeoutMs);
    } catch (error) {
      if (!submitted) error.beforeSubmission = true;
      throw error;
    }
  }
  async delete() { fail('FACEBOOK_REMOVAL_REQUIRES_REVIEW'); }
}
