/**
 * CV Heatmap & Human-in-the-Loop (HITL) Engine
 * Yamaha Iconic Blue visual detection, thermal heatmap overlays,
 * color segmentation masks, and active learning verification workflow.
 */

(function (window) {
  'use strict';

  // Target Yamaha Racing Blue spectrum:
  // Nominal hue: ~220° (cobalt / racing blue #0033A0 to #1E4FC8)
  function analyzePixelScore(r, g, b, sensitivity = 1.0) {
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
    const d = max - min;
    let h = 0, s = 0, l = (max + min) / 2;

    if (d > 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
      else if (max === gf) h = ((bf - rf) / d + 2) / 6;
      else h = ((rf - gf) / d + 4) / 6;
      h *= 360;
    }

    // Must be in the cobalt/royal blue spectrum (approx 202° - 242°)
    if (h < 202 || h > 242) return 0;

    // Reject low saturation (grays, whites, metals)
    if (s < 0.30) return 0;

    // Reject very dark shadows or blown out highlights
    if (l < 0.10 || l > 0.78) return 0;

    const hueDelta = Math.abs(h - 220);
    const hueWeight = Math.max(0, 1 - hueDelta / 22);
    const satWeight = Math.min(1, Math.max(0, (s - 0.30) / 0.50));
    const lightWeight = 1 - Math.abs(l - 0.44) / 0.34;

    const rawScore = hueWeight * satWeight * Math.max(0, lightWeight);
    return Math.min(1, rawScore * sensitivity * 1.35);
  }

  // Thermal / Turbo Colormap: Blue -> Cyan -> Green -> Yellow -> Red -> Magenta
  function scoreToThermalRgba(score) {
    if (score <= 0.05) return [0, 0, 0, 0];
    const s = Math.min(1, Math.max(0, (score - 0.05) / 0.95));

    let r = 0, g = 0, b = 0, a = Math.min(240, Math.floor(130 + s * 110));

    if (s < 0.25) {
      // Deep blue to cyan
      const t = s / 0.25;
      r = 0;
      g = Math.floor(t * 220);
      b = 255;
    } else if (s < 0.5) {
      // Cyan to lime-green
      const t = (s - 0.25) / 0.25;
      r = Math.floor(t * 180);
      g = 255;
      b = Math.floor((1 - t) * 255);
    } else if (s < 0.75) {
      // Lime-green to bright yellow/orange
      const t = (s - 0.5) / 0.25;
      r = 255;
      g = Math.floor(255 - t * 75);
      b = 0;
    } else {
      // Orange to intense red/magenta hotspot
      const t = (s - 0.75) / 0.25;
      r = 255;
      g = Math.floor((1 - t) * 180);
      b = Math.floor(t * 140);
    }

    return [r, g, b, a];
  }

  /**
   * Process and draw CV Heatmap or Color Mask onto a canvas.
   */
  function processCvCanvas(img, canvas, { mode = 'heatmap', sensitivity = 1.0 } = {}) {
    if (!img || !canvas) return null;
    const w = canvas.width = img.naturalWidth || img.width || 400;
    const h = canvas.height = img.naturalHeight || img.height || 260;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    if (mode === 'original' || mode === 'photo') {
      ctx.drawImage(img, 0, 0, w, h);
      return { totalScore: 0, blueRatio: 0, peakScore: 0, confidencePct: 0, dominantHex: '#0032A0' };
    }

    // Use an offscreen canvas to isolate pixel processing and prevent tainting
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!offCtx) return null;

    offCtx.drawImage(img, 0, 0, w, h);

    let imgData;
    try {
      imgData = offCtx.getImageData(0, 0, w, h);
    } catch (err) {
      // Cross-origin image without CORS headers
      return null;
    }

    const data = imgData.data;
    const totalPixels = w * h;
    let bluePixelCount = 0;
    let sumScore = 0;
    let peakScore = 0;
    let dominantR = 0, dominantG = 50, dominantB = 160;

    if (mode === 'heatmap') {
      // Draw semi-darkened original background, then thermal activations
      for (let i = 0; i < data.length; i += 4) {
        const score = analyzePixelScore(data[i], data[i + 1], data[i + 2], sensitivity);
        if (score > 0.15) {
          bluePixelCount++;
          sumScore += score;
          if (score > peakScore) {
            peakScore = score;
            dominantR = data[i];
            dominantG = data[i + 1];
            dominantB = data[i + 2];
          }
          const [hr, hg, hb, ha] = scoreToThermalRgba(score);
          // Alpha blend thermal color over original pixel
          const alpha = ha / 255;
          data[i] = Math.floor(data[i] * (1 - alpha * 0.7) + hr * alpha);
          data[i + 1] = Math.floor(data[i + 1] * (1 - alpha * 0.7) + hg * alpha);
          data[i + 2] = Math.floor(data[i + 2] * (1 - alpha * 0.7) + hb * alpha);
        } else {
          // Dim non-target background slightly to highlight detections
          data[i] = Math.floor(data[i] * 0.65);
          data[i + 1] = Math.floor(data[i + 1] * 0.65);
          data[i + 2] = Math.floor(data[i + 2] * 0.65);
        }
      }
    } else if (mode === 'mask') {
      // Isolate color: keep Iconic Blue vibrant, turn rest to monochrome
      for (let i = 0; i < data.length; i += 4) {
        const score = analyzePixelScore(data[i], data[i + 1], data[i + 2], sensitivity);
        if (score > 0.18) {
          bluePixelCount++;
          sumScore += score;
          if (score > peakScore) {
            peakScore = score;
            dominantR = data[i];
            dominantG = data[i + 1];
            dominantB = data[i + 2];
          }
          // Boost saturation of detected blue parts
          data[i] = Math.max(0, Math.floor(data[i] * 0.9));
          data[i + 1] = Math.min(255, Math.floor(data[i + 1] * 1.05));
          data[i + 2] = Math.min(255, Math.floor(data[i + 2] * 1.25));
        } else {
          // Convert to grayscale
          const gray = Math.floor(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
          data[i] = gray;
          data[i + 1] = gray;
          data[i + 2] = gray;
        }
      }
    }

    offCtx.putImageData(imgData, 0, 0);

    // Draw the processed offscreen buffer onto destination canvas
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(offscreen, 0, 0, w, h);

    const blueRatio = totalPixels > 0 ? (bluePixelCount / totalPixels) : 0;
    const avgScore = bluePixelCount > 0 ? (sumScore / bluePixelCount) : 0;
    const confidencePct = Math.min(99, Math.max(15, Math.round(avgScore * 85 + blueRatio * 1500)));

    return {
      bluePixelCount,
      blueRatio,
      peakScore,
      confidencePct,
      dominantHex: `#${((1 << 24) + (dominantR << 16) + (dominantG << 8) + dominantB).toString(16).slice(1)}`
    };
  }

  // Cache for CORS-friendly proxy images
  const proxyImageCache = new Map();

  /**
   * Safe renderer that draws Heatmap or Mask onto a canvas.
   * If direct getImageData fails due to CDN CORS / canvas tainting,
   * automatically fallbacks to /api/proxy-image without breaking UI.
   */
  function renderCvOnCanvas(img, canvas, { mode = 'heatmap', sensitivity = 1.05, onResult = null } = {}) {
    if (!img || !canvas) return;

    function applyResult(res) {
      if (res && typeof onResult === 'function') {
        onResult(res);
      }
      return res;
    }

    if (mode === 'original' || mode === 'photo') {
      canvas.style.display = 'none';
      return applyResult({ confidencePct: 0, dominantHex: '#0032A0' });
    }

    canvas.style.display = 'block';

    function doProcess(sourceImg) {
      if (!sourceImg.complete || sourceImg.naturalWidth === 0) {
        sourceImg.onload = () => doProcess(sourceImg);
        return null;
      }
      const res = processCvCanvas(sourceImg, canvas, { mode, sensitivity });
      if (res) {
        return applyResult(res);
      }
      return null;
    }

    // Try processing directly first
    try {
      const res = doProcess(img);
      if (res) return res;
    } catch (_) {}

    // Fallback: If getImageData failed (CORS / tainted canvas), load via server proxy with CORS headers
    const rawSrc = img.currentSrc || img.src;
    if (rawSrc && !rawSrc.startsWith('data:') && !rawSrc.includes('/api/proxy-image')) {
      const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(rawSrc)}`;
      if (proxyImageCache.has(proxyUrl)) {
        const cachedImg = proxyImageCache.get(proxyUrl);
        return doProcess(cachedImg);
      }

      const proxyImg = new Image();
      proxyImg.crossOrigin = 'anonymous';
      proxyImg.onload = () => {
        proxyImageCache.set(proxyUrl, proxyImg);
        doProcess(proxyImg);
      };
      proxyImg.onerror = () => {
        // If proxy also fails, draw raw image without crashing
        try {
          const w = canvas.width = img.naturalWidth || 400;
          const h = canvas.height = img.naturalHeight || 260;
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.drawImage(img, 0, 0, w, h);
        } catch (_) {}
      };
      proxyImg.src = proxyUrl;
    }
  }


  /**
   * Calculate grayscale and opacity aging for inactive listings.
   * "im dawniej temu to widzielismy, tym bardziej szare jest ten kafelek"
   */
  function getInactiveAging(lastSeen) {
    if (!lastSeen) {
      return { grayscale: 85, opacity: 0.52, days: 30, label: 'dawno temu' };
    }
    const ms = Date.now() - new Date(lastSeen).getTime();
    const days = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));

    // Scale from day 0 to 45+ days:
    // 0 days: grayscale 30%, opacity 0.88
    // 7 days: grayscale 55%, opacity 0.76
    // 14 days: grayscale 70%, opacity 0.65
    // 30 days: grayscale 88%, opacity 0.52
    // 45+ days: grayscale 100%, opacity 0.40
    const factor = Math.min(1, days / 45);
    const grayscale = Math.round(30 + factor * 70);
    const opacity = +(0.88 - factor * 0.48).toFixed(2);

    let label = `${days} dni temu`;
    if (days === 0) label = 'dzisiaj';
    else if (days === 1) label = 'wczoraj';
    else if (days >= 60) label = `ponad 2 mies. temu (${days}d)`;

    return { grayscale, opacity, days, label };
  }

  /**
   * Modal dialog for deep CV Heatmap Inspection and Human-in-the-Loop review
   */
  let modalInitialized = false;
  let currentModalItem = null;
  let currentModalMode = 'heatmap';

  function ensureModalExists() {
    if (modalInitialized && document.getElementById('cvModal')) return;

    const modalHtml = `
      <dialog id="cvModal" class="cv-modal">
        <div class="cv-modal-box">
          <div class="cv-modal-header">
            <div class="cv-modal-title-group">
              <span class="cv-modal-badge">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
                Model CV & Heatmap Analyzer
              </span>
              <h3 id="cvModalTitle" class="cv-modal-title">Yamaha Listing</h3>
            </div>
            <button class="cv-modal-close" onclick="window.cvHeatmapEngine.closeModal()" title="Zamknij (Esc)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="cv-modal-body">
            <!-- Left: Viewport with canvas heatmap -->
            <div class="cv-viewport-wrapper">
              <div class="cv-viewport" id="cvViewport">
                <img id="cvModalImg" class="cv-base-img" alt="Motorcycle" />
                <canvas id="cvModalCanvas" class="cv-overlay-canvas"></canvas>
                <div class="cv-loading-overlay" id="cvModalLoading">Analizowanie pikseli CV...</div>
              </div>

              <!-- View mode controls -->
              <div class="cv-mode-bar">
                <button class="cv-mode-btn" data-mode="original" onclick="window.cvHeatmapEngine.setMode('original')">
                  Oryginał
                </button>
                <button class="cv-mode-btn active" data-mode="heatmap" onclick="window.cvHeatmapEngine.setMode('heatmap')">
                  Thermal Heatmap
                </button>
                <button class="cv-mode-btn" data-mode="mask" onclick="window.cvHeatmapEngine.setMode('mask')">
                  Maska Koloru
                </button>
              </div>
            </div>

            <!-- Right: CV Insights & Human-in-the-Loop Controls -->
            <div class="cv-insights-panel">
              <div class="cv-insight-card">
                <div class="cv-insight-title">
                  <span>Predykcja Modelu Computer Vision</span>
                  <span id="cvModelName" class="cv-pill-sm">Gemini Vision</span>
                </div>
                <div class="cv-stat-row">
                  <span class="cv-stat-label">Detekcja Iconic Blue:</span>
                  <span id="cvBlueStatus" class="cv-stat-val">—</span>
                </div>
                <div class="cv-stat-row">
                  <span class="cv-stat-label">Wykryte elementy:</span>
                  <div id="cvPartsContainer" class="cv-parts-tags"></div>
                </div>
                <div class="cv-stat-row">
                  <span class="cv-stat-label">Pewność spektralna CV:</span>
                  <span id="cvConfidenceScore" class="cv-confidence-val">--%</span>
                </div>
                <div class="cv-confidence-bar-bg">
                  <div id="cvConfidenceFill" class="cv-confidence-fill" style="width: 0%"></div>
                </div>
                <div class="cv-stat-row" style="margin-top: 10px;">
                  <span class="cv-stat-label">Próbka barwy (Racing Blue):</span>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span id="cvColorSwatch" class="cv-swatch" style="background:#0032A0"></span>
                    <span id="cvColorHex" style="font-family:monospace;font-size:12px;color:var(--text-secondary)">#0032A0</span>
                  </div>
                </div>
              </div>

              <!-- Human in the loop module -->
              <div class="cv-insight-card hitl-highlight-card">
                <div class="cv-insight-title">
                  <span>Human-in-the-Loop (HITL) Studio</span>
                  <span id="cvHitlBadge" class="hitl-status-badge">Oczekuje na weryfikację</span>
                </div>
                <p class="hitl-desc">
                  Weryfikacja ekspercka: Twoja decyzja koryguje wynik AI i zasila zbiór Ground Truth w bazie danych.
                </p>

                <div class="hitl-tag-section" style="margin-bottom:12px;">
                  <span style="font-size:11px;font-weight:700;color:#cbd5e1;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px;">
                    Oznacz powód / tag weryfikacji (opcjonalnie):
                  </span>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;" id="cvHitlPillsContainer">
                    <button type="button" class="cv-tag-pill-btn" onclick="window.cvHeatmapEngine.setTag('Słabe zdjęcie / miniatura')">Słabe zdjęcie / miniatura</button>
                    <button type="button" class="cv-tag-pill-btn" onclick="window.cvHeatmapEngine.setTag('Pozostałe zdjęcia niebieskie')">Pozostałe zdjęcia niebieskie</button>
                    <button type="button" class="cv-tag-pill-btn" onclick="window.cvHeatmapEngine.setTag('Wielokolorowy / zmiana plastików')">Wielokolorowy</button>
                    <button type="button" class="cv-tag-pill-btn" onclick="window.cvHeatmapEngine.setTag('Złe oświetlenie / cień')">Złe oświetlenie</button>
                    <button type="button" class="cv-tag-pill-btn" onclick="window.cvHeatmapEngine.setTag('Zweryfikowane manualnie')">Potwierdzone ręcznie</button>
                  </div>
                  <input type="text" id="cvHitlTagInput" placeholder="Wpisz lub wybierz tag (np. zdjęcie nr 1 kijowe)..." style="width:100%;background:rgba(5,20,60,0.6);border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:7px 10px;color:#fff;font-size:12px;outline:none;box-sizing:border-box;" />
                </div>

                <div class="hitl-action-buttons">
                  <button class="btn-hitl btn-hitl-yes" onclick="window.cvHeatmapEngine.verifyCurrent(true)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Potwierdź: To JEST Iconic Blue
                  </button>
                  <button class="btn-hitl btn-hitl-no" onclick="window.cvHeatmapEngine.verifyCurrent(false)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
                      <line x1="18" y1="6" x2="6" y2="18"/>
                      <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                    Odrzuć: Inny kolor / Nie-blue
                  </button>
                </div>
                <div id="cvHitlFeedback" class="hitl-feedback-msg" style="display:none"></div>
              </div>

              <div class="cv-direct-link-row">
                <a id="cvListingLink" href="#" target="_blank" rel="noopener" class="cv-external-link">
                  Otwórz oryginalne ogłoszenie ↗
                </a>
                <button type="button" class="btn-modal-reject" onclick="window.cvHeatmapEngine.rejectCurrentListing()" title="Trwale odrzuć ogłoszenie z bazy">
                  ✕ Odrzuć to ogłoszenie
                </button>
              </div>
            </div>
          </div>
        </div>
      </dialog>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    modalInitialized = true;

    // Close on backdrop click
    const dialog = document.getElementById('cvModal');
    dialog.addEventListener('click', (e) => {
      const rect = dialog.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        dialog.close();
      }
    });
  }

  function openModal(listing) {
    ensureModalExists();
    currentModalItem = listing;
    currentModalMode = 'heatmap';

    const dialog = document.getElementById('cvModal');
    const titleEl = document.getElementById('cvModalTitle');
    const imgEl = document.getElementById('cvModalImg');
    const canvasEl = document.getElementById('cvModalCanvas');
    const loadingEl = document.getElementById('cvModalLoading');
    const blueStatusEl = document.getElementById('cvBlueStatus');
    const partsContainer = document.getElementById('cvPartsContainer');
    const hitlBadgeEl = document.getElementById('cvHitlBadge');
    const linkEl = document.getElementById('cvListingLink');
    const feedbackEl = document.getElementById('cvHitlFeedback');

    titleEl.textContent = listing.title || 'Yamaha Listing';
    linkEl.href = listing.url || '#';
    feedbackEl.style.display = 'none';

    const tagInput = document.getElementById('cvHitlTagInput');
    if (tagInput) tagInput.value = listing.iconic_blue_tag || '';
    if (typeof highlightCvTagPill === 'function') highlightCvTagPill(listing.iconic_blue_tag || '');

    // Parts tags
    let parts = [];
    try {
      parts = Array.isArray(listing.iconic_blue_parts)
        ? listing.iconic_blue_parts
        : JSON.parse(listing.iconic_blue_parts || '[]');
    } catch (_) {}

    if (parts.length > 0) {
      partsContainer.innerHTML = parts.map(p => `<span class="cv-part-tag">${p}</span>`).join('');
    } else {
      partsContainer.innerHTML = '<span style="color:var(--text-muted);font-size:12px;">Brak wykrytych elementów</span>';
    }

    if (listing.iconic_blue === 1) {
      blueStatusEl.innerHTML = '<span style="color:#60a5fa;font-weight:700;">Wykryto Iconic Blue</span>';
    } else if (listing.iconic_blue === 0) {
      blueStatusEl.innerHTML = '<span style="color:#94a3b8;font-weight:600;">Brak Iconic Blue</span>';
    } else {
      blueStatusEl.innerHTML = '<span style="color:#93c5fd;font-weight:600;">Nie sprawdzono</span>';
    }

    updateHitlStatusBadge(listing.iconic_blue_verified, listing.iconic_blue);

    // Set active button
    document.querySelectorAll('.cv-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === 'heatmap');
    });

    loadingEl.style.display = 'flex';
    imgEl.onload = () => {
      loadingEl.style.display = 'none';
      renderCurrentModalCv();
    };
    imgEl.onerror = () => {
      if (!imgEl.dataset.hasProxyFallback && listing.image) {
        imgEl.dataset.hasProxyFallback = 'true';
        imgEl.src = `/api/proxy-image?url=${encodeURIComponent(listing.image)}`;
      } else {
        loadingEl.textContent = 'Nie udało się wczytać zdjęcia';
      }
    };

    imgEl.src = listing.image || '';
    dialog.showModal();
  }

  function updateHitlStatusBadge(verified, isBlue) {
    const badge = document.getElementById('cvHitlBadge');
    if (!badge) return;
    if (verified === 1) {
      badge.className = 'hitl-status-badge verified';
      badge.textContent = isBlue === 1 ? 'Potwierdzone (Ground Truth)' : 'Odrzucone przez weryfikatora';
    } else {
      badge.className = 'hitl-status-badge pending';
      badge.textContent = 'Oczekuje na weryfikację (AI)';
    }
  }

  function renderCurrentModalCv() {
    const imgEl = document.getElementById('cvModalImg');
    const canvasEl = document.getElementById('cvModalCanvas');
    const confScoreEl = document.getElementById('cvConfidenceScore');
    const confFillEl = document.getElementById('cvConfidenceFill');
    const swatchEl = document.getElementById('cvColorSwatch');
    const hexEl = document.getElementById('cvColorHex');

    renderCvOnCanvas(imgEl, canvasEl, {
      mode: currentModalMode,
      sensitivity: 1.05,
      onResult: (result) => {
        if (result) {
          confScoreEl.textContent = `${result.confidencePct}%`;
          confFillEl.style.width = `${result.confidencePct}%`;
          swatchEl.style.backgroundColor = result.dominantHex;
          hexEl.textContent = result.dominantHex;
        }
      }
    });
  }

  function setMode(mode) {
    currentModalMode = mode;
    document.querySelectorAll('.cv-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    renderCurrentModalCv();
  }

  function setTag(tag) {
    const input = document.getElementById('cvHitlTagInput');
    if (input) input.value = tag;
    highlightCvTagPill(tag);
  }

  function highlightCvTagPill(tag) {
    document.querySelectorAll('#cvHitlPillsContainer .cv-tag-pill-btn').forEach(btn => {
      btn.classList.toggle('selected', tag && tag.includes(btn.textContent.replace(/^[^\s]+\s*/, '')));
    });
  }

  async function verifyCurrent(isBlue) {
    if (!currentModalItem || !currentModalItem.id) return;
    const feedback = document.getElementById('cvHitlFeedback');
    feedback.style.display = 'block';
    feedback.innerHTML = '<span class="spinner-sm"></span> Zapisywanie weryfikacji w bazie...';

    const tag = document.getElementById('cvHitlTagInput')?.value.trim() || null;

    try {
      const res = await fetch('/api/verify-blue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentModalItem.id, isBlue, tag })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      currentModalItem.iconic_blue = isBlue ? 1 : 0;
      currentModalItem.iconic_blue_verified = 1;
      currentModalItem.iconic_blue_tag = tag;

      feedback.innerHTML = `Zapisano. Status: <strong>${isBlue ? 'Iconic Blue' : 'Inny kolor'}</strong>${tag ? ` (${tag})` : ''}`;
      feedback.className = 'hitl-feedback-msg success';

      // Update badge in modal
      const hitlBadgeEl = document.getElementById('cvHitlBadge');
      if (hitlBadgeEl) {
        hitlBadgeEl.textContent = isBlue ? 'Zweryfikowano (Iconic Blue)' : 'Zweryfikowano (Nie-blue)';
        hitlBadgeEl.className = 'hitl-status-badge verified';
      }

      // Notify parent listeners
      window.dispatchEvent(new CustomEvent('hitl-verified', {
        detail: { id: currentModalItem.id, isBlue, tag, verified: 1 }
      }));

    } catch (err) {
      feedback.textContent = `Błąd zapisu: ${err.message}`;
      feedback.className = 'hitl-feedback-msg error';
    }
  }

  async function rejectCurrentListing() {
    if (!currentModalItem || !currentModalItem.id) return;
    const confirmed = confirm(`Czy na pewno trwale odrzucić to ogłoszenie z bazy?\n\n"${currentModalItem.title || currentModalItem.id}"\n\nOgłoszenie zostanie usunięte z bazy i dodane do czarnej listy.`);
    if (!confirmed) return;

    const feedback = document.getElementById('cvHitlFeedback');
    if (feedback) {
      feedback.style.display = 'block';
      feedback.innerHTML = '<span class="spinner-sm"></span> Trwa odrzucanie ogłoszenia...';
      feedback.className = 'hitl-feedback-msg';
    }

    try {
      const res = await fetch('/api/reject-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: currentModalItem.id,
          url: currentModalItem.url,
          title: currentModalItem.title,
          source: currentModalItem.source,
          reason: 'Odrzucone z okna inspekcji'
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const rejectedId = currentModalItem.id;
      // Dispatch event so any open view (list, cards, verify) can remove the element
      window.dispatchEvent(new CustomEvent('listing-rejected', {
        detail: { id: rejectedId }
      }));

      // Also directly remove card or table row if present in DOM
      const domCard = document.getElementById(`listing-${rejectedId}`) || document.getElementById(`card-${rejectedId}`) || document.getElementById(`row-${rejectedId}`);
      if (domCard) {
        domCard.style.transition = 'all 0.3s ease';
        domCard.style.opacity = '0';
        domCard.style.transform = 'scale(0.9)';
        setTimeout(() => domCard.remove(), 320);
      }

      closeModal();
    } catch (err) {
      if (feedback) {
        feedback.textContent = `Błąd odrzucania: ${err.message}`;
        feedback.className = 'hitl-feedback-msg error';
      } else {
        alert(`Błąd odrzucania: ${err.message}`);
      }
    }
  }

  function closeModal() {
    const dialog = document.getElementById('cvModal');
    if (dialog && dialog.open) dialog.close();
  }

  // Export to window
  window.cvHeatmapEngine = {
    analyzePixelScore,
    scoreToThermalRgba,
    processCvCanvas,
    renderCvOnCanvas,
    getInactiveAging,
    openModal,
    closeModal,
    setMode,
    setTag,
    verifyCurrent,
    rejectCurrentListing
  };

})(window);
