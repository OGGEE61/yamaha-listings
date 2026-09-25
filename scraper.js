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

function isYZ250TwoStroke(title, description = '') {
  if (!title) return false;
  const t = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const d = description.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 400); // Only check the first 400 chars of desc

  // Title must mention yz250 (with or without space)
  const hasYZ250 = /yz[ ]?250/.test(t);
  if (!hasYZ250) return false;

  // Must NOT be a competing brand spamming tags
  const competingBrands = /\b(ktm|honda|suzuki|kawasaki|husqvarna|gasgas|beta|sx|sxf|exc|rm|rmz|kx|kxf|cr|crf|tc)\b/i;
  // If a competing brand is in the title, it's probably spam like "KTM SX 250 (yz250)"
  if (competingBrands.test(t) && !/\byamaha\b/.test(t)) {
     return false;
  }
  // Even if they wrote Yamaha, if it has KTM SX etc, let's just reject it if it looks like tag spam
  // Or we can just reject if any competing brand model is present
  if (/\b(ktm|honda|suzuki|kawasaki|husqvarna|sx|exc|rm|kx|cr|tc)\b/i.test(t)) {
    // some people write "Yamaha YZ 250 zamienię na KTM" - this is tricky. 
    // Let's check the very first word of the title. If it's a competing brand, reject.
    const firstWord = t.split(' ')[0];
    if (['ktm', 'honda', 'suzuki', 'kawasaki', 'husqvarna', 'gasgas'].includes(firstWord)) {
        return false;
    }
    
    // Also reject if it has multiple brands (typical tag spam)
    let brandCount = 0;
    if (/\byamaha\b/.test(t)) brandCount++;
    if (/\bktm\b/.test(t)) brandCount++;
    if (/\bhonda\b/.test(t)) brandCount++;
    if (/\bsuzuki\b/.test(t)) brandCount++;
    if (/\bkawasaki\b/.test(t)) brandCount++;
    if (brandCount >= 2) return false; // Tag spam: "Yamaha YZ 250 KTM SX 250"
  }

  // Must NOT be a 4-stroke variant (in title or early desc)
  const isFourStroke = /yz[ ]?250[ ]?f[x]?/i.test(t) || /yzf[ ]?250/i.test(t) ||
                       /yz[ ]?250[ ]?f[x]?/i.test(d) || /yzf[ ]?250/i.test(d) ||
                       /\b4[ ]?t\b/i.test(d) || /4suw/i.test(d);
  if (isFourStroke) return false;

  // Must NOT be a 125cc, 85cc, or 450cc explicitly (in title or early desc)
  const isOtherCc = /\b125\b/.test(t) || /125cc/i.test(t) ||
                    /\b85\b/.test(t)  || /85cc/i.test(t)  ||
                    /\b450\b/.test(t) || /450cc/i.test(t) ||
                    /\b125\b/.test(d) || /125cc/i.test(d) ||
                    /\b85\b/.test(d)  || /85cc/i.test(d)  ||
                    /\b450\b/.test(d) || /450cc/i.test(d);
  
  if (isOtherCc) return false;

  return true;
}

const SOURCES = {
  olx: {
    name: 'OLX.pl',
    baseUrl: 'https://www.olx.pl',
    searchUrls: [
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-yz-250/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-yz250/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/cross/q-yz-250/'
    ],
    scrape: scrapeOLX
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
          if (!isYZ250TwoStroke(title)) continue;

          const location = offer.areaServed ? (offer.areaServed.name || '') : '';

          listings.push({
            id: offer.url ? offer.url.split('/').filter(Boolean).pop() : null,
            title,
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
    if (!title || !isYZ250TwoStroke(title)) return;

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
  const preliminaryListings = listings.filter(l => isYZ250TwoStroke(l.title, ''));
  console.log(`[OLX] Page ${pageNum}: found ${preliminaryListings.length} preliminary matches`);
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
    if (isYZ250TwoStroke(listing.title, desc)) {
      verifiedListings.push(listing);
    } else {
      console.log(`[Scraper] ❌ REJECTED based on description: ${listing.url}`);
    }
    await delay(500); // Politeness delay between fetching items
  }

  console.log(`[Scraper] Done. Total VERIFIED YZ250 2-stroke listings: ${verifiedListings.length}`);
  return verifiedListings;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { scrapeAll, isYZ250TwoStroke };
