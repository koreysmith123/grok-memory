import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config.js";
import type { MemoryRepository } from "./db.js";
import type { HookEvent, Identity } from "./types.js";

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !trimmed.includes("..") && /^[A-Za-z0-9._:@/-]{1,300}$/.test(trimmed) ? trimmed : undefined;
}

async function workspaceBinding(event: HookEvent): Promise<{ botId: string; projectId?: string } | undefined> {
  const candidates = [event.cwd, ...(event.workspace_roots ?? [])].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    let cursor = resolve(candidate);
    for (let depth = 0; depth < 8; depth++) {
      try {
        const value = clean(await readFile(join(cursor, ".grok-memory", "bot-id"), "utf8"));
        if (value) return { botId: value, projectId: cursor };
      } catch {}
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return undefined;
}

export async function resolveIdentity(event: HookEvent, config: Pick<Config, "ownerId" | "explicitBotId">, repository: Pick<MemoryRepository, "binding">): Promise<Identity> {
  const conversationId = clean(event.conversation_id) ?? `anonymous-${clean(event.generation_id) ?? "unknown"}`;
  if (config.explicitBotId) return { ownerId: config.ownerId, botId: config.explicitBotId, conversationId, resolution: "explicit" };
  const metadataId = clean(event.bot_id) ?? clean(event.agent_id);
  if (metadataId) return { ownerId: config.ownerId, botId: metadataId, conversationId, resolution: "metadata" };
  const workspace = await workspaceBinding(event);
  if (workspace) return { ownerId: config.ownerId, botId: workspace.botId, conversationId, ...(workspace.projectId ? { projectId: workspace.projectId } : {}), resolution: "workspace" };
  const binding = await repository.binding(config.ownerId, conversationId);
  if (binding) return { ownerId: config.ownerId, botId: binding.botId, conversationId, ...(binding.projectId ? { projectId: binding.projectId } : {}), resolution: "binding" };
  return { ownerId: config.ownerId, botId: `conversation:${conversationId}`, conversationId, resolution: "conversation-fallback" };
}
