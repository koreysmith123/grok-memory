import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { EMBEDDING_MODEL, EMBEDDING_PREFIX } from "../src/embedding.js";
import { STRICT_GROK_ARGS } from "../src/grok-build.js";

const root = resolve(import.meta.dirname, "..");
async function files(directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "artifacts"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}

test("MOD-001 MOD-002 DB-001 INS-008 model and storage boundaries", async () => {
  assert.equal(EMBEDDING_MODEL, "onnx-community/embeddinggemma-300m-ONNX");
  assert.match(EMBEDDING_PREFIX.query, /^task: search result \| query:/);
  const sourceFiles = (await files()).filter((path) => /\.(ts|json|sql|sh)$/.test(path) && !path.includes("/test/"));
  const content = (await Promise.all(sourceFiles.map((path) => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(content, /sqlite|cerebras|openai\.com\/v1|anthropic\.com\/v1/i);
  assert.doesNotMatch(content, /\/Users\/pattirae|xai-[A-Za-z0-9_-]{20,}/);
});

test("MOD-003 MOD-006 MOD-007 QUA-007 Grok Build invocation is isolated", () => {
  for (const flag of ["--no-memory", "--no-subagents", "--disable-web-search", "--tools", "--max-turns"]) assert.ok(STRICT_GROK_ARGS.includes(flag as any));
  assert.equal(STRICT_GROK_ARGS[STRICT_GROK_ARGS.indexOf("--max-turns") + 1], "1");
});

test("HOK-006 plugin hooks are valid fail-open version 1 commands", async () => {
  const config = JSON.parse(await readFile(join(root, "hooks/hooks.json"), "utf8"));
  assert.equal(config.version, 1);
  for (const name of ["beforeSubmitPrompt", "afterAgentResponse"]) {
    assert.equal(config.hooks[name][0].type, "command");
    assert.equal(config.hooks[name][0].failClosed, false);
  }
  const plugin = JSON.parse(await readFile(join(root, ".cursor-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.hooks, "./hooks/hooks.json"); assert.equal(plugin.mcpServers, "./.mcp.json");
  const grokPlugin = JSON.parse(await readFile(join(root, ".grok-plugin/plugin.json"), "utf8"));
  assert.equal(grokPlugin.name, "recallsmith"); assert.equal(grokPlugin.skills, "./skills/");
  assert.equal(grokPlugin.hooks, "./hooks/grok-hooks.json"); assert.equal(grokPlugin.mcpServers, "./mcp.grok.json");
  const grokHooks = await readFile(join(root, "hooks/grok-hooks.json"), "utf8");
  assert.match(grokHooks, /GROK_PLUGIN_ROOT/); assert.match(await readFile(join(root, "mcp.grok.json"), "utf8"), /GROK_PLUGIN_ROOT/);
});

test("QUA-002 requirements IDs are unique and measurable", async () => {
  const requirements = await readFile(join(root, "REQUIREMENTS.md"), "utf8");
  const ids = [...requirements.matchAll(/\| ([A-Z]{3}-\d{3}) \|/g)].map((match) => match[1]!);
  assert.ok(ids.length >= 60, `expected at least 60 requirements, got ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => requirements.includes(`| ${id} |`)));
});

test("INS-002 INS-003 INS-004 INS-006 installer is bounded and non-destructive", async () => {
  const installer = await readFile(join(root, "install.sh"), "utf8");
  assert.match(installer, /npm ci/); assert.match(installer, /docker compose up -d postgres/); assert.match(installer, /migrate/);
  assert.doesNotMatch(installer, /rm\s+-rf|reset\s+--hard|XAI_API_KEY=/);
  const merger = await readFile(join(root, "scripts/merge-config.mjs"), "utf8");
  assert.match(merger, /filter/); assert.match(merger, /rename\(temporary/);
});
