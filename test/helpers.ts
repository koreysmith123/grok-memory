import { createServer } from "node:http";
import type { ClaimedJob, MemoryRepository } from "../src/db.js";
import type { Embedder, EmbeddingPurpose } from "../src/embedding.js";
import type { GrokReasoner } from "../src/grok-build.js";
import type { ConsolidationOperation, Identity, MemoryDraft, MemoryLevel, SearchHit, ThreeLevels, TurnRecord } from "../src/types.js";

export class FakeEmbedder implements Embedder {
  readonly dimensions = 768;
  readonly calls: Array<{ text: string; purpose: EmbeddingPurpose }> = [];
  async embed(text: string, purpose: EmbeddingPurpose): Promise<number[]> {
    this.calls.push({ text, purpose });
    const value = Math.max(0.001, (text.length % 97) / 97);
    return Array.from({ length: 768 }, (_, index) => index === 0 ? value : 0);
  }
}

export class FakeGrok implements GrokReasoner {
  constructor(public levels: ThreeLevels = { concrete: "specific current task", abstract: "structural task pattern", meta: "universal pattern" }) {}
  operations: ConsolidationOperation[] = [{ operation: "none", reason: "nothing durable" }];
  failInterpret = false;
  async interpret(_prompt?: string): Promise<ThreeLevels> { if (this.failInterpret) throw new Error("offline"); return this.levels; }
  async consolidate(_prompt?: string): Promise<ConsolidationOperation[]> { return this.operations; }
}

export class FakeRepository implements MemoryRepository {
  bindingValue?: { botId: string; projectId?: string };
  prompts = new Map<string, string>();
  turns: TurnRecord[] = [];
  hits: Record<MemoryLevel, SearchHit[]> = { concrete: [], abstract: [], meta: [] };
  saved: MemoryDraft[] = [];
  exposures: SearchHit[] = [];
  async binding() { return this.bindingValue; }
  async bind(identity: Identity) { this.bindingValue = { botId: identity.botId, ...(identity.projectId ? { projectId: identity.projectId } : {}) }; }
  async recordPrompt(_identity: Identity, generationId: string, prompt: string) { this.prompts.set(generationId, prompt); }
  async promptForGeneration(_identity: Identity, generationId: string) { return this.prompts.get(generationId) ?? ""; }
  async recentTurns(_identity: Identity, limit: number) { return this.turns.slice(-limit).map((turn) => ({ userText: turn.userText, assistantText: turn.assistantText })); }
  async completeTurnAndEnqueue(turn: TurnRecord) { if (!this.turns.some((item) => item.generationId === turn.generationId)) this.turns.push(turn); }
  async search(_identity: Identity, level: MemoryLevel) { return this.hits[level]; }
  async recordExposures(_identity: Identity, _generation: string, hits: SearchHit[]) { this.exposures.push(...hits); }
  async save(_identity: Identity, draft: MemoryDraft, _embeddings?: Record<MemoryLevel, number[]>) { this.saved.push(draft); return crypto.randomUUID(); }
  async apply(identity: Identity, operation: any, embeddings?: Record<MemoryLevel, number[]>) { if (operation.operation === "create") await this.save(identity, operation.memory, embeddings!); }
  async claimJob(): Promise<ClaimedJob | undefined> { return undefined; }
  async finishJob() {}
  async recentMemorySummary() { return ""; }
  async rate() {}
  async forget() { return true; }
  async grant() {}
  async pruneTurns() { return 0; }
  async inspect() { return []; }
  async health() { return { ok: true, pgvector_version: "test", schema_version: 1, queue_depth: 0 }; }
  async close() {}
}

export function hit(id: string, level: MemoryLevel, score: number, overrides: Partial<SearchHit> = {}): SearchHit {
  return { id, level, trigger: `trigger ${id}`, body: `lesson ${id}`, scopeType: "bot", scopeKey: "bot-a", vectorScore: score,
    lexicalScore: 0.2, importance: 70, usefulness: 0.5, updatedAt: new Date(), finalScore: score, ...overrides };
}

export async function fakeDaemon(handler?: (path: string, body: any) => unknown | Promise<unknown>) {
  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url ?? "", body });
    try {
      const value = handler ? await handler(req.url ?? "", body) : req.url === "/v1/health" ? { ok: true } : { ok: true };
      const output = JSON.stringify(value);
      res.writeHead(200, { "content-type": "application/json" }); res.end(output);
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
