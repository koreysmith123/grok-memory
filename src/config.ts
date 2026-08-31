import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  databaseUrl: string;
  migrationDatabaseUrl?: string;
  ownerId: string;
  explicitBotId?: string;
  grokBinary: string;
  grokModel?: string;
  recallTimeoutMs: number;
  jobPollMs: number;
  retentionDays: number;
  dataDir: string;
  modelCacheDir: string;
  fixtureDir?: string;
  searchBackend: "pgvector" | "centroid-shadow";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.GROK_MEMORY_DATA_DIR ?? join(homedir(), ".local", "share", "grok-memory"));
  const explicitBotId = env.GROK_MEMORY_BOT_ID?.trim() || undefined;
  const fixtureDir = env.GROK_MEMORY_GROK_FIXTURES?.trim() || undefined;
  const migrationDatabaseUrl = env.GROK_MEMORY_MIGRATION_DATABASE_URL?.trim() || undefined;
  return {
    databaseUrl: env.DATABASE_URL ?? "postgresql://grok_memory:grok_memory@127.0.0.1:54329/grok_memory",
    ...(migrationDatabaseUrl ? { migrationDatabaseUrl } : {}),
    ownerId: env.GROK_MEMORY_OWNER_ID?.trim() || "local-user",
    ...(explicitBotId ? { explicitBotId } : {}),
    grokBinary: env.GROK_MEMORY_GROK_BINARY?.trim() || "grok",
    ...(env.GROK_MEMORY_MODEL?.trim() ? { grokModel: env.GROK_MEMORY_MODEL.trim() } : {}),
    recallTimeoutMs: positiveInteger(env.GROK_MEMORY_RECALL_TIMEOUT_MS, 1_800),
    jobPollMs: positiveInteger(env.GROK_MEMORY_JOB_POLL_MS, 500),
    retentionDays: positiveInteger(env.GROK_MEMORY_TRANSCRIPT_RETENTION_DAYS, 30),
    dataDir,
    modelCacheDir: resolve(env.GROK_MEMORY_MODEL_CACHE ?? join(dataDir, "models")),
    searchBackend: env.GROK_MEMORY_SEARCH_BACKEND === "centroid-shadow" ? "centroid-shadow" : "pgvector",
    ...(fixtureDir ? { fixtureDir: resolve(fixtureDir) } : {}),
  };
}
