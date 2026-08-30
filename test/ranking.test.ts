import assert from "node:assert/strict";
import test from "node:test";
import { scoreMemory } from "../src/db.js";
import { embeddingInput } from "../src/embedding.js";

test("MEM-003 EmbeddingGemma uses official asymmetric query and document prefixes", () => {
  assert.equal(embeddingInput("hello", "query"), "task: search result | query: hello");
  assert.equal(embeddingInput("hello", "document"), "title: none | text: hello");
});

test("MEM-004 each retrieval factor changes ranking in the intended direction", () => {
  const base = { vectorScore: .5, lexicalScore: .1, importance: 50, usefulness: .5, ageDays: 10 };
  const score = scoreMemory(base);
  assert.ok(scoreMemory({ ...base, vectorScore: .8 }) > score);
  assert.ok(scoreMemory({ ...base, lexicalScore: .2 }) > score);
  assert.ok(scoreMemory({ ...base, importance: 90 }) > score);
  assert.ok(scoreMemory({ ...base, usefulness: .9 }) > score);
  assert.ok(scoreMemory({ ...base, ageDays: 1 }) > score);
});
