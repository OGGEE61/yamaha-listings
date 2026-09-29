/**
 * SQLite-based database layer for YZ250 tracker
 * Uses better-sqlite3 for synchronous, fast queries.
 *
 * Tables:
 *   listings       - canonical listing record (upserted on each scrape)
 *   price_history  - append-only price log per listing
 *   scrape_runs    - metadata about each scrape execution
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'listings.db');
const PUBLIC_JSON_PATH = path.join(__dirname, 'public', 'listings.json');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency / performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ──────────────────────────────────────────────
// SCHEMA
// ──────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT 'Unknown',
    price       INTEGER,
    currency    TEXT NOT NULL DEFAULT 'PLN',
    location    TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL,
    image       TEXT,
    cc          INTEGER NOT NULL DEFAULT 0,
    source      TEXT NOT NULL DEFAULT 'Unknown',
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    valid_until TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  TEXT NOT NULL REFERENCES listings(id),
    price       INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scrape_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    total_found  INTEGER NOT NULL DEFAULT 0,
    new_listings INTEGER NOT NULL DEFAULT 0,
    updated      INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_listings_source    ON listings(source);
  CREATE INDEX IF NOT EXISTS idx_listings_is_active ON listings(is_active);
  CREATE INDEX IF NOT EXISTS idx_price_hist_listing ON price_history(listing_id);
`);

// ──────────────────────────────────────────────
// PUBLIC JSON EXPORT  (for the static dashboard)
// ──────────────────────────────────────────────

function exportPublicJson() {
  const active = db.prepare(`
    SELECT * FROM listings WHERE is_active = 1
    ORDER BY cc DESC, first_seen DESC
  `).all();

  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  fs.writeFileSync(
    PUBLIC_JSON_PATH,
    JSON.stringify({ listings: active, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

// ──────────────────────────────────────────────
// UPSERT LISTINGS
// ──────────────────────────────────────────────

const stmtGet    = db.prepare('SELECT * FROM listings WHERE id = ?');
const stmtInsert = db.prepare(`
  INSERT INTO listings
    (id, title, model, price, currency, location, url, image, cc, source, first_seen, last_seen, valid_until, is_active)
  VALUES
    (@id, @title, @model, @price, @currency, @location, @url, @image, @cc, @source, @first_seen, @last_seen, @valid_until, 1)
`);
const stmtUpdate = db.prepare(`
  UPDATE listings SET
    title       = @title,
    model       = @model,
    price       = @price,
    location    = @location,
    image       = @image,
    cc          = @cc,
    last_seen   = @last_seen,
    valid_until = @valid_until,
    is_active   = 1
  WHERE id = @id
`);
const stmtAddPrice = db.prepare(`
  INSERT INTO price_history (listing_id, price, recorded_at) VALUES (?, ?, ?)
`);

function upsertListings(newItems) {
  const now = new Date().toISOString();
  let newCount = 0;
  let updatedCount = 0;

  const run = db.transaction((items) => {
    for (const item of items) {
      if (!item.id) item.id = item.url.split('/').filter(Boolean).pop();

      const existing = stmtGet.get(item.id);

      if (existing) {
        const priceChanged = item.price !== null && item.price !== undefined && item.price !== existing.price;

        stmtUpdate.run({
          id:          item.id,
          title:       item.title,
          model:       item.model || existing.model || 'Unknown',
          price:       item.price ?? existing.price,
          location:    item.location || existing.location,
          image:       item.image   || existing.image,
          cc:          item.cc !== undefined ? item.cc : existing.cc,
          last_seen:   now,
          valid_until: item.validUntil || null,
        });

        if (priceChanged) {
          stmtAddPrice.run(item.id, item.price, now);
        }

        updatedCount++;
      } else {
        stmtInsert.run({
          id:          item.id,
          title:       item.title,
          model:       item.model || 'Unknown',
          price:       item.price ?? null,
          currency:    item.currency || 'PLN',
          location:    item.location || '',
          url:         item.url,
          image:       item.image || null,
          cc:          item.cc || 0,
          source:      item.source || 'Unknown',
          first_seen:  now,
          last_seen:   now,
          valid_until: item.validUntil || null,
        });

        if (item.price !== null && item.price !== undefined) {
          stmtAddPrice.run(item.id, item.price, now);
        }

        newCount++;
      }
    }
  });

  run(newItems);
  exportPublicJson();
  return { newCount, updatedCount };
}

// ──────────────────────────────────────────────
// MARK INACTIVE
// ──────────────────────────────────────────────

function markInactiveIfNotSeen(seenUrls, source) {
  if (seenUrls.length === 0) return;
  const placeholders = seenUrls.map(() => '?').join(',');

  db.prepare(`
    UPDATE listings SET is_active = 0
    WHERE source = ? AND url NOT IN (${placeholders}) AND is_active = 1
  `).run(source, ...seenUrls);

  exportPublicJson();
}

// ──────────────────────────────────────────────
// QUERY LISTINGS
// ──────────────────────────────────────────────

function getListings({ source, minPrice, maxPrice, search, model, engine, excludeTenere, activeOnly = true, limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (activeOnly)       { where.push('is_active = 1'); }
  if (source)           { where.push('source = ?');    params.push(source); }
  if (model)            { where.push('model = ?');     params.push(model); }
  if (minPrice != null) { where.push('price >= ?');    params.push(minPrice); }
  if (maxPrice != null) { where.push('price <= ?');    params.push(maxPrice); }
  if (search) {
    where.push('LOWER(title) LIKE ?');
    params.push('%' + search.toLowerCase() + '%');
  }

  if (engine === '2T') {
    where.push(`(model IN ('YZ 250 2T','YZ 250X') OR (model = 'Yamaha Vintage' AND (LOWER(title) LIKE '%dt%' OR LOWER(title) LIKE '% it%')))`);
  } else if (engine === '4T') {
    where.push(`(model IN ('WR 250F','WR 450F','Tenere 700') OR (model = 'Yamaha Vintage' AND (LOWER(title) LIKE '%xt%' OR LOWER(title) LIKE '% tt%')))`);
  }

  if (excludeTenere) {
    where.push(`(model != 'Tenere 700' AND NOT (model = 'Yamaha Vintage' AND LOWER(title) LIKE '%tenere%'))`);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sql = `SELECT * FROM listings ${whereClause} ORDER BY cc DESC, first_seen DESC LIMIT ? OFFSET ?`;

  const listings = db.prepare(sql).all(...params, limit, offset);
  const total    = db.prepare(`SELECT COUNT(*) as cnt FROM listings ${whereClause}`).get(...params).cnt;

  return { listings, total };
}

// ──────────────────────────────────────────────
// STATS
// ──────────────────────────────────────────────

function getStats() {
  const totalActive = db.prepare('SELECT COUNT(*) as cnt FROM listings WHERE is_active = 1').get().cnt;
  const totalAll    = db.prepare('SELECT COUNT(*) as cnt FROM listings').get().cnt;

  const priceRow = db.prepare(`
    SELECT AVG(price) as avg, MIN(price) as min, MAX(price) as max
    FROM listings WHERE is_active = 1 AND price IS NOT NULL
  `).get();

  const today = new Date().toISOString().slice(0, 10);
  const newToday = db.prepare(
    `SELECT COUNT(*) as cnt FROM listings WHERE first_seen LIKE ?`
  ).get(today + '%').cnt;

  const bySource = db.prepare(`
    SELECT source, COUNT(*) as count FROM listings WHERE is_active = 1 GROUP BY source
  `).all();

  const byModel = db.prepare(`
    SELECT model, COUNT(*) as count FROM listings WHERE is_active = 1 GROUP BY model
  `).all();

  const lastRun = db.prepare(
    'SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1'
  ).get() || null;

  const priceRanges = [
    { label: 'Under 5k',  min: 0,     max: 4999  },
    { label: '5k-10k',    min: 5000,  max: 9999  },
    { label: '10k-15k',   min: 10000, max: 14999 },
    { label: '15k-20k',   min: 15000, max: 19999 },
    { label: '20k-30k',   min: 20000, max: 29999 },
    { label: 'Over 30k',  min: 30000, max: null   },
  ].map(({ label, min, max }) => {
    const cnt = max !== null
      ? db.prepare(`SELECT COUNT(*) as cnt FROM listings WHERE is_active=1 AND price >= ? AND price <= ?`).get(min, max).cnt
      : db.prepare(`SELECT COUNT(*) as cnt FROM listings WHERE is_active=1 AND price >= ?`).get(min).cnt;
    return { range: label, count: cnt };
  }).filter(r => r.count > 0);

  return {
    totalActive,
    totalAll,
    avgPrice:  priceRow.avg ? Math.round(priceRow.avg) : 0,
    minPrice:  priceRow.min ?? null,
    maxPrice:  priceRow.max ?? null,
    newToday,
    bySource,
    byModel,
    lastRun,
    priceRanges,
  };
}

// ──────────────────────────────────────────────
// SCRAPE RUN TRACKING
// ──────────────────────────────────────────────

function recordScrapeRun(startedAt) {
  const result = db.prepare(
    'INSERT INTO scrape_runs (started_at) VALUES (?)'
  ).run(startedAt);
  return result.lastInsertRowid;
}

function finishScrapeRun(runId, { totalFound, newListings, updated }) {
  db.prepare(`
    UPDATE scrape_runs SET finished_at=?, total_found=?, new_listings=?, updated=?
    WHERE id=?
  `).run(new Date().toISOString(), totalFound, newListings, updated, runId);
}

// ──────────────────────────────────────────────
// PRICE HISTORY
// ──────────────────────────────────────────────

function getPriceHistory(listingId) {
  return db.prepare(
    'SELECT * FROM price_history WHERE listing_id = ? ORDER BY recorded_at ASC'
  ).all(listingId);
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
