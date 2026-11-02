/**
 * Model Catalog & Domain Knowledge Loader
 * 
 * Provides model-specific knowledge contexts for Bielik LLM analysis.
 * Dynamically resolves model family, factory generations, milestones,
 * and buyer checkpoints.
 */

const fs = require('fs');
const path = require('path');
const { byName, matchModel, fold } = require('../../models/registry');

const MODELS_DIR = path.join(__dirname, 'models');

// In-memory cache of loaded models
let modelsCache = null;

function loadAllModels() {
  if (modelsCache) return modelsCache;
  modelsCache = {};

  if (!fs.existsSync(MODELS_DIR)) {
    return modelsCache;
  }

  const files = fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const filePath = path.join(MODELS_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.id) {
        modelsCache[data.id] = data;
      }
    } catch (err) {
      console.warn(`[ModelCatalog] Failed to load ${file}:`, err.message);
    }
  }

  return modelsCache;
}

/**
 * Match a listing to its model knowledge file based on model name, title, and description.
 * 
 * @param {object} listing - { model, title, description }
 * @returns {object|null} model knowledge object
 */
function findModelKnowledge(listing) {
  const models = loadAllModels();
  if (!listing) return null;

  // The registry owns which knowledge file belongs to which model; prefer the stored model, else re-resolve
  // from the text (e.g. a listing that was never classified).
  const stored = byName(listing.model);
  if (stored) return models[stored.knowledge] || null;

  const resolved = matchModel(fold(listing.title), fold(listing.description).substring(0, 400));
  return resolved ? models[resolved.knowledge] || null : null;
}

/**
 * Find the matching generation in a model's knowledge based on an extracted year.
 * 
 * @param {object} modelKnowledge 
 * @param {number|null} year 
 * @returns {object|null} generation object
 */
function findGeneration(modelKnowledge, year) {
  if (!modelKnowledge || !modelKnowledge.generations || !year) return null;
  const numYear = parseInt(year, 10);
  if (isNaN(numYear)) return null;

  for (const gen of modelKnowledge.generations) {
    const min = gen.min_year || 0;
    const max = gen.max_year || 9999;
    if (numYear >= min && numYear <= max) {
      return gen;
    }
  }
  return null;
}

/**
 * Format model knowledge into a rich, structured context block for Bielik's prompt.
 * 
 * @param {object|null} modelKnowledge 
 * @returns {string} context prompt string
 */
function formatModelContextForPrompt(modelKnowledge) {
  if (!modelKnowledge) {
    return `Baza wiedzy: Model ogólny Yamaha.
Zasady:
- Rozróżnij całkowity przebieg od przebiegu po remoncie.
- Określ czy motocykl posiada homologację drogową.
- Zidentyfikuj rocznik i stan techniczny.`;
  }

  let text = `=== FABRYCZNA BAZA WIEDZY DLA MODELU: ${modelKnowledge.name.toUpperCase()} ===\n`;
  text += `Kategoria: ${modelKnowledge.category}\n`;
  text += `Silnik fabryczny: ${modelKnowledge.engine_type} (${modelKnowledge.displacement_cc || '?'} cc)\n`;
  text += `Główna jednostka licznika: ${modelKnowledge.meter_unit} (${modelKnowledge.meter_unit === 'MTH' ? 'motogodziny' : 'kilometry'})\n`;
  text += `Domyślna rejestracja/homologacja: ${modelKnowledge.street_legal_default ? 'Wymagana / Fabryczna' : 'Cross – fabrycznie brak rejestracji'}\n`;
  text += `Opis konstrukcji: ${modelKnowledge.description}\n\n`;

  if (modelKnowledge.generations && modelKnowledge.generations.length) {
    text += `OSIE CZASU I CECHY FABRYCZNYCH GENERACJI (UŻYJ DO WERYFIKACJI ROCZNIKA):\n`;
    for (const g of modelKnowledge.generations) {
      text += `• Roczniki ${g.period} [${g.name}]:\n`;
      if (g.frame) text += `   - Rama: ${g.frame}\n`;
      if (g.suspension) text += `   - Zawieszenie: ${g.suspension}\n`;
      if (g.fuel_system || g.carburetor) text += `   - Zasilanie paliwem: ${g.fuel_system || g.carburetor}\n`;
      if (g.factory_features && g.factory_features.length) {
        text += `   - Cechy seryjne: ${g.factory_features.join('; ')}\n`;
      }
      if (g.buyer_checklist && g.buyer_checklist.length) {
        text += `   - Co sprawdzić dla tych roczników: ${g.buyer_checklist.join('; ')}\n`;
      }
    }
    text += `\n`;
  }

  if (modelKnowledge.special_editions && modelKnowledge.special_editions.length) {
    text += `FABRYCZNE WERSJE SPECJALNE:\n`;
    for (const se of modelKnowledge.special_editions) {
      text += `• ${se.name}: ${se.specs}\n`;
    }
    text += `\n`;
  }

  if (modelKnowledge.submodels && modelKnowledge.submodels.length) {
    text += `PODMODELE I ICH SPECYFIKA:\n`;
    for (const sm of modelKnowledge.submodels) {
      text += `• ${sm.model} (${sm.engine}):\n`;
      if (sm.periods) {
        for (const p of sm.periods) {
          text += `   - ${p.period}: ${p.features}\n`;
        }
      }
      if (sm.buyer_checklist) {
        text += `   - Punkty kontrolne: ${sm.buyer_checklist.join('; ')}\n`;
      }
    }
    text += `\n`;
  }

  if (modelKnowledge.common_traps && modelKnowledge.common_traps.length) {
    text += `TYPOWE PUŁAPKI I PRZEKRĘTY SPRZEDAWCÓW DLA TEGO MODELU:\n`;
    for (const trap of modelKnowledge.common_traps) {
      text += `! ${trap}\n`;
    }
  }

  return text;
}

module.exports = {
  loadAllModels,
  findModelKnowledge,
  findGeneration,
  formatModelContextForPrompt
};
