export class UncertainPublishError extends Error {
  constructor(message, options) { super(message, options); this.code = 'UNCERTAIN'; }
}

export function validateDatetime(value, now = new Date()) {
  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!parts) throw new Error('Datetime must be YYYY-MM-DD HH:MM in the configured account timezone.');
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (year < 2000 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) {
    throw new Error('Invalid calendar date or time (including a daylight-saving gap).');
  }
  // Reject an ambiguous fall-back local time instead of guessing which occurrence.
  for (const offset of [-120, -60, -30, 30, 60, 120]) {
    const other = new Date(date.getTime() + offset * 60000);
    if (other.getFullYear() === year && other.getMonth() === month - 1 && other.getDate() === day && other.getHours() === hour && other.getMinutes() === minute) {
      throw new Error('Ambiguous daylight-saving time; choose a different time.');
    }
  }
  const delta = date - now;
  if (delta < 20 * 60000 || delta > 29 * 86400000) throw new Error('Schedule must be between 20 minutes and 29 days from now.');
  return { date, yearInt: year, monthInt: month, dayInt: day, hourInt: hour, minuteInt: minute };
}

export function assertAccount(account, { live = false } = {}) {
  if (!/^\d+$/.test(account.pageId || '') || !account.pageName?.trim()) throw new Error('Exact Page ID and name are required.');
  if (JSON.stringify(account.platforms) !== '["facebook"]') throw new Error('This fork supports Facebook-only destinations.');
  if (!account.destinationLabel?.trim() || !account.destinationGroupLabel?.trim()) throw new Error('Verified exact destination checkbox and group labels are required.');
  if (live && account.liveEnabled !== true) throw new Error('Live publishing is disabled pending account eligibility and adapter verification.');
}

export async function assertAccessiblePage(page, account) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.hostname !== 'business.facebook.com' || url.searchParams.get('asset_id') !== account.pageId) throw new Error('Page identity mismatch or signed-out redirect.');
  const denied = page.getByText(/you cannot access this service|account (?:has been |is )?restricted|request a review|confirm your identity|security check|log in to facebook/i);
  if (await denied.count()) throw new Error('Meta requires account action; automated publishing stopped.');
}

export async function ensureFacebookDestination(page, account) {
  await assertAccessiblePage(page, account);
  const group = page.getByRole('group', { name: account.destinationGroupLabel, exact: true });
  if (await group.count() !== 1) throw new Error('Cannot uniquely identify the posting destinations.');
  const intended = group.getByRole('checkbox', { name: account.destinationLabel, exact: true });
  if (await intended.count() !== 1) throw new Error('Exact Facebook Page destination not found.');
  const all = group.getByRole('checkbox');
  for (let i = 0; i < await all.count(); i++) await all.nth(i).setChecked(false);
  await intended.setChecked(true);
  let checked = 0;
  for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isChecked()) checked++;
  if (checked !== 1 || !await intended.isChecked()) throw new Error('Destination selection did not commit.');
}

export function validateReceipt(receipt, pageId) {
  if (!receipt || receipt.pageId !== pageId || typeof receipt.postId !== 'string' || !/^[A-Za-z0-9_:-]+$/.test(receipt.postId) || receipt.verified !== true) throw new Error('A verified receipt with exact Page/post identity is required.');
  const url = new URL(receipt.url);
  if (url.protocol !== 'https:' || !['www.facebook.com', 'facebook.com'].includes(url.hostname) || url.username || url.password || url.hash || url.search || !/^\/[^/]+\/posts\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error('Receipt must contain a canonical Facebook post URL.');
  if (url.pathname.split('/')[3] !== receipt.postId) throw new Error('Receipt ID and URL do not match.');
  return receipt;
}

export async function scheduleAndVerify(page, account, beforeCommit) {
  await ensureFacebookDestination(page, account);
  const success = page.getByText(account.successText, { exact: true });
  if (!account.successText || await success.count()) throw new Error('Missing confirmation configuration or stale confirmation already visible.');
  const button = page.getByRole('button', { name: 'Schedule', exact: true });
  if (await button.count() !== 1) throw new Error('Schedule button is ambiguous.');
  await beforeCommit(); // Persist intent before the first potentially irreversible click.
  try {
    await button.click();
    await success.waitFor({ state: 'visible', timeout: 15000 });
    await assertAccessiblePage(page, account);
    const postLink = page.getByRole('link', { name: account.successLinkLabel, exact: true });
    if (!account.successLinkLabel || await postLink.count() !== 1) throw new Error('Unique confirmed post link unavailable.');
    const url = new URL(await postLink.getAttribute('href'), page.url());
    return validateReceipt({ pageId: account.pageId, postId: url.pathname.split('/')[3], url: url.href, verified: true }, account.pageId);
  } catch (cause) { throw new UncertainPublishError('Scheduling outcome is uncertain; reconcile before retrying.', { cause }); }
}
