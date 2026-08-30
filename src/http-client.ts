import type { HookEvent, Identity } from "./types.js";

export class DaemonClient {
  constructor(private readonly baseUrl = process.env.GROK_MEMORY_DAEMON_URL ?? "http://127.0.0.1:7391") {}

  async post<T>(path: string, body: unknown, timeoutMs = 8_000): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Memory daemon ${path} returned ${response.status}`);
    return response.json() as Promise<T>;
  }

  recall(event: HookEvent, timeoutMs?: number) { return this.post<any>("/v1/recall", event, timeoutMs); }
  complete(event: HookEvent) { return this.post<any>("/v1/turn", event, 2_000); }
  tool(name: string, args: Record<string, unknown>) { return this.post<any>(`/v1/tools/${name}`, args, 30_000); }
  health() { return this.post<any>("/v1/health", {}, 3_000); }
}

export function identityArgs(args: Record<string, unknown>): Identity {
  const ownerId = String(args.ownerId ?? process.env.GROK_MEMORY_OWNER_ID ?? "local-user");
  const botId = String(args.botId ?? process.env.GROK_MEMORY_BOT_ID ?? "");
  const conversationId = String(args.conversationId ?? "mcp");
  if (!botId) throw new Error("botId is required until this conversation is bound");
  return { ownerId, botId, conversationId, ...(args.projectId ? { projectId: String(args.projectId) } : {}), resolution: "explicit" };
}
