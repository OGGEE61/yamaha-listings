/**
 * JSON-file based database layer for YZ250 tracker
 * Replaced better-sqlite3 due to native compilation issues.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'listings.json');
const PUBLIC_JSON_PATH = path.join(__dirname, 'public', 'listings.json');

let db = {
  listings: {}, // id -> listing object
  price_history: [],
  scrape_runs: []
};

function loadDb() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      db = JSON.parse(data);
    } catch (e) {
      console.error('Error reading db.json:', e);
    }
  }
}

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  exportPublicJson();
}

function exportPublicJson() {
  const active = Object.values(db.listings).filter(l => l.is_active === 1);
  active.sort((a, b) => new Date(b.first_seen) - new Date(a.first_seen));
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(PUBLIC_JSON_PATH, JSON.stringify({ listings: active, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

// Load initially
loadDb();

function upsertListings(newItems) {
  const now = new Date().toISOString();
  let newCount = 0;
  let updatedCount = 0;

  for (const item of newItems) {
    if (!item.id) item.id = item.url.split('/').filter(Boolean).pop();
    
    const existing = db.listings[item.id];
    
    if (existing) {
      existing.title = item.title;
      existing.model = item.model || existing.model || 'Unknown';
      existing.price = item.price;
      existing.location = item.location || existing.location;
      existing.image = item.image || existing.image;
      existing.last_seen = now;
      existing.valid_until = item.validUntil || null;
      existing.is_active = 1;
      updatedCount++;
      
      if (existing.price !== item.price && item.price !== null) {
        db.price_history.push({
          listing_id: item.id,
          price: item.price,
          recorded_at: now
        });
      }
    } else {
      db.listings[item.id] = {
        id: item.id,
        title: item.title,
        model: item.model || 'Unknown',
        price: item.price,
        currency: item.currency || 'PLN',
        location: item.location || '',
        url: item.url,
        image: item.image || null,
        source: item.source || 'Unknown',
        first_seen: now,
        last_seen: now,
        valid_until: item.validUntil || null,
        is_active: 1
      };
      
      if (item.price !== null) {
        db.price_history.push({
          listing_id: item.id,
          price: item.price,
          recorded_at: now
        });
      }
      
      newCount++;
    }
  }
  
  saveDb();
  return { newCount, updatedCount };
}

function markInactiveIfNotSeen(seenUrls, source) {
  const seenSet = new Set(seenUrls);
  let changed = false;
  
  for (const key of Object.keys(db.listings)) {
    const item = db.listings[key];
    if (item.source === source && !seenSet.has(item.url) && item.is_active === 1) {
      item.is_active = 0;
      changed = true;
    }
  }
  
  if (changed) saveDb();
}

function getListings({ source, minPrice, maxPrice, search, model, engine, excludeTenere, activeOnly = true, limit = 200, offset = 0 } = {}) {
  let results = Object.values(db.listings);
  
  if (activeOnly) {
    results = results.filter(l => l.is_active === 1);
  }
  if (source) {
    results = results.filter(l => l.source === source);
  }
  if (model) {
    results = results.filter(l => l.model === model);
  }
  if (engine) {
    if (engine === '2T') {
      results = results.filter(l => 
        l.model === 'YZ 250 2T' || 
        l.model === 'YZ 250X' || 
        (l.model === 'Yamaha Vintage' && /\b(dt|it)\b/i.test(l.title))
      );
    } else if (engine === '4T') {
      results = results.filter(l => 
        l.model === 'WR 250F' || 
        l.model === 'WR 450F' || 
        l.model === 'Tenere 700' || 
        (l.model === 'Yamaha Vintage' && /\b(xt|tt)\b/i.test(l.title))
      );
    }
  }
  
  if (excludeTenere) {
    results = results.filter(l => 
      l.model !== 'Tenere 700' &&
      !(l.model === 'Yamaha Vintage' && /tenere/i.test(l.title))
    );
  }

  if (minPrice != null) {
    results = results.filter(l => l.price !== null && l.price >= minPrice);
  }
  if (maxPrice != null) {
    results = results.filter(l => l.price !== null && l.price <= maxPrice);
  }
  if (search) {
    const s = search.toLowerCase();
    results = results.filter(l => l.title.toLowerCase().includes(s));
  }
  
  results.sort((a, b) => new Date(b.first_seen) - new Date(a.first_seen));
  
  const total = results.length;
  const paginated = results.slice(offset, offset + limit);
  
  return { listings: paginated, total };
}

function getStats() {
  const activeListings = Object.values(db.listings).filter(l => l.is_active === 1);
  const allListings = Object.values(db.listings);
  
  const totalActive = activeListings.length;
  const totalAll = allListings.length;
  
  const prices = activeListings.map(l => l.price).filter(p => p !== null);
  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  
  const today = new Date().toDateString();
  const newToday = allListings.filter(l => new Date(l.first_seen).toDateString() === today).length;
  
  const sourceMap = {};
  for (const l of activeListings) {
    sourceMap[l.source] = (sourceMap[l.source] || 0) + 1;
  }
  const bySource = Object.entries(sourceMap).map(([source, count]) => ({ source, count }));
  
  const modelMap = {};
  for (const l of activeListings) {
    const m = l.model || 'Unknown';
    modelMap[m] = (modelMap[m] || 0) + 1;
  }
  const byModel = Object.entries(modelMap).map(([model, count]) => ({ model, count }));
  
  const lastRun = db.scrape_runs.length ? db.scrape_runs[db.scrape_runs.length - 1] : null;
  
  const ranges = {
    'Under 5k': 0,
    '5k–10k': 0,
    '10k–15k': 0,
    '15k–20k': 0,
    '20k–30k': 0,
    'Over 30k': 0
  };
  
  for (const p of prices) {
    if (p < 5000) ranges['Under 5k']++;
    else if (p < 10000) ranges['5k–10k']++;
    else if (p < 15000) ranges['10k–15k']++;
    else if (p < 20000) ranges['15k–20k']++;
    else if (p < 30000) ranges['20k–30k']++;
    else ranges['Over 30k']++;
  }
  
  const priceRanges = Object.entries(ranges)
    .filter(([_, count]) => count > 0)
    .map(([range, count]) => ({ range, count }));
    
  return { totalActive, totalAll, avgPrice, minPrice, maxPrice, newToday, bySource, byModel, lastRun, priceRanges };
}

function recordScrapeRun(startedAt) {
  const id = db.scrape_runs.length > 0 ? db.scrape_runs[db.scrape_runs.length - 1].id + 1 : 1;
  db.scrape_runs.push({
    id,
    started_at: startedAt,
    finished_at: null,
    total_found: 0,
    new_listings: 0,
    updated: 0
  });
  saveDb();
  return id;
}

function finishScrapeRun(runId, { totalFound, newListings, updated }) {
  const run = db.scrape_runs.find(r => r.id === runId);
  if (run) {
    run.finished_at = new Date().toISOString();
    run.total_found = totalFound;
    run.new_listings = newListings;
    run.updated = updated;
    saveDb();
  }
}

function getPriceHistory(listingId) {
  return db.price_history
    .filter(h => h.listing_id === listingId)
    .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
}

module.exports = {
  upsertListings,
  markInactiveIfNotSeen,
  getListings,
  getStats,
  recordScrapeRun,
  finishScrapeRun,
  getPriceHistory,
};
