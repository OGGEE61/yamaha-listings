/**
 * Active Listing Verification Engine
 * Checks whether an OLX or Autoplac listing is still live.
 *
 * Result: { isActive: true | false | null, reason, ... }
 *   true  – the page rendered a real offer
 *   false – the page loaded fine but OLX no longer has the offer
 *   null  – unknown (blocked, empty, timeout). Callers must NOT deactivate on null.
 *
 * Note: OLX ships the "listing ended" texts in a translation table inside EVERY page,
 * so matching those strings says nothing. We only trust positive signals of a live offer
 * (Product JSON-LD / price block) and OLX's generic fallback page for removed offers.
 */

const cheerio = require('cheerio');
const { execSync } = require('child_process');
const path = require('path');

const GENERIC_OLX_TITLE = /^Ogłoszenia - Sprzedam, kupię na OLX\.pl/i;

function checkListingActive(url) {
  if (!url) return { isActive: null, reason: 'No URL' };

  let html;
  try {
    const scriptPath = path.join(__dirname, 'puppeteer_fetcher.js');
    html = execSync(`node "${scriptPath}" "${url}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 40000,
    });
  } catch (err) {
    return { isActive: null, reason: `Fetch failed: ${err.message.split('\n')[0]}` };
  }

  if (!html || html.length < 5000) return { isActive: null, reason: 'Empty response' };
  if (/datadome|px-captcha|Just a moment\.\.\./i.test(html) && !html.includes('og:title')) {
    return { isActive: null, reason: 'Blocked by bot protection' };
  }

  const $ = cheerio.load(html);
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const pageTitle = $('title').text().trim();

  // 1. Positive signals of a live offer
  let product = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data['@type'] === 'Product') product = data;
    } catch (_) {}
  });
  const hasPriceBlock = html.includes('ad-price-container');
  const hasDescription = html.includes('ad_description');
  const genericTitle = GENERIC_OLX_TITLE.test(ogTitle) || GENERIC_OLX_TITLE.test(pageTitle);

  if (product) {
    const avail = product.offers?.availability || '';
    if (/Discontinued|OutOfStock|SoldOut/i.test(avail)) {
      return { isActive: false, reason: 'Offer marked as ended' };
    }
    const img = product.image;
    return {
      isActive: true,
      reason: 'Live offer',
      productName: product.name || '',
      freshImage: Array.isArray(img) ? img[0] : img || null,
    };
  }
  if (hasPriceBlock && hasDescription && !genericTitle) return { isActive: true, reason: 'Live offer (price block)' };

  // 2. OLX serves its generic homepage-style page for removed offers
  if (genericTitle) return { isActive: false, reason: 'Offer removed from OLX' };

  // 3. Page loaded but shows neither an offer nor the removal page – don't guess
  return { isActive: null, reason: 'Inconclusive page' };
}

module.exports = { checkListingActive };
