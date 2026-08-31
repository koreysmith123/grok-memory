import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GrokBuildClient, grokBuildAuthenticated } from "../src/grok-build.js";
import { MemoryDaemon } from "../src/daemon.js";
import { MemoryService } from "../src/memory/service.js";
import { loadConfig } from "../src/config.js";
import { FakeEmbedder, FakeGrok, FakeRepository } from "./helpers.js";

async function fakeGrok(output: string) {
  const dir = await mkdtemp(join(tmpdir(), "fake-grok-")); const argsPath = join(dir, "args.json"); const binary = join(dir, "grok");
  await writeFile(binary, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(${JSON.stringify(output)});\n`);
  await chmod(binary, 0o700); return { binary, argsPath, dir };
}

test("MOD-003 MOD-004 Grok Build adapter executes strict tool-free command and validates output", async () => {
  const fake = await fakeGrok('{"concrete":"specific task","abstract":"task pattern","meta":"universal pattern"}');
  const client = new GrokBuildClient({ grokBinary: fake.binary, grokModel: "grok-build", dataDir: fake.dir });
  assert.equal((await client.interpret("prompt")).meta, "universal pattern");
  const args = JSON.parse(await readFile(fake.argsPath, "utf8")) as string[];
  for (const flag of ["--no-memory", "--no-subagents", "--disable-web-search", "--tools", "--system-prompt-override"]) assert.ok(args.includes(flag));
});

test("MOD-005 missing binary, nonzero, and malformed output are rejected for hook fail-open handling", async () => {
  const missing = new GrokBuildClient({ grokBinary: "/definitely/missing/grok", grokModel: "grok-build", dataDir: tmpdir() });
  await assert.rejects(missing.interpret("prompt"));
  const malformed = await fakeGrok("not-json");
  await assert.rejects(new GrokBuildClient({ grokBinary: malformed.binary, grokModel: "grok-build", dataDir: malformed.dir }).interpret("prompt"));
});

test("MEM-018 authentication detection enables bounded failed-job recovery", async () => {
  const grokHome = await mkdtemp(join(tmpdir(), "grok-home-"));
  assert.equal(grokBuildAuthenticated({ GROK_HOME: grokHome }), false);
  await writeFile(join(grokHome, "auth.json"), "{}");
  assert.equal(grokBuildAuthenticated({ GROK_HOME: grokHome }), true);
  assert.equal(grokBuildAuthenticated({ GROK_HOME: join(grokHome, "missing"), XAI_API_KEY: "configured" }), true);
});

test("MEM-018 daemon requeues once when authenticated instead of looping while unauthenticated", async () => {
  const grokHome = await mkdtemp(join(tmpdir(), "daemon-grok-home-")); const previous = process.env.GROK_HOME; process.env.GROK_HOME = grokHome;
  const repo = new FakeRepository(); const config = loadConfig({ GROK_MEMORY_JOB_POLL_MS: "10" });
  const daemon = new MemoryDaemon(config, repo, new MemoryService(config, repo, new FakeEmbedder(), new FakeGrok())); const server = await daemon.listen(0);
  try {
    await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(repo.requeueCalls, 0);
    await writeFile(join(grokHome, "auth.json"), "{}");
    (daemon as any).lastAuthCheckAt = 0;
    await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(repo.requeueCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(repo.requeueCalls, 1);
  } finally {
    daemon.stop(); await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previous;
  }
});
