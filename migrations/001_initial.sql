BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE memory_scope AS ENUM ('bot', 'project', 'conversation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS conversation_bindings (
  owner_id text NOT NULL,
  conversation_id text NOT NULL,
  bot_id text NOT NULL,
  project_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  bot_id text NOT NULL,
  scope_type memory_scope NOT NULL,
  scope_key text NOT NULL,
  trigger_concrete text NOT NULL CHECK (length(trigger_concrete) >= 3),
  trigger_abstract text NOT NULL CHECK (length(trigger_abstract) >= 3),
  trigger_meta text NOT NULL CHECK (length(trigger_meta) >= 3),
  body_concrete text NOT NULL CHECK (length(body_concrete) >= 3),
  body_abstract text NOT NULL CHECK (length(body_abstract) >= 3),
  body_meta text NOT NULL CHECK (length(body_meta) >= 3),
  embedding_concrete vector(768) NOT NULL,
  embedding_abstract vector(768) NOT NULL,
  embedding_meta vector(768) NOT NULL,
  importance smallint NOT NULL CHECK (importance BETWEEN 0 AND 100),
  usefulness real NOT NULL DEFAULT 0.5 CHECK (usefulness BETWEEN 0 AND 1),
  exposure_count integer NOT NULL DEFAULT 0,
  source_generation_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deleted')),
  superseded_by uuid REFERENCES memories(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, bot_id, source_generation_id, trigger_concrete)
);

CREATE TABLE IF NOT EXISTS memory_grants (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  grantee_bot_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, grantee_bot_id)
);

CREATE TABLE IF NOT EXISTS turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  bot_id text NOT NULL,
  project_id text,
  conversation_id text NOT NULL,
  generation_id text NOT NULL,
  user_text text NOT NULL,
  assistant_text text NOT NULL,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, bot_id, generation_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  bot_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('consolidate')),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, bot_id, kind, dedupe_key)
);

CREATE TABLE IF NOT EXISTS memory_exposures (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  bot_id text NOT NULL,
  generation_id text NOT NULL,
  lane text NOT NULL CHECK (lane IN ('concrete', 'abstract', 'meta')),
  score real NOT NULL,
  usefulness smallint CHECK (usefulness BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, generation_id, lane)
);

CREATE INDEX IF NOT EXISTS memories_namespace_idx ON memories(owner_id, bot_id, scope_type, scope_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS memories_fts_concrete_idx ON memories USING gin (to_tsvector('english', trigger_concrete || ' ' || body_concrete));
CREATE INDEX IF NOT EXISTS memories_fts_abstract_idx ON memories USING gin (to_tsvector('english', trigger_abstract || ' ' || body_abstract));
CREATE INDEX IF NOT EXISTS memories_fts_meta_idx ON memories USING gin (to_tsvector('english', trigger_meta || ' ' || body_meta));
CREATE INDEX IF NOT EXISTS memories_vec_concrete_idx ON memories USING hnsw (embedding_concrete vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memories_vec_abstract_idx ON memories USING hnsw (embedding_abstract vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memories_vec_meta_idx ON memories USING hnsw (embedding_meta vector_cosine_ops);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(state, available_at, created_at);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_exposures FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memories_isolation ON memories;
CREATE POLICY memories_isolation ON memories USING (
  owner_id = current_setting('grok_memory.owner_id', true)
  AND (bot_id = current_setting('grok_memory.bot_id', true)
    OR EXISTS (SELECT 1 FROM memory_grants g WHERE g.memory_id = id AND g.grantee_bot_id = current_setting('grok_memory.bot_id', true)))
) WITH CHECK (owner_id = current_setting('grok_memory.owner_id', true) AND bot_id = current_setting('grok_memory.bot_id', true));
DROP POLICY IF EXISTS turns_isolation ON turns;
CREATE POLICY turns_isolation ON turns USING (owner_id = current_setting('grok_memory.owner_id', true) AND bot_id = current_setting('grok_memory.bot_id', true))
WITH CHECK (owner_id = current_setting('grok_memory.owner_id', true) AND bot_id = current_setting('grok_memory.bot_id', true));
DROP POLICY IF EXISTS jobs_isolation ON jobs;
CREATE POLICY jobs_isolation ON jobs USING (owner_id = current_setting('grok_memory.owner_id', true) AND bot_id = current_setting('grok_memory.bot_id', true))
WITH CHECK (owner_id = current_setting('grok_memory.owner_id', true) AND bot_id = current_setting('grok_memory.bot_id', true));
DROP POLICY IF EXISTS exposures_isolation ON memory_exposures;
CREATE POLICY exposures_isolation ON memory_exposures USING (owner_id = current_setting('grok_memory.owner_id', true) AND bot_id = current_setting('grok_memory.bot_id', true))
WITH CHECK (owner_id = current_setting('grok_memory.owner_id', true) AND bot_id = current_setting('grok_memory.bot_id', true));

CREATE OR REPLACE FUNCTION grok_memory_claim_job(worker text)
RETURNS TABLE(id uuid, owner_id text, bot_id text, payload jsonb, attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH candidate AS (
    SELECT jobs.id FROM jobs WHERE (state='queued' AND available_at<=now())
      OR (state='running' AND locked_at < now()-interval '5 minutes')
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE jobs SET state='running', attempts=jobs.attempts+1, locked_at=now(), locked_by=worker, updated_at=now()
  FROM candidate WHERE jobs.id=candidate.id
  RETURNING jobs.id,jobs.owner_id,jobs.bot_id,jobs.payload,jobs.attempts;
$$;
CREATE OR REPLACE FUNCTION grok_memory_finish_job(target uuid, succeeded boolean, failure text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE jobs SET
    state=CASE WHEN succeeded THEN 'done' WHEN attempts < 3 THEN 'queued' ELSE 'failed' END,
    available_at=CASE WHEN NOT succeeded AND attempts < 3 THEN now()+make_interval(secs => (1 << attempts)) ELSE available_at END,
    locked_at=NULL, locked_by=NULL, last_error=CASE WHEN succeeded THEN NULL ELSE left(failure,2000) END, updated_at=now()
  WHERE id=target;
$$;
CREATE OR REPLACE FUNCTION grok_memory_queue_depth()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT count(*) FROM jobs WHERE state='queued' $$;
CREATE OR REPLACE FUNCTION grok_memory_grant(target uuid, grantee text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memories WHERE id=target AND owner_id=current_setting('grok_memory.owner_id',true) AND bot_id=current_setting('grok_memory.bot_id',true)) THEN
    RAISE EXCEPTION 'Memory not found or not owned by this Bot';
  END IF;
  INSERT INTO memory_grants(memory_id,grantee_bot_id) VALUES(target,grantee) ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION grok_memory_prune_turns(retention_days integer)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE removed bigint;
BEGIN
  IF retention_days < 1 THEN RAISE EXCEPTION 'retention_days must be positive'; END IF;
  DELETE FROM turns WHERE created_at < now() - make_interval(days => retention_days);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION grok_memory_claim_job(text), grok_memory_finish_job(uuid,boolean,text), grok_memory_queue_depth(), grok_memory_grant(uuid,text), grok_memory_prune_turns(integer) FROM PUBLIC;

INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
