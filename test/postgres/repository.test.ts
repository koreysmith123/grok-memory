import assert from "node:assert/strict";
import test from "node:test";
import { PostgresRepository } from "../../src/db.js";
import type { Identity, MemoryDraft, MemoryLevel } from "../../src/types.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDaemon } from "../../src/daemon.js";
import { GrokBotEmulator } from "../../src/emulator.js";
import { DaemonClient } from "../../src/http-client.js";
import { MemoryService } from "../../src/memory/service.js";
import { FakeEmbedder, FakeGrok } from "../helpers.js";

const enabled = process.env.GROK_MEMORY_POSTGRES_TEST === "1";
const databaseUrl = process.env.GROK_MEMORY_TEST_DATABASE_URL ?? "postgresql://grok_memory_app@127.0.0.1:55439/grok_memory_test";
const adminDatabaseUrl = process.env.GROK_MEMORY_TEST_ADMIN_DATABASE_URL ?? "postgresql://127.0.0.1:55439/grok_memory_test";
const vector = (axis: number): number[] => Array.from({ length: 768 }, (_, index) => index === axis ? 1 : 0);
const embeddings = (axis = 0): Record<MemoryLevel, number[]> => ({ concrete: vector(axis), abstract: vector(axis), meta: vector(axis) });
const identity = (botId: string, conversationId: string, projectId?: string): Identity => ({ ownerId: "integration-owner", botId, conversationId, ...(projectId ? { projectId } : {}), resolution: "explicit" });
const draft = (botId: string, scopeType: "bot" | "project" | "conversation", scopeKey: string, generation: string, noun = "oranges"): MemoryDraft => ({
  trigger: { concrete: `${botId} is choosing ${noun}`, abstract: `someone is choosing ${noun}`, meta: "a choice is guided by prior experience" },
  body: { concrete: `${botId} prefers fresh ${noun}`, abstract: `prefer reliable ${noun}`, meta: "past outcomes should guide future choices" },
  importance: 80, scopeType, scopeKey, sourceGenerationId: generation,
});

test("DB-002 DB-005 DB-006 DB-008 migrations, vector/FTS search, and health", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  const admin = new PostgresRepository(adminDatabaseUrl);
  try {
    await admin.migrate("grok_memory_app"); await admin.migrate("grok_memory_app");
    const bot = identity("search-bot", "search-conversation", "project-a");
    await repo.save(bot, draft(bot.botId, "bot", bot.botId, `search-${crypto.randomUUID()}`), embeddings());
    const hits = await repo.search(bot, "concrete", "fresh oranges", vector(0), 5);
    assert.ok(hits.some((item) => item.trigger.includes("oranges")));
    assert.ok(hits[0]!.vectorScore > .99); assert.ok(hits[0]!.lexicalScore >= 0);
    const health = await repo.health(); assert.equal(health.ok, true); assert.equal(health.schema_version, 1); assert.ok(health.pgvector_version);
    assert.ok("active_workers" in health); assert.ok("oldest_worker_lease" in health); assert.ok("last_completed_job" in health);
  } finally { await admin.close(); await repo.close(); }
});

test("ISO-002 ISO-003 ISO-004 ISO-005 namespace matrix, RLS, and explicit sharing", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  try {
    const suffix = crypto.randomUUID();
    const a = identity(`isolation-a-${suffix}`, `conv-a-${suffix}`, `project-a-${suffix}`), b = identity(`isolation-b-${suffix}`, `conv-b-${suffix}`, `project-b-${suffix}`);
    const botMemory = await repo.save(a, draft(a.botId, "bot", a.botId, `bot-${crypto.randomUUID()}`), embeddings(1));
    await repo.save(a, draft(a.botId, "conversation", a.conversationId, `conv-${crypto.randomUUID()}`, "lemons"), embeddings(2));
    await repo.save(a, draft(a.botId, "project", a.projectId!, `project-${crypto.randomUUID()}`, "limes"), embeddings(3));
    assert.ok((await repo.search(a, "concrete", "oranges", vector(1), 10)).length >= 1);
    assert.equal((await repo.search(b, "concrete", "oranges", vector(1), 10)).length, 0);
    const raw = await repo.pool.query("SELECT count(*) AS count FROM memories WHERE owner_id='integration-owner'");
    assert.equal(Number(raw.rows[0].count), 0, "RLS must hide rows without scoped settings");
    await repo.grant(a, botMemory, b.botId);
    assert.ok((await repo.search(b, "concrete", "oranges", vector(1), 10)).some((item) => item.id === botMemory));
  } finally { await repo.close(); }
});

test("DB-003 DB-004 MEM-007 MEM-009 16 workers claim 250 concurrent jobs exactly once", { skip: !enabled, timeout: 30_000 }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  try {
    const bot = identity(`jobs-${crypto.randomUUID()}`, "jobs-conversation");
    await Promise.all(Array.from({ length: 250 }, (_, index) => repo.completeTurnAndEnqueue({ identity: bot, generationId: `job-${index}`,
      userText: `request ${index}`, assistantText: `response ${index}` })));
    await repo.completeTurnAndEnqueue({ identity: bot, generationId: "job-0", userText: "duplicate", assistantText: "duplicate" });
    const claimed: string[] = [], ownClaimed: string[] = [];
    await Promise.all(Array.from({ length: 16 }, async (_, worker) => {
      while (true) {
        const job = await repo.claimJob(`worker-${worker}`); if (!job) break;
        claimed.push(job.id); if (job.botId === bot.botId) ownClaimed.push(job.id); await repo.finishJob(job.id, true);
      }
    }));
    assert.equal(ownClaimed.length, 250); assert.equal(new Set(ownClaimed).size, 250); assert.equal(new Set(claimed).size, claimed.length);
  } finally { await repo.close(); }
});

test("MEM-001 MEM-012 constraints and transcript retention", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  const admin = new PostgresRepository(adminDatabaseUrl);
  try {
    const bot = identity("retention-bot", "retention-conversation");
    await assert.rejects(repo.save(bot, { ...draft(bot.botId, "bot", bot.botId, `bad-${crypto.randomUUID()}`), trigger: { concrete: "", abstract: "valid abstract", meta: "valid meta" } }, embeddings()));
    await repo.completeTurnAndEnqueue({ identity: bot, generationId: `old-${crypto.randomUUID()}`, userText: "old", assistantText: "old" });
    await admin.pool.query("UPDATE turns SET created_at=now()-interval '60 days' WHERE bot_id=$1", [bot.botId]);
    const beforeMemories = (await repo.inspect(bot, 100)).length;
    assert.ok(await repo.pruneTurns(30) >= 1); assert.equal((await repo.inspect(bot, 100)).length, beforeMemories);
  } finally { await admin.close(); await repo.close(); }
});

test("DB-004 ISO-002 32 simultaneous Bot read/write workloads remain isolated", { skip: !enabled, timeout: 30_000 }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  try {
    const suffix = crypto.randomUUID();
    await Promise.all(Array.from({ length: 32 }, async (_, index) => {
      const bot = identity(`parallel-${index}-${suffix}`, `conversation-${index}-${suffix}`);
      const memoryId = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `parallel-${index}-${suffix}`, `fruit-${index}`), embeddings(index));
      const hits = await repo.search(bot, "concrete", `fruit-${index}`, vector(index), 5);
      assert.deepEqual(hits.map((item) => item.id), [memoryId]);
    }));
  } finally { await repo.close(); }
});

test("EMU-001 EMU-005 EMU-006 EMU-007 MCP-005 production hooks handle concurrent Bots and exact forgetting", { skip: !enabled, timeout: 30_000 }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  const config = loadConfig({ DATABASE_URL: databaseUrl, GROK_MEMORY_OWNER_ID: "integration-owner", GROK_MEMORY_JOB_POLL_MS: "50" });
  const service = new MemoryService(config, repo, new FakeEmbedder(), new FakeGrok());
  const daemon = new MemoryDaemon(config, repo, service);
  const server = await daemon.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("daemon did not bind TCP");
  const url = `http://127.0.0.1:${address.port}`;
  const previous = process.env.GROK_MEMORY_DAEMON_URL; process.env.GROK_MEMORY_DAEMON_URL = url;
  try {
    const suffix = crypto.randomUUID();
    const a = identity(`emu-a-${suffix}`, `emu-conv-a-${suffix}`), b = identity(`emu-b-${suffix}`, `emu-conv-b-${suffix}`);
    const aId = await service.remember(a, "alpha-private-memory", "bot");
    await service.remember(b, "beta-private-memory", "bot");
    const emulator = new GrokBotEmulator();
    const [aTurn, bTurn] = await Promise.all([
      emulator.turn({ botId: a.botId, conversationId: a.conversationId, generationId: `a-${suffix}`, user: "retrieve alpha", assistant: "done" }),
      emulator.turn({ botId: b.botId, conversationId: b.conversationId, generationId: `b-${suffix}`, user: "retrieve beta", assistant: "done" }),
    ]);
    assert.match(aTurn.injected ?? "", /alpha-private-memory/); assert.doesNotMatch(aTurn.injected ?? "", /beta-private-memory/);
    assert.match(bTurn.injected ?? "", /beta-private-memory/); assert.doesNotMatch(bTurn.injected ?? "", /alpha-private-memory/);
    const client = new DaemonClient(url);
    const args = { ownerId: a.ownerId, botId: a.botId, conversationId: a.conversationId, memoryId: aId };
    await assert.rejects(client.tool("forget", { ...args, confirm: "wrong" }));
    assert.deepEqual(await client.tool("forget", { ...args, confirm: `forget:${aId}` }), { forgotten: true });
  } finally {
    daemon.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); await repo.close();
    if (previous === undefined) delete process.env.GROK_MEMORY_DAEMON_URL; else process.env.GROK_MEMORY_DAEMON_URL = previous;
  }
});

test("MEM-008 every consolidation operation executes transactionally", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  try {
    const bot = identity(`operations-${crypto.randomUUID()}`, "operations-conversation");
    await repo.apply(bot, { operation: "none", reason: "nothing" });
    await repo.apply(bot, { operation: "create", memory: draft(bot.botId, "bot", bot.botId, `create-${crypto.randomUUID()}`) }, embeddings(50));
    const reinforced = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `reinforce-${crypto.randomUUID()}`), embeddings(51));
    await repo.apply(bot, { operation: "reinforce", targetId: reinforced, reason: "confirmed" });
    for (const [index, operation] of ["update", "merge", "supersede"].entries()) {
      const targetId = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `${operation}-old-${crypto.randomUUID()}`), embeddings(52 + index));
      const replacement = draft(bot.botId, "bot", bot.botId, `${operation}-new-${crypto.randomUUID()}`, `${operation}-fruit`);
      await repo.apply(bot, { operation, targetId, memory: replacement, reason: "new evidence" }, embeddings(60 + index));
      assert.ok((await repo.inspect(bot, 100)).some(item => item.trigger_concrete === replacement.trigger.concrete));
    }
    await assert.rejects(repo.apply(bot, { operation: "reinforce", targetId: crypto.randomUUID(), reason: "hallucinated" }));
  } finally { await repo.close(); }
});

test("EMU-007 stale worker leases are recovered after a daemon restart", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl); const admin = new PostgresRepository(adminDatabaseUrl);
  try {
    const bot = identity(`restart-${crypto.randomUUID()}`, "restart-conversation");
    await repo.completeTurnAndEnqueue({ identity: bot, generationId: "restart-generation", userText: "u", assistantText: "a" });
    await admin.pool.query("UPDATE jobs SET state='running',locked_at=now()-interval '10 minutes',locked_by='dead-worker' WHERE bot_id=$1", [bot.botId]);
    let recovered;
    for (let index = 0; index < 100; index++) {
      const claimed = await repo.claimJob("replacement-worker"); if (!claimed) break;
      if (claimed.botId === bot.botId) { recovered = claimed; break; }
      await repo.finishJob(claimed.id, true);
    }
    assert.equal(recovered?.botId, bot.botId); assert.equal(recovered?.attempts, 1);
    await repo.finishJob(recovered!.id, true);
  } finally { await admin.close(); await repo.close(); }
});
