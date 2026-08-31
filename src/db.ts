import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type PoolClient } from "pg";
import type { Identity, MemoryDraft, MemoryLevel, SearchHit, TimelineEntry, TurnRecord } from "./types.js";
import type { IndexRecord } from "./index/centroid.js";

const { Pool } = pg;

export interface ClaimedJob {
  id: string;
  ownerId: string;
  botId: string;
  payload: TurnRecord;
  attempts: number;
}

export interface MemoryRepository {
  binding(ownerId: string, conversationId: string): Promise<{ botId: string; projectId?: string } | undefined>;
  bind(identity: Identity): Promise<void>;
  recordPrompt(identity: Identity, generationId: string, prompt: string, model?: string): Promise<void>;
  promptForGeneration(identity: Identity, generationId: string): Promise<string>;
  recentTurns(identity: Identity, limit: number): Promise<Array<{ userText: string; assistantText: string }>>;
  addNote(identity: Identity, content: string): Promise<string>;
  enqueueReflection(identity: Identity, summary: string, resolution: string): Promise<{ generationId: string; turnCount: number; noteCount: number }>;
  completeTurnAndEnqueue(turn: TurnRecord): Promise<void>;
  search(identity: Identity, level: MemoryLevel, text: string, embedding: number[], limit: number): Promise<SearchHit[]>;
  recordExposures(identity: Identity, generationId: string, hits: SearchHit[]): Promise<void>;
  save(identity: Identity, draft: MemoryDraft, embeddings: Record<MemoryLevel, number[]>): Promise<string>;
  apply(identity: Identity, operation: any, embeddings?: Record<MemoryLevel, number[]>): Promise<void>;
  claimJob(workerId: string): Promise<ClaimedJob | undefined>;
  finishJob(jobId: string, ok: boolean, error?: string): Promise<void>;
  requeueFailedJobs(limit?: number): Promise<number>;
  recentMemorySummary(identity: Identity, limit: number): Promise<string>;
  rate(identity: Identity, memoryId: string, generationId: string, usefulness: number): Promise<void>;
  forget(identity: Identity, memoryId: string): Promise<boolean>;
  grant(identity: Identity, memoryId: string, granteeBotId: string): Promise<void>;
  pruneTurns(retentionDays: number): Promise<number>;
  inspect(identity: Identity, limit: number): Promise<Array<Record<string, unknown>>>;
  timeline(identity: Identity, limit: number): Promise<TimelineEntry[]>;
  compliance(identity: Identity): Promise<{ completedTurns: number; observedRecallCalls: number; exactlyPairedTurns: number; turnsWithoutExactObservedRecall: number }>;
  indexRecords(identity: Identity): Promise<IndexRecord[]>;
  pendingTriggerEmbeddings(limit: number): Promise<Array<{ id: string; trigger: Record<MemoryLevel, string> }>>;
  updateTriggerEmbeddings(id: string, embeddings: Record<MemoryLevel, number[]>): Promise<void>;
  recordEvent(identity: Identity, eventType: "recall" | "remember" | "note" | "reflect" | "rate" | "forget" | "brainstorm", generationId?: string, details?: Record<string, unknown>): Promise<void>;
  health(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== 768 || vector.some((value) => !Number.isFinite(value))) throw new Error("Expected a finite 768-dimensional vector");
  return `[${vector.join(",")}]`;
}

function parseVector(value: string): number[] { return value.slice(1, -1).split(",").map(Number); }

export function scoreMemory(input: { vectorScore: number; lexicalScore: number; importance: number; usefulness: number; ageDays: number }): number {
  const recency = 0.5 + 0.5 * Math.max(0, 1 - Math.max(0, input.ageDays) / 90);
  return (input.vectorScore * 0.65 + Math.min(1, input.lexicalScore * 4) * 0.2 + input.importance / 100 * 0.1 + input.usefulness * 0.05) * recency;
}

export class PostgresRepository implements MemoryRepository {
  readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 20, connectionTimeoutMillis: 3_000 });
  }

  async migrate(appRole?: string): Promise<void> {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    for (const file of (await readdir(root)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      await this.pool.query(await readFile(join(root, file), "utf8"));
    }
    if (appRole) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) throw new Error("Unsafe PostgreSQL application role");
      await this.pool.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
      await this.pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
      await this.pool.query(`REVOKE ALL ON memory_grants FROM ${appRole}`);
      await this.pool.query(`GRANT SELECT ON memory_grants TO ${appRole}`);
      await this.pool.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
      await this.pool.query(`GRANT EXECUTE ON FUNCTION grok_memory_claim_job(text), grok_memory_finish_job(uuid,boolean,text), grok_memory_queue_depth(), grok_memory_grant(uuid,text), grok_memory_prune_turns(integer), grok_memory_requeue_failed(integer) TO ${appRole}`);
    }
  }

  private async scoped<T>(identity: Pick<Identity, "ownerId" | "botId">, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('grok_memory.owner_id', $1, true), set_config('grok_memory.bot_id', $2, true)", [identity.ownerId, identity.botId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async binding(ownerId: string, conversationId: string) {
    const result = await this.pool.query("SELECT bot_id, project_id FROM conversation_bindings WHERE owner_id=$1 AND conversation_id=$2", [ownerId, conversationId]);
    const row = result.rows[0] as { bot_id: string; project_id: string | null } | undefined;
    return row ? { botId: row.bot_id, ...(row.project_id ? { projectId: row.project_id } : {}) } : undefined;
  }

  async bind(identity: Identity): Promise<void> {
    await this.pool.query(`INSERT INTO conversation_bindings(owner_id,conversation_id,bot_id,project_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,conversation_id) DO UPDATE SET bot_id=excluded.bot_id,project_id=excluded.project_id,updated_at=now()`,
      [identity.ownerId, identity.conversationId, identity.botId, identity.projectId ?? null]);
  }

  async recordPrompt(identity: Identity, generationId: string, prompt: string, model?: string): Promise<void> {
    await this.bind(identity);
    await this.scoped(identity, async (client) => {
      await client.query(`INSERT INTO turns(owner_id,bot_id,project_id,conversation_id,generation_id,user_text,assistant_text,model)
        VALUES($1,$2,$3,$4,$5,$6,'',$7) ON CONFLICT(owner_id,bot_id,generation_id) DO UPDATE SET user_text=excluded.user_text,model=excluded.model`,
        [identity.ownerId, identity.botId, identity.projectId ?? null, identity.conversationId, generationId, prompt, model ?? null]);
    });
  }

  async promptForGeneration(identity: Identity, generationId: string): Promise<string> {
    return this.scoped(identity, async (client) => {
      const result = await client.query("SELECT user_text FROM turns WHERE owner_id=$1 AND bot_id=$2 AND generation_id=$3", [identity.ownerId, identity.botId, generationId]);
      return (result.rows[0]?.user_text as string | undefined) ?? "";
    });
  }

  async recentTurns(identity: Identity, limit: number): Promise<Array<{ userText: string; assistantText: string }>> {
    return this.scoped(identity, async (client) => {
      const result = await client.query(`SELECT user_text, assistant_text FROM turns
        WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3 AND assistant_text<>''
        ORDER BY created_at DESC LIMIT $4`, [identity.ownerId, identity.botId, identity.conversationId, Math.min(12, Math.max(0, limit))]);
      return result.rows.reverse().map((row: any) => ({ userText: row.user_text, assistantText: row.assistant_text }));
    });
  }

  async addNote(identity: Identity, content: string): Promise<string> {
    return this.scoped(identity, async (client) => {
      const result = await client.query(`INSERT INTO reflection_notes(owner_id,bot_id,conversation_id,content)
        VALUES($1,$2,$3,$4) RETURNING id`, [identity.ownerId, identity.botId, identity.conversationId, content]);
      await client.query(`INSERT INTO memory_events(owner_id,bot_id,conversation_id,event_type,details)
        VALUES($1,$2,$3,'note',$4::jsonb)`, [identity.ownerId, identity.botId, identity.conversationId, JSON.stringify({ noteId: result.rows[0].id })]);
      return result.rows[0].id as string;
    });
  }

  async enqueueReflection(identity: Identity, summary: string, resolution: string): Promise<{ generationId: string; turnCount: number; noteCount: number }> {
    return this.scoped(identity, async (client) => {
      await client.query(`INSERT INTO chapter_state(owner_id,bot_id,conversation_id) VALUES($1,$2,$3)
        ON CONFLICT(owner_id,bot_id,conversation_id) DO NOTHING`, [identity.ownerId, identity.botId, identity.conversationId]);
      const state = await client.query(`SELECT reflected_through FROM chapter_state
        WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3 FOR UPDATE`, [identity.ownerId, identity.botId, identity.conversationId]);
      const through = state.rows[0].reflected_through;
      const turns = await client.query(`SELECT user_text,assistant_text FROM turns
        WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3 AND created_at>$4 AND assistant_text<>''
        ORDER BY created_at LIMIT 50`, [identity.ownerId, identity.botId, identity.conversationId, through]);
      const notes = await client.query(`SELECT id,content,created_at FROM reflection_notes
        WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3 AND created_at>$4
        ORDER BY created_at LIMIT 100`, [identity.ownerId, identity.botId, identity.conversationId, through]);
      const generationId = `reflection:${crypto.randomUUID()}`;
      const payload: TurnRecord = {
        identity, generationId, userText: summary, assistantText: resolution,
        chapter: {
          summary, resolution,
          turns: turns.rows.map((row: any) => ({ userText: row.user_text, assistantText: row.assistant_text })),
          notes: notes.rows.map((row: any) => ({ id: row.id, content: row.content, createdAt: new Date(row.created_at).toISOString() })),
        },
      };
      await client.query(`INSERT INTO jobs(owner_id,bot_id,kind,dedupe_key,payload)
        VALUES($1,$2,'consolidate',$3,$4::jsonb)`, [identity.ownerId, identity.botId, generationId, JSON.stringify(payload)]);
      await client.query(`UPDATE chapter_state SET reflected_through=now(),updated_at=now()
        WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3`, [identity.ownerId, identity.botId, identity.conversationId]);
      await client.query(`INSERT INTO memory_events(owner_id,bot_id,conversation_id,generation_id,event_type,details)
        VALUES($1,$2,$3,$4,'reflect',$5::jsonb)`, [identity.ownerId, identity.botId, identity.conversationId, generationId,
        JSON.stringify({ turnCount: turns.rowCount, noteCount: notes.rowCount, summary, resolution })]);
      return { generationId, turnCount: turns.rowCount ?? 0, noteCount: notes.rowCount ?? 0 };
    });
  }

  async completeTurnAndEnqueue(turn: TurnRecord): Promise<void> {
    await this.bind(turn.identity);
    await this.scoped(turn.identity, async (client) => {
      await client.query(`INSERT INTO turns(owner_id,bot_id,project_id,conversation_id,generation_id,user_text,assistant_text,model)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,bot_id,generation_id) DO UPDATE SET assistant_text=excluded.assistant_text, model=COALESCE(excluded.model,turns.model)`,
        [turn.identity.ownerId, turn.identity.botId, turn.identity.projectId ?? null, turn.identity.conversationId, turn.generationId, turn.userText, turn.assistantText, turn.model ?? null]);
      await client.query(`INSERT INTO jobs(owner_id,bot_id,kind,dedupe_key,payload) VALUES($1,$2,'consolidate',$3,$4::jsonb) ON CONFLICT DO NOTHING`,
        [turn.identity.ownerId, turn.identity.botId, turn.generationId, JSON.stringify(turn)]);
    });
  }

  async search(identity: Identity, level: MemoryLevel, text: string, embedding: number[], limit: number): Promise<SearchHit[]> {
    const column = { concrete: "concrete", abstract: "abstract", meta: "meta" }[level];
    return this.scoped(identity, async (client) => {
      await client.query("SET LOCAL hnsw.iterative_scan = 'strict_order'");
      // Namespace predicates are enforced in the query as well as by RLS. Tests,
      // migrations, and some operator commands may connect as a table owner or
      // superuser, for whom PostgreSQL can bypass RLS. Cross-Bot rows are visible
      // only when an explicit grant exists.
      const scope = `(m.owner_id=$7 AND ((m.bot_id=$3 AND ((m.scope_type='bot' AND m.scope_key=$3) OR (m.scope_type='conversation' AND m.scope_key=$4) OR (m.scope_type='project' AND $5::text IS NOT NULL AND m.scope_key=$5))) OR (m.bot_id<>$3 AND EXISTS (SELECT 1 FROM memory_grants grant_row WHERE grant_row.memory_id=m.id AND grant_row.grantee_bot_id=$3))))`;
      const candidateLimit = Math.max(limit * 12, 36);
      const result = await client.query(`WITH vector_candidates AS MATERIALIZED (
        SELECT t.id FROM memory_trigger_sets t JOIN memories m ON m.id=t.memory_id
        WHERE m.status='active' AND ${scope} ORDER BY t.embedding_${column} <=> $1::vector LIMIT $6
      ), lexical_trigger_candidates AS MATERIALIZED (
        SELECT t.id FROM memory_trigger_sets t JOIN memories m ON m.id=t.memory_id
        WHERE m.status='active' AND ${scope}
        AND to_tsvector('english',t.trigger_${column}) @@ plainto_tsquery('english',$2)
        ORDER BY ts_rank_cd(to_tsvector('english',t.trigger_${column}), plainto_tsquery('english',$2)) DESC LIMIT $6
      ), lexical_body_candidates AS MATERIALIZED (
        SELECT (SELECT t.id FROM memory_trigger_sets t WHERE t.memory_id=m.id ORDER BY t.created_at LIMIT 1) AS id
        FROM memories m WHERE m.status='active' AND ${scope}
        AND to_tsvector('english',m.body_${column}) @@ plainto_tsquery('english',$2)
        ORDER BY ts_rank_cd(to_tsvector('english',m.body_${column}),plainto_tsquery('english',$2)) DESC LIMIT $6
      ), candidates AS (SELECT id FROM vector_candidates UNION SELECT id FROM lexical_trigger_candidates UNION SELECT id FROM lexical_body_candidates WHERE id IS NOT NULL), counts AS (
        SELECT memory_id,count(*)::int AS trigger_count FROM memory_trigger_sets GROUP BY memory_id
      )
      SELECT m.id,t.id AS trigger_set_id,'${level}' AS level,t.trigger_${column} AS trigger,m.body_${column} AS body,
        t.trigger_concrete,t.trigger_abstract,t.trigger_meta,m.body_concrete,m.body_abstract,m.body_meta,
        m.scope_type,m.scope_key,1-(t.embedding_${column} <=> $1::vector) AS vector_score,
        ts_rank_cd(to_tsvector('english',t.trigger_${column}),plainto_tsquery('english',$2)) +
          ts_rank_cd(to_tsvector('english',m.body_${column}),plainto_tsquery('english',$2)) AS lexical_score,
        m.importance,m.usefulness,m.merge_count,counts.trigger_count,m.updated_at
      FROM candidates c JOIN memory_trigger_sets t ON t.id=c.id JOIN memories m ON m.id=t.memory_id
      JOIN counts ON counts.memory_id=m.id`,
        [vectorLiteral(embedding), text, identity.botId, identity.conversationId, identity.projectId ?? null, candidateLimit, identity.ownerId]);
      const ranked = result.rows.map((row: any) => {
        const ageDays = Math.max(0, (Date.now() - new Date(row.updated_at).getTime()) / 86_400_000);
        const vectorScore = Number(row.vector_score);
        const lexicalScore = Math.min(1, Number(row.lexical_score) * 4);
        const importance = Number(row.importance);
        const usefulness = Number(row.usefulness);
        return { id: row.id, level, trigger: row.trigger, body: row.body, scopeType: row.scope_type, scopeKey: row.scope_key,
          vectorScore, lexicalScore, importance, usefulness, updatedAt: new Date(row.updated_at),
          finalScore: scoreMemory({ vectorScore, lexicalScore: Number(row.lexical_score), importance, usefulness, ageDays }),
          chain: { id: row.id, triggerSetId: row.trigger_set_id,
            trigger: { concrete: row.trigger_concrete, abstract: row.trigger_abstract, meta: row.trigger_meta },
            triggerCount: Number(row.trigger_count), mergeCount: Number(row.merge_count),
            body: { concrete: row.body_concrete, abstract: row.body_abstract, meta: row.body_meta },
            importance, usefulness, scopeType: row.scope_type, scopeKey: row.scope_key, updatedAt: new Date(row.updated_at) } } satisfies SearchHit;
      }).sort((a: SearchHit, b: SearchHit) => b.finalScore - a.finalScore);
      const distinct = new Map<string, SearchHit>();
      for (const hit of ranked) if (!distinct.has(hit.id)) distinct.set(hit.id, hit);
      return [...distinct.values()].slice(0, limit);
    });
  }

  async recordExposures(identity: Identity, generationId: string, hits: SearchHit[]): Promise<void> {
    await this.scoped(identity, async (client) => {
      for (const hit of hits) {
        await client.query(`INSERT INTO memory_exposures(memory_id,owner_id,bot_id,generation_id,lane,score) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [hit.id, identity.ownerId, identity.botId, generationId, hit.level, hit.finalScore]);
        await client.query("UPDATE memories SET exposure_count=exposure_count+1 WHERE id=$1", [hit.id]);
      }
    });
  }

  async save(identity: Identity, draft: MemoryDraft, embeddings: Record<MemoryLevel, number[]>): Promise<string> {
    return this.scoped(identity, (client) => this.insertMemory(client, identity, draft, embeddings));
  }

  private async insertMemory(client: PoolClient, identity: Identity, draft: MemoryDraft, embeddings: Record<MemoryLevel, number[]>): Promise<string> {
      const result = await client.query(`INSERT INTO memories(owner_id,bot_id,scope_type,scope_key,trigger_concrete,trigger_abstract,trigger_meta,
        body_concrete,body_abstract,body_meta,embedding_concrete,embedding_abstract,embedding_meta,importance,source_generation_id,embedding_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12::vector,$13::vector,$14,$15,2)
        ON CONFLICT(owner_id,bot_id,source_generation_id,trigger_concrete) DO UPDATE SET importance=GREATEST(memories.importance,excluded.importance),updated_at=now() RETURNING id`,
        [identity.ownerId, identity.botId, draft.scopeType, draft.scopeKey, draft.trigger.concrete, draft.trigger.abstract, draft.trigger.meta,
          draft.body.concrete, draft.body.abstract, draft.body.meta, vectorLiteral(embeddings.concrete), vectorLiteral(embeddings.abstract), vectorLiteral(embeddings.meta), draft.importance, draft.sourceGenerationId]);
      const id = result.rows[0].id as string;
      await this.insertTriggerSet(client, identity, id, draft, embeddings);
      return id;
  }

  private async insertTriggerSet(client: PoolClient, identity: Identity, memoryId: string, draft: MemoryDraft,
    embeddings: Record<MemoryLevel, number[]>): Promise<void> {
    await client.query(`INSERT INTO memory_trigger_sets(memory_id,owner_id,bot_id,trigger_concrete,trigger_abstract,trigger_meta,
      embedding_concrete,embedding_abstract,embedding_meta,source_generation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::vector,$8::vector,$9::vector,$10)
      ON CONFLICT(memory_id,trigger_concrete,trigger_abstract,trigger_meta) DO NOTHING`,
      [memoryId, identity.ownerId, identity.botId, draft.trigger.concrete, draft.trigger.abstract, draft.trigger.meta,
        vectorLiteral(embeddings.concrete), vectorLiteral(embeddings.abstract), vectorLiteral(embeddings.meta), draft.sourceGenerationId]);
  }

  async apply(identity: Identity, operation: any, embeddings?: Record<MemoryLevel, number[]>): Promise<void> {
    if (operation.operation === "none") return;
    await this.scoped(identity, async (client) => {
      if (operation.operation === "create") { await this.insertMemory(client, identity, operation.memory, embeddings!); return; }
      if (operation.operation === "reinforce") {
        const result = await client.query("UPDATE memories SET usefulness=LEAST(1,usefulness+0.05),importance=LEAST(100,importance+2),updated_at=now() WHERE id=$1 AND status='active' RETURNING id", [operation.targetId]);
        if (result.rowCount !== 1) throw new Error("Reinforcement target is not an active memory in this Bot namespace");
        return;
      }
      if (!operation.memory || !embeddings) throw new Error(`${operation.operation} requires a replacement memory`);
      const target = await client.query("SELECT id FROM memories WHERE id=$1 AND status='active' FOR UPDATE", [operation.targetId]);
      if (target.rowCount !== 1) throw new Error("Replacement target is not an active memory in this Bot namespace");
      if (operation.operation === "merge") {
        await this.insertTriggerSet(client, identity, operation.targetId, operation.memory, embeddings);
        await client.query(`UPDATE memories SET body_concrete=$2,body_abstract=$3,body_meta=$4,
          importance=GREATEST(importance,$5),merge_count=merge_count+1,updated_at=now() WHERE id=$1`,
          [operation.targetId, operation.memory.body.concrete, operation.memory.body.abstract, operation.memory.body.meta, operation.memory.importance]);
        return;
      }
      const replacementId = await this.insertMemory(client, identity, operation.memory, embeddings);
      await client.query("UPDATE memories SET status='superseded',superseded_by=$2,updated_at=now() WHERE id=$1", [operation.targetId, replacementId]);
    });
  }

  async claimJob(workerId: string): Promise<ClaimedJob | undefined> {
    const result = await this.pool.query("SELECT * FROM grok_memory_claim_job($1)", [workerId]);
    const row = result.rows[0];
    return row ? { id: row.id, ownerId: row.owner_id, botId: row.bot_id, payload: row.payload as TurnRecord, attempts: row.attempts } : undefined;
  }

  async finishJob(jobId: string, ok: boolean, error?: string): Promise<void> {
    await this.pool.query("SELECT grok_memory_finish_job($1,$2,$3)", [jobId, ok, error?.slice(0, 2_000) ?? null]);
  }

  async requeueFailedJobs(limit = 100): Promise<number> {
    const result = await this.pool.query("SELECT grok_memory_requeue_failed($1) AS count", [limit]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async recentMemorySummary(identity: Identity, limit: number): Promise<string> {
    const rows = await this.inspect(identity, limit);
    return rows.map((row) => JSON.stringify({ id: row.id, scopeType: row.scope_type, scopeKey: row.scope_key,
      triggerSets: row.trigger_sets, mergeCount: row.merge_count,
      body: { concrete: row.body_concrete, abstract: row.body_abstract, meta: row.body_meta },
      importance: row.importance, usefulness: row.usefulness })).join("\n");
  }

  async rate(identity: Identity, memoryId: string, generationId: string, usefulness: number): Promise<void> {
    await this.scoped(identity, async (client) => {
      await client.query("UPDATE memory_exposures SET usefulness=$4 WHERE memory_id=$1 AND bot_id=$2 AND generation_id=$3", [memoryId, identity.botId, generationId, usefulness]);
      await client.query("UPDATE memories SET usefulness=(usefulness*0.8)+($2::real/100*0.2),updated_at=now() WHERE id=$1", [memoryId, usefulness]);
      await client.query(`INSERT INTO memory_events(owner_id,bot_id,conversation_id,generation_id,event_type,details)
        VALUES($1,$2,$3,$4,'rate',$5::jsonb)`, [identity.ownerId, identity.botId, identity.conversationId, generationId, JSON.stringify({ memoryId, usefulness })]);
    });
  }

  async forget(identity: Identity, memoryId: string): Promise<boolean> {
    return this.scoped(identity, async (client) => (await client.query("UPDATE memories SET status='deleted',updated_at=now() WHERE id=$1 AND bot_id=$2 RETURNING id", [memoryId, identity.botId])).rowCount === 1);
  }

  async grant(identity: Identity, memoryId: string, granteeBotId: string): Promise<void> {
    await this.scoped(identity, async (client) => {
      await client.query("SELECT grok_memory_grant($1,$2)", [memoryId, granteeBotId]);
    });
  }

  async pruneTurns(retentionDays: number): Promise<number> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("retentionDays must be positive");
    const result = await this.pool.query("SELECT grok_memory_prune_turns($1) AS removed", [retentionDays]);
    return Number(result.rows[0]?.removed ?? 0);
  }

  async inspect(identity: Identity, limit: number): Promise<Array<Record<string, unknown>>> {
    return this.scoped(identity, async (client) => (await client.query(`SELECT m.id,m.scope_type,m.scope_key,
      m.trigger_concrete,m.trigger_abstract,m.trigger_meta,m.body_concrete,m.body_abstract,m.body_meta,
      m.importance,m.usefulness,m.exposure_count,m.merge_count,m.updated_at,
      count(t.id)::int AS trigger_count,
      COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'concrete',t.trigger_concrete,'abstract',t.trigger_abstract,
        'meta',t.trigger_meta,'sourceGenerationId',t.source_generation_id,'createdAt',t.created_at)
        ORDER BY t.created_at) FILTER (WHERE t.id IS NOT NULL),'[]'::jsonb) AS trigger_sets
      FROM memories m LEFT JOIN memory_trigger_sets t ON t.memory_id=m.id WHERE m.status='active'
      GROUP BY m.id ORDER BY m.updated_at DESC LIMIT $1`, [limit])).rows);
  }

  async timeline(identity: Identity, limit: number): Promise<TimelineEntry[]> {
    return this.scoped(identity, async (client) => {
      const result = await client.query(`SELECT * FROM (
        SELECT 'turn' AS kind,created_at,generation_id,left(user_text,500) AS summary,
          jsonb_build_object('assistant',left(assistant_text,500),'model',model) AS details FROM turns
          WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3
        UNION ALL
        SELECT 'note',created_at,NULL,left(content,500),jsonb_build_object('id',id) FROM reflection_notes
          WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3
        UNION ALL
        SELECT 'event',created_at,generation_id,event_type,details FROM memory_events
          WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3
        UNION ALL
        SELECT 'memory',created_at,source_generation_id,left(trigger_concrete,500),
          jsonb_build_object('id',id,'body',left(body_concrete,500),'status',status,'mergeCount',merge_count,
            'triggerCount',(SELECT count(*) FROM memory_trigger_sets t WHERE t.memory_id=memories.id)) FROM memories
          WHERE owner_id=$1 AND bot_id=$2
      ) timeline ORDER BY created_at DESC LIMIT $4`, [identity.ownerId, identity.botId, identity.conversationId, limit]);
      return result.rows.reverse().map((row: any) => ({ kind: row.kind, createdAt: new Date(row.created_at).toISOString(),
        ...(row.generation_id ? { generationId: row.generation_id } : {}), summary: row.summary, details: row.details ?? {} }));
    });
  }

  async compliance(identity: Identity): Promise<{ completedTurns: number; observedRecallCalls: number; exactlyPairedTurns: number; turnsWithoutExactObservedRecall: number }> {
    return this.scoped(identity, async (client) => {
      const result = await client.query(`SELECT
        (SELECT count(*) FROM turns WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3 AND assistant_text<>'')::int AS completed_turns,
        (SELECT count(*) FROM memory_events WHERE owner_id=$1 AND bot_id=$2 AND conversation_id=$3 AND event_type='recall')::int AS recall_calls,
        (SELECT count(*) FROM turns t WHERE t.owner_id=$1 AND t.bot_id=$2 AND t.conversation_id=$3 AND t.assistant_text<>'' AND EXISTS (
          SELECT 1 FROM memory_events e WHERE e.owner_id=t.owner_id AND e.bot_id=t.bot_id AND e.conversation_id=t.conversation_id
          AND e.event_type='recall' AND e.generation_id=t.generation_id))::int AS paired` , [identity.ownerId, identity.botId, identity.conversationId]);
      const row = result.rows[0]; const completedTurns = Number(row.completed_turns), exactlyPairedTurns = Number(row.paired);
      return { completedTurns, observedRecallCalls: Number(row.recall_calls), exactlyPairedTurns, turnsWithoutExactObservedRecall: completedTurns - exactlyPairedTurns };
    });
  }

  async indexRecords(identity: Identity): Promise<IndexRecord[]> {
    return this.scoped(identity, async (client) => {
      const result = await client.query(`SELECT m.id,m.owner_id,m.bot_id,m.scope_type,m.scope_key,
        t.embedding_concrete::text AS concrete,t.embedding_abstract::text AS abstract,t.embedding_meta::text AS meta
        FROM memories m JOIN memory_trigger_sets t ON t.memory_id=m.id
        WHERE m.owner_id=$1 AND m.bot_id=$2 AND m.status='active'`, [identity.ownerId, identity.botId]);
      return result.rows.flatMap((row: any) => (["concrete", "abstract", "meta"] as const).map((level) => ({
        memoryId: row.id, ownerId: row.owner_id, botId: row.bot_id, scopeType: row.scope_type, scopeKey: row.scope_key, level, vector: parseVector(row[level]),
      })));
    });
  }

  async pendingTriggerEmbeddings(limit: number): Promise<Array<{ id: string; trigger: Record<MemoryLevel, string> }>> {
    const result = await this.pool.query(`SELECT id,trigger_concrete,trigger_abstract,trigger_meta FROM memories
      WHERE status='active' AND embedding_version<2 ORDER BY created_at LIMIT $1`, [limit]);
    return result.rows.map((row: any) => ({ id: row.id, trigger: { concrete: row.trigger_concrete, abstract: row.trigger_abstract, meta: row.trigger_meta } }));
  }

  async updateTriggerEmbeddings(id: string, embeddings: Record<MemoryLevel, number[]>): Promise<void> {
    const values = [id, vectorLiteral(embeddings.concrete), vectorLiteral(embeddings.abstract), vectorLiteral(embeddings.meta)];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE memories SET embedding_concrete=$2::vector,embedding_abstract=$3::vector,embedding_meta=$4::vector,
        embedding_version=2,updated_at=now() WHERE id=$1`, values);
      await client.query(`UPDATE memory_trigger_sets t SET embedding_concrete=$2::vector,embedding_abstract=$3::vector,embedding_meta=$4::vector
        FROM memories m WHERE t.memory_id=m.id AND m.id=$1 AND t.trigger_concrete=m.trigger_concrete
        AND t.trigger_abstract=m.trigger_abstract AND t.trigger_meta=m.trigger_meta`, values);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async recordEvent(identity: Identity, eventType: "recall" | "remember" | "note" | "reflect" | "rate" | "forget" | "brainstorm", generationId?: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.scoped(identity, async (client) => {
      await client.query(`INSERT INTO memory_events(owner_id,bot_id,conversation_id,generation_id,event_type,details)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [identity.ownerId, identity.botId, identity.conversationId, generationId ?? null, eventType, JSON.stringify(details)]);
    });
  }

  async health(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(`SELECT current_database() AS database, extversion AS pgvector_version,
      (SELECT max(version) FROM schema_migrations) AS schema_version,
      grok_memory_queue_depth() AS queue_depth,
      (SELECT count(*) FROM jobs WHERE state='failed') AS failed_jobs,
      (SELECT count(*) FROM jobs WHERE state='running') AS active_workers,
      (SELECT min(locked_at) FROM jobs WHERE state='running') AS oldest_worker_lease,
      (SELECT max(updated_at) FROM jobs WHERE state='done') AS last_completed_job
      FROM pg_extension WHERE extname='vector'`);
    return { ok: result.rowCount === 1, ...result.rows[0] };
  }

  async close(): Promise<void> { await this.pool.end(); }
}
