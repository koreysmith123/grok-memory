import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DaemonClient } from "./http-client.js";

const identityShape = {
  ownerId: z.string().min(1).optional(),
  botId: z.string().min(1),
  conversationId: z.string().min(1),
  projectId: z.string().min(1).optional(),
};

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

export function createMcpServer(client = new DaemonClient()): McpServer {
  const server = new McpServer({ name: "grok-memory", version: "0.1.0" });
  server.registerTool("memory_search", {
    title: "Search private Bot memory", description: "Search this Bot's private experiential memory and explain why results matched.",
    inputSchema: { ...identityShape, query: z.string().min(3).max(24_000) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => result(await client.tool("search", args)));
  server.registerTool("memory_remember", {
    title: "Remember something", description: "Save a durable experience, preference, decision, correction, or lesson for this Bot.",
    inputSchema: { ...identityShape, text: z.string().min(3).max(24_000), scopeType: z.enum(["bot", "project", "conversation"]).default("bot") },
    annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => result(await client.tool("remember", args)));
  server.registerTool("memory_rate", {
    title: "Rate a recalled memory", description: "Record whether a surfaced memory was useful for this generation.",
    inputSchema: { ...identityShape, memoryId: z.string().uuid(), generationId: z.string().min(1), usefulness: z.number().int().min(0).max(100) },
    annotations: { idempotentHint: true, openWorldHint: false },
  }, async (args) => result(await client.tool("rate", args)));
  server.registerTool("memory_bind_bot", {
    title: "Bind conversation to Bot", description: "Explicitly bind a GrokBot conversation to a stable private Bot identity.",
    inputSchema: identityShape, annotations: { idempotentHint: true, openWorldHint: false },
  }, async (args) => result(await client.tool("bind", args)));
  server.registerTool("memory_inspect", {
    title: "Inspect Bot memories", description: "List recent memories owned by this Bot.",
    inputSchema: { ...identityShape, limit: z.number().int().min(1).max(100).default(20) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => result(await client.tool("inspect", args)));
  server.registerTool("memory_forget", {
    title: "Forget one memory", description: "Soft-delete exactly one memory. confirm must equal forget:<memoryId>.",
    inputSchema: { ...identityShape, memoryId: z.string().uuid(), confirm: z.string().min(1) },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => result(await client.tool("forget", args)));
  server.registerTool("memory_health", {
    title: "Memory health", description: "Report local memory service, PostgreSQL, pgvector, schema, and queue health.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => result(await client.health()));
  return server;
}

export async function mcpMain(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
