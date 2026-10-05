import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogSnapshot, loadCatalog, verifyMachinePage } from './catalog-source.js';

const config = { tenantId: 'fixture', pageId: '123', crmOrigin: 'https://login.jimdoes.it', websiteOrigin: 'https://georgiawoodtools.com', availableUrl: 'https://georgiawoodtools.com/' };
const row = { id: 'fb_1234', sourceListingId: '1234', title: 'Fixture saw', description: 'Fixture only', priceCents: 123456, currency: 'USD', status: 'available', updatedAt: '2026-10-01T00:00:00.001Z' };
const url = `${config.websiteOrigin}/equipment/1234/fixture-saw`;
const sitemap = `<urlset><url><loc>${url}</loc></url></urlset>`;
const snapshot = (r = row, s = sitemap) => catalogSnapshot({ ok: true, listings: [r] }, s, config, Date.parse('2026-10-04T00:00:00Z'));

test('effective public catalog retains source identity, timestamp ordering and the exact sitemap URL', () => {
  const item = snapshot().items[0];
  assert.equal(item.id, '1234'); assert.equal(item.revision, Date.parse(row.updatedAt));
  assert.equal(item.price, '$1,234.56'); assert.equal(item.url, url);
});
test('sold prices remain private unless the public DTO explicitly allows them', () => {
  assert.equal(snapshot({ ...row, status: 'sold' }).items[0].price, '');
  assert.equal(snapshot({ ...row, status: 'sold', soldPriceVisible: true }).items[0].price, '$1,234.56');
});
test('conflicting identity, unknown states, future revisions and missing sitemap links stop the snapshot', () => {
  for (const patch of [{ id: 'other' }, { status: 'removed' }, { updatedAt: '2029-01-01' }, { updatedAt: null }, { currency: 'GBP' }, { priceCents: -1 }]) assert.throws(() => snapshot({ ...row, ...patch }));
  assert.throws(() => snapshot(row, '<urlset></urlset>'), /MACHINE_LINK/);
  assert.throws(() => snapshot(row, sitemap.replace('/fixture-saw', '/fixture-saw?token=secret')), /SITEMAP_INVALID/);
});
test('catalog fetch has no credentials, rejects redirects, and requires an acknowledged catalog', async () => {
  const calls = [];
  const fetcher = async (url, opts) => { calls.push({ url, opts }); return new Response(url.includes('sitemap') ? sitemap : JSON.stringify({ ok: true, listings: [row] })); };
  assert.equal((await loadCatalog(config, fetcher)).items.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(x => x.opts.redirect === 'error' && !x.opts.headers.authorization && !x.opts.headers['X-JDI-Site-Key']));
  await assert.rejects(loadCatalog(config, async () => new Response('error', { status: 503 })), /CATALOG_UNAVAILABLE/);
});
test('destination verification requires the canonical link and inquiry form together', async () => {
  await verifyMachinePage(url, '1234', config, async () => new Response(`<link rel="canonical" href="${url}"><div id="inquire"><form></form></div>`));
  await assert.rejects(verifyMachinePage(url, '1234', config, async () => new Response('<h1>Unavailable</h1>')), /INQUIRY_FORM/);
});
test('transport timeouts and interrupted reads remain retryable catalog failures', async () => {
  const config = { tenantId: 'fixture', crmOrigin: 'https://login.jimdoes.it', websiteOrigin: 'https://georgiawoodtools.com' };
  for (const name of ['TimeoutError', 'AbortError']) {
    await assert.rejects(loadCatalog(config, async () => { throw new DOMException('fixture timeout', name); }), { code: 'CATALOG_UNAVAILABLE' });
  }
});
