-- Add participant tracking to transcript_ingestion_log and pending_insights
-- Enables filtering meetings by attendee without hitting Fireflies API

-- 1. transcript_ingestion_log: add participants, organizer_email, meeting_date
ALTER TABLE transcript_ingestion_log
  ADD COLUMN IF NOT EXISTS participants TEXT[],
  ADD COLUMN IF NOT EXISTS organizer_email TEXT,
  ADD COLUMN IF NOT EXISTS meeting_date TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transcript_ingestion_participants
  ON transcript_ingestion_log USING GIN(participants);

CREATE INDEX IF NOT EXISTS idx_transcript_ingestion_organizer
  ON transcript_ingestion_log(organizer_email);

CREATE INDEX IF NOT EXISTS idx_transcript_ingestion_date
  ON transcript_ingestion_log(meeting_date);

-- 2. pending_insights: add participants
ALTER TABLE pending_insights
  ADD COLUMN IF NOT EXISTS participants TEXT[];

-- 3. Backfill from meetings table
UPDATE transcript_ingestion_log til
SET
  participants = m.participant_emails,
  organizer_email = m.organizer_email,
  meeting_date = m.date
FROM meetings m
WHERE til.meeting_id = m.id
  AND til.participants IS NULL;

UPDATE pending_insights pi
SET participants = m.participant_emails
FROM meetings m
WHERE pi.meeting_id = m.id
  AND pi.participants IS NULL;
