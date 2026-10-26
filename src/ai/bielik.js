/**
 * Bielik AI Analyzer (Local LLM via Ollama)
 * 
 * Uses SpeakLeash Bielik (e.g. SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M)
 * running on local Ollama to:
 * 1. Deeply analyze listing titles and descriptions (2nd layer of verification).
 * 2. Verify engine type (2T vs 4T) and detect false positives (e.g. "zamiana na Tenere", tag spam).
 * 3. Extract enthusiast specs:
 *    - Kayaba SSS suspension (post-2006 on YZ250)
 *    - Aluminum frame (2005+) vs steel frame (<2005)
 *    - Engine condition (hours, rebuild / remont, nicasil vs cast iron sleeve)
 *    - Model year & homologation / registration status
 * 4. Generate structured JSON highlights & executive summary for buyers.
 */

try { process.loadEnvFile(); } catch (_) {}

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M';

const modelCatalog = require('./knowledge/modelCatalog');

/**
 * Check if Ollama is running and whether the Bielik model is available.
 */
async function checkOllamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    const hasModel = models.some(m => m === OLLAMA_MODEL || m.includes('bielik'));
    const matchedModel = models.find(m => m === OLLAMA_MODEL) || models.find(m => m.includes('bielik')) || models[0];

    return {
      available: true,
      hasModel: Boolean(hasModel),
      configuredModel: OLLAMA_MODEL,
      activeModel: matchedModel || OLLAMA_MODEL,
      allModels: models
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Fetch description for a listing if missing in the database.
 */
async function ensureListingDescription(listing) {
  if (listing.description && listing.description.trim().length > 15) {
    return listing.description;
  }

  // Attempt to fetch details if URL is present
  if (!listing.url) return '';
  try {
    const { execSync } = require('child_process');
    const cheerio = require('cheerio');
    const path = require('path');
    const scriptPath = path.join(__dirname, '..', 'scraper', 'puppeteer_fetcher.js');

    const html = execSync(`node "${scriptPath}" "${listing.url}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 25000
    });

    if (!html) return '';
    const $ = cheerio.load(html);
    let desc = '';

    const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        if (data.description) desc = data.description;
      } catch (_) {}
    }

    if (!desc) desc = $('meta[name="description"]').attr('content') || '';
    if (!desc) desc = $('div[data-cy="ad_description"] > div').text().trim();

    return desc.trim();
  } catch (err) {
    console.warn(`[Bielik] Failed to fetch live description for ${listing.url}: ${err.message}`);
    return '';
  }
}

const WORKER_URL = process.env.WORKER_URL || 'https://yamaha-listings.maxgustaw.workers.dev';

async function persistAnalysis(id, { summary, verdict, analysis, description, isParts }) {
  const secret = process.env.ADMIN_SYNC_SECRET;
  if (secret) {
    const res = await fetch(`${WORKER_URL}/api/bielik/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
      body: JSON.stringify({ id, summary, verdict, analysis, description, is_parts: isParts }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Worker /api/bielik/save HTTP ${res.status}`);
    return;
  }
  require('../server/db').saveBielikAnalysis(id, {
    summary, verdict, analysisJson: JSON.stringify(analysis), description,
  });
}

/**
 * Analyze a single listing with Bielik AI.
 * 
 * @param {object} listing - listing object from DB
 * @param {object} options - { force: boolean }
 * @returns {Promise<object>} structured analysis
 */
async function analyzeListingWithBielik(listing, { force = false } = {}) {
  // Return cached result if already analyzed and not forced
  if (!force && listing.bielik_analysis) {
    try {
      const cached = JSON.parse(listing.bielik_analysis);
      return { ...cached, cached: true };
    } catch (_) {}
  }

  const status = await checkOllamaStatus();
  if (!status.available) {
    throw new Error(`Ollama nie jest uruchomiona na ${OLLAMA_HOST}. Uruchom aplikację Ollama.`);
  }

  const modelToUse = status.activeModel || OLLAMA_MODEL;

  // Ensure we have description
  const description = await ensureListingDescription(listing);
  const textContent = (description && description.length > 20)
    ? description
    : `(Brak pełnego opisu, tytuł: ${listing.title})`;

  // Match domain knowledge for this listing
  const modelKnowledge = modelCatalog.findModelKnowledge(listing);
  const modelContext = modelCatalog.formatModelContextForPrompt(modelKnowledge);

  const prompt = `Jesteś doświadczonym rzeczoznawcą i mechanikiem motocyklowym marki Yamaha.
Dokonaj wnikliwej analizy tego ogłoszenia motocyklowego dla entuzjasty kupującego.

${modelContext}

=== DANE OGŁOSZENIA ===
Tytuł: ${listing.title}
Wstępnie przypisany model: ${listing.model || 'Nieznany'}
Cena: ${listing.price ? listing.price + ' ' + (listing.currency || 'PLN') : 'Nie podano'}
Pojemność zadeklarowana: ${listing.cc || 0} cc
Treść ogłoszenia:
${textContent.slice(0, 2600)}

=== ZASADY ANALIZY I WERYFIKACJI ===
1. RZECZYWISTY MODEL: Zweryfikuj jaki motocykl jest RZECZYWIŚCIE sprzedawany. Wykryj próby zamiany (np. "Sprzedam MT-10, zamiana na Tenere 700" to NIE JEST Tenere!) oraz spam marek/tagów.
2. ROCZNIK (ROK PRODUKCJI): Wyciągnij rok produkcji (np. 2024, 2022, 2008, 1998) z tytułu lub opisu.
3. WERYFIKACJA ZGODNOŚCI Z BAZĄ WIEDZY FABRYCZNEJ:
   - Porównaj deklarowany rocznik oraz osprzęt (rama, zawieszenie, zasilanie, nadwozie) z osiami czasu z powyższej Bazy Wiedzy.
   - W factory_consistency opisz czy cechy są w 100% zgodne z fabryczną generacją, czy wykryto anomalię/przebierankę (np. starsza generacja w nowych plastikach).
4. PRZEBIEG I EKSPLOATACJA (BĄDŹ PRECYZYJNY):
   - Dla cross/enduro główną jednostką są MTH (motogodziny). Jeśli opis podaje np. "72 mth, remont przy 66 mth", oznacza to: całkowity przebieg to 72 MTH, a od remontu minęło 6 MTH (72 - 66 = 6 MTH)!
   - Dla motocykli szosowych/adventure (np. Tenere 700, XJ6, WR 250X) jednostką są kilometry (km).
   - W mileage_total podaj całkowity przebieg (np. "72 MTH" lub "19 559 km").
   - W mileage_since_rebuild podaj ile minęło od remontu (np. "6 MTH") lub null jeśli brak wzmianki o remoncie.
   - W engine_condition krótko opisz stan silnika i wykonane prace.
5. HIGHLIGHTS: 3-4 najważniejsze, konkretne fakty w punktach (rocznik, wersja, stan, osprzęt).
6. BUYER_CHECKPOINTS: 2-3 konkretne punkty do weryfikacji na miejscu przy oględzinach dla TEGO modelu z bazy wiedzy.
7. SUMMARY: 2-3 zdaniowa ocena oferty dla kupującego.
8. KOMPLETNOŚĆ: Oceń czy to kompletny, jeżdżący motocykl ("complete"), czy brakuje istotnych elementów, np. silnika, ramy, kół, zawieszenia, dokumentów ("incomplete"), czy ogłoszenie dotyczy sprzedaży na części / dawcy / samych części ("parts_only"). Frazy typu "nie na części" oznaczają complete. W missing_parts wypisz czego brakuje (lub []).
9. VERDICT: "Warto obejrzeć" | "Ostrożnie / Dopytaj" | "Błędny model / Odrzuć".

Zwróć odpowiedź WYŁĄCZNIE jako poprawny format JSON (żadnego tekstu poza JSON):
{
  "actual_model": "np. Yamaha Tenere 700 World Raid lub Yamaha YZ 250 2T",
  "engine_type": "2T" | "4T" | "Nieznany",
  "is_target_model": true | false,
  "year": 2024 | null,
  "meter_unit": "MTH" | "km" | null,
  "mileage_total": "np. 72 MTH" | "np. 19 559 km" | null,
  "mileage_since_rebuild": "np. 6 MTH" | null,
  "engine_condition": "np. Przebieg 72 MTH (6 MTH po kompletnym remoncie przy 66 MTH)" | null,
  "factory_consistency": "Zgodne z fabryką dla rocznika 2024" | "Niezgodność..." | null,
  "is_registered": true | false | null,
  "highlights": ["Punkt 1", "Punkt 2", "Punkt 3"],
  "buyer_checkpoints": ["Na co uważać 1", "Na co uważać 2"],
  "parts_status": "complete" | "incomplete" | "parts_only",
  "missing_parts": ["np. silnik", "np. dokumenty"],
  "summary": "Zwięzła, merytoryczna ocena stanu oferty i poradnik dla kupującego.",
  "verdict": "Warto obejrzeć" | "Ostrożnie / Dopytaj" | "Błędny model / Odrzuć"
}`;

  console.log(`[Bielik] Analyzing listing ${listing.id} (${modelKnowledge ? modelKnowledge.name : listing.model}) with ${modelToUse}...`);
  const startTime = Date.now();

  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelToUse,
      prompt,
      format: 'json',
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 800
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = await response.json();
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Bielik] Generated response in ${durationSec}s`);

  let parsed = {};
  try {
    parsed = JSON.parse(data.response);
  } catch (err) {
    console.error(`[Bielik] JSON parse error from model response:\n${data.response}`);
    throw new Error(`Model nie zwrócił poprawnego JSON: ${err.message}`);
  }

  // Parse year from response or title fallback
  let year = parsed.year ? parseInt(parsed.year, 10) : null;
  if (!year) {
    const yearMatch = (listing.title + ' ' + (description || '')).match(/\b(20[0-2][0-9]|199[0-9])\b/);
    if (yearMatch) year = parseInt(yearMatch[1], 10);
  }

  // Match verified generation from domain knowledge
  const matchedGen = modelCatalog.findGeneration(modelKnowledge, year);

  // Derived factory specs grounded in domain knowledge
  let hasKayabaSSS = null;
  let hasAluminumFrame = null;
  if (modelKnowledge && modelKnowledge.id === 'yz_250_2t') {
    hasKayabaSSS = year ? year >= 2006 : null;
    hasAluminumFrame = year ? year >= 2005 : null;
  } else if (modelKnowledge && (modelKnowledge.id === 'wr_250f' || modelKnowledge.id === 'wr_450f')) {
    hasKayabaSSS = year ? year >= 2008 : null;
    hasAluminumFrame = year ? year >= 2007 : null;
  }

  const meterUnit = parsed.meter_unit || modelKnowledge?.meter_unit || (listing.model?.includes('2T') ? 'MTH' : 'km');
  const mileageTotal = parsed.mileage_total || parsed.total_hours || null;
  const mileageSinceRebuild = parsed.mileage_since_rebuild || parsed.hours_since_rebuild || null;
  const engineStatus = parsed.engine_condition || parsed.engine_status || null;

  // Normalize final result
  const result = {
    actual_model: parsed.actual_model || listing.model || 'Unknown',
    model_family: modelKnowledge ? modelKnowledge.name : (listing.model || 'Unknown'),
    model_id: modelKnowledge ? modelKnowledge.id : null,
    engine_type: parsed.engine_type || (modelKnowledge?.engine_type?.includes('2T') ? '2T' : '4T'),
    is_target_model: parsed.is_target_model !== false,
    year,
    generation_name: matchedGen ? `${matchedGen.period}: ${matchedGen.name}` : null,
    factory_features: matchedGen ? (matchedGen.factory_features || []) : [],
    factory_consistency: parsed.factory_consistency || null,
    meter_unit: meterUnit,
    mileage_total: mileageTotal,
    mileage_since_rebuild: mileageSinceRebuild,
    total_hours: meterUnit === 'MTH' ? mileageTotal : null,
    hours_since_rebuild: mileageSinceRebuild,
    engine_status: engineStatus,
    has_kayaba_sss: hasKayabaSSS,
    has_aluminum_frame: hasAluminumFrame,
    is_registered: typeof parsed.is_registered === 'boolean' ? parsed.is_registered : (modelKnowledge?.street_legal_default ?? null),
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
    buyer_checkpoints: Array.isArray(parsed.buyer_checkpoints) ? parsed.buyer_checkpoints : (matchedGen?.buyer_checklist || []),
    parts_status: ['complete', 'incomplete', 'parts_only'].includes(parsed.parts_status) ? parsed.parts_status : null,
    missing_parts: Array.isArray(parsed.missing_parts) ? parsed.missing_parts : [],
    summary: parsed.summary || 'Brak podsumowania',
    verdict: parsed.verdict || 'Warto obejrzeć',
    model_used: modelToUse,
    analyzed_at: new Date().toISOString()
  };

  // Save to D1 (source of truth); fall back to the local SQLite file when there's no secret.
  await persistAnalysis(listing.id, {
    summary: result.summary,
    verdict: result.verdict,
    analysis: result,
    description: description || null,
    // null leaves the keyword-based flag untouched when the model gave no usable answer
    isParts: result.parts_status ? (result.parts_status === 'complete' ? 0 : 1) : null
  });

  return result;
}

module.exports = {
  checkOllamaStatus,
  ensureListingDescription,
  analyzeListingWithBielik,
  OLLAMA_MODEL,
  OLLAMA_HOST
};

async function fetchListingFromWorker(id) {
  const res = await fetch(`${WORKER_URL}/api/listing/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  return (await res.json()).listing || null;
}

if (require.main === module) {
  (async () => {
    const status = await checkOllamaStatus();
    console.log('[Bielik CLI] Status:', status);
    if (!status.available) process.exit(1);

    const args = process.argv.slice(2);
    const li = args.indexOf('--limit');
    const limit = li !== -1 ? parseInt(args[li + 1], 10) : Infinity;
    const force = args.includes('--force');

    if (args.includes('--all')) {
      // Batch: every active listing in D1 that has no analysis yet.
      const res = await fetch(`${WORKER_URL}/api/listings?limit=500&activeOnly=true`, { signal: AbortSignal.timeout(30000) });
      const { listings = [] } = await res.json();
      const todo = listings.filter(l => force || !l.bielik_analysis).slice(0, limit);
      console.log(`[Bielik CLI] ${todo.length} listing(s) to analyse (of ${listings.length} active)`);
      let ok = 0, failed = 0;
      for (const [i, listing] of todo.entries()) {
        try {
          const r = await analyzeListingWithBielik(listing, { force: true });
          ok++;
          console.log(`[Bielik CLI] ${i + 1}/${todo.length} ✅ ${listing.title.substring(0, 50)} → ${r.verdict}`);
        } catch (err) {
          failed++;
          console.error(`[Bielik CLI] ${i + 1}/${todo.length} ❌ ${listing.title.substring(0, 50)}: ${err.message}`);
        }
      }
      console.log('[Bielik CLI] Done:', { ok, failed });
      return;
    }

    const id = args.find(a => !a.startsWith('--'));
    if (!id) {
      console.log('Usage: node bielik.js <listing_id> | --all [--limit N] [--force]');
      return;
    }
    const listing = await fetchListingFromWorker(id);
    if (!listing) {
      console.error('Listing not found:', id);
      process.exit(1);
    }
    const res = await analyzeListingWithBielik(listing, { force: true });
    console.log('Result:\n', JSON.stringify(res, null, 2));
  })().catch(err => {
    console.error('[Bielik CLI] Fatal error:', err);
    process.exit(1);
  });
}
