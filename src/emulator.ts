import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { HookEvent } from "./types.js";

export function renderAdditionalContext(content: string | undefined): string | undefined {
  const normalized = content?.trim();
  if (!normalized || normalized.length > 10_000) return undefined;
  const sanitized = normalized.replace(/<\/?system_reminder>/gi, "[system-reminder-marker-removed]");
  return `<system_reminder>\n${sanitized}\n</system_reminder>`;
}

async function subprocess(args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string }> {
  const sourceMode = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(sourceMode ? "./cli.ts" : "./cli.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const nodeArgs = sourceMode ? ["--import", "tsx", entry, ...args] : [entry, ...args];
    const child = spawn(process.execPath, nodeArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `child exited ${code}`)));
    child.stdin.end(input);
  });
}

export interface EmulatedTurn {
  botId: string;
  conversationId: string;
  generationId: string;
  user: string;
  assistant: string;
  projectId?: string;
  model?: string;
  modelId?: string;
  workspaceRoots?: string[];
  cwd?: string;
  attachments?: unknown[];
  inputTokens?: number;
  outputTokens?: number;
}

export class GrokBotEmulator {
  async turn(turn: EmulatedTurn): Promise<{ injected?: string; hookContext?: string }> {
    const base: HookEvent = { conversation_id: turn.conversationId, generation_id: turn.generationId, bot_id: turn.botId,
      model: turn.model ?? "grokbot-emulated", ...(turn.modelId ? { model_id: turn.modelId } : {}),
      ...(turn.workspaceRoots ? { workspace_roots: turn.workspaceRoots } : {}), ...(turn.cwd ? { cwd: turn.cwd } : {}) };
    const before = await subprocess(["hook", "before"], JSON.stringify({ ...base, hook_event_name: "beforeSubmitPrompt", prompt: turn.user,
      attachments: turn.attachments ?? [] }));
    const response = JSON.parse(before.stdout) as { additional_context?: string };
    const hookContext = response.additional_context;
    const injected = renderAdditionalContext(hookContext);
    await subprocess(["hook", "after"], JSON.stringify({ ...base, hook_event_name: "afterAgentResponse", text: turn.assistant,
      input_tokens: turn.inputTokens ?? 0, output_tokens: turn.outputTokens ?? 0 }));
    return { ...(injected ? { injected } : {}), ...(hookContext ? { hookContext } : {}) };
  }
}

export async function replay(turns: EmulatedTurn[], concurrency = 4): Promise<Array<Record<string, unknown>>> {
  const emulator = new GrokBotEmulator();
  const results: Array<Record<string, unknown>> = [];
  for (let index = 0; index < turns.length; index += Math.max(1, concurrency)) {
    const batch = turns.slice(index, index + Math.max(1, concurrency));
    results.push(...await Promise.all(batch.map(async (turn) => ({ ...turn, ...await emulator.turn(turn) }))));
  }
  return results;
}

export async function consoleEmulator(botId: string, conversationId = crypto.randomUUID()): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let index = 0;
  process.stdout.write(`GrokBot emulator ready (bot=${botId}, conversation=${conversationId}). Type /quit to exit.\n`);
  for await (const line of rl) {
    if (line.trim() === "/quit") break;
    const assistant = `Emulated response to: ${line}`;
    const result = await new GrokBotEmulator().turn({ botId, conversationId, generationId: `${conversationId}:${++index}`, user: line, assistant });
    if (result.injected) process.stdout.write(`[injected]\n${result.injected}\n`);
    process.stdout.write(`Bot: ${assistant}\n`);
  }
}
