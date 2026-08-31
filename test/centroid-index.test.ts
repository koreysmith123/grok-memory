import assert from "node:assert/strict";
import test from "node:test";
import { binaryQuantize, NamespaceCentroidIndex, cosine, recallAtK, type IndexRecord } from "../src/index/centroid.js";
import type { Identity } from "../src/types.js";

function randomVector(seed: number, dimensions = 64): number[] {
  let state = seed >>> 0; const values: number[] = [];
  for (let index = 0; index < dimensions; index++) { state = (1664525 * state + 1013904223) >>> 0; values.push(state / 0xffffffff * 2 - 1); }
  return values;
}

function identity(botId: string, conversationId = "conversation", projectId = "project"): Identity {
  return { ownerId: "owner", botId, conversationId, projectId, resolution: "explicit" };
}

test("DB-009 binary quantization stores one bit per dimension", () => {
  assert.equal(binaryQuantize(randomVector(1, 768)).byteLength, 96);
});

test("DB-009 namespace-aware centroid/BQ shadow has high recall and no cross-Bot leakage", () => {
  const records: IndexRecord[] = [];
  for (const botId of ["bot-a", "bot-b"]) for (let index = 0; index < 300; index++) {
    records.push({ memoryId: `${botId}-${index}`, ownerId: "owner", botId, scopeType: index % 3 === 0 ? "conversation" : index % 3 === 1 ? "project" : "bot",
      scopeKey: index % 3 === 0 ? "conversation" : index % 3 === 1 ? "project" : botId, level: "concrete", vector: randomVector(index + (botId === "bot-a" ? 1 : 10_000)) });
  }
  const index = new NamespaceCentroidIndex(25); index.build(records);
  const active = identity("bot-a"); let totalRecall = 0;
  for (let queryIndex = 0; queryIndex < 20; queryIndex++) {
    const query = records.filter((record) => record.botId === "bot-a")[queryIndex * 7]!.vector;
    const visible = records.filter((record) => record.botId === "bot-a" && (record.scopeType === "bot" || record.scopeKey === "conversation" || record.scopeKey === "project"));
    const brute = visible.map((record) => ({ id: record.memoryId, score: cosine(query, record.vector) })).sort((a, b) => b.score - a.score).slice(0, 5).map((item) => item.id);
    const actual = index.search(active, "concrete", query, { topClusters: 5, binaryCandidates: 100, limit: 5 }).map((item) => item.memoryId);
    totalRecall += recallAtK(brute, actual, 5); assert.ok(actual.every((id) => id.startsWith("bot-a-")));
  }
  assert.ok(totalRecall / 20 >= .9, `recall@5 was ${totalRecall / 20}`);
  assert.equal(index.search(identity("bot-b", "wrong-conversation", "wrong-project"), "concrete", records[0]!.vector).some((item) => item.memoryId.startsWith("bot-a-")), false);
});
