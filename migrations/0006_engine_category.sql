-- Model structure: every listing carries its engine (2T/4T) and bike category, resolved from the model registry
-- (src/models/registry.js) at scrape time. Replaces the model/title LIKE heuristics the filters used to repeat.
ALTER TABLE listings ADD COLUMN engine TEXT;
ALTER TABLE listings ADD COLUMN category TEXT;

-- One pass over the table (D1 bills rows read). Vintage is a rough title split here; scripts/reclassify.js refines it.
UPDATE listings SET
  engine = CASE
    WHEN model IN ('YZ 250 2T', 'YZ 250X') THEN '2T'
    WHEN model IN ('WR 250F', 'WR 450F', 'WR 250X', 'Tenere 700', 'XJ6 Naked') THEN '4T'
    WHEN model = 'Yamaha Vintage' AND LOWER(title) LIKE '%tenere%' THEN '4T'
    WHEN model = 'Yamaha Vintage' AND ((' ' || LOWER(title) || ' ') LIKE '% dt %' OR (' ' || LOWER(title) || ' ') LIKE '% it %') THEN '2T'
    WHEN model = 'Yamaha Vintage' AND ((' ' || LOWER(title) || ' ') LIKE '% xt %' OR (' ' || LOWER(title) || ' ') LIKE '% tt %') THEN '4T'
  END,
  category = CASE
    WHEN model = 'YZ 250 2T' THEN 'Motocross'
    WHEN model IN ('YZ 250X', 'WR 250F', 'WR 450F') THEN 'Enduro'
    WHEN model = 'WR 250X' THEN 'Supermoto'
    WHEN model = 'Tenere 700' OR (model = 'Yamaha Vintage' AND LOWER(title) LIKE '%tenere%') THEN 'Adventure'
    WHEN model = 'XJ6 Naked' THEN 'Naked'
    WHEN model = 'Yamaha Vintage' THEN 'Classic'
  END;
