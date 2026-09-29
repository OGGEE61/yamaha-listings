<p align="center">
  <img src="public/Yamaha_Motor_Racing_logo.svg" alt="Yamaha" width="100%"/>
</p>

# Yamaha Listings Tracker

> Automated scraper and dashboard for Yamaha motorcycle listings on OLX.pl — focused on lightweight 2-stroke and 4-stroke off-road bikes.

---

## 🏍️ What it tracks

| Model | Type | Notes |
|---|---|---|
| **YZ 250 2T** | 2T Motocross | Core target |
| **YZ 250X** | 2T Enduro | Enduro version of the YZ250 |
| **WR 250F** | 4T Enduro | |
| **WR 450F** | 4T Enduro | |
| **Yamaha Vintage** | 2T/4T | DT, IT (2T) · XT, TT (4T) |
| **Ténéré 700** | 4T Adventure | Hidden by default, toggleable |

**Excluded:** Super Ténéré (XT1200Z), competing brands (KTM, Beta, Honda…), spam listings.

---

## 🌐 Dashboard

Static frontend hosted on **Cloudflare Pages** — no server, no database.

- Filter by engine type (2T / 4T)
- Filter by exact model
- Price range filter
- Full-text search
- Toggle to hide Ténéré 700 listings

---

## ⚙️ How it works

```
GitHub Actions (runs twice daily: 9:00 + 19:00 CEST)
  └─ node scraper.js
       ├─ fetches OLX.pl listings via Puppeteer
       ├─ verifies each listing (title + description)
       ├─ classifies the exact Yamaha model
       └─ saves → public/listings.json + git commit

Cloudflare Pages (auto-deploys on every push)
  └─ serves public/ as a static site
       └─ app.js loads listings.json and filters in-browser
```

No external database server needed — `listings.json` committed to the repo **is** the database for the frontend, generated from a local SQLite database (`listings.db`) during the scraping process.

---

## 🗄️ Data Model

The data is stored in a local SQLite database (`listings.db`) which contains the following tables:

1. **`listings`**: The core table containing all motorcycles.
   - `id`: Unique identifier (usually extracted from the OLX URL).
   - `title`, `model`, `price`, `currency`, `location`, `url`, `image`, `cc`, `source`: Basic details about the bike.
   - `first_seen` & `last_seen`: Timestamps to track when the listing appeared and when it was last verified.
   - `is_active`: Boolean (`1` or `0`) indicating if the listing is still live on the marketplace.

2. **`price_history`**: Tracks price drops/increases for each listing.
   - `listing_id`: Foreign key to the listing.
   - `price` & `recorded_at`: The price at a given time.

3. **`scrape_runs`**: Metadata about the scraper's execution.
   - `started_at`, `finished_at`, `total_found`, `new_listings`, `updated`: Stats for each run.

When the scraper finishes, it queries the `listings` table and exports everything to `public/listings.json` for the Cloudflare Pages dashboard to consume.

---

## 🚀 Local development

```bash
npm install
node scraper.js       # run scraper once, generates public/listings.json
npx serve public/     # preview the static dashboard locally
```

Or run the full server (for local scraping on a schedule):

```bash
node server.js        # http://localhost:3000
```

---

## 🔧 GitHub Actions

The workflow at [`.github/workflows/scrape.yml`](.github/workflows/scrape.yml) runs automatically.
You can also trigger it manually: **Actions → Scrape Yamaha Listings → Run workflow**.

---

## 📦 Stack

- **Scraper:** Node.js + Puppeteer (headless Chrome)
- **Frontend:** Vanilla HTML/CSS/JS — zero dependencies
- **Hosting:** Cloudflare Pages (free tier)
- **CI:** GitHub Actions
