import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveIdentity } from "../src/identity.js";
import { FakeRepository } from "./helpers.js";

test("ISO-001 identity precedence and conversation-safe fallback", async () => {
  const repo = new FakeRepository();
  const explicit = await resolveIdentity({ conversation_id: "c1", bot_id: "metadata" }, { ownerId: "owner", explicitBotId: "explicit" }, repo);
  assert.equal(explicit.botId, "explicit"); assert.equal(explicit.resolution, "explicit");
  const metadata = await resolveIdentity({ conversation_id: "c1", agent_id: "agent" }, { ownerId: "owner" }, repo);
  assert.equal(metadata.botId, "agent"); assert.equal(metadata.resolution, "metadata");
  const fallback = await resolveIdentity({ conversation_id: "private-c" }, { ownerId: "owner" }, new FakeRepository());
  assert.equal(fallback.botId, "conversation:private-c"); assert.equal(fallback.resolution, "conversation-fallback");
});

test("ISO-001 workspace binding beats saved conversation binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-memory-"));
  await mkdir(join(dir, ".grok-memory")); await writeFile(join(dir, ".grok-memory/bot-id"), "workspace-bot\n");
  const repo = new FakeRepository(); repo.bindingValue = { botId: "saved-bot" };
  const identity = await resolveIdentity({ conversation_id: "c", cwd: join(dir, "nested") }, { ownerId: "owner" }, repo);
  assert.equal(identity.botId, "workspace-bot"); assert.equal(identity.resolution, "workspace");
});

test("ISO-006 unsafe identifiers are rejected into an isolated fallback", async () => {
  const identity = await resolveIdentity({ conversation_id: "../../escape", bot_id: "bad id with spaces" }, { ownerId: "owner" }, new FakeRepository());
  assert.match(identity.botId, /^conversation:/); assert.doesNotMatch(identity.botId, /\.\./);
});
