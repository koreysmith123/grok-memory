import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GrokBotEmulator } from "../dist/emulator.js";
import { DaemonClient } from "../dist/http-client.js";

const databaseUrl = process.env.GROK_MEMORY_TEST_DATABASE_URL;
const modelCache = process.env.GROK_MEMORY_MODEL_CACHE;
if (!databaseUrl || !modelCache) throw new Error("Set GROK_MEMORY_TEST_DATABASE_URL and GROK_MEMORY_MODEL_CACHE");
const temporary = await mkdtemp(join(tmpdir(), "grok-memory-e2e-"));
const port = 18400 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}`;
const ownerId = `e2e-owner-${crypto.randomUUID()}`;
const env = { ...process.env, DATABASE_URL: databaseUrl, GROK_MEMORY_MODEL_CACHE: modelCache,
  GROK_MEMORY_DATA_DIR: temporary, GROK_MEMORY_GROK_FIXTURES: resolve("test/fixtures/grok"),
  GROK_MEMORY_OWNER_ID: ownerId, GROK_MEMORY_PORT: String(port), GROK_MEMORY_DAEMON_URL: url, GROK_MEMORY_JOB_POLL_MS: "50" };
const daemon = spawn(process.execPath, [resolve("dist/cli.js"), "daemon"], { env, stdio: ["ignore", "ignore", "pipe"] });
let daemonError = ""; daemon.stderr.setEncoding("utf8"); daemon.stderr.on("data", value => daemonError = (daemonError + value).slice(-20_000));
const client = new DaemonClient(url);
const previousUrl = process.env.GROK_MEMORY_DAEMON_URL;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await client.health()).ok) { ready = true; break; } } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  if (!ready) throw new Error(`daemon did not become healthy\n${daemonError}`);
  process.env.GROK_MEMORY_DAEMON_URL = url;
  const suffix = crypto.randomUUID();
  const identities = [
    { ownerId, botId: `real-a-${suffix}`, conversationId: `real-conv-a-${suffix}` },
    { ownerId, botId: `real-b-${suffix}`, conversationId: `real-conv-b-${suffix}` },
  ];
  const [aMemory, bMemory] = await Promise.all([
    client.tool("remember", { ...identities[0], triggerConcrete: "Bot A needs its alpha private calibration memory now",
      triggerAbstract: "an agent needs a private calibration fact", triggerMeta: "identity boundaries preserve experience",
      bodyConcrete: "Bot A retains alpha-real-embedding-private-memory", bodyAbstract: "retain the agent's private calibration fact",
      bodyMeta: "private experience must remain identity-scoped", scopeType: "bot" }),
    client.tool("remember", { ...identities[1], triggerConcrete: "Bot B needs its beta private calibration memory now",
      triggerAbstract: "an agent needs a private calibration fact", triggerMeta: "identity boundaries preserve experience",
      bodyConcrete: "Bot B retains beta-real-embedding-private-memory", bodyAbstract: "retain the agent's private calibration fact",
      bodyMeta: "private experience must remain identity-scoped", scopeType: "bot" }),
  ]);
  assert.match(aMemory.id, /^[0-9a-f-]{36}$/); assert.match(bMemory.id, /^[0-9a-f-]{36}$/);
  const recallArgs = { ...identities[0], currentContext: "retrieve the alpha private memory while measuring recall latency",
    concrete: "retrieve alpha-real-embedding-private-memory for bot A",
    abstract: "recall a private agent memory by semantic similarity",
    meta: "use durable experience without crossing agent namespaces" };
  await client.tool("recall", recallArgs);
  const recallSamplesMs = [];
  for (let index = 0; index < 7; index++) {
    const started = performance.now();
    const recalled = await client.tool("recall", recallArgs);
    recallSamplesMs.push(performance.now() - started);
    assert.match(recalled.additionalContext ?? "", /alpha-real-embedding-private-memory/);
    assert.ok(Number.isFinite(recalled.memoryServiceMs));
  }
  const sortedRecallSamples = [...recallSamplesMs].sort((a, b) => a - b);
  const recallP95Ms = sortedRecallSamples[Math.ceil(sortedRecallSamples.length * 0.95) - 1];
  assert.ok(recallP95Ms < 2_000, `warm MCP recall p95 ${recallP95Ms.toFixed(1)}ms exceeds 2000ms`);
  const emulator = new GrokBotEmulator();
  const [aTurn, bTurn] = await Promise.all([
    emulator.turn({ botId: identities[0].botId, conversationId: identities[0].conversationId, generationId: `generation-a-${suffix}`,
      user: "retrieve the alpha private memory", assistant: "alpha recalled", attachments: [{ name: "contract.json" }], inputTokens: 20, outputTokens: 8 }),
    emulator.turn({ botId: identities[1].botId, conversationId: identities[1].conversationId, generationId: `generation-b-${suffix}`,
      user: "retrieve the beta private memory", assistant: "beta recalled", attachments: [], inputTokens: 18, outputTokens: 7 }),
  ]);
  assert.match(aTurn.injected ?? "", /alpha-real-embedding-private-memory/); assert.doesNotMatch(aTurn.injected ?? "", /beta-real-embedding-private-memory/);
  assert.match(bTurn.injected ?? "", /beta-real-embedding-private-memory/); assert.doesNotMatch(bTurn.injected ?? "", /alpha-real-embedding-private-memory/);
  let settled = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    const [health, aInspect, bInspect] = await Promise.all([client.health(), client.tool("inspect", { ...identities[0], limit: 20 }), client.tool("inspect", { ...identities[1], limit: 20 })]);
    if (Number(health.queue_depth) === 0 && Number(health.active_workers) === 0 && aInspect.memories.length >= 2 && bInspect.memories.length >= 2) { settled = true; break; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  assert.equal(settled, true, `consolidation jobs did not settle\n${daemonError}`);
  await mkdir(resolve("artifacts/evidence"), { recursive: true });
  await writeFile(resolve("artifacts/evidence/e2e.json"), `${JSON.stringify({ suite: "e2e", passed: true, actualEmbeddingGemma: true,
    productionHooks: true, productionDaemon: true, fixtureGrokBuild: true, postgres: true, concurrentBots: 2, namespaceLeakage: false,
    recallSamplesMs: recallSamplesMs.map(value => Number(value.toFixed(2))), recallP95Ms: Number(recallP95Ms.toFixed(2)), recallBudgetMs: 2_000,
    requirements: { "LAT-003": recallP95Ms < 2_000, "LAT-004": true } }, null, 2)}\n`);
  process.stdout.write("Full real-embedding GrokBot emulator loop passed for two concurrent isolated Bots.\n");
} finally {
  if (previousUrl === undefined) delete process.env.GROK_MEMORY_DAEMON_URL; else process.env.GROK_MEMORY_DAEMON_URL = previousUrl;
  daemon.kill("SIGTERM"); await new Promise(resolvePromise => { daemon.once("close", resolvePromise); setTimeout(resolvePromise, 3_000); });
  await rm(temporary, { recursive: true, force: true });
}
