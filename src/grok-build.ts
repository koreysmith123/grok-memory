import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Config } from "./config.js";
import { consolidationSchema, parseJsonObject, threeLevelsSchema } from "./memory/schemas.js";
import type { ConsolidationOperation, ThreeLevels } from "./types.js";

export interface GrokReasoner {
  interpret(prompt: string, signal?: AbortSignal): Promise<ThreeLevels>;
  consolidate(prompt: string, signal?: AbortSignal): Promise<ConsolidationOperation[]>;
}

export const STRICT_GROK_ARGS = [
  "--no-auto-update", "--output-format", "plain", "--max-turns", "1",
  "--no-memory", "--no-subagents", "--disable-web-search", "--tools", "",
] as const;

export function grokBuildAuthenticated(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.XAI_API_KEY?.trim()) return true;
  const grokHome = env.GROK_HOME?.trim() || join(homedir(), ".grok");
  return existsSync(join(grokHome, "auth.json"));
}

export class GrokBuildClient implements GrokReasoner {
  constructor(private readonly config: Pick<Config, "grokBinary" | "grokModel" | "dataDir" | "fixtureDir">) {}

  async interpret(prompt: string, signal?: AbortSignal): Promise<ThreeLevels> {
    const text = await this.invoke("interpret", prompt, signal);
    const parsed = threeLevelsSchema.safeParse(parseJsonObject(text));
    if (!parsed.success) throw new Error(`Grok Build interpretation schema violation: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    return parsed.data;
  }

  async consolidate(prompt: string, signal?: AbortSignal): Promise<ConsolidationOperation[]> {
    const text = await this.invoke("consolidate", prompt, signal);
    const parsed = consolidationSchema.safeParse(parseJsonObject(text));
    if (!parsed.success) throw new Error(`Grok Build consolidation schema violation: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    return parsed.data.operations as ConsolidationOperation[];
  }

  private async invoke(kind: "interpret" | "consolidate", prompt: string, signal?: AbortSignal): Promise<string> {
    if (this.config.fixtureDir) return readFile(join(this.config.fixtureDir, `${kind}.json`), "utf8");
    await mkdir(this.config.dataDir, { recursive: true });
    const args = [
      ...STRICT_GROK_ARGS,
      ...(this.config.grokModel ? ["--model", this.config.grokModel] : []),
      "--cwd", this.config.dataDir,
      "--system-prompt-override", "Return only the requested JSON. You have no tools and must not access files or the network.",
      "-p", prompt,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.grokBinary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        signal,
        env: { ...process.env, GROK_MEMORY_INTERNAL: "1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Grok Build exited ${code}: ${stderr}`)));
    });
  }
}
