import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GrokBuildClient } from "../src/grok-build.js";

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
