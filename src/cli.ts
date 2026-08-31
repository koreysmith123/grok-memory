#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { MemoryDaemon } from "./daemon.js";
import { consoleEmulator, replay } from "./emulator.js";
import { hookMain } from "./hook.js";
import { mcpMain } from "./mcp.js";
import { createRuntime } from "./runtime.js";
import { verifyOrCreateCacheManifest } from "./cache-integrity.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "hook") {
    const kind = args[0];
    if (kind !== "before" && kind !== "after") throw new Error("hook requires before or after");
    return hookMain(kind);
  }
  if (command === "mcp") return mcpMain();
  if (command === "migrate") {
    const config = loadConfig();
    const { PostgresRepository } = await import("./db.js");
    const repository = new PostgresRepository(config.migrationDatabaseUrl ?? config.databaseUrl);
    try { await repository.migrate(process.env.GROK_MEMORY_APP_ROLE?.trim() || undefined); process.stdout.write("Migrations applied.\n"); }
    finally { await repository.close(); }
    return;
  }
  if (command === "daemon") {
    const runtime = createRuntime();
    const daemon = new MemoryDaemon(runtime.config, runtime.repository, runtime.service);
    const server = await daemon.listen();
    const stop = async () => { daemon.stop(); server.close(); await runtime.repository.close(); process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    return;
  }
  if (command === "warm-embedding") {
    const runtime = createRuntime();
    const vector = await runtime.embedder.embed("RecallSmith installation health check", "document");
    if (vector.length !== 768) throw new Error(`Expected 768 embedding dimensions, received ${vector.length}`);
    const integrity = await verifyOrCreateCacheManifest(runtime.config.modelCacheDir);
    await runtime.repository.close();
    process.stdout.write(`EmbeddingGemma ready (768 dimensions; cache integrity ${integrity.status}).\n`);
    return;
  }
  if (command === "doctor") {
    const config = loadConfig();
    const grokVersion = spawnSync(config.grokBinary, ["version"], { encoding: "utf8", timeout: 3_000 });
    const checks: Record<string, unknown> = { node: process.version,
      grokBuild: { ok: grokVersion.status === 0, version: grokVersion.stdout?.trim() || undefined, error: grokVersion.error?.message || grokVersion.stderr?.trim() || undefined },
      embedding: { model: "onnx-community/embeddinggemma-300m-ONNX", cachePresent: existsSync(config.modelCacheDir) },
      botIdentity: config.explicitBotId ?? "conversation/workspace fallback" };
    try { const { DaemonClient } = await import("./http-client.js"); checks.daemon = await new DaemonClient().health(); }
    catch (error) { checks.daemon = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    process.stdout.write(`${JSON.stringify(checks, null, args.includes("--json") ? 2 : 2)}\n`);
    return;
  }
  if (command === "emulate") {
    const replayIndex = args.indexOf("--replay");
    if (replayIndex >= 0 && args[replayIndex + 1]) {
      const turns = JSON.parse(await readFile(args[replayIndex + 1]!, "utf8"));
      process.stdout.write(`${JSON.stringify(await replay(turns), null, 2)}\n`);
    } else await consoleEmulator(args[0] ?? "test-bot");
    return;
  }
  process.stdout.write(`grok-memory commands:\n  daemon\n  migrate\n  warm-embedding\n  mcp\n  hook before|after\n  doctor --json\n  emulate [bot-id]\n  emulate --replay transcript.json\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
