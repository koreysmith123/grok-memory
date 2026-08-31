import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type PoolClient } from "pg";
import type { Identity, MemoryDraft, MemoryLevel, SearchHit, TurnRecord } from "./types.js";

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
  completeTurnAndEnqueue(turn: TurnRecord): Promise<void>;
  search(identity: Identity, level: MemoryLevel, text: string, embedding: number[], limit: number): Promise<SearchHit[]>;
  recordExposures(identity: Identity, generationId: string, hits: SearchHit[]): Promise<void>;
  save(identity: Identity, draft: MemoryDraft, embeddings: Record<MemoryLevel, number[]>): Promise<string>;
  apply(identity: Identity, operation: any, embeddings?: Record<MemoryLevel, number[]>): Promise<void>;
  claimJob(workerId: string): Promise<ClaimedJob | undefined>;
  finishJob(jobId: string, ok: boolean, error?: string): Promise<void>;
  recentMemorySummary(identity: Identity, limit: number): Promise<string>;
  rate(identity: Identity, memoryId: string, generationId: string, usefulness: number): Promise<void>;
  forget(identity: Identity, memoryId: string): Promise<boolean>;
  grant(identity: Identity, memoryId: string, granteeBotId: string): Promise<void>;
  pruneTurns(retentionDays: number): Promise<number>;
  inspect(identity: Identity, limit: number): Promise<Array<Record<string, unknown>>>;
  health(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== 768 || vector.some((value) => !Number.isFinite(value))) throw new Error("Expected a finite 768-dimensional vector");
  return `[${vector.join(",")}]`;
}

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
      await this.pool.query(`GRANT EXECUTE ON FUNCTION grok_memory_claim_job(text), grok_memory_finish_job(uuid,boolean,text), grok_memory_queue_depth(), grok_memory_grant(uuid,text), grok_memory_prune_turns(integer) TO ${appRole}`);
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
      const scope = `(owner_id=$7 AND ((bot_id=$3 AND ((scope_type='bot' AND scope_key=$3) OR (scope_type='conversation' AND scope_key=$4) OR (scope_type='project' AND $5::text IS NOT NULL AND scope_key=$5))) OR (bot_id<>$3 AND EXISTS (SELECT 1 FROM memory_grants grant_row WHERE grant_row.memory_id=memories.id AND grant_row.grantee_bot_id=$3))))`;
      const result = await client.query(`WITH vector_candidates AS MATERIALIZED (
        SELECT id FROM memories WHERE status='active' AND ${scope} ORDER BY embedding_${column} <=> $1::vector LIMIT $6
      ), lexical_candidates AS MATERIALIZED (
        SELECT id FROM memories WHERE status='active' AND ${scope}
        AND to_tsvector('english',trigger_${column} || ' ' || body_${column}) @@ plainto_tsquery('english',$2)
        ORDER BY ts_rank_cd(to_tsvector('english',trigger_${column} || ' ' || body_${column}), plainto_tsquery('english',$2)) DESC LIMIT $6
      ), candidates AS (SELECT id FROM vector_candidates UNION SELECT id FROM lexical_candidates)
      SELECT id, '${level}' AS level, trigger_${column} AS trigger, body_${column} AS body,
        scope_type, scope_key, 1-(embedding_${column} <=> $1::vector) AS vector_score,
        ts_rank_cd(to_tsvector('english',trigger_${column} || ' ' || body_${column}), plainto_tsquery('english',$2)) AS lexical_score,
        importance, usefulness, updated_at
        FROM memories WHERE id IN (SELECT id FROM candidates)`,
        [vectorLiteral(embedding), text, identity.botId, identity.conversationId, identity.projectId ?? null, limit * 3, identity.ownerId]);
      return result.rows.map((row: any) => {
        const ageDays = Math.max(0, (Date.now() - new Date(row.updated_at).getTime()) / 86_400_000);
        const vectorScore = Number(row.vector_score);
        const lexicalScore = Math.min(1, Number(row.lexical_score) * 4);
        const importance = Number(row.importance);
        const usefulness = Number(row.usefulness);
        return { id: row.id, level, trigger: row.trigger, body: row.body, scopeType: row.scope_type, scopeKey: row.scope_key,
          vectorScore, lexicalScore, importance, usefulness, updatedAt: new Date(row.updated_at),
          finalScore: scoreMemory({ vectorScore, lexicalScore: Number(row.lexical_score), importance, usefulness, ageDays }) } satisfies SearchHit;
      }).sort((a: SearchHit, b: SearchHit) => b.finalScore - a.finalScore).slice(0, limit);
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
        body_concrete,body_abstract,body_meta,embedding_concrete,embedding_abstract,embedding_meta,importance,source_generation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12::vector,$13::vector,$14,$15)
        ON CONFLICT(owner_id,bot_id,source_generation_id,trigger_concrete) DO UPDATE SET importance=GREATEST(memories.importance,excluded.importance),updated_at=now() RETURNING id`,
        [identity.ownerId, identity.botId, draft.scopeType, draft.scopeKey, draft.trigger.concrete, draft.trigger.abstract, draft.trigger.meta,
          draft.body.concrete, draft.body.abstract, draft.body.meta, vectorLiteral(embeddings.concrete), vectorLiteral(embeddings.abstract), vectorLiteral(embeddings.meta), draft.importance, draft.sourceGenerationId]);
      return result.rows[0].id as string;
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

  async recentMemorySummary(identity: Identity, limit: number): Promise<string> {
    const rows = await this.inspect(identity, limit);
    return rows.map((row) => `[${row.id}] ${row.trigger_concrete}: ${row.body_concrete}`).join("\n");
  }

  async rate(identity: Identity, memoryId: string, generationId: string, usefulness: number): Promise<void> {
    await this.scoped(identity, async (client) => {
      await client.query("UPDATE memory_exposures SET usefulness=$4 WHERE memory_id=$1 AND bot_id=$2 AND generation_id=$3", [memoryId, identity.botId, generationId, usefulness]);
      await client.query("UPDATE memories SET usefulness=(usefulness*0.8)+($2::real/100*0.2),updated_at=now() WHERE id=$1", [memoryId, usefulness]);
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
    return this.scoped(identity, async (client) => (await client.query(`SELECT id,scope_type,scope_key,trigger_concrete,body_concrete,importance,usefulness,exposure_count,updated_at
      FROM memories WHERE status='active' ORDER BY updated_at DESC LIMIT $1`, [limit])).rows);
  }

  async health(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(`SELECT current_database() AS database, extversion AS pgvector_version,
      (SELECT max(version) FROM schema_migrations) AS schema_version,
      grok_memory_queue_depth() AS queue_depth,
      (SELECT count(*) FROM jobs WHERE state='running') AS active_workers,
      (SELECT min(locked_at) FROM jobs WHERE state='running') AS oldest_worker_lease,
      (SELECT max(updated_at) FROM jobs WHERE state='done') AS last_completed_job
      FROM pg_extension WHERE extname='vector'`);
    return { ok: result.rowCount === 1, ...result.rows[0] };
  }

  async close(): Promise<void> { await this.pool.end(); }
}
