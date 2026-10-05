import { fail } from './catalog-source.js';

const tidy = value => value.replace(/\s+/g, ' ').trim();
export function buttonDestination(value) {
  try {
    let url = new URL(value);
    if (url.origin === 'https://l.facebook.com' && url.pathname === '/l.php') url = new URL(url.searchParams.get('u'));
    if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => key !== 'fbclid')) return null;
    url.search = '';
    return url.href;
  } catch { return null; }
}

// Facebook can draw the label using a descendant aria-labelledby span whose
// text lives in a hidden tooltip. Check the visible anchor and its hit target,
// not the tooltip, caption URL, Page button, or Ads Manager preview.
export async function readPostButton(page, operation, timeoutMs = 2000) {
  const boost = page.getByRole('link', { name: 'Boost post', exact: true });
  await boost.scrollIntoViewIfNeeded();
  const dialogs = page.getByRole('dialog', { name: `${operation.pageName}'s Post`, exact: true });
  if (await dialogs.count() > 1) fail('FACEBOOK_BUTTON_AMBIGUOUS');
  const root = await dialogs.count() === 1 ? dialogs : page.locator('body');
  const native = root.getByRole('link', { name: 'Learn more', exact: true });
  try { await native.waitFor({ state: 'attached', timeout: timeoutMs }); }
  catch (error) { if (error.name === 'TimeoutError') return null; throw error; }
  if (await native.count() !== 1) fail('FACEBOOK_BUTTON_AMBIGUOUS');
  await native.scrollIntoViewIfNeeded();
  const until = Date.now() + timeoutMs;
  do {
    const buttons = await root.evaluate(element => [...element.querySelectorAll('a')].filter(anchor => {
      const labelled = [anchor, ...anchor.querySelectorAll('[aria-labelledby]')].flatMap(node => (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || ''));
      const labels = [anchor.getAttribute('aria-label') || '', anchor.innerText, ...labelled];
      if (!labels.some(label => /^learn more$/i.test(label.trim()))) return false;
      const rect = anchor.getBoundingClientRect();
      return rect.width >= 40 && rect.height >= 20 && getComputedStyle(anchor).visibility !== 'hidden'
        && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('a') === anchor;
    }).map(anchor => ({ href: anchor.href })));
    if (buttons.length > 1) fail('FACEBOOK_BUTTON_AMBIGUOUS');
    if (buttons.length === 1) {
      const expected = `${operation.item.url}#inquire`;
      if (buttonDestination(buttons[0].href) !== expected) fail('FACEBOOK_BUTTON_DESTINATION_CHANGED');
      return { version: 1, verified: true, type: 'LEARN_MORE', url: expected };
    }
    if (Date.now() >= until) return null;
    await page.waitForTimeout(100);
  } while (true);
}

function helperConfig(config) {
  const draft = config.postButtonDraft;
  if (!draft || !['accountId', 'campaignId', 'adsetId', 'adId'].every(key => /^\d{1,30}$/.test(draft[key] || ''))
    || !['campaignName', 'adsetName', 'adName'].every(key => typeof draft[key] === 'string' && draft[key].length > 0)) fail('CONFIG_POST_BUTTON_DRAFT_REQUIRED');
  return draft;
}

function editorUrl(draft, level) {
  return `https://adsmanager.facebook.com/adsmanager/manage/${level}/edit/standalone?${new URLSearchParams({ act: draft.accountId, selected_ad_ids: draft.adId, selected_adset_ids: draft.adsetId, selected_campaign_ids: draft.campaignId, treenav: 'true', simplified_creation: 'true' })}`;
}

async function assertInactiveDraft(page, draft, level, name) {
  const url = new URL(page.url());
  const expected = new URL(editorUrl(draft, level));
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || ['act', 'selected_ad_ids', 'selected_adset_ids', 'selected_campaign_ids'].some(key => url.searchParams.get(key) !== expected.searchParams.get(key))) fail('FACEBOOK_BUTTON_HELPER_MISMATCH');
  const title = page.getByRole('heading', { name, exact: true, includeHidden: true });
  await title.waitFor({ state: 'visible', timeout: 20000 });
  const status = page.getByText('In draft', { exact: true });
  const toggle = page.getByRole('switch', { name: 'On/off', exact: true, includeHidden: true });
  if (await title.count() !== 1 || await status.count() !== 1 || await toggle.count() !== 1 || await toggle.isChecked()) fail('FACEBOOK_BUTTON_HELPER_NOT_INACTIVE');
}

export async function preparePostButton(page, operation, config) {
  let stage = 'FACEBOOK_BUTTON_HELPER_NOT_READY';
  try {
  const draft = helperConfig(config);
  // All three levels must remain off and unpublished. Never toggle, publish,
  // boost, create campaigns, or change a budget from this adapter.
  for (const [level, name] of [['campaigns', draft.campaignName], ['adsets', draft.adsetName], ['ads', draft.adName]]) {
    await page.goto(editorUrl(draft, level), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await assertInactiveDraft(page, draft, level, name);
  }
  stage = 'FACEBOOK_BUTTON_SETUP_NOT_READY';
  // Ads Manager virtualizes form contents outside the editor viewport. The
  // section header remains mounted while its combobox/fields can disappear.
  await page.getByRole('button', { name: 'Ad setup', exact: true }).scrollIntoViewIfNeeded();
  const setup = page.getByRole('combobox', { name: /Select an existing post or create a new one/ });
  await setup.waitFor({ state: 'visible' });
  if (await setup.count() !== 1 || !/Use existing post/.test(await setup.innerText())) fail('FACEBOOK_BUTTON_HELPER_MISMATCH');
  stage = 'FACEBOOK_BUTTON_POST_SELECTION_NOT_READY';
  await page.getByRole('heading', { name: 'Ad creative', exact: true }).scrollIntoViewIfNeeded();
  const enter = page.getByRole('link', { name: 'Enter post ID', exact: true });
  await enter.click();
  const id = page.getByRole('textbox', { name: 'Enter post ID', exact: true });
  await id.fill(operation.previous.businessContentId);
  await page.getByRole('button', { name: /^Submit[\s\u200b]*$/ }).click();
  const selected = page.getByText(new RegExp(`^${operation.previous.businessContentId} - `));
  await selected.waitFor({ state: 'visible', timeout: 20000 });
  if (await selected.count() !== 1 || !tidy(await page.locator('body').innerText()).includes(tidy(operation.item.caption))) fail('FACEBOOK_BUTTON_POST_MISMATCH');
  await assertInactiveDraft(page, draft, 'ads', draft.adName);
  stage = 'FACEBOOK_BUTTON_CONTROL_NOT_READY';
  const add = page.getByRole('button', { name: 'Add button', exact: true });
  await add.waitFor({ state: 'visible', timeout: 15000 });
  await add.click();
  stage = 'FACEBOOK_BUTTON_DIALOG_NOT_READY';
  const dialog = page.getByRole('dialog', { name: 'Add a call to action to your post', exact: true });
  await dialog.waitFor({ state: 'visible' });
  if (!/Adding a call to action will update your original post\./.test(await dialog.innerText())) fail('FACEBOOK_BUTTON_POST_MISMATCH');
  await dialog.getByRole('combobox').click();
  const option = page.getByRole('option', { name: 'Learn more', exact: true });
  // Meta also virtualizes this menu. Scroll inside the open list until the
  // actual option is mounted; clicking a missing locator cannot reveal it.
  for (let attempt = 0; !await option.isVisible() && attempt < 6; attempt++) {
    const menu = page.getByRole('listbox');
    if (await menu.count() !== 1) fail('FACEBOOK_BUTTON_CONTROL_NOT_READY');
    const bounds = await menu.boundingBox();
    if (!bounds) fail('FACEBOOK_BUTTON_CONTROL_NOT_READY');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, Math.max(200, bounds.height * 0.8));
    await page.waitForTimeout(150);
  }
  await option.click();
  stage = 'FACEBOOK_BUTTON_URL_NOT_READY';
  const input = dialog.getByRole('textbox', { name: 'Website URL (required)', exact: true });
  const expected = `${operation.item.url}#inquire`;
  await input.fill(expected);
  await input.press('Tab');
  const save = dialog.getByRole('button', { name: 'Update post', exact: true });
  // Wait for Meta's controlled form to register the value, without submitting.
  const until = Date.now() + 10000;
  while (!await save.isEnabled() && Date.now() < until) await page.waitForTimeout(100);
  if (!await save.isEnabled() || await input.inputValue() !== expected || !/Learn more/.test(await dialog.getByRole('combobox').innerText())) fail('FACEBOOK_BUTTON_NOT_READY');
  return { save, dialog, verify: async () => {
    await assertInactiveDraft(page, draft, 'ads', draft.adName);
    if (await selected.count() !== 1 || await input.inputValue() !== expected || !/Learn more/.test(await dialog.getByRole('combobox').innerText())) fail('FACEBOOK_BUTTON_POST_MISMATCH');
  } };
  } catch (error) {
    // Keep diagnostics useful without retaining page content or credentials.
    if (error.name === 'TimeoutError' && !error.code) error.code = stage;
    throw error;
  }
}
