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
    assert.match(hits[0]!.chain.trigger.abstract, /choosing oranges/); assert.match(hits[0]!.chain.body.meta, /past outcomes/);
    const health = await repo.health(); assert.equal(health.ok, true); assert.equal(health.schema_version, 3); assert.ok(health.pgvector_version);
    assert.ok("active_workers" in health); assert.ok("oldest_worker_lease" in health); assert.ok("last_completed_job" in health);
  } finally { await admin.close(); await repo.close(); }
});

test("MEM-015 upgrades existing trigger-plus-body vectors to trigger-only version 2", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl); const admin = new PostgresRepository(adminDatabaseUrl);
  try {
    const bot = identity(`reembed-${crypto.randomUUID()}`, "reembed-conversation");
    const memoryId = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `reembed-${crypto.randomUUID()}`), embeddings(7));
    await admin.pool.query("UPDATE memories SET embedding_version=1 WHERE id=$1", [memoryId]);
    // The shared integration database may contain older version-1 rows from
    // previous runs, so inspect the full practical backfill batch here.
    const pending = await admin.pendingTriggerEmbeddings(10_000); const target = pending.find((memory) => memory.id === memoryId)!;
    assert.match(target.trigger.concrete, /choosing oranges/);
    await admin.updateTriggerEmbeddings(memoryId, embeddings(8));
    const row = (await admin.pool.query("SELECT embedding_version,embedding_concrete::text AS vector FROM memories WHERE id=$1", [memoryId])).rows[0];
    assert.equal(row.embedding_version, 2); assert.match(row.vector, /^\[0,0,0,0,0,0,0,0,1,/);
    const triggerSet = (await admin.pool.query("SELECT embedding_concrete::text AS vector FROM memory_trigger_sets WHERE memory_id=$1", [memoryId])).rows[0];
    assert.match(triggerSet.vector, /^\[0,0,0,0,0,0,0,0,1,/);
  } finally { await admin.close(); await repo.close(); }
});

test("MEM-019 one thought retains five three-level trigger paths and returns once per search", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  try {
    const suffix = crypto.randomUUID(); const bot = identity(`multi-trigger-${suffix}`, `conversation-${suffix}`);
    const memoryId = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `seed-${suffix}`, "oranges"), embeddings(100));
    const nouns = ["lemons", "limes", "pears", "peaches"];
    for (const [index, noun] of nouns.entries()) {
      const merged = draft(bot.botId, "bot", bot.botId, `merge-${index}-${suffix}`, noun);
      merged.body = { concrete: `refined lesson after ${noun}`, abstract: "one lesson can arise through several situations", meta: "independent paths can converge on one principle" };
      await repo.apply(bot, { operation: "merge", targetId: memoryId, memory: merged, reason: "same lesson, new situation" }, embeddings(101 + index));
    }
    const inspected = (await repo.inspect(bot, 20)).find((row) => row.id === memoryId)!;
    assert.equal(inspected.trigger_count, 5); assert.equal(inspected.merge_count, 4);
    assert.match(String(inspected.body_concrete), /peaches/);
    assert.deepEqual((inspected.trigger_sets as any[]).map((item) => item.concrete),
      [`${bot.botId} is choosing oranges`, ...nouns.map((noun) => `${bot.botId} is choosing ${noun}`)]);
    for (const [index, noun] of ["oranges", ...nouns].entries()) {
      const hits = await repo.search(bot, "concrete", noun, vector(100 + index), 10);
      assert.equal(hits.filter((hit) => hit.id === memoryId).length, 1);
      assert.match(hits.find((hit) => hit.id === memoryId)!.trigger, new RegExp(noun));
      assert.equal(hits.find((hit) => hit.id === memoryId)!.chain.triggerCount, 5);
    }
    const duplicate = draft(bot.botId, "bot", bot.botId, `duplicate-${suffix}`, "peaches");
    await repo.apply(bot, { operation: "merge", targetId: memoryId, memory: duplicate, reason: "rediscovered identically" }, embeddings(104));
    const afterDuplicate = (await repo.inspect(bot, 20)).find((row) => row.id === memoryId)!;
    assert.equal(afterDuplicate.trigger_count, 5); assert.equal(afterDuplicate.merge_count, 5);
  } finally { await repo.close(); }
});

test("MEM-020 schema-2 data is additively backfilled without changing memories, grants, or Bot ownership", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl); const admin = new PostgresRepository(adminDatabaseUrl);
  try {
    const suffix = crypto.randomUUID(); const bot = identity(`upgrade-owner-${suffix}`, `upgrade-conversation-${suffix}`);
    const memoryId = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `upgrade-${suffix}`), embeddings(120));
    await repo.grant(bot, memoryId, `upgrade-grantee-${suffix}`);
    await admin.pool.query("DELETE FROM memory_trigger_sets WHERE memory_id=$1", [memoryId]);
    const before = (await admin.pool.query("SELECT id,owner_id,bot_id,status FROM memories WHERE id=$1", [memoryId])).rows[0];
    await admin.migrate("grok_memory_app"); await admin.migrate("grok_memory_app");
    const after = (await admin.pool.query("SELECT id,owner_id,bot_id,status FROM memories WHERE id=$1", [memoryId])).rows[0];
    assert.deepEqual(after, before);
    assert.equal(Number((await admin.pool.query("SELECT count(*) FROM memory_trigger_sets WHERE memory_id=$1", [memoryId])).rows[0].count), 1);
    assert.equal(Number((await admin.pool.query("SELECT count(*) FROM memory_grants WHERE memory_id=$1", [memoryId])).rows[0].count), 1);
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

test("MEM-016 MEM-017 QUA-009 notes close into an isolated multi-turn chapter and readable timeline", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  try {
    const suffix = crypto.randomUUID(); const bot = identity(`chapter-${suffix}`, `conversation-${suffix}`);
    await repo.completeTurnAndEnqueue({ identity: bot, generationId: `turn-${suffix}`, userText: "Earlier user decision context", assistantText: "Earlier assistant analysis" });
    await repo.addNote(bot, "The fallback boundary became the decisive observation.");
    const reflected = await repo.enqueueReflection(bot, "The chapter compares authoritative storage with accelerated projections.", "PostgreSQL stays canonical and the centroid index remains replaceable.");
    assert.equal(reflected.turnCount, 1); assert.equal(reflected.noteCount, 1);
    let chapterJob;
    for (let index = 0; index < 500; index++) {
      const candidate = await repo.claimJob(`chapter-worker-${suffix}`); if (!candidate) break;
      if (candidate.payload.generationId === reflected.generationId) { chapterJob = candidate; break; }
      await repo.finishJob(candidate.id, true);
    }
    assert.equal(chapterJob?.payload.chapter?.turns[0]?.userText, "Earlier user decision context");
    assert.equal(chapterJob?.payload.chapter?.notes[0]?.content, "The fallback boundary became the decisive observation.");
    await repo.finishJob(chapterJob!.id, true);
    const timeline = await repo.timeline(bot, 50);
    assert.ok(timeline.some((entry) => entry.kind === "note")); assert.ok(timeline.some((entry) => entry.summary === "reflect"));
    const beforeRecall = await repo.compliance(bot); assert.equal(beforeRecall.completedTurns, 1); assert.equal(beforeRecall.turnsWithoutExactObservedRecall, 1);
    await repo.recordEvent(bot, "recall", `turn-${suffix}`, { source: "test" });
    const afterRecall = await repo.compliance(bot); assert.equal(afterRecall.exactlyPairedTurns, 1); assert.equal(afterRecall.turnsWithoutExactObservedRecall, 0);
  } finally { await repo.close(); }
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

test("MEM-008 MEM-019 every consolidation operation executes transactionally", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl);
  try {
    const bot = identity(`operations-${crypto.randomUUID()}`, "operations-conversation");
    await repo.apply(bot, { operation: "none", reason: "nothing" });
    await repo.apply(bot, { operation: "create", memory: draft(bot.botId, "bot", bot.botId, `create-${crypto.randomUUID()}`) }, embeddings(50));
    const reinforced = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `reinforce-${crypto.randomUUID()}`), embeddings(51));
    await repo.apply(bot, { operation: "reinforce", targetId: reinforced, reason: "confirmed" });
    for (const [index, operation] of ["update", "supersede"].entries()) {
      const targetId = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `${operation}-old-${crypto.randomUUID()}`), embeddings(52 + index));
      const replacement = draft(bot.botId, "bot", bot.botId, `${operation}-new-${crypto.randomUUID()}`, `${operation}-fruit`);
      await repo.apply(bot, { operation, targetId, memory: replacement, reason: "new evidence" }, embeddings(60 + index));
      assert.ok((await repo.inspect(bot, 100)).some(item => item.trigger_concrete === replacement.trigger.concrete));
    }
    const mergeTarget = await repo.save(bot, draft(bot.botId, "bot", bot.botId, `merge-old-${crypto.randomUUID()}`), embeddings(54));
    const mergeMemory = draft(bot.botId, "bot", bot.botId, `merge-new-${crypto.randomUUID()}`, "merge-fruit");
    await repo.apply(bot, { operation: "merge", targetId: mergeTarget, memory: mergeMemory, reason: "new path" }, embeddings(60));
    const merged = (await repo.inspect(bot, 100)).find((item) => item.id === mergeTarget)!;
    assert.equal(merged.trigger_count, 2); assert.equal(merged.merge_count, 1);
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

test("DB-003 EMU-007 failed jobs retry with backoff and become terminal after three attempts", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl); const admin = new PostgresRepository(adminDatabaseUrl);
  try {
    const bot = identity(`retry-${crypto.randomUUID()}`, "retry-conversation");
    await repo.completeTurnAndEnqueue({ identity: bot, generationId: "retry-generation", userText: "u", assistantText: "a" });
    let targetId = "";
    for (let expected = 1; expected <= 3; expected++) {
      let claimed;
      for (let index = 0; index < 100; index++) {
        const candidate = await repo.claimJob(`retry-worker-${expected}`); if (!candidate) break;
        if (candidate.botId === bot.botId) { claimed = candidate; break; }
        await repo.finishJob(candidate.id, true);
      }
      assert.equal(claimed?.attempts, expected); targetId = claimed!.id;
      await repo.finishJob(targetId, false, `failure-${expected}`);
      if (expected < 3) await admin.pool.query("UPDATE jobs SET available_at=now() WHERE id=$1", [targetId]);
    }
    const row = (await admin.pool.query("SELECT state,attempts,last_error,locked_at,locked_by FROM jobs WHERE id=$1", [targetId])).rows[0];
    assert.deepEqual({ state: row.state, attempts: row.attempts, lastError: row.last_error, lockedAt: row.locked_at, lockedBy: row.locked_by },
      { state: "failed", attempts: 3, lastError: "failure-3", lockedAt: null, lockedBy: null });
    assert.equal(await repo.claimJob("retry-worker-final"), undefined);
  } finally { await admin.close(); await repo.close(); }
});

test("MEM-018 authentication failures can be requeued after credentials appear", { skip: !enabled }, async () => {
  const repo = new PostgresRepository(databaseUrl); const admin = new PostgresRepository(adminDatabaseUrl);
  try {
    const suffix = crypto.randomUUID(); const bot = identity(`auth-replay-${suffix}`, "auth-replay-conversation");
    await repo.completeTurnAndEnqueue({ identity: bot, generationId: `auth-replay-${suffix}`, userText: "u", assistantText: "a" });
    let targetId = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      let job;
      for (let index = 0; index < 500; index++) {
        const candidate = await repo.claimJob(`auth-worker-${attempt}`); if (!candidate) break;
        if (candidate.botId === bot.botId) { job = candidate; break; }
        await repo.finishJob(candidate.id, true);
      }
      targetId = job!.id; await repo.finishJob(targetId, false, "Grok Build authentication required: please sign in");
      if (attempt < 3) await admin.pool.query("UPDATE jobs SET available_at=now() WHERE id=$1", [targetId]);
    }
    assert.ok(await repo.requeueFailedJobs(100) >= 1);
    const row = (await admin.pool.query("SELECT state,attempts,last_error FROM jobs WHERE id=$1", [targetId])).rows[0];
    assert.deepEqual(row, { state: "queued", attempts: 0, last_error: null });
  } finally { await admin.close(); await repo.close(); }
});
