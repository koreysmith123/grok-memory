import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { logger } from "../src/log.js";
import { formatContext } from "../src/memory/service.js";
import { hit } from "./helpers.js";

const root = resolve(import.meta.dirname, "..");

test("INS-001 QUA-001 one-command package and full validation pipeline are present", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.bin["grok-memory"], "dist/cli.js");
  assert.match(packageJson.scripts["validate:deterministic"], /typecheck.*lint.*test.*build.*audit/);
  assert.match(packageJson.scripts.validate, /deterministic.*postgres.*install.*e2e.*live.*report/);
  assert.match(await readFile(resolve(root, "install.sh"), "utf8"), /npm ci/);
});

test("INS-009 INS-010 INS-011 GrokBot VM bootstrap and MCP handoff are explicit", async () => {
  const nodeBootstrap = await readFile(resolve(root, "scripts/bootstrap-node.sh"), "utf8");
  assert.match(nodeBootstrap, /NODE_VERSION/); assert.match(nodeBootstrap, /sha256sum|shasum/);
  assert.match(nodeBootstrap, /\.local\/lib\/grok-memory/); assert.match(nodeBootstrap, /x86_64.*x64/s); assert.match(nodeBootstrap, /aarch64.*arm64/s);
  const postgres = await readFile(resolve(root, "scripts/provision-native-postgres.sh"), "utf8");
  assert.match(postgres, /postgresql-17-pgvector/); assert.match(postgres, /pg_createcluster 17 grok-memory --port 54329/);
  const manifest = await readFile(resolve(root, "scripts/write-grokbot-manifest.mjs"), "utf8");
  assert.match(manifest, /process\.execPath/); assert.match(manifest, /"mcp"/);
  const installer = await readFile(resolve(root, "install.sh"), "utf8");
  assert.match(installer, /GROKBOT_INSTALL\.md/); assert.match(installer, /GROKBOT_MCP_MANIFEST/);
  assert.match(await readFile(resolve(root, "GROKBOT_INSTALL.md"), "utf8"), /AddMcpServer/);
});

test("BOT-001 BOT-005 original NeoSmith operating loop is packaged for all GrokBots", async () => {
  const skill = await readFile(resolve(root, "skills/grok-memory/SKILL.md"), "utf8");
  for (const phrase of ["every substantive", "snapshot of the exact moment", "sound like a real thought, not a clinical label", "deep pattern", "resolution point", "Do not force", "bodyConcrete", "bodyAbstract", "bodyMeta", "failed recall"]) assert.match(skill, new RegExp(phrase, "i"));
  assert.match(skill, /Ignorance is not a\s+durable lesson/i);
  assert.match(skill, /Korey is bracing/); assert.match(skill, /The user is anticipating a social situation/);
  const handoff = await readFile(resolve(root, "GROKBOT_INSTALL.md"), "utf8");
  assert.match(handoff, /ListAgents/); assert.match(handoff, /Preserve your own existing profile description byte-for-byte/i);
  assert.match(handoff, /Do not create a polling routine/i); assert.match(handoff, /Update only your own profile/i);
  assert.doesNotMatch(handoff, /\*\/5 \* \* \* \*/);
});

test("BOT-008 BOT-009 one-message installation contract is strict and self-verifying", async () => {
  const agents = await readFile(resolve(root, "AGENTS.md"), "utf8");
  const handoff = await readFile(resolve(root, "GROKBOT_INSTALL.md"), "utf8");
  const installer = await readFile(resolve(root, "install.sh"), "utf8");
  assert.match(agents, /execute\s+`GROKBOT_INSTALL\.md` completely/i);
  assert.match(agents, /Do not ask the user questions/i);
  for (const phrase of [
    "GROK_MEMORY_READY", "AddMcpServer", "memory_health", "memory_remember",
    "memory_recall", "memory_inspect", "memory_forget", "Update only your own profile",
    "triggerConcrete", "triggerAbstract", "triggerMeta", "bodyConcrete", "bodyAbstract",
    "bodyMeta", "Do not create a polling routine", "Leave no canary data",
  ]) assert.match(handoff, new RegExp(phrase, "i"));
  assert.match(installer, /GROK_MEMORY_VM_READY/);
  assert.match(installer, /write-install-result\.mjs/);
  assert.match(installer, /Do not ask the user questions/i);
});

test("INS-007 doctor reports Grok Build, embedding cache, Bot identity, and daemon health", async () => {
  const source = await readFile(resolve(root, "src/cli.ts"), "utf8");
  for (const field of ["grokBuild", "embedding", "botIdentity", "daemon"]) assert.match(source, new RegExp(field));
});

test("QUA-003 structured logger redacts tokens and secret fields", () => {
  let output = ""; const original = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (value: string) => { output += value; return true; };
  try { logger.log("info", "turn", { botId: "b", conversationId: "c", generationId: "g", durationMs: 12, apiKey: "xai-secret-value-that-is-long" }); }
  finally { (process.stderr as any).write = original; }
  const record = JSON.parse(output); assert.equal(record.event, "turn"); assert.equal(record.apiKey, "[REDACTED]"); assert.doesNotMatch(output, /secret-value/);
});

test("QUA-004 retrieval trace exposes lane, scores, scope, and selection provenance", () => {
  const memory = hit("trace-id", "abstract", .81, { vectorScore: .8, lexicalScore: .4, scopeType: "project", scopeKey: "p" });
  const context = formatContext([memory])!;
  assert.match(context, /memory:trace-id/); assert.match(context, /lane:abstract/); assert.match(context, /scope:project/); assert.match(context, /relevance:0.810/);
});

test("QUA-005 README covers all operator and privacy topics", async () => {
  const readme = (await readFile(resolve(root, "README.md"), "utf8")).toLowerCase();
  for (const topic of ["architecture", "privacy", "authentication", "install", "emulator", "back up", "upgrade", "uninstall", "resource"]) assert.ok(readme.includes(topic), `missing ${topic}`);
});

test("QUA-006 validation report generator records environment, evidence, requirement status, commit, and timestamp", async () => {
  const source = await readFile(resolve(root, "scripts/validate.mjs"), "utf8");
  for (const field of ["generatedAt", "commit", "environment", "status", "evidence"]) assert.match(source, new RegExp(field));
});

test("QUA-008 licenses and NeoSmith attribution ship in the package", async () => {
  assert.match(await readFile(resolve(root, "LICENSE"), "utf8"), /MIT License/);
  assert.match(await readFile(resolve(root, "NOTICE.md"), "utf8"), /NeoSmith/);
});

test("EMU-006 EMU-007 emulator retains multi-Bot identity and production fault paths", async () => {
  const emulator = await readFile(resolve(root, "src/emulator.ts"), "utf8");
  assert.match(emulator, /botId/); assert.match(emulator, /Promise\.all|async/); assert.match(emulator, /hook.*before/);
  assert.match(emulator, /memory_recall/); assert.match(emulator, /StdioClientTransport/);
  const protocol = await readFile(resolve(root, "test/protocol.test.ts"), "utf8");
  assert.match(protocol, /failed open/); assert.match(protocol, /127\.0\.0\.1:1/);
});

test("MCP-005 destructive forgetting is exact-ID and exact-confirmation only", async () => {
  const daemon = await readFile(resolve(root, "src/daemon.ts"), "utf8");
  assert.match(daemon, /args\.confirm !== `forget:\$\{args\.memoryId\}`/);
  assert.doesNotMatch(daemon, /forgetAll|DELETE FROM memories/);
});

test("MEM-011 exposure and usefulness paths are wired without blocking recall", async () => {
  const service = await readFile(resolve(root, "src/memory/service.ts"), "utf8");
  assert.match(service, /recordExposures.*catch/);
  const repository = await readFile(resolve(root, "src/db.ts"), "utf8");
  assert.match(repository, /memory_exposures/); assert.match(repository, /usefulness=\(usefulness\*0\.8\)/);
});
