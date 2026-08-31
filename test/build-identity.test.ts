import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getOrCreateBuildIdentity } from "../src/build-identity.js";

test("BLD-002 Grok Build identity is stable across sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recallsmith-build-"));
  const first = await getOrCreateBuildIdentity(directory);
  const second = await getOrCreateBuildIdentity(directory);
  assert.equal(second, first);
  assert.match(first, /^grok-build:[0-9a-f-]{36}$/);
  assert.equal((await readFile(join(directory, "grok-build-id"), "utf8")).trim(), first);
});
