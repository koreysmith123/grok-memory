import assert from "node:assert/strict";
import test from "node:test";
import { consolidationSchema, parseJsonObject, threeLevelsSchema } from "../src/memory/schemas.js";

const levels = { concrete: "exact situation", abstract: "structural pattern", meta: "universal shape" };
test("MOD-004 MEM-001 parses valid three-level JSON including fenced output", () => {
  assert.deepEqual(threeLevelsSchema.parse(parseJsonObject(`\n\`\`\`json\n${JSON.stringify(levels)}\n\`\`\``)), levels);
});
test("MOD-004 MEM-001 rejects partial, extra, and malformed interpretations", () => {
  assert.throws(() => threeLevelsSchema.parse({ concrete: "only one" }));
  assert.throws(() => threeLevelsSchema.parse({ ...levels, surprise: true }));
  assert.throws(() => parseJsonObject("not json"));
});
test("MEM-008 consolidation supports the complete operation vocabulary", () => {
  const draft = { trigger: levels, body: levels, importance: 50, scopeType: "bot", scopeKey: "bot-a", sourceGenerationId: "g1" };
  const id = crypto.randomUUID();
  const operations = [{ operation: "create", memory: draft }, { operation: "update", targetId: id, memory: draft, reason: "correction" },
    { operation: "merge", targetId: id, memory: draft, reason: "duplicate" }, { operation: "supersede", targetId: id, memory: draft, reason: "obsolete" },
    { operation: "reinforce", targetId: id, reason: "confirmed" }, { operation: "none", reason: "nothing durable" }];
  assert.equal(consolidationSchema.parse({ operations }).operations.length, 6);
});
