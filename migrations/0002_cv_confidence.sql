-- CV pipeline v2: confidence/evidence per verdict, multi-photo support, label log.
ALTER TABLE listings ADD COLUMN images TEXT;                    -- JSON array of photo URLs
ALTER TABLE listings ADD COLUMN iconic_blue_confidence REAL;    -- 0..1, model confidence in its verdict
ALTER TABLE listings ADD COLUMN iconic_blue_reason TEXT;        -- short model/gate explanation
ALTER TABLE listings ADD COLUMN iconic_blue_model TEXT;         -- gemini model id, or 'hsv-gate'
ALTER TABLE listings ADD COLUMN iconic_blue_photo TEXT;         -- photo URL that decided the verdict

-- Every human verdict, alongside what the model said (eval/training set).
CREATE TABLE IF NOT EXISTS cv_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  image_url TEXT,
  model_verdict INTEGER,
  model_confidence REAL,
  model TEXT,
  human_verdict INTEGER NOT NULL,
  tag TEXT,
  labeled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cv_labels_listing ON cv_labels(listing_id);
