/**
 * Iconic Blue detector
 *
 * Sends the main photo of each listing to Gemini (vision) and asks whether any
 * physical part of the motorcycle (plastics, wheels/rims, frame, seat...) is in
 * Yamaha "Icon Blue" / Racing Blue. Stickers/graphics alone do NOT count.
 *
 * Results are cached in SQLite per image URL, so each photo is analysed once.
 *
 * Env:
 *   GEMINI_API_KEY  (required)  – Google AI Studio key
 *   GEMINI_MODEL    (optional)  – comma-separated fallback chain,
 *                                 default: gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite
 *
 * Usage:
 *   node vision.js            # analyse all unchecked listings
 *   node vision.js --limit 20 # analyse at most 20
 */

try { process.loadEnvFile(); } catch (_) { /* no .env file – rely on real env */ }

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

const PROMPT = `You are an expert on Yamaha motorcycles. Look at the motorcycle in this photo.

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

If the photo does not clearly show a motorcycle, answer false.

Return "parts" using only these Polish labels: "plastiki", "felgi".`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    iconic_blue: { type: 'BOOLEAN' },
    parts: {
      type: 'ARRAY',
      items: { type: 'STRING', enum: ['plastiki', 'felgi'] },
    },
  },
  required: ['iconic_blue', 'parts'],
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchImageAsBase64(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
  });
  if (!res.ok) {
    const err = new Error(`Image HTTP ${res.status}`);
    err.imageGone = res.status === 404 || res.status === 410;
    throw err;
  }
  const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!mimeType.startsWith('image/')) throw new Error(`Not an image (${mimeType})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, data: buf.toString('base64') };
}

/**
 * Analyse a single image URL.
 * @returns {Promise<{iconicBlue: boolean, parts: string[]}>}
 */
async function analyzeImage(imageUrl) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const image = await fetchImageAsBase64(imageUrl);
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: image.mimeType, data: image.data } },
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
      const res = await fetch(apiUrl(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });

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

      const parsed = JSON.parse(text);
      const parts = Array.isArray(parsed.parts) ? [...new Set(parsed.parts)] : [];
      const iconicBlue = Boolean(parsed.iconic_blue) && parts.length > 0;
      return { iconicBlue, parts: iconicBlue ? parts : [], model };
    }
  }

  if (MODELS.every(m => exhaustedModels.has(m))) {
    throw new AllModelsExhaustedError('Daily quota exhausted on all Gemini models');
  }
  throw new Error('All Gemini models unavailable (overloaded), will retry next run');
}

/**
 * Analyse every listing that hasn't been checked yet (or whose image changed)
 * and store results in the DB. Safe to call after every scrape.
 */
async function runColorCheck({ limit = 500 } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[Vision] GEMINI_API_KEY not set – skipping Iconic Blue check.');
    return { checked: 0, blue: 0, failed: 0, skipped: true };
  }

  const db = require('./db');
  const queue = db.getListingsNeedingColorCheck(limit);
  console.log(`[Vision] ${queue.length} listing(s) to analyse (models: ${MODELS.join(' → ')})...`);

  let checked = 0, blue = 0, failed = 0, quotaStop = false;

  async function worker() {
    while (queue.length && !quotaStop) {
      const listing = queue.shift();
      try {
        const result = await analyzeImage(listing.image);
        db.setColorCheckResult(listing.id, { ...result, image: listing.image, title: listing.title });
        checked++;
        if (result.iconicBlue) blue++;
        console.log(`[Vision] ${result.iconicBlue ? '🔵' : '⚪'} ${listing.title.substring(0, 50)}${result.parts.length ? ' → ' + result.parts.join(', ') : ''}  [${result.model}]`);
      } catch (err) {
        if (err instanceof AllModelsExhaustedError) {
          quotaStop = true;
          console.warn(`[Vision] ⛔ ${err.message} – remaining ${queue.length + 1} listing(s) will be analysed on the next run.`);
          break;
        }
        if (err.imageGone) {
          // Photo URL expired – store as "no Iconic Blue" for this URL so we don't
          // retry every run. It will be re-checked once the scraper picks up a new image URL.
          db.setColorCheckResult(listing.id, { iconicBlue: false, parts: [], image: listing.image, title: listing.title });
          console.warn(`[Vision] ⚠️  ${listing.title.substring(0, 50)}: image no longer available, skipped`);
          continue;
        }
        failed++;
        console.error(`[Vision] ❌ ${listing.title.substring(0, 50)}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (checked > 0) db.exportPublicJson();

  const summary = { checked, blue, failed, remaining: queue.length + (quotaStop ? 1 : 0) };
  console.log('[Vision] Done:', summary);
  return summary;
}

module.exports = { analyzeImage, runColorCheck };

if (require.main === module) {
  const idx = process.argv.indexOf('--limit');
  const limit = idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 500;
  runColorCheck({ limit }).catch(err => {
    console.error('[Vision] Fatal:', err);
    process.exit(1);
  });
}
