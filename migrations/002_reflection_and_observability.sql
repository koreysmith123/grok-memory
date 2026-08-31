BEGIN;

ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_version smallint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS reflection_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  bot_id text NOT NULL,
  conversation_id text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 3 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chapter_state (
  owner_id text NOT NULL,
  bot_id text NOT NULL,
  conversation_id text NOT NULL,
  reflected_through timestamptz NOT NULL DEFAULT '-infinity',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, bot_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS memory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  bot_id text NOT NULL,
  conversation_id text NOT NULL,
  generation_id text,
  event_type text NOT NULL CHECK (event_type IN ('recall','remember','note','reflect','rate','forget','brainstorm')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reflection_notes_chapter_idx ON reflection_notes(owner_id,bot_id,conversation_id,created_at);
CREATE INDEX IF NOT EXISTS memory_events_timeline_idx ON memory_events(owner_id,bot_id,conversation_id,created_at DESC);

ALTER TABLE reflection_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE reflection_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE chapter_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapter_state FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reflection_notes_isolation ON reflection_notes;
CREATE POLICY reflection_notes_isolation ON reflection_notes USING (
  owner_id=current_setting('grok_memory.owner_id',true) AND bot_id=current_setting('grok_memory.bot_id',true)
) WITH CHECK (owner_id=current_setting('grok_memory.owner_id',true) AND bot_id=current_setting('grok_memory.bot_id',true));
DROP POLICY IF EXISTS chapter_state_isolation ON chapter_state;
CREATE POLICY chapter_state_isolation ON chapter_state USING (
  owner_id=current_setting('grok_memory.owner_id',true) AND bot_id=current_setting('grok_memory.bot_id',true)
) WITH CHECK (owner_id=current_setting('grok_memory.owner_id',true) AND bot_id=current_setting('grok_memory.bot_id',true));
DROP POLICY IF EXISTS memory_events_isolation ON memory_events;
CREATE POLICY memory_events_isolation ON memory_events USING (
  owner_id=current_setting('grok_memory.owner_id',true) AND bot_id=current_setting('grok_memory.bot_id',true)
) WITH CHECK (owner_id=current_setting('grok_memory.owner_id',true) AND bot_id=current_setting('grok_memory.bot_id',true));

CREATE OR REPLACE FUNCTION grok_memory_requeue_failed(max_jobs integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changed integer;
BEGIN
  IF max_jobs < 1 OR max_jobs > 10000 THEN RAISE EXCEPTION 'max_jobs must be between 1 and 10000'; END IF;
  WITH targets AS (
    SELECT id FROM jobs WHERE state='failed' AND (
      last_error ILIKE '%auth%' OR last_error ILIKE '%login%' OR last_error ILIKE '%log in%'
      OR last_error ILIKE '%sign in%' OR last_error ILIKE '%XAI_API_KEY%'
    ) ORDER BY updated_at LIMIT max_jobs FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs SET state='queued',attempts=0,available_at=now(),locked_at=NULL,locked_by=NULL,last_error=NULL,updated_at=now()
  WHERE id IN (SELECT id FROM targets);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION grok_memory_requeue_failed(integer) FROM PUBLIC;

INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
