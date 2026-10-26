-- Model year, used as the secondary sort after engine size.
ALTER TABLE listings ADD COLUMN year INTEGER;
-- Prefer the year Bielik read from the full description where we have one; the rest is backfilled by script.
UPDATE listings SET year = CAST(json_extract(bielik_analysis, '$.year') AS INTEGER)
WHERE bielik_analysis IS NOT NULL AND json_extract(bielik_analysis, '$.year') BETWEEN 1950 AND 2100;
CREATE INDEX IF NOT EXISTS idx_listings_year ON listings(year);
