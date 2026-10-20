/**
 * Iconic Blue detector (v2)
 *
 * For every listing that still needs a colour verdict, fetches up to MAX_PHOTOS of its
 * photos, ranks them by a cheap HSV "blue pixel share", and sends the best ones to Gemini
 * in ONE request. Gemini answers whether any physical part of the motorcycle (plastics,
 * wheels/rims) is in Yamaha "Icon Blue", with a confidence and a short reason.
 *
 * Source of truth is Cloudflare D1, reached through the Worker:
 *   GET  /api/cv/queue    -> listings needing a check (never human-verified ones)
 *   POST /api/cv/results  -> verdict + confidence + reason + evidence photo
 *
 * Env:
 *   GEMINI_API_KEY     (required)  – Google AI Studio key
 *   ADMIN_SYNC_SECRET  (required)  – shared secret for the Worker API
 *   WORKER_URL         (optional)  – default https://yamaha-listings.maxgustaw.workers.dev
 *   GEMINI_MODEL       (optional)  – comma-separated fallback chain
 *   CV_MAX_PHOTOS      (optional)  – photos sent per listing, default 3
 *   CV_GATE_MIN_SHARE  (optional)  – skip Gemini when NO photo has at least this blue share
 *                                    (0..1). Default 0 = never skip; calibration on 125
 *                                    human labels showed a hard single-photo gate loses
 *                                    12-25% of true positives.
 *
 * Usage:
 *   node vision.js              # analyse the whole queue
 *   node vision.js --limit 20   # at most 20 listings
 *   node vision.js --dry        # analyse but don't write results
 */

try { process.loadEnvFile(); } catch (_) { /* no .env file – rely on real env */ }

const sharp = require('sharp');

const WORKER_URL  = process.env.WORKER_URL || 'https://yamaha-listings.maxgustaw.workers.dev';
const MAX_PHOTOS  = parseInt(process.env.CV_MAX_PHOTOS || '3', 10);
const FETCH_PHOTOS = 6;     // candidates downloaded and ranked per listing
const GATE_MIN_SHARE = parseFloat(process.env.CV_GATE_MIN_SHARE || '0');
const POST_BATCH  = 25;
const GEMINI_TIMEOUT_MS = 60000;
const PHOTO_TIMEOUT_MS  = 20000;

// Fallback chain: on the free tier every model has its own daily quota, and
// individual models are sometimes overloaded (503) – so we try them in order.
const MODELS = (process.env.GEMINI_MODEL || 'gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite')
  .split(',').map(s => s.trim()).filter(Boolean);
const apiUrl      = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const CONCURRENCY = parseInt(process.env.GEMINI_CONCURRENCY || '1', 10); // raise on a paid tier
const MAX_RETRIES = 3;      // per model, for transient errors
const MAX_WAIT_MS = 65000;  // longer retryDelay = daily quota exhausted → switch model
const exhaustedModels = new Set();

class AllModelsExhaustedError extends Error {}

const PROMPT = `You are an expert on Yamaha motorcycles. You are given 1-3 photos of the SAME motorcycle listing. Judge the motorcycle across all of them.

Task: decide whether any PHYSICAL PART of the motorcycle itself is coloured in Yamaha "Icon Blue" (a.k.a. Yamaha Racing Blue) – the deep, saturated royal/cobalt blue used on factory Yamaha YZ/WR plastics (roughly #0033A0 to #1E4FC8).

Count ONLY these parts when the part itself is moulded/painted in that blue:
- plastics: front fender, rear fender, radiator shrouds, side panels, number plates, fork guards, airbox/tank covers
- wheels / rims

Do NOT count:
- stickers, decals or graphics kits on otherwise non-blue (e.g. white) plastics
- frame or swingarm
- seat cover
- small blue accents (anodised bolts, caps, levers, logos)
- light/sky blue, turquoise, teal, or near-black navy
- anything that is not the motorcycle (background, sky, tarp, rider gear, trailer)

If the photos do not clearly show a motorcycle, answer false.

Return:
- "parts": only these Polish labels: "plastiki", "felgi"
- "confidence": your confidence in the iconic_blue verdict, 0 to 1 (use < 0.7 when lighting, angle, wear or similar blues make it unclear)
- "reason": one short sentence (max 20 words) naming what you saw
- "photo": the 1-based number of the photo that best supports your verdict`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    iconic_blue: { type: 'BOOLEAN' },
    parts: {
      type: 'ARRAY',
      items: { type: 'STRING', enum: ['plastiki', 'felgi'] },
    },
    confidence: { type: 'NUMBER' },
    reason: { type: 'STRING' },
    photo: { type: 'INTEGER' },
  },
  required: ['iconic_blue', 'parts', 'confidence', 'reason', 'photo'],
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// Same spectrum as public/cv-heatmap.js (cobalt / racing blue, hue ≈ 202°–242°).
function bluePixelScore(r, g, b) {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const d = max - min, l = (max + min) / 2;
  if (d === 0) return 0;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
  else if (max === gf) h = ((bf - rf) / d + 2) / 6;
  else h = ((rf - gf) / d + 4) / 6;
  h *= 360;
  if (h < 202 || h > 242 || s < 0.30 || l < 0.10 || l > 0.78) return 0;
  const hue = Math.max(0, 1 - Math.abs(h - 220) / 22);
  const sat = Math.min(1, Math.max(0, (s - 0.30) / 0.50));
  const light = Math.max(0, 1 - Math.abs(l - 0.44) / 0.34);
  return Math.min(1, hue * sat * light * 1.35);
}

async function blueShare(buf) {
  const { data } = await sharp(buf).resize(160, 160, { fit: 'inside' }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let hits = 0;
  for (let i = 0; i < data.length; i += 3) {
    if (bluePixelScore(data[i], data[i + 1], data[i + 2]) > 0.3) hits++;
  }
  return hits / (data.length / 3);
}

async function fetchPhoto(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) });
  if (!res.ok) {
    const err = new Error(`Image HTTP ${res.status}`);
    err.imageGone = res.status === 404 || res.status === 410;
    throw err;
  }
  const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!mimeType.startsWith('image/')) throw new Error(`Not an image (${mimeType})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { url, mimeType, buf, share: await blueShare(buf) };
}

function photoUrls(listing) {
  let extra = [];
  try { extra = JSON.parse(listing.images || '[]'); } catch (_) {}
  return [...new Set([listing.image, ...extra].filter(Boolean))].slice(0, FETCH_PHOTOS);
}

async function callGemini(photos) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const body = {
    contents: [{
      parts: [
        ...photos.flatMap((p, i) => [
          { text: `Photo ${i + 1}:` },
          { inline_data: { mime_type: p.mimeType, data: p.buf.toString('base64') } },
        ]),
        { text: PROMPT },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  for (const model of MODELS) {
    if (exhaustedModels.has(model)) continue;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res;
      try {
        res = await fetch(apiUrl(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        });
      } catch (err) {
        // Hung/aborted request: treat like an overloaded model so the retry/fallback chain handles it.
        console.warn(`[Vision] ${model}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
        res = { status: 503, ok: false, json: async () => ({}), text: async () => '' };
      }

      if (res.status === 429 || res.status >= 500) {
        let wait = 2000 * 2 ** attempt;
        try {
          const errBody = await res.json();
          const retryInfo = errBody?.error?.details?.find(d => d.retryDelay);
          if (retryInfo) wait = Math.max(wait, parseFloat(retryInfo.retryDelay) * 1000 + 500);
        } catch (_) {}

        if (res.status === 429 && wait > MAX_WAIT_MS) {
          console.warn(`[Vision] ${model}: quota exhausted (retry in ${Math.round(wait / 3600000)}h) – switching model`);
          exhaustedModels.add(model);
          break;
        }
        if (attempt === MAX_RETRIES) {
          console.warn(`[Vision] ${model}: HTTP ${res.status} persists – trying next model`);
          break;
        }
        console.warn(`[Vision] ${model}: HTTP ${res.status}, retrying in ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`Gemini ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
      if (!text) throw new Error(`Empty response from ${model}`);
      return { parsed: JSON.parse(text), model };
    }
  }

  if (MODELS.every(m => exhaustedModels.has(m))) {
    throw new AllModelsExhaustedError('Daily quota exhausted on all Gemini models');
  }
  throw new Error('All Gemini models unavailable (overloaded), will retry next run');
}

/**
 * Analyse one queue entry ({id, title, image, images}).
 * @returns {Promise<{iconic_blue, parts, confidence, reason, model, photo}>}
 */
async function analyzeListing(listing) {
  const settled = await Promise.allSettled(photoUrls(listing).map(fetchPhoto));
  const loaded = settled.filter(r => r.status === 'fulfilled').map(r => r.value);

  if (!loaded.length) {
    const gone = settled.length > 0 && settled.every(r => r.reason?.imageGone);
    if (gone) {
      // Every photo URL expired – nothing to analyse until the scraper brings a new image.
      return { iconic_blue: false, parts: [], confidence: 0, reason: 'all photos unavailable', model: 'none', photo: null };
    }
    throw settled.find(r => r.status === 'rejected').reason;
  }

  const ranked = [...loaded].sort((a, b) => b.share - a.share);
  if (GATE_MIN_SHARE > 0 && ranked[0].share < GATE_MIN_SHARE) {
    return {
      iconic_blue: false, parts: [], confidence: 0.8, model: 'hsv-gate', photo: ranked[0].url,
      reason: `no photo above ${(GATE_MIN_SHARE * 100).toFixed(2)}% blue pixels (max ${(ranked[0].share * 100).toFixed(2)}%)`,
    };
  }

  const chosen = ranked.slice(0, MAX_PHOTOS);
  const { parsed, model } = await callGemini(chosen);

  const parts = Array.isArray(parsed.parts) ? [...new Set(parsed.parts)] : [];
  const iconicBlue = Boolean(parsed.iconic_blue) && parts.length > 0;
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  const evidence = chosen[(parsed.photo || 1) - 1] || chosen[0];
  return {
    iconic_blue: iconicBlue,
    parts: iconicBlue ? parts : [],
    confidence,
    reason: String(parsed.reason || '').slice(0, 200),
    model,
    photo: evidence.url,
  };
}

async function workerApi(path, { method = 'GET', body } = {}) {
  const secret = process.env.ADMIN_SYNC_SECRET;
  if (!secret) throw new Error('ADMIN_SYNC_SECRET is not set');
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Worker ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Analyse every listing in the D1 queue and write the verdicts back.
 * Safe to call after every scrape; human-verified listings are never in the queue.
 */
async function runColorCheck({ limit = 500, dry = false } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[Vision] GEMINI_API_KEY not set – skipping Iconic Blue check.');
    return { checked: 0, blue: 0, failed: 0, skipped: true };
  }

  const { queue } = await workerApi(`/api/cv/queue?limit=${limit}`);
  console.log(`[Vision] ${queue.length} listing(s) to analyse (models: ${MODELS.join(' → ')}, photos/listing ≤ ${MAX_PHOTOS})...`);

  const pending = [];
  let checked = 0, blue = 0, failed = 0, quotaStop = false;

  const flush = async () => {
    if (!pending.length || dry) { pending.length = 0; return; }
    await workerApi('/api/cv/results', { method: 'POST', body: { results: pending.splice(0) } });
  };

  async function worker() {
    while (queue.length && !quotaStop) {
      const listing = queue.shift();
      try {
        const r = await analyzeListing(listing);
        pending.push({ id: listing.id, image: listing.image, ...r });
        checked++;
        if (r.iconic_blue) blue++;
        const conf = r.confidence ? ` ${(r.confidence * 100).toFixed(0)}%` : '';
        console.log(`[Vision] ${r.iconic_blue ? '🔵' : '⚪'}${conf} ${listing.title.substring(0, 50)}${r.parts.length ? ' → ' + r.parts.join(', ') : ''}  [${r.model}] ${r.reason}`);
        if (pending.length >= POST_BATCH) await flush();
      } catch (err) {
        if (err instanceof AllModelsExhaustedError) {
          quotaStop = true;
          console.warn(`[Vision] ⛔ ${err.message} – remaining ${queue.length + 1} listing(s) will be analysed on the next run.`);
          break;
        }
        failed++;
        console.error(`[Vision] ❌ ${listing.title.substring(0, 50)}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();

  const summary = { checked, blue, failed, remaining: queue.length + (quotaStop ? 1 : 0), dry };
  console.log('[Vision] Done:', summary);
  return summary;
}

module.exports = { analyzeListing, runColorCheck };

if (require.main === module) {
  const idx = process.argv.indexOf('--limit');
  const limit = idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 500;
  const dry = process.argv.includes('--dry');
  runColorCheck({ limit, dry }).catch(err => {
    console.error('[Vision] Fatal:', err);
    process.exit(1);
  });
}
