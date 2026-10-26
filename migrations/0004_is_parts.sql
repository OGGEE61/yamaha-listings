-- Parts bikes ("na części", donor bikes, part-only ads): ranked last and hideable in the UI.
ALTER TABLE listings ADD COLUMN is_parts INTEGER DEFAULT 0;

-- Backfill from what we already store; the scraper keeps it current from now on.
UPDATE listings SET is_parts = 1
WHERE LOWER(title) LIKE '%na części%' OR LOWER(title) LIKE '%na czesci%' OR LOWER(title) LIKE '%na cześci%'
   OR LOWER(title) LIKE '%dawca%' OR LOWER(title) LIKE '%rozbiórk%' OR LOWER(title) LIKE '%rozbiork%'
   OR LOWER(title) LIKE '%szrot%' OR LOWER(title) LIKE '%części zamienne%'
   OR LOWER(title) LIKE 'plastiki%' OR LOWER(title) LIKE 'yamaha plastiki%';

CREATE INDEX IF NOT EXISTS idx_listings_is_parts ON listings(is_parts);
