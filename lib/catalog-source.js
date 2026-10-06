import { normalizeSnapshot } from './inventory.js';

export class PublisherError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const fail = code => { throw new PublisherError(code); };

async function boundedGet(url, fetcher, maximum) {
  try {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { accept: 'application/json, application/xml, text/html' } });
  if (!response.ok || !response.body) fail('CATALOG_UNAVAILABLE');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) fail('CATALOG_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error?.name) || (error instanceof TypeError && /fetch failed/i.test(error.message))) fail('CATALOG_UNAVAILABLE');
    throw error;
  }
}

export function catalogSnapshot(catalog, sitemap, config, now = Date.now()) {
  if (catalog?.ok !== true || !Array.isArray(catalog.listings) || catalog.listings.length > 10000) fail('CATALOG_INVALID');
  if (typeof sitemap !== 'string' || !/<urlset\b/.test(sitemap) || !/<\/urlset>/.test(sitemap)) fail('SITEMAP_INVALID');
  const links = new Map();
  for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    let url;
    try { url = new URL(match[1].replaceAll('&amp;', '&')); } catch { fail('SITEMAP_INVALID'); }
    const path = /^\/equipment\/(\d{1,30})\/[^/]+\/?$/.exec(url.pathname);
    if (!path) continue;
    if (url.origin !== config.websiteOrigin || url.username || url.password || url.search || url.hash) fail('SITEMAP_INVALID');
    if (links.has(path[1]) && links.get(path[1]) !== url.href) fail('SITEMAP_AMBIGUOUS');
    links.set(path[1], url.href);
  }
  const items = catalog.listings.map(row => {
    const id = row.sourceListingId;
    const revision = typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : NaN;
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id) || row.id !== `fb_${id}` || !['available', 'reserved', 'sold'].includes(row.status)) fail('CATALOG_INVALID');
    if (!Number.isSafeInteger(revision) || revision <= 0 || revision > now + 60000) fail('CATALOG_REVISION_INVALID');
    if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 300 || typeof row.description !== 'string' || row.description.length > 100000) fail('CATALOG_INVALID');
    if (row.location != null && (typeof row.location !== 'string' || row.location.length > 160 || /[\r\n]/.test(row.location))) fail('CATALOG_INVALID');
    if (row.currency !== 'USD' || (row.priceCents !== null && (!Number.isSafeInteger(row.priceCents) || row.priceCents < 0))) fail('CATALOG_PRICE_INVALID');
    // The public DTO has already applied CRM visibility and price overrides.
    const visiblePrice = row.status !== 'sold' || row.soldPriceVisible === true;
    const price = visiblePrice && row.priceCents !== null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(row.priceCents / 100) : '';
    if (!links.has(id)) fail('MACHINE_LINK_NOT_VERIFIED');
    return { id, revision, status: row.status, title: row.title, description: row.description.slice(0, 4000), price, url: links.get(id), ...(row.location?.trim() ? { location: row.location.trim() } : {}) };
  });
  const snapshot = { version: 1, source: 'crm', tenantId: config.tenantId, items };
  normalizeSnapshot(snapshot, config);
  return snapshot;
}

export async function loadCatalog(config, fetcher = fetch) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(config.tenantId) || config.crmOrigin !== 'https://login.jimdoes.it' || config.websiteOrigin !== 'https://georgiawoodtools.com') fail('CONFIG_INVALID');
  const catalogUrl = `${config.crmOrigin}/api/public/woodworking-equipment/${config.tenantId}/listings?format=catalog`;
  const [json, xml] = await Promise.all([
    boundedGet(catalogUrl, fetcher, 16000000),
    boundedGet(`${config.websiteOrigin}/sitemap.xml`, fetcher, 4000000),
  ]);
  let data;
  try { data = JSON.parse(json); } catch { fail('CATALOG_INVALID'); }
  return catalogSnapshot(data, xml, config);
}

export async function verifyMachinePage(url, id, config, fetcher = fetch) {
  const target = new URL(url);
  if (target.origin !== config.websiteOrigin || target.username || target.password || target.search || target.hash || !target.pathname.startsWith(`/equipment/${id}/`)) fail('MACHINE_LINK_NOT_VERIFIED');
  const html = await boundedGet(url, fetcher, 4000000);
  const canonical = [...html.matchAll(/<link\b[^>]*>/g)].some(([tag]) => /\brel="canonical"/.test(tag) && tag.includes(`href="${url}"`));
  if (!canonical || !/id="inquire"/.test(html) || !/<form\b/.test(html)) fail('INQUIRY_FORM_NOT_VERIFIED');
}
