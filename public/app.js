/* ============================================
   YZ250 Tracker — Dashboard Logic
   ============================================ */

const PAGE_SIZE = 24;
let currentPage = 0;
let totalListings = 0;
let debounceTimer = null;
let autoRefreshInterval = null;

// ──────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadListings();
  checkScrapeStatus();

  // Auto-refresh dashboard data every 60 seconds
  autoRefreshInterval = setInterval(() => {
    loadStats();
    loadListings();
    checkScrapeStatus();
  }, 60000);
});

// ──────────────────────────────────────────────
// STATS
// ──────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    renderStats(data);
    renderPriceChart(data.priceRanges || []);
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function renderStats(data) {
  setText('statTotal', data.totalActive ?? '—');
  setText('statAvg', data.avgPrice ? formatPrice(Math.round(data.avgPrice)) : '—');
  setText('statMin', data.minPrice ? formatPrice(data.minPrice) : '—');
  setText('statMax', data.maxPrice ? formatPrice(data.maxPrice) : '—');
  setText('statNewToday', data.newToday ?? '0');

  if (data.lastRun) {
    const ago = timeAgo(data.lastRun.finished_at || data.lastRun.started_at);
    setText('lastUpdated', `Last scraped ${ago}`);
  }
}

function renderPriceChart(ranges) {
  const container = document.getElementById('priceChart');
  if (!ranges || ranges.length === 0) {
    container.innerHTML = '<div class="chart-loading">No price data yet — run a scrape first</div>';
    return;
  }

  const maxCount = Math.max(...ranges.map(r => r.count), 1);
  const maxHeight = 100; // px

  container.innerHTML = ranges.map(r => {
    const height = Math.max(4, Math.round((r.count / maxCount) * maxHeight));
    return `
      <div class="chart-bar-wrap">
        <div class="chart-bar-count">${r.count}</div>
        <div class="chart-bar" style="height:${height}px" title="${r.range}: ${r.count} listing(s)"></div>
        <div class="chart-bar-label">${r.range}</div>
      </div>`;
  }).join('');
}

// ──────────────────────────────────────────────
// LISTINGS
// ──────────────────────────────────────────────

async function loadListings(page = 0) {
  currentPage = page;
  const grid = document.getElementById('listingsGrid');
  grid.innerHTML = '<div class="loading-spinner"></div>';

  const params = new URLSearchParams({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const search  = document.getElementById('filterSearch').value.trim();
  const minPrice = document.getElementById('filterMin').value;
  const maxPrice = document.getElementById('filterMax').value;
  const model   = document.getElementById('filterModel').value;
  const engine  = document.getElementById('filterEngine').value;
  const source  = document.getElementById('filterSource').value;
  const excludeTenere = document.getElementById('excludeTenere').checked;

  if (search)   params.set('search',   search);
  if (minPrice) params.set('minPrice', minPrice);
  if (maxPrice) params.set('maxPrice', maxPrice);
  if (model)    params.set('model',    model);
  if (engine)   params.set('engine',   engine);
  if (source)   params.set('source',  source);
  if (excludeTenere) params.set('excludeTenere', 'true');

  try {
    const res = await fetch(`/api/listings?${params}`);
    const { listings, total } = await res.json();
    totalListings = total;

    setText('listingMeta', `Showing ${listings.length} of ${total} Yamaha listings`);
    renderListings(listings);
    renderPagination(total, page);
  } catch (err) {
    grid.innerHTML = '<div class="empty-state"><p>Failed to load listings. Is the server running?</p></div>';
  }
}

function renderListings(listings) {
  const grid = document.getElementById('listingsGrid');

  if (!listings || listings.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <h3>No listings found</h3>
        <p>Try adjusting your filters or trigger a scrape.</p>
      </div>`;
    return;
  }

  const today = new Date().toDateString();
  grid.innerHTML = listings.map(l => {
    const isNew = l.first_seen && new Date(l.first_seen).toDateString() === today;
    const priceHtml = l.price
      ? `<div class="listing-price">${formatPrice(l.price)} ${l.currency || 'PLN'}</div>`
      : `<div class="listing-price no-price">Price on request</div>`;

    const imgHtml = l.image
      ? `<img class="listing-img" src="${escHtml(l.image)}" alt="${escHtml(l.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="listing-img-placeholder" style="display:none">${motorcycleIcon()}</div>`
      : `<div class="listing-img-placeholder">${motorcycleIcon()}</div>`;

    const location = l.location ? `
      <span class="listing-chip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>
        ${escHtml(l.location)}
      </span>` : '';

    const dateChip = l.first_seen ? `
      <span class="listing-chip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        ${timeAgo(l.first_seen)}
      </span>` : '';

    return `
      <article class="listing-card${isNew ? ' new' : ''}">
        ${imgHtml}
        <div class="listing-body">
          <div class="listing-title">${escHtml(l.title)}</div>
          ${priceHtml}
          <div class="listing-meta-row">
            ${location}
            ${dateChip}
            <span class="listing-source" style="background:var(--gray-200);color:var(--gray-800);border-color:var(--gray-300);">${escHtml(l.model || 'Unknown')}</span>
            <span class="listing-source">${escHtml(l.source || 'Unknown')}</span>
          </div>
        </div>
        <div class="listing-footer">
          <a class="listing-link" href="${escHtml(l.url)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/>
            </svg>
            View Listing
          </a>
        </div>
      </article>`;
  }).join('');
}

function renderPagination(total, page) {
  const container = document.getElementById('pagination');
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const pages = [];

  // Prev button
  pages.push(`<button class="page-btn" onclick="loadListings(${page - 1})" ${page === 0 ? 'disabled' : ''}>← Prev</button>`);

  // Page numbers (show max 7 pages around current)
  const start = Math.max(0, page - 3);
  const end   = Math.min(totalPages - 1, page + 3);
  if (start > 0)             pages.push(`<button class="page-btn" onclick="loadListings(0)">1</button>${start > 1 ? '<span style="color:var(--text-muted)">…</span>' : ''}`);
  for (let i = start; i <= end; i++) {
    pages.push(`<button class="page-btn${i === page ? ' active' : ''}" onclick="loadListings(${i})">${i + 1}</button>`);
  }
  if (end < totalPages - 1) pages.push(`${end < totalPages - 2 ? '<span style="color:var(--text-muted)">…</span>' : ''}<button class="page-btn" onclick="loadListings(${totalPages - 1})">${totalPages}</button>`);

  // Next button
  pages.push(`<button class="page-btn" onclick="loadListings(${page + 1})" ${page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>`);

  container.innerHTML = pages.join('');
}

// ──────────────────────────────────────────────
// SCRAPE
// ──────────────────────────────────────────────

async function triggerScrape() {
  const btn = document.getElementById('btnScrape');
  btn.disabled = true;
  btn.textContent = 'Scraping…';

  try {
    await fetch('/api/scrape', { method: 'POST' });
    showToast('Scrape started! Dashboard will update automatically.', 'success');

    // Poll for completion
    let polls = 0;
    const poll = setInterval(async () => {
      polls++;
      const status = await checkScrapeStatus();
      if (!status.running || polls > 60) {
        clearInterval(poll);
        btn.disabled = false;
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Refresh Now`;
        loadStats();
        loadListings();
      }
    }, 3000);
  } catch (err) {
    showToast('Failed to trigger scrape.', 'error');
    btn.disabled = false;
  }
}

async function checkScrapeStatus() {
  try {
    const res = await fetch('/api/scrape-status');
    const status = await res.json();
    const pill = document.getElementById('scrapeStatus');
    const dot  = pill.querySelector('.status-dot');
    const label = pill.querySelector('.status-label');

    if (status.running) {
      dot.className = 'status-dot running';
      label.textContent = 'Scraping…';
    } else {
      dot.className = 'status-dot idle';
      label.textContent = status.lastRun ? `Updated ${timeAgo(status.lastRun)}` : 'Ready';
    }
    return status;
  } catch { return {}; }
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function debounceLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => loadListings(0), 350);
}

function formatPrice(n) {
  if (!n && n !== 0) return '—';
  return n.toLocaleString('pl-PL') + ' zł';
}

function timeAgo(iso) {
  if (!iso) return 'unknown';
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (secs < 60)      return 'just now';
  if (secs < 3600)    return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)   return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800)  return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function motorcycleIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
    <path d="M5 17H3a2 2 0 01-2-2v-2l3-3 2-4h7l2 4 2-1 2 2v4a2 2 0 01-2 2h-2"/>
    <circle cx="5" cy="17" r="2"/><circle cx="19" cy="17" r="2"/>
  </svg>`;
}

function showToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
