import { z } from "zod";

export const threeLevelsSchema = z.object({
  concrete: z.string().trim().min(3).max(2_000),
  abstract: z.string().trim().min(3).max(2_000),
  meta: z.string().trim().min(3).max(2_000),
}).strict();

export const memoryDraftSchema = z.object({
  trigger: threeLevelsSchema,
  body: threeLevelsSchema,
  importance: z.number().int().min(0).max(100),
  scopeType: z.enum(["bot", "project", "conversation"]),
  scopeKey: z.string().trim().min(1).max(300),
  sourceGenerationId: z.string().trim().min(1).max(300),
}).strict();

const noneOperation = z.object({ operation: z.literal("none"), reason: z.string().max(2_000) }).strict();
const createOperation = z.object({ operation: z.literal("create"), memory: memoryDraftSchema }).strict();
const modifyOperation = z.object({
  operation: z.enum(["update", "merge", "supersede", "reinforce"]),
  targetId: z.string().uuid(),
  memory: memoryDraftSchema.optional(),
  reason: z.string().min(1).max(2_000),
}).strict();

export const consolidationSchema = z.object({
  operations: z.array(z.discriminatedUnion("operation", [noneOperation, createOperation, modifyOperation])).max(12),
}).strict();

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Grok Build did not return a JSON object");
  return JSON.parse(trimmed.slice(start, end + 1));
}
