import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmbeddingGemma } from "../../src/embedding.js";
import { GrokBuildClient } from "../../src/grok-build.js";
import { verifyOrCreateCacheManifest } from "../../src/cache-integrity.js";
import { consolidationPrompt, interpretationPrompt } from "../../src/memory/prompts.js";

const enabled = process.env.GROK_MEMORY_LIVE_TEST === "1";

test("EMU-005 MOD-001 live authenticated Grok Build returns validated three-level interpretation", { skip: !enabled, timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "grok-memory-live-"));
  const grokModel = process.env.GROK_MEMORY_MODEL?.trim();
  const client = new GrokBuildClient({ grokBinary: process.env.GROK_MEMORY_GROK_BINARY ?? "grok", dataDir, ...(grokModel ? { grokModel } : {}) });
  const levels = await client.interpret(interpretationPrompt("A developer is testing an agent memory adapter."));
  assert.ok(levels.concrete.length > 3); assert.ok(levels.abstract.length > 3); assert.ok(levels.meta.length > 3);
  const operations = await client.consolidate(consolidationPrompt({ generationId: "live-validation", botId: "validation-bot",
    conversationId: "validation-conversation", userText: "Please verify the memory adapter.", assistantText: "The adapter was verified.", existingMemories: "" }));
  assert.ok(Array.isArray(operations)); assert.ok(operations.length <= 12);
});

test("INS-005 MOD-002 live EmbeddingGemma q4 loads, caches, and returns normalized 768d vectors", { skip: !enabled, timeout: 300_000 }, async () => {
  const cache = process.env.GROK_MEMORY_MODEL_CACHE ?? join(tmpdir(), "grok-memory-embedding-cache");
  const embedder = new EmbeddingGemma({ modelCacheDir: cache });
  const first = await embedder.embed("memory retrieval test", "query");
  const second = await embedder.embed("memory retrieval test", "document");
  assert.equal(first.length, 768); assert.equal(second.length, 768);
  const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, `expected normalized vector, got ${norm}`);
  await verifyOrCreateCacheManifest(cache);
  assert.equal((await verifyOrCreateCacheManifest(cache)).status, "verified");
});
