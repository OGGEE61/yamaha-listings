/**
 * Model registry: the single source of truth for which bikes we track and how each one behaves.
 *
 * Each entry says how to recognise the model in a listing (title/description patterns), what kind of bike
 * it is (category, stroke, displacement) and which Bielik knowledge file describes it. The scraper, the
 * knowledge loader and the stored `engine` / `category` columns all derive from here, so adding or
 * reworking a model is one edit instead of a hunt through if-chains and SQL filters.
 *
 * Patterns run against folded text (lower-case, diacritics stripped), see `fold`.
 *
 * Entry fields:
 *   name       label stored in listings.model (and shown in the UI)
 *   category   what sort of bike it is: one of CATEGORIES
 *   engine     '2T' | '4T'; vintage resolves it per variant
 *   cc         displacement used for sorting
 *   knowledge  id of src/ai/knowledge/models/<id>.json
 *   match      pattern tested against the title
 *   notInTitle title patterns that veto the match (the listing is another bike)
 *   reject     { title, desc } patterns that veto the listing outright (not a bike we want)
 *   promote    if title/desc matches `re`, the listing is the sibling model `to` instead
 *   fallback   only tried when no explicit model matched (short tokens like DT/XT/IT are too ambiguous otherwise)
 *   variants   sub-families whose engine/category differ from the entry default
 */

const CATEGORIES = ['Motocross', 'Enduro', 'Supermoto', 'Adventure', 'Naked', 'Classic'];

const MODELS = [
  {
    name: 'Tenere 700',
    category: 'Adventure', engine: '4T', cc: 700, knowledge: 'tenere_700',
    match: /\b(tenere[\s-]*700|xtz[\s-]*700|xtz690|t7|t700)\b/,
    notInTitle: /\bxt[\s-]?6/,
  },
  {
    name: 'WR 450F',
    category: 'Enduro', engine: '4T', cc: 450, knowledge: 'wr_450f',
    match: /wr[ ]?450/,
  },
  {
    // A bare "WR 250" is assumed to be the 250F: the two-stroke WR250Z is extremely rare and often confused.
    name: 'WR 250F',
    category: 'Enduro', engine: '4T', cc: 250, knowledge: 'wr_250f',
    match: /wr[ ]?250/,
    promote: { re: /wr[ ]?250[ ]?x/, to: 'WR 250X', inTitle: true, inDesc: true },
  },
  {
    name: 'WR 250X',
    category: 'Supermoto', engine: '4T', cc: 250, knowledge: 'wr_250x',
    // Only reachable through WR 250F's `promote`
    match: null,
  },
  {
    name: 'YZ 250 2T',
    category: 'Motocross', engine: '2T', cc: 250, knowledge: 'yz_250_2t',
    match: /yz[ ]?250/,
    // The four-stroke YZ250F/YZF250 is a different bike. Descriptions are only trusted for explicit markers.
    reject: {
      title: /yz[ ]?250[ ]?f[x]?|yzf[ ]?250/,
      desc: /yz[ ]?250[ ]?f[x]?|yzf[ ]?250|\b4[ ]?t\b|4suw/,
    },
    promote: { re: /yz[ ]?250[ ]?x/, to: 'YZ 250X', inTitle: true, inDesc: true },
  },
  {
    name: 'YZ 250X',
    category: 'Enduro', engine: '2T', cc: 250, knowledge: 'yz_250_2t',
    match: null,
  },
  {
    name: 'XJ6 Naked',
    category: 'Naked', engine: '4T', cc: 600, knowledge: 'xj6',
    match: /\bxj[\s-]?6\b/,
    // Diversion / F / S are the faired road variants, a different segment
    reject: {
      title: /\bdiversion\b|\bxj6[\s-]*[fs]\b|\bxj[\s-]*6[fs]\b/,
      desc: /\bdiversion\b/,
    },
  },
  {
    name: 'Yamaha Vintage',
    category: 'Classic', engine: null, cc: 0, knowledge: 'yamaha_vintage',
    match: /\b(dt|xt|tt|it)\b/,
    fallback: true,
    // First variant that matches the title wins; the Ténéré XT is a trail/adventure classic.
    variants: [
      { key: 'XT Tenere', re: /tenere/, engine: '4T', category: 'Adventure' },
      { key: 'DT', re: /\bdt\b/, engine: '2T' },
      { key: 'IT', re: /\bit\b/, engine: '2T' },
      { key: 'XT', re: /\bxt\b/, engine: '4T' },
      { key: 'TT', re: /\btt\b/, engine: '4T' },
    ],
  },
];

const BY_NAME = new Map(MODELS.map(m => [m.name, m]));

// Super Ténéré / XT1200 / XTZ750 are big twins we explicitly don't track.
const BIG_TWIN = /(super[\s-]*tenere|xtz?[\s-]*1200|xtz[\s-]*750|\b1200\b)/;

function fold(x) {
  return (x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
}

/**
 * Resolve folded title/description text to a registry entry. Returns null when the listing is not a bike we track.
 */
function matchModel(title, desc = '') {
  const t = title, d = desc;
  if (BIG_TWIN.test(t)) return null;

  const explicit = MODELS.filter(m => m.match && !m.fallback);
  for (const m of explicit) {
    if (!m.match.test(t)) continue;
    if (m.notInTitle && m.notInTitle.test(t)) continue;
    if (m.reject && (m.reject.title.test(t) || m.reject.desc.test(d))) return null;
    if (m.promote && ((m.promote.inTitle && m.promote.re.test(t)) || (m.promote.inDesc && m.promote.re.test(d)))) {
      return BY_NAME.get(m.promote.to);
    }
    return m;
  }

  // The old generic 125/85cc rejection never applied to the vintage fallback, so it needs no check here.
  return MODELS.find(m => m.fallback && m.match.test(t)) || null;
}

/** engine / category for a listing, resolving per-variant differences (vintage DT vs XT). */
function describe(modelName, title = '') {
  const m = BY_NAME.get(modelName);
  if (!m) return { engine: null, category: null, variant: null };
  let { engine, category } = m;
  let variant = null;
  if (m.variants) {
    const t = fold(title);
    const v = m.variants.find(x => x.re.test(t));
    if (v) { variant = v.key; engine = v.engine || engine; category = v.category || category; }
  }
  return { engine, category, variant };
}

function displacementFor(modelName) {
  const m = BY_NAME.get(modelName);
  return m ? m.cc : 0;
}

module.exports = { CATEGORIES, MODELS, BIG_TWIN, fold, matchModel, describe, displacementFor, byName: n => BY_NAME.get(n) || null };
