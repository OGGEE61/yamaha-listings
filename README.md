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

No external database needed — `listings.json` committed to the repo **is** the database.

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
