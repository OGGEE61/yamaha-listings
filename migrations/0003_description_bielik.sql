-- Listing description + Bielik (local Ollama) analysis stored in D1, so the live dashboard can show them.
ALTER TABLE listings ADD COLUMN description TEXT;
ALTER TABLE listings ADD COLUMN bielik_summary TEXT;
ALTER TABLE listings ADD COLUMN bielik_verdict TEXT;
ALTER TABLE listings ADD COLUMN bielik_analysis TEXT;     -- JSON
ALTER TABLE listings ADD COLUMN bielik_checked_at TEXT;
