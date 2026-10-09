console.log("[DEBUG] scraper.js started");

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
  if (/\b(super tenere|supertenere|xt1200|xtz1200|xtz 1200|xt 1200|xtz 750|1200ze|1200z|1200)\b/i.test(t)) {
      return null;
  }

  const isVintage = /\b(dt|xt|tt|it)\b/i.test(t);

  // Check explicit models BEFORE applying generic CC filters
  if (/\b(tenere[\s-]*700|xtz[\s-]*700|xtz690|\bt7\b|t700)\b/i.test(t) && !/\bxt[\s-]?6/i.test(t)) {
    return 'Tenere 700';
  }

  if (/wr[ ]?450/i.test(t)) {
    return 'WR 450F';
  }

  if (/wr[ ]?250/i.test(t)) {
    if (/wr[ ]?250[ ]?x/i.test(t) || /wr[ ]?250[ ]?x/i.test(d)) {
      return 'WR 250X';
    }
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

  // Must NOT be a 125cc, 85cc explicitly (unless it's a vintage model like DT 125)
  // We do this AFTER explicit model checks to avoid false positives from descriptions (e.g. "zamienię na 125" or "transport do 125km")
  const isOtherCc = /\b125\b/.test(t) || /125cc/i.test(t) ||
                    /\b85\b/.test(t)  || /85cc/i.test(t)  ||
                    /\b125\b/.test(d) || /125cc/i.test(d) ||
                    /\b85\b/.test(d)  || /85cc/i.test(d);
  if (isOtherCc && !isVintage) return null;

  if (isVintage) {
    return 'Yamaha Vintage';
  }

  return null;
}

function extractCC(title, desc, model) {
  if (model === 'Tenere 700') return 700;
  if (model === 'WR 450F') return 450;
  if (model === 'WR 250F' || model === 'WR 250X' || model === 'YZ 250 2T' || model === 'YZ 250X') return 250;
  if (model === 'XJ6 Naked') return 600;
  
  const t = title.toLowerCase();
  const match = t.match(/\b(50|80|85|125|175|200|225|250|350|400|426|450|500|600|650|700)[a-z]*\b/);
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
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-wr-250x/',
      'https://www.olx.pl/motoryzacja/motocykle-skutery/q-yamaha-wr-250-x/',
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
    const scriptPath = require('path').join(__dirname, 'scripts', 'puppeteer_fetcher.js');
    
    // Call the puppeteer script
    const html = execSync(`node "${scriptPath}" "${url}"`, { 
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer for large HTML
    });

    if (html.includes('datadome') || html.includes('Just a moment...') || html.includes('px-captcha')) {
      throw new Error('BOT PROTECTION DETECTED');
    }

    return html;
  } catch (err) {
    console.error(`Puppeteer fetch error for ${url}:`, err.message);
    if (err.message.includes('BOT PROTECTION')) {
      console.error('[WARNING] Scraper was blocked by bot protection. Skipping this URL to protect database.');
      return null;
    }
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
          const cleanUrl = offer.url ? offer.url.split('?')[0] : '';

          listings.push({
            id: cleanUrl ? cleanUrl.split('/').filter(Boolean).pop() : null,
            title,
            model: modelName,
            cc: extractCC(title, '', modelName),
            price: offer.price || null,
            currency: offer.priceCurrency || 'PLN',
            location,
            url: offer.url || '',
            image: (offer.image && offer.image[0]) || null,
            source: 'OLX.pl',
            searchUrl: searchUrl,
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
    href = href.split('?')[0];
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
      searchUrl: searchUrl,
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
    fullUrl = fullUrl.split('?')[0];
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
      searchUrl: searchUrl,
      scrapedAt: new Date().toISOString(),
      validUntil: null,
    });
  });

  hasMore = html.includes(`page=${pageNum + 1}`);

  const preliminaryListings = listings.filter(l => determineYamahaModel(l.title, ''));
  console.log(`[Autoplac] Page ${pageNum}: found ${preliminaryListings.length} preliminary matches`);
  return { listings: preliminaryListings, hasMore };
}

async function fetchDetails(url) {
  const html = fetchWithPuppeteer(url);
  if (!html) return { desc: '', image: null };
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
  
  const image = $('meta[property="og:image"]').attr('content') || null;
  
  return { desc, image };
}

function parsePrice(text) {
  if (!text) return null;
  const firstPart = text.split(/zł|pln|\n/i)[0];
  const cleaned = firstPart.replace(/[^\d]/g, '');
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
      
      while (hasMore) {
        const { listings, hasMore: more } = await source.scrape(page, searchUrl);
        allListings.push(...listings);
        hasMore = more;
        page++;
        
        if (hasMore) {
          // Break it down into smaller pieces: take a longer 10-second pause every 5 pages
          if (page % 5 === 0) {
            console.log(`[Scraper] Reached page ${page}, taking a longer 10s break to avoid bot protection...`);
            await delay(10000);
          } else {
            await delay(2000);
          }
        }
      }
    }
  }

  const seen = new Set();
  let unique = allListings.filter(l => {
    if (!l.url || seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  // Load blacklisted / rejected IDs and URLs so we never fetch details or keep them
  let rejectedIds = new Set();
  let rejectedUrls = new Set();
  try {
    const db = require('./db');
    const rej = db.getRejectedIds();
    rejectedIds = rej.ids;
    rejectedUrls = rej.urls;
  } catch (_) {}

  console.log(`[Scraper] Found ${unique.length} unique candidates (${rejectedUrls.size} permanently blacklisted). Verifying descriptions...`);
  const verifiedListings = [];
  
  for (const listing of unique) {
    const id = listing.id || listing.url.split('/').filter(Boolean).pop();
    if (rejectedIds.has(id) || rejectedUrls.has(listing.url)) {
      console.log(`[Scraper] ⏭️ Skipping permanently blacklisted listing: ${listing.url}`);
      continue;
    }

    console.log(`[Scraper] Checking details for: ${listing.title.substring(0, 40)}...`);
    const details = await fetchDetails(listing.url);
    if (details.image) {
      listing.image = details.image;
    }
    const finalModel = determineYamahaModel(listing.title, details.desc);
    if (finalModel) {
      listing.model = finalModel;
      listing.cc = extractCC(listing.title, details.desc, finalModel);
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

async function syncListingsToD1(listings, runStats, inactiveUrls = []) {
  const workerUrl = process.env.WORKER_URL || 'https://yamaha-listings.maxgustaw.workers.dev';
  const secret = process.env.ADMIN_SYNC_SECRET || 'yamaha-listing-tracker-secret-2026';

  console.log(`[D1 Sync] Syncing ${listings.length} listings to Cloudflare D1 via ${workerUrl}/api/sync-listings...`);
  const nodeFetch = global.fetch || require('node-fetch');
  const res = await nodeFetch(`${workerUrl}/api/sync-listings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sync-secret': secret,
    },
    body: JSON.stringify({
      listings,
      run: runStats,
      inactiveUrls,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[D1 Sync] Error response: ${text}`);
    throw new Error(`D1 sync failed: HTTP ${res.status}`);
  }
  const result = await res.json();
  console.log('[D1 Sync] Cloudflare D1 updated successfully:', result);
  return result;
}

module.exports = { scrapeAll, determineYamahaModel, extractCC, syncListingsToD1 };

if (require.main === module) {
  (async () => {
    try {
      const startedAt = new Date().toISOString();
      console.log(`[CLI] Scrape run started at ${startedAt}`);

      const listings = await scrapeAll();

      const olxUrls = listings.filter(l => l.source === 'OLX.pl').map(l => l.url);
      const inactiveUrls = [];

      // Sync directly to Cloudflare D1
      const runStats = {
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        total_found: listings.length,
        new_listings: 0,
        updated: listings.length
      };

      try {
        await syncListingsToD1(listings, runStats, inactiveUrls);
      } catch (err) {
        console.warn('[CLI] Direct D1 sync failed, checking local DB fallback:', err.message);
      }

      // Optional local SQLite sync if db exists
      try {
        const db = require('./db');
        const { newCount, updatedCount } = db.upsertListings(listings);
        if (olxUrls.length > 30) {
          db.markInactiveIfNotSeen(olxUrls, 'OLX.pl');
        }
        db.finishScrapeRun(db.recordScrapeRun(startedAt), {
          totalFound: listings.length,
          newListings: newCount,
          updated: updatedCount
        });
      } catch (_) {}

      // Post-processing: Iconic Blue detection on listing photos (Gemini vision)
      try {
        await require('./vision').runColorCheck();
      } catch (err) {
        console.error('[CLI] Iconic Blue check failed (scrape results kept):', err.message);
      }
    } catch (err) {
      console.error('[CLI] Scrape error:', err);
      process.exit(1);
    }
  })();
}
