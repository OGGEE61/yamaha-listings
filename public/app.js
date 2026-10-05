/* ============================================
   Yamaha Listings Tracker — D1-Powered Dashboard
   Fetches & filters directly from Cloudflare D1
   ============================================ */

const PAGE_SIZE = 24;
let currentPage = 0;
let debounceTimer = null;
let priceChart = null;

// ──────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadListings(0);
});

// ──────────────────────────────────────────────
// DATA FETCHING & FILTERING (via Cloudflare D1 API)
// ──────────────────────────────────────────────

async function loadListings(page = 0) {
  currentPage = page;
  const search        = document.getElementById('filterSearch').value.trim();
  const minPrice      = document.getElementById('filterMin').value;
  const maxPrice      = document.getElementById('filterMax').value;
  const model         = document.getElementById('filterModel').value;
  const engine        = document.getElementById('filterEngine').value;
  const source        = document.getElementById('filterSource').value;
  const excludeTenere = document.getElementById('excludeTenere').checked;
  const showInactive  = document.getElementById('showInactive') ? document.getElementById('showInactive').checked : false;
  const iconicBlue    = document.getElementById('filterIconicBlue') ? document.getElementById('filterIconicBlue').checked : false;

  const params = new URLSearchParams();
  params.set('limit', PAGE_SIZE);
  params.set('offset', page * PAGE_SIZE);
  if (search) params.set('search', search);
  if (minPrice) params.set('minPrice', minPrice);
  if (maxPrice) params.set('maxPrice', maxPrice);
  if (model) params.set('model', model);
  if (engine) params.set('engine', engine);
  if (source) params.set('source', source);
  if (excludeTenere) params.set('excludeTenere', 'true');
  if (showInactive) params.set('activeOnly', 'false');
  if (iconicBlue) params.set('iconicBlue', 'true');

  try {
    const res = await fetch(`/api/listings?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const listings = data.listings || [];
    const total = data.total || 0;
    const stats = data.stats || { total, avgPrice: 0, minPrice: null, maxPrice: null, newToday: 0, prices: [] };

    // Update status & timestamps
    if (data.updatedAt) {
      setText('lastUpdated', `Last scraped ${timeAgo(data.updatedAt)}`);
      const statusPill = document.getElementById('scrapeStatus');
      if (statusPill) {
        statusPill.innerHTML = `<span class="status-dot" style="background:#10b981"></span><span class="status-label">Up to date</span>`;
      }
    }

    renderStats(stats);
    renderPriceChart(stats.prices || []);
    setText('listingMeta', `Showing ${listings.length} of ${total} listings`);
    renderListings(listings);
    renderPagination(total, page);

  } catch (err) {
    console.warn('[Dashboard] Direct D1 query failed, trying /listings.json fallback...', err);
    await fallbackFetchAll(page);
  }
}

// Fallback in case /api/listings is unavailable
let cachedFallbackListings = null;
async function fallbackFetchAll(page = 0) {
  try {
    if (!cachedFallbackListings) {
      const res = await fetch('./listings.json');
      if (!res.ok) throw new Error('listings.json not found');
      const data = await res.json();
      cachedFallbackListings = data.listings || [];
    }

    const search        = document.getElementById('filterSearch').value.trim().toLowerCase();
    const minPrice      = parseInt(document.getElementById('filterMin').value) || 0;
    const maxPrice      = parseInt(document.getElementById('filterMax').value) || Infinity;
    const model         = document.getElementById('filterModel').value;
    const engine        = document.getElementById('filterEngine').value;
    const source        = document.getElementById('filterSource').value;
    const excludeTenere = document.getElementById('excludeTenere').checked;
    const showInactive  = document.getElementById('showInactive')?.checked || false;
    const iconicBlue    = document.getElementById('filterIconicBlue')?.checked || false;

    const filtered = cachedFallbackListings.filter(l => {
      if (!showInactive && l.is_active === 0) return false;
      if (source && l.source !== source) return false;
      if (model  && l.model  !== model)  return false;
      if (iconicBlue && l.iconic_blue !== 1) return false;
      if (engine === '2T') {
        const is2T = l.model === 'YZ 250 2T' || l.model === 'YZ 250X' || (l.model === 'Yamaha Vintage' && /\b(dt|it)\b/i.test(l.title));
        if (!is2T) return false;
      }
      if (engine === '4T') {
        const is4T = l.model === 'WR 250F' || l.model === 'WR 450F' || l.model === 'Tenere 700' || (l.model === 'Yamaha Vintage' && /\b(xt|tt)\b/i.test(l.title));
        if (!is4T) return false;
      }
      if (excludeTenere) {
        if (l.model === 'Tenere 700' || l.model === 'XJ6 Naked' || (l.model === 'Yamaha Vintage' && /tenere/i.test(l.title))) return false;
      }
      if (l.price && minPrice && l.price < minPrice) return false;
      if (l.price && maxPrice < Infinity && l.price > maxPrice) return false;
      if (search && !l.title.toLowerCase().includes(search)) return false;
      return true;
    });

    const total = filtered.length;
    const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const prices = filtered.map(l => l.price).filter(Boolean);

    renderStats({
      total,
      avgPrice: prices.length ? Math.round(prices.reduce((a,b)=>a+b,0)/prices.length) : 0,
      minPrice: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
      newToday: filtered.filter(l => l.first_seen && new Date(l.first_seen).toDateString() === new Date().toDateString()).length,
    });
    renderPriceChart(prices);
    setText('listingMeta', `Showing ${slice.length} of ${total} listings`);
    renderListings(slice);
    renderPagination(total, page);

  } catch (e) {
    document.getElementById('listingsGrid').innerHTML =
      '<div class="empty-state"><p>Could not load listings. Please ensure Cloudflare D1 is connected.</p></div>';
  }
}

function applyAndRender(page = 0) {
  loadListings(page);
}

function debounceLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => loadListings(0), 300);
}

function onModelChange() {
  const model = document.getElementById('filterModel').value;
  if (model) {
    document.getElementById('filterEngine').value = ""; // Reset to All Engines
    document.getElementById('excludeTenere').checked = false; // Uncheck hide toggle
  }
  loadListings(0);
}

// ──────────────────────────────────────────────
// STATS
// ──────────────────────────────────────────────

function renderStats(stats) {
  setText('statTotal',    stats.total || 0);
  setText('statAvg',      stats.avgPrice ? formatPrice(stats.avgPrice) : '—');
  setText('statMin',      stats.minPrice ? formatPrice(stats.minPrice) : '—');
  setText('statMax',      stats.maxPrice ? formatPrice(stats.maxPrice) : '—');
  setText('statNewToday', stats.newToday || 0);
}

function renderPriceChart(prices) {
  const canvas = document.getElementById('priceChartCanvas');
  const container = document.getElementById('priceChartContainer');

  if (!prices || prices.length === 0) {
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    canvas.style.display = 'none';
    if (!document.getElementById('noChartData')) {
      const msg = document.createElement('div');
      msg.id = 'noChartData';
      msg.className = 'chart-loading';
      msg.textContent = 'No price data for current filters';
      msg.style.position = 'absolute';
      msg.style.top = '50%';
      msg.style.left = '50%';
      msg.style.transform = 'translate(-50%, -50%)';
      container.appendChild(msg);
    }
    return;
  }
  
  canvas.style.display = 'block';
  const noDataMsg = document.getElementById('noChartData');
  if (noDataMsg) noDataMsg.remove();

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const step = Math.ceil((max - min) / 8 / 1000) * 1000 || 1000;
  
  const buckets = {};
  for (let s = Math.floor(min/step)*step; s <= max; s += step) {
    buckets[s] = 0;
  }
  prices.forEach(p => {
    const bucket = Math.floor(p / step) * step;
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  });

  const labels = Object.keys(buckets).map(k => {
    const startK = Math.round(k/1000);
    const endK = Math.round((parseInt(k)+step)/1000);
    return `${startK}k - ${endK}k PLN`;
  });
  const data = Object.values(buckets);

  if (priceChart) {
    priceChart.data.labels = labels;
    priceChart.data.datasets[0].data = data;
    priceChart.update();
  } else {
    const ctx = canvas.getContext('2d');
    
    // Create gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0.1)');

    Chart.defaults.color = '#cbd5e1';
    Chart.defaults.font.family = 'Inter, sans-serif';

    priceChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Listings',
          data: data,
          backgroundColor: gradient,
          borderRadius: 4,
          borderSkipped: false,
          hoverBackgroundColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(10, 45, 130, 0.95)',
            titleColor: '#fff',
            bodyColor: '#fff',
            titleFont: { size: 13, weight: 'bold' },
            bodyFont: { size: 14 },
            padding: 12,
            borderColor: 'rgba(255,255,255,0.2)',
            borderWidth: 1,
            displayColors: false,
            callbacks: {
              label: function(context) {
                return context.parsed.y + ' listing(s)';
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { stepSize: 1, precision: 0 },
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            border: { display: false }
          },
          x: {
            grid: { display: false },
            border: { display: false }
          }
        },
        animation: { duration: 600 }
      }
    });
  }
}

// ──────────────────────────────────────────────
// LISTINGS RENDER
// ──────────────────────────────────────────────

function renderListings(listings) {
  const grid = document.getElementById('listingsGrid');

  if (!listings || listings.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <h3>No listings found</h3>
        <p>Try adjusting your filters.</p>
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

    let iconicBlueTag = '';
    if (l.iconic_blue === 1) {
      let parts = [];
      try { parts = JSON.parse(l.iconic_blue_parts || '[]'); } catch (_) {}
      const tip = parts.length ? `Iconic Blue: ${parts.join(', ')}` : 'Iconic Blue';
      iconicBlueTag = `<span class="listing-source tag-iconic-blue" title="${escHtml(tip)}">Iconic Blue</span>`;
    }

    return `
      <article class="listing-card${isNew ? ' new' : ''}" style="${l.is_active === 0 ? 'opacity: 0.6;' : ''}">
        ${imgHtml}
        <div class="listing-body">
          <div class="listing-title">${escHtml(l.title)}</div>
          ${priceHtml}
          <div class="listing-meta-row">
            ${location}
            ${dateChip}
            ${l.cc ? `<span class="listing-source" style="background:#e0f2fe;color:#0369a1;border-color:#bae6fd;">${l.cc} cc</span>` : ''}
            ${iconicBlueTag}
            <span class="listing-source" style="background:var(--gray-200);color:var(--gray-800);border-color:var(--gray-300);">${escHtml(l.model || 'Unknown')}</span>
            <span class="listing-source">${escHtml(l.source || 'OLX.pl')}</span>
            ${l.is_active === 0 ? `<span class="listing-source" style="background:#fecdd3;color:#e11d48;border-color:#fda4af;">Inactive</span>` : ''}
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
  pages.push(`<button class="page-btn" onclick="applyAndRender(${page - 1})" ${page === 0 ? 'disabled' : ''}>← Prev</button>`);

  const start = Math.max(0, page - 3);
  const end   = Math.min(totalPages - 1, page + 3);
  if (start > 0) pages.push(`<button class="page-btn" onclick="applyAndRender(0)">1</button>${start > 1 ? '<span style="color:var(--text-muted)">…</span>' : ''}`);
  for (let i = start; i <= end; i++) {
    pages.push(`<button class="page-btn${i === page ? ' active' : ''}" onclick="applyAndRender(${i})">${i + 1}</button>`);
  }
  if (end < totalPages - 1) pages.push(`${end < totalPages - 2 ? '<span style="color:var(--text-muted)">…</span>' : ''}<button class="page-btn" onclick="applyAndRender(${totalPages - 1})">${totalPages}</button>`);
  pages.push(`<button class="page-btn" onclick="applyAndRender(${page + 1})" ${page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>`);

  container.innerHTML = pages.join('');
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

async function triggerScrape() {
  const statusPill = document.getElementById('scrapeStatus');
  const btn = document.getElementById('btnScrape');
  
  if (statusPill) {
    statusPill.innerHTML = `<span class="status-dot" style="background:#f59e0b; animation: pulse 1.5s infinite"></span><span class="status-label">Refreshing...</span>`;
  }
  if (btn) btn.disabled = true;

  try {
    await loadListings(0);
    showToast('Dashboard data refreshed from D1!', 'success');
  } catch (err) {
    if (statusPill) {
      statusPill.innerHTML = `<span class="status-dot" style="background:#ef4444"></span><span class="status-label">Error</span>`;
    }
    showToast('Failed to refresh data', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function formatPrice(n) {
  if (!n && n !== 0) return '—';
  return n.toLocaleString('pl-PL') + ' zł';
}

function timeAgo(iso) {
  if (!iso) return 'unknown';
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (secs < 60)     return 'just now';
  if (secs < 3600)   return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)  return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('pl-PL');
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
