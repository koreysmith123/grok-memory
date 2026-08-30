import { loadConfig } from "./config.js";
import { DaemonClient } from "./http-client.js";
import type { HookEvent } from "./types.js";

async function readStdin(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function runHook(kind: "before" | "after", client = new DaemonClient()): Promise<Record<string, unknown>> {
  try {
    const event = JSON.parse(await readStdin()) as HookEvent;
    if (process.env.GROK_MEMORY_INTERNAL === "1") return {};
    if (kind === "before") {
      const result = await client.recall(event, loadConfig().recallTimeoutMs);
      return result.additionalContext ? { additional_context: String(result.additionalContext).slice(0, 9_500) } : {};
    }
    await client.complete(event);
    return {};
  } catch (error) {
    process.stderr.write(`[grok-memory] ${kind} hook failed open: ${error instanceof Error ? error.message : String(error)}\n`);
    return {};
  }
}

export async function hookMain(kind: "before" | "after"): Promise<void> {
  process.stdout.write(`${JSON.stringify(await runHook(kind))}\n`);
}
