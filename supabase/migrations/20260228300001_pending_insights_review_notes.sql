-- Store rejection reasons / feedback notes from Daniel's thread replies
ALTER TABLE pending_insights ADD COLUMN IF NOT EXISTS review_notes TEXT;
