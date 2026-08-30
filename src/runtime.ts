import { loadConfig } from "./config.js";
import { PostgresRepository } from "./db.js";
import { EmbeddingGemma } from "./embedding.js";
import { GrokBuildClient } from "./grok-build.js";
import { MemoryService } from "./memory/service.js";

export function createRuntime() {
  const config = loadConfig();
  const repository = new PostgresRepository(config.databaseUrl);
  const embedder = new EmbeddingGemma(config);
  const grok = new GrokBuildClient(config);
  const service = new MemoryService(config, repository, embedder, grok);
  return { config, repository, embedder, grok, service };
}
