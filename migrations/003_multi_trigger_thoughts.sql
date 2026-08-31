BEGIN;

ALTER TABLE memories ADD COLUMN IF NOT EXISTS merge_count integer NOT NULL DEFAULT 0 CHECK (merge_count >= 0);

CREATE TABLE IF NOT EXISTS memory_trigger_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  bot_id text NOT NULL,
  trigger_concrete text NOT NULL CHECK (length(trigger_concrete) >= 3),
  trigger_abstract text NOT NULL CHECK (length(trigger_abstract) >= 3),
  trigger_meta text NOT NULL CHECK (length(trigger_meta) >= 3),
  embedding_concrete vector(768) NOT NULL,
  embedding_abstract vector(768) NOT NULL,
  embedding_meta vector(768) NOT NULL,
  source_generation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memory_id, trigger_concrete, trigger_abstract, trigger_meta)
);

-- Every pre-v3 memory becomes the first trigger set of the same canonical
-- thought. This is additive: no memory, grant, identity, or Bot row changes.
INSERT INTO memory_trigger_sets(memory_id,owner_id,bot_id,trigger_concrete,trigger_abstract,trigger_meta,
  embedding_concrete,embedding_abstract,embedding_meta,source_generation_id,created_at)
SELECT id,owner_id,bot_id,trigger_concrete,trigger_abstract,trigger_meta,
  embedding_concrete,embedding_abstract,embedding_meta,source_generation_id,created_at
FROM memories
ON CONFLICT(memory_id,trigger_concrete,trigger_abstract,trigger_meta) DO NOTHING;

CREATE INDEX IF NOT EXISTS memory_trigger_sets_memory_idx ON memory_trigger_sets(memory_id,created_at);
CREATE INDEX IF NOT EXISTS memory_trigger_sets_namespace_idx ON memory_trigger_sets(owner_id,bot_id,memory_id);
CREATE INDEX IF NOT EXISTS memory_trigger_sets_fts_concrete_idx ON memory_trigger_sets USING gin (to_tsvector('english',trigger_concrete));
CREATE INDEX IF NOT EXISTS memory_trigger_sets_fts_abstract_idx ON memory_trigger_sets USING gin (to_tsvector('english',trigger_abstract));
CREATE INDEX IF NOT EXISTS memory_trigger_sets_fts_meta_idx ON memory_trigger_sets USING gin (to_tsvector('english',trigger_meta));
CREATE INDEX IF NOT EXISTS memories_body_fts_concrete_idx ON memories USING gin (to_tsvector('english',body_concrete));
CREATE INDEX IF NOT EXISTS memories_body_fts_abstract_idx ON memories USING gin (to_tsvector('english',body_abstract));
CREATE INDEX IF NOT EXISTS memories_body_fts_meta_idx ON memories USING gin (to_tsvector('english',body_meta));
CREATE INDEX IF NOT EXISTS memory_trigger_sets_vec_concrete_idx ON memory_trigger_sets USING hnsw (embedding_concrete vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memory_trigger_sets_vec_abstract_idx ON memory_trigger_sets USING hnsw (embedding_abstract vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memory_trigger_sets_vec_meta_idx ON memory_trigger_sets USING hnsw (embedding_meta vector_cosine_ops);

ALTER TABLE memory_trigger_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_trigger_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_trigger_sets_isolation ON memory_trigger_sets;
CREATE POLICY memory_trigger_sets_isolation ON memory_trigger_sets USING (
  owner_id=current_setting('grok_memory.owner_id',true)
  AND (bot_id=current_setting('grok_memory.bot_id',true)
    OR EXISTS (SELECT 1 FROM memory_grants g
      WHERE g.memory_id=memory_trigger_sets.memory_id
      AND g.grantee_bot_id=current_setting('grok_memory.bot_id',true)))
) WITH CHECK (
  owner_id=current_setting('grok_memory.owner_id',true)
  AND bot_id=current_setting('grok_memory.bot_id',true)
);

INSERT INTO schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;
