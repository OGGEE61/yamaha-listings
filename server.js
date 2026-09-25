/**
 * YZ250 Tracker - Express Server
 * Serves the dashboard and REST API
 */

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { scrapeAll } = require('./scraper');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// API ROUTES
// ──────────────────────────────────────────────

// GET /api/listings
app.get('/api/listings', (req, res) => {
  const { source, minPrice, maxPrice, search, limit = 200, offset = 0 } = req.query;
  const result = db.getListings({
    source,
    minPrice: minPrice ? parseInt(minPrice) : undefined,
    maxPrice: maxPrice ? parseInt(maxPrice) : undefined,
    search,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
  res.json(result);
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

// GET /api/price-history/:id
app.get('/api/price-history/:id', (req, res) => {
  const history = db.getPriceHistory(req.params.id);
  res.json(history);
});

// POST /api/scrape — manually trigger a scrape
app.post('/api/scrape', async (req, res) => {
  // Don't block, respond immediately
  res.json({ message: 'Scrape started', timestamp: new Date().toISOString() });
  runScrape();
});

// GET /api/scrape-status
let scrapeStatus = { running: false, lastRun: null, lastResult: null };
app.get('/api/scrape-status', (req, res) => {
  res.json(scrapeStatus);
});

// ──────────────────────────────────────────────
// SCRAPE RUNNER
// ──────────────────────────────────────────────

async function runScrape() {
  if (scrapeStatus.running) {
    console.log('[Server] Scrape already running, skipping.');
    return;
  }

  scrapeStatus.running = true;
  const startedAt = new Date().toISOString();
  const runId = db.recordScrapeRun(startedAt);
  console.log(`[Server] Scrape run #${runId} started at ${startedAt}`);

  try {
    const listings = await scrapeAll();
    
    // Save to DB
    const { newCount, updatedCount } = db.upsertListings(listings);
    
    // Mark any OLX listings that weren't seen in this run as inactive
    const olxUrls = listings.filter(l => l.source === 'OLX.pl').map(l => l.url);
    if (olxUrls.length > 0) {
      db.markInactiveIfNotSeen(olxUrls, 'OLX.pl');
    }

    const result = { totalFound: listings.length, newListings: newCount, updated: updatedCount };
    db.finishScrapeRun(runId, result);
    scrapeStatus.lastRun = new Date().toISOString();
    scrapeStatus.lastResult = result;
    console.log(`[Server] Scrape #${runId} complete:`, result);
  } catch (err) {
    console.error('[Server] Scrape error:', err);
  } finally {
    scrapeStatus.running = false;
  }
}

// ──────────────────────────────────────────────
// SCHEDULED SCRAPE — every 30 minutes
// ──────────────────────────────────────────────

cron.schedule('*/30 * * * *', () => {
  console.log('[Cron] Triggering scheduled scrape...');
  runScrape();
});

// ──────────────────────────────────────────────
// START
// ──────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ YZ250 Tracker running at http://localhost:${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}`);
  console.log(`🔄 Scraping every 30 minutes`);
  
  // Run initial scrape on startup
  console.log('[Server] Running initial scrape...');
  runScrape();
});
