/**
 * One-time migration: import listings.json -> listings.db
 * Run once: node migrate_json_to_sqlite.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const JSON_PATH = path.join(__dirname, 'listings.json');
const DB_PATH   = path.join(__dirname, 'listings.db');

if (!fs.existsSync(JSON_PATH)) {
  console.error('listings.json not found, nothing to migrate.');
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const db  = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// Ensure schema exists (db.js already creates it, but be safe)
db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'Unknown',
    price INTEGER, currency TEXT NOT NULL DEFAULT 'PLN', location TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL, image TEXT, cc INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'Unknown', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    valid_until TEXT, is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT NOT NULL REFERENCES listings(id),
    price INTEGER NOT NULL, recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scrape_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
    total_found INTEGER NOT NULL DEFAULT 0, new_listings INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0
  );
`);

const insert = db.prepare(`
  INSERT OR IGNORE INTO listings
    (id, title, model, price, currency, location, url, image, cc, source, first_seen, last_seen, valid_until, is_active)
  VALUES
    (@id, @title, @model, @price, @currency, @location, @url, @image, @cc, @source, @first_seen, @last_seen, @valid_until, @is_active)
`);

const insertPrice = db.prepare(`
  INSERT OR IGNORE INTO price_history (listing_id, price, recorded_at) VALUES (?, ?, ?)
`);

const insertRun = db.prepare(`
  INSERT OR IGNORE INTO scrape_runs (id, started_at, finished_at, total_found, new_listings, updated)
  VALUES (@id, @started_at, @finished_at, @total_found, @new_listings, @updated)
`);

let listingCount = 0;
let priceCount   = 0;
let runCount     = 0;

const migrateAll = db.transaction(() => {
  // Listings
  for (const [id, l] of Object.entries(raw.listings || {})) {
    insert.run({
      id:          l.id || id,
      title:       l.title || '',
      model:       l.model || 'Unknown',
      price:       l.price ?? null,
      currency:    l.currency || 'PLN',
      location:    l.location || '',
      url:         l.url || '',
      image:       l.image || null,
      cc:          l.cc || 0,
      source:      l.source || 'Unknown',
      first_seen:  l.first_seen || new Date().toISOString(),
      last_seen:   l.last_seen  || new Date().toISOString(),
      valid_until: l.valid_until || null,
      is_active:   l.is_active !== undefined ? l.is_active : 1,
    });
    listingCount++;
  }

  // Price history
  for (const h of (raw.price_history || [])) {
    insertPrice.run(h.listing_id, h.price, h.recorded_at);
    priceCount++;
  }

  // Scrape runs
  for (const r of (raw.scrape_runs || [])) {
    insertRun.run({
      id:           r.id,
      started_at:   r.started_at,
      finished_at:  r.finished_at || null,
      total_found:  r.total_found || 0,
      new_listings: r.new_listings || 0,
      updated:      r.updated || 0,
    });
    runCount++;
  }
});

migrateAll();

console.log(`Migration complete:`);
console.log(`  Listings    : ${listingCount}`);
console.log(`  Price rows  : ${priceCount}`);
console.log(`  Scrape runs : ${runCount}`);
