/**
 * YZ250 2-Stroke Listing Scraper
 * 
 * Scrapes OLX.pl for Yamaha YZ250 2-stroke listings.
 * Critically filters OUT any YZ250F (4-stroke) results.
 */

const cheerio = require('cheerio');
const { execSync } = require('child_process');

// ──────────────────────────────────────────────
// FILTER LOGIC
// ──────────────────────────────────────────────

function determineYamahaModel(title, description = '') {
  if (!title) return null;
  const t = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const d = description.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 400); // Only check the first 400 chars of desc

  const hasYamaha = /\byamaha\b/.test(t);
  
  // 1. Aggressively filter out tag spam and competing brands
  const competingBrands = ['ktm', 'honda', 'suzuki', 'kawasaki', 'husqvarna', 'gasgas', 'beta', 'aprilia', 'sherco', 'derbi', 'rieju', 'keeway', 'peugeot', 'motorhispania', 'tm', 'husaberg', 'bmw', 'triumph', 'ducati'];
  
  const firstWord = t.split(' ')[0];
  if (competingBrands.includes(firstWord)) {
      return null; // Actual bike is likely a competing brand
  }

  let brandCount = hasYamaha ? 1 : 0;
  for (const b of competingBrands) {
    if (new RegExp('\\b' + b + '\\b', 'i').test(t)) brandCount++;
  }
  
  if (brandCount >= 2) return null; // Tag spam (mentions multiple brands)
  if (brandCount === 1 && !hasYamaha) return null; // Mentions only a competing brand
  
  // Reject typical competing models
  if (/\b(sx|sxf|exc|rm|rmz|kx|kxf|cr|crf|tc|te|tx|senda|rr|mh10)\b/i.test(t)) {
      return null;
  }

  // Reject Super Tenere / 1200cc models
  if (/\b(super tenere|supertenere|xt1200|xtz1200|xtz 1200|xtz 750|1200ze)\b/i.test(t)) {
      return null;
  }

  const isVintage = /\b(dt|xt|tt|it)\b/i.test(t);

  // Must NOT be a 125cc, 85cc explicitly (unless it's a vintage model like DT 125)
  const isOtherCc = /\b125\b/.test(t) || /125cc/i.test(t) ||
                    /\b85\b/.test(t)  || /85cc/i.test(t)  ||
                    /\b125\b/.test(d) || /125cc/i.test(d) ||
                    /\b85\b/.test(d)  || /85cc/i.test(d);
  if (isOtherCc && !isVintage) return null;

  if (/\b(tenere[\s-]*700|xtz[\s-]*700|xtz690|\bt7\b|t700)\b/i.test(t) && !/\bxt[\s-]?6/i.test(t)) {
    return 'Tenere 700';
  }

  if (/wr[ ]?450/i.test(t)) {
    return 'WR 450F';
  }

  if (/wr[ ]?250/i.test(t)) {
    // WR 250 is assumed to be WR250F since WR250Z is extremely rare and often confused.
    return 'WR 250F';
  }

  if (/yz[ ]?250/i.test(t)) {
    const isFourStroke = /yz[ ]?250[ ]?f[x]?/i.test(t) || /yzf[ ]?250/i.test(t) ||
                         /yz[ ]?250[ ]?f[x]?/i.test(d) || /yzf[ ]?250/i.test(d) ||
                         /\b4[ ]?t\b/i.test(d) || /4suw/i.test(d);
    if (isFourStroke) return null;

    if (/yz[ ]?250[ ]?x/i.test(t) || /yz[ ]?250[ ]?x/i.test(d)) {
      return 'YZ 250X';
    }

    return 'YZ 250 2T';
  }

  if (/\bxj6\b/i.test(t) || /\bxj[\s-]?6\b/i.test(t)) {
    if (/\bdiversion\b/i.test(t) || /\bdiversion\b/i.test(d)) return null;
    if (/\bxj6[\s-]*f\b/i.test(t) || /\bxj[\s-]*6f\b/i.test(t)) return null;
    if (/\bxj6[\s-]*s\b/i.test(t) || /\bxj[\s-]*6s\b/i.test(t)) return null;
    return 'XJ6 Naked';
  }

  if (isVintage) {
    return 'Yamaha Vintage';
  }

  return null;
}

function extractCC(title, desc, model) {
  if (model === 'Tenere 700') return 700;
  if (model === 'WR 450F') return 450;
  if (model === 'WR 250F' || model === 'YZ 250 2T' || model === 'YZ 250X') return 250;
  if (model === 'XJ6 Naked') return 600;
  
  const t = title.toLowerCase();
  const match = t.match(/\b(50|80|85|125|175|200|225|250|350|400|426|450|500|600|650|700)\b/);
  if (match) return parseInt(match[1], 10);
  
  return 0;
}

const SOURCES = {
  olx: {
    name: 'OLX.pl',
    baseUrl: 'https://www.olx.pl',
    searchUrls: [
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-yz-250/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-yz250/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/cross/q-yz-250/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-wr-250/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-wr250/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-wr-450/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-wr450/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-dt/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-xt/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-tt/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-it/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-tenere-700/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-t7/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-xj6/'
    ],
    scrape: scrapeOLX
  },
  autoplac: {
    name: 'Autoplac',
    baseUrl: 'https://autoplac.pl',
    searchUrls: [
      'https://autoplac.pl/oferty/motocykle/yamaha'
    ],
    scrape: scrapeAutoplac
  }
};

// ──────────────────────────────────────────────
// PUPPETEER FETCHER (Bypasses Datadome JS Challenge)
// ──────────────────────────────────────────────
function fetchWithPuppeteer(url) {
  try {
    const scriptPath = require('path').join(__dirname, 'puppeteer_fetcher.js');
    
    // Call the puppeteer script
    return execSync(`node "${scriptPath}" "${url}"`, { 
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer for large HTML
    });
  } catch (err) {
    console.error(`Puppeteer fetch error for ${url}:`, err.message);
    return null;
  }
}

// ──────────────────────────────────────────────
// OLX SCRAPER
// ──────────────────────────────────────────────

async function scrapeOLX(pageNum = 1, searchUrl) {
  const url = pageNum === 1
    ? searchUrl
    : `${searchUrl}?page=${pageNum}`;

  const html = fetchWithPuppeteer(url);
  if (!html) {
    console.error(`[OLX] Failed to fetch page ${pageNum}`);
    return { listings: [], hasMore: false };
  }

  const listings = [];
  let hasMore = false;

  // ── Parse JSON-LD schema (most reliable) ──
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data['@type'] === 'Product' && data.offers && data.offers.offers) {
        for (const offer of data.offers.offers) {
          const title = offer.name || '';
          const modelName = determineYamahaModel(title);
          if (!modelName) continue;

          const location = offer.areaServed ? (offer.areaServed.name || '') : '';

          listings.push({
            id: offer.url ? offer.url.split('/').filter(Boolean).pop() : null,
            title,
            model: modelName,
            cc: extractCC(title, '', modelName),
            price: offer.price || null,
            currency: offer.priceCurrency || 'PLN',
            location,
            url: offer.url || '',
            image: (offer.image && offer.image[0]) || null,
            source: 'OLX.pl',
            scrapedAt: new Date().toISOString(),
            validUntil: offer.priceValidUntil || null,
          });
        }
      }
    } catch (_) {}
  }

  // ── Parse HTML ──
  const $ = cheerio.load(html);
  const seen = new Set(listings.map(l => l.url));

  $('[data-testid="l-card"]').each((_, el) => {
    const $el = $(el);
    const title = $el.find('[data-testid="ad-title"]').text().trim();
    const modelName = determineYamahaModel(title);
    if (!modelName) return;

    let href = $el.find('a[href]').first().attr('href') || '';
    if (href && !href.startsWith('http')) href = SOURCES.olx.baseUrl + href;
    if (seen.has(href)) return;

    const priceText = $el.find('[data-testid="ad-price"]').text().trim();
    const price = parsePrice(priceText);
    const location = $el.find('[data-testid="location-date"]').text().trim().split('-')[0].trim();
    const img = $el.find('img').first().attr('src') || null;

    seen.add(href);
    listings.push({
      id: href.split('/').filter(Boolean).pop(),
      title,
      model: modelName,
      cc: extractCC(title, '', modelName),
      price,
      currency: 'PLN',
      location,
      url: href,
      image: img,
      source: 'OLX.pl',
      scrapedAt: new Date().toISOString(),
      validUntil: null,
    });
  });

  hasMore = $('[data-testid="pagination-forward"]').length > 0 ||
            $('a[data-cy="pagination-forward"]').length > 0 ||
            html.includes('"nextPage"');

  // Filter listings based on title alone first, to save requests
  const preliminaryListings = listings.filter(l => determineYamahaModel(l.title, ''));
  console.log(`[OLX] Page ${pageNum}: found ${preliminaryListings.length} preliminary matches`);
  return { listings: preliminaryListings, hasMore };
}

// ──────────────────────────────────────────────
// AUTOPLAC SCRAPER
// ──────────────────────────────────────────────

async function scrapeAutoplac(pageNum = 1, searchUrl) {
  const url = pageNum === 1
    ? searchUrl
    : `${searchUrl}?page=${pageNum}`;

  const html = fetchWithPuppeteer(url);
  if (!html) {
    console.error(`[Autoplac] Failed to fetch page ${pageNum}`);
    return { listings: [], hasMore: false };
  }

  const listings = [];
  let hasMore = false;
  const $ = cheerio.load(html);
  const seen = new Set();
  
  $('a[href*="/oferta/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;
    
    const title = $el.find('h2, h3, [class*="title"]').first().text().trim();
    if (!title) return;
    
    const modelName = determineYamahaModel(title);
    if (!modelName) return;

    let fullUrl = href.startsWith('http') ? href : 'https://autoplac.pl' + href;
    if (seen.has(fullUrl)) return;
    seen.add(fullUrl);

    const id = fullUrl.split('/').filter(Boolean).pop();
    
    const priceText = $el.find('[class*="price"]').first().text().trim();
    const price = parsePrice(priceText);
    
    const img = $el.find('img').first().attr('src') || null;
    
    listings.push({
      id,
      title,
      model: modelName,
      cc: extractCC(title, '', modelName),
      price,
      currency: 'PLN',
      location: '',
      url: fullUrl,
      image: img,
      source: 'Autoplac',
      scrapedAt: new Date().toISOString(),
      validUntil: null,
    });
  });

  hasMore = html.includes(`page=${pageNum + 1}`);

  const preliminaryListings = listings.filter(l => determineYamahaModel(l.title, ''));
  console.log(`[Autoplac] Page ${pageNum}: found ${preliminaryListings.length} preliminary matches`);
  return { listings: preliminaryListings, hasMore };
}

async function fetchDescription(url) {
  const html = fetchWithPuppeteer(url);
  if (!html) return '';
  const $ = cheerio.load(html);
  
  let desc = '';
  // Try JSON-LD first
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data.description) desc = data.description;
    } catch(e) {}
  }
  
  // Try meta tag if JSON-LD fails
  if (!desc) {
    desc = $('meta[name="description"]').attr('content') || '';
  }
  
  // Try div if meta tag fails
  if (!desc) {
    desc = $('div[data-cy="ad_description"] > div').text().trim();
  }
  
  return desc;
}

function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^\d]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

// ──────────────────────────────────────────────
// MAIN SCRAPE FUNCTION
// ──────────────────────────────────────────────

async function scrapeAll() {
  console.log('[Scraper] Starting scrape run...');
  const allListings = [];
  
  for (const [key, source] of Object.entries(SOURCES)) {
    console.log(`[Scraper] Scraping ${source.name}...`);
    
    // Iterate over all search URLs for this source
    for (const searchUrl of source.searchUrls) {
      console.log(`[Scraper] Using query: ${searchUrl}`);
      let page = 1;
      let hasMore = true;
      
      while (hasMore && page <= 5) {
        const { listings, hasMore: more } = await source.scrape(page, searchUrl);
        allListings.push(...listings);
        hasMore = more;
        page++;
        if (hasMore) await delay(1500);
      }
    }
  }

  const seen = new Set();
  let unique = allListings.filter(l => {
    if (!l.url || seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  console.log(`[Scraper] Found ${unique.length} unique candidates. Verifying descriptions...`);
  const verifiedListings = [];
  
  for (const listing of unique) {
    console.log(`[Scraper] Checking description for: ${listing.title.substring(0, 40)}...`);
    const desc = await fetchDescription(listing.url);
    const finalModel = determineYamahaModel(listing.title, desc);
    if (finalModel) {
      listing.model = finalModel;
      listing.cc = extractCC(listing.title, desc, finalModel);
      verifiedListings.push(listing);
    } else {
      console.log(`[Scraper] ❌ REJECTED based on description: ${listing.url}`);
    }
    await delay(500); // Politeness delay between fetching items
  }

  console.log(`[Scraper] Done. Total VERIFIED Yamaha listings: ${verifiedListings.length}`);
  return verifiedListings;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { scrapeAll, determineYamahaModel, extractCC };

if (require.main === module) {
  const db = require('./db');
  (async () => {
    try {
      const startedAt = new Date().toISOString();
      const runId = db.recordScrapeRun(startedAt);
      console.log(`[CLI] Scrape run #${runId} started at ${startedAt}`);

      const listings = await scrapeAll();
      const { newCount, updatedCount } = db.upsertListings(listings);

      const olxUrls = listings.filter(l => l.source === 'OLX.pl').map(l => l.url);
      if (olxUrls.length > 0) {
        db.markInactiveIfNotSeen(olxUrls, 'OLX.pl');
      }

      const autoplacUrls = listings.filter(l => l.source === 'Autoplac').map(l => l.url);
      if (autoplacUrls.length > 0) {
        db.markInactiveIfNotSeen(autoplacUrls, 'Autoplac');
      }

      const result = { totalFound: listings.length, newListings: newCount, updated: updatedCount };
      db.finishScrapeRun(runId, result);
      console.log(`[CLI] Scrape #${runId} complete:`, result);
    } catch (err) {
      console.error('[CLI] Scrape error:', err);
      process.exit(1);
    }
  })();
}
