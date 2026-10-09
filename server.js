/**
 * YZ250 Tracker - Express Server
 * Serves the dashboard and REST API
 */

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { scrapeAll } = require('./scraper');
const { runColorCheck } = require('./vision');
const { checkListingActive } = require('./active_checker');
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
  const { source, minPrice, maxPrice, search, model, engine, excludeTenere, limit = 5000, offset = 0, activeOnly, iconicBlue, hitlOnly } = req.query;
  const result = db.getListings({
    source,
    minPrice: minPrice ? parseInt(minPrice) : undefined,
    maxPrice: maxPrice ? parseInt(maxPrice) : undefined,
    search,
    model,
    engine,
    excludeTenere: excludeTenere === 'true',
    activeOnly: activeOnly !== 'false',
    iconicBlue: iconicBlue === 'true',
    hitlOnly: hitlOnly === 'true',
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

// POST /api/verify-blue
app.post('/api/verify-blue', (req, res) => {
  const { id, isBlue, tag } = req.body;
  if (!id || isBlue === undefined) return res.status(400).json({ error: 'Missing id or isBlue' });
  try {
    db.verifyIconicBlue(id, isBlue, tag);
    res.json({ success: true, id, isBlue, tag });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reject-listing — delete listing and permanently blacklist it
app.post('/api/reject-listing', (req, res) => {
  const { id, reason } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    const result = db.rejectListing(id, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rejected-listings — view blacklisted listings
app.get('/api/rejected-listings', (req, res) => {
  try {
    res.json(db.getRejectedListings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/check-listing-active — verify if single listing is still active on portal
app.post('/api/check-listing-active', (req, res) => {
  const { id, url } = req.body;
  if (!id || !url) return res.status(400).json({ error: 'Missing id or url' });
  try {
    const result = checkListingActive(url);
    const updated = db.updateListingActiveStatus(id, result.isActive);
    res.json({ success: true, ...result, ...updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/proxy-image — secure CORS proxy for canvas heatmap processing
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');
  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
    if (!upstream.ok) return res.status(upstream.status).send('Upstream image error');
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=604800, immutable');
    res.setHeader('Content-Type', contentType);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(500).send(err.message);
  }
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
    
    // Mark any listings that weren't seen in this run as inactive
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
    scrapeStatus.lastRun = new Date().toISOString();
    scrapeStatus.lastResult = result;
    console.log(`[Server] Scrape #${runId} complete:`, result);

    // Post-processing: Iconic Blue detection (Gemini vision)
    try {
      await runColorCheck();
    } catch (err) {
      console.error('[Server] Iconic Blue check failed:', err.message);
    }
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
  // console.log('[Server] Running initial scrape...');
  // runScrape();
});
