/**
 * Re-derive model, engine, category, parts flag and year for every stored listing from its title + description,
 * using the current registry and detection rules. Run after changing src/models/registry.js or detectParts.
 *
 *   node scripts/reclassify.js            # dry run: prints what would change
 *   node scripts/reclassify.js --apply    # pushes the changes (needs ADMIN_SYNC_SECRET)
 *
 * Rows Bielik has analysed keep their is_parts and year: it read the whole ad, which beats the keyword rules.
 */
const { determineYamahaModel, detectParts, extractCC, extractYear, modelTraits } = require('../src/scraper/scraper');

const WORKER_URL = process.env.WORKER_URL || 'https://yamaha-listings.maxgustaw.workers.dev';
const apply = process.argv.includes('--apply');

(async () => {
  const res = await fetch(`${WORKER_URL}/api/listings?limit=500&activeOnly=false`);
  const { listings } = await res.json();
  const updates = [];

  for (const l of listings) {
    const desc = l.description || '';
    // A row the rules no longer recognise keeps its model rather than being silently re-labelled
    const model = determineYamahaModel(l.title, desc) || l.model;
    const { engine, category } = modelTraits(l.title, model);
    const analysed = !!l.bielik_analysis;
    const next = {
      id: l.id,
      model,
      cc: extractCC(l.title, desc, model) || l.cc,
      engine, category,
      is_parts: analysed ? l.is_parts : (detectParts(l.title, desc) ? 1 : 0),
      year: analysed ? l.year : (extractYear(l.title, desc) || l.year || null),
    };
    const changed = ['model', 'cc', 'engine', 'category', 'is_parts', 'year'].filter(k => (next[k] ?? null) !== (l[k] ?? null));
    if (changed.length) {
      updates.push(next);
      console.log(`${l.id.slice(0, 50)}  ${changed.map(k => `${k}: ${l[k] ?? '-'} → ${next[k] ?? '-'}`).join(', ')}`);
    }
  }

  console.log(`\n${updates.length} of ${listings.length} listings would change`);
  if (!apply || !updates.length) return;

  const secret = process.env.ADMIN_SYNC_SECRET;
  if (!secret) throw new Error('ADMIN_SYNC_SECRET env var is required with --apply');
  const out = await fetch(`${WORKER_URL}/api/reclassify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
    body: JSON.stringify({ updates }),
  });
  if (!out.ok) throw new Error(`Reclassify failed: HTTP ${out.status} ${await out.text()}`);
  console.log('Applied:', await out.json());
})().catch(e => { console.error(e.message); process.exit(1); });
