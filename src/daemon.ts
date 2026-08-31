import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { Config } from "./config.js";
import type { MemoryRepository } from "./db.js";
import { identityArgs } from "./http-client.js";
import { logger } from "./log.js";
import type { MemoryService } from "./memory/service.js";
import type { HookEvent } from "./types.js";
import { threeLevelsSchema } from "./memory/schemas.js";
import { grokBuildAuthenticated } from "./grok-build.js";

async function json(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request too large");
  }
  return body ? JSON.parse(body) : {};
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export class MemoryDaemon {
  private stopping = false;
  private lastPruneAt = 0;
  private lastAuthCheckAt = 0;
  private lastAuthenticated: boolean | undefined;
  private readonly workerId = `${hostname()}:${process.pid}`;
  constructor(private readonly config: Config, private readonly repository: MemoryRepository, private readonly service: MemoryService) {}

  async listen(port = Number(process.env.GROK_MEMORY_PORT ?? 7391), host = "127.0.0.1"): Promise<ReturnType<typeof createServer>> {
    const server = createServer(async (req, res) => {
      const started = Date.now();
      try {
        if (req.method !== "POST") return send(res, 405, { error: "POST required" });
        const body = await json(req);
        if (req.url === "/v1/recall") {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.config.recallTimeoutMs - 100);
          try {
            const result = await this.service.recall(body as HookEvent, controller.signal);
            return send(res, 200, { additionalContext: result.additionalContext, identity: result.identity, interpreted: result.interpreted, hits: result.hits, degraded: result.degraded, memoryServiceMs: result.memoryServiceMs });
          } finally { clearTimeout(timer); }
        }
        if (req.url === "/v1/prompt") { await this.service.begin(body as HookEvent); return send(res, 200, { ok: true }); }
        if (req.url === "/v1/turn") { await this.service.complete(body as HookEvent); return send(res, 200, { ok: true }); }
        if (req.url === "/v1/health") return send(res, 200, await this.repository.health());
        if (req.url?.startsWith("/v1/tools/")) return this.handleTool(req.url.slice("/v1/tools/".length), body, res);
        return send(res, 404, { error: "not found" });
      } catch (error) {
        logger.log("error", "http_request_failed", { path: req.url, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
        return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
    void this.workerLoop();
    logger.log("info", "daemon_ready", { host, port, workerId: this.workerId });
    return server;
  }

  stop(): void { this.stopping = true; }

  private async workerLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (Date.now() - this.lastAuthCheckAt > 30_000) {
          const authenticated = grokBuildAuthenticated();
          if (authenticated && this.lastAuthenticated !== true) {
            const requeued = await this.repository.requeueFailedJobs(500);
            if (requeued > 0) logger.log("info", "auth_jobs_requeued", { count: requeued });
          }
          this.lastAuthenticated = authenticated;
          this.lastAuthCheckAt = Date.now();
        }
        if (Date.now() - this.lastPruneAt > 86_400_000) {
          await this.repository.pruneTurns(this.config.retentionDays);
          this.lastPruneAt = Date.now();
        }
        const job = await this.repository.claimJob(this.workerId);
        if (!job) { await new Promise((resolve) => setTimeout(resolve, this.config.jobPollMs)); continue; }
        try { await this.service.processJob(job); await this.repository.finishJob(job.id, true); }
        catch (error) { await this.repository.finishJob(job.id, false, error instanceof Error ? error.message : String(error)); }
      } catch (error) {
        if (this.stopping) return;
        logger.log("error", "worker_loop_failed", { error: error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, this.config.jobPollMs)));
      }
    }
  }

  private async handleTool(name: string, args: Record<string, unknown>, res: ServerResponse): Promise<void> {
    if (name === "health") return send(res, 200, await this.repository.health());
    const identity = identityArgs(args);
    if (name === "search") return send(res, 200, await this.service.search(identity, String(args.query ?? "")));
    if (name === "note") return send(res, 200, { id: await this.service.note(identity, String(args.content ?? "")) });
    if (name === "reflect") return send(res, 200, await this.service.reflect(identity, String(args.summary ?? ""), String(args.resolution ?? "")));
    if (name === "brainstorm") return send(res, 200, await this.service.brainstorm(identity, args.thoughts as any));
    if (name === "timeline") return send(res, 200, { entries: await this.repository.timeline(identity, Math.min(200, Number(args.limit ?? 50))) });
    if (name === "compliance") return send(res, 200, await this.repository.compliance(identity));
    if (name === "recall") {
      const queries = threeLevelsSchema.parse({ concrete: args.concrete, abstract: args.abstract, meta: args.meta });
      return send(res, 200, await this.service.search(identity, String(args.currentContext ?? args.concrete ?? ""), queries));
    }
    if (name === "remember") {
      const trigger = threeLevelsSchema.parse({ concrete: args.triggerConcrete, abstract: args.triggerAbstract, meta: args.triggerMeta });
      const body = threeLevelsSchema.parse({ concrete: args.bodyConcrete, abstract: args.bodyAbstract, meta: args.bodyMeta });
      return send(res, 200, { id: await this.service.rememberStructured(identity, trigger, body,
        (args.scopeType as any) ?? "bot", Number(args.importance ?? 70)) });
    }
    if (name === "bind") { await this.repository.bind(identity); return send(res, 200, { ok: true, identity }); }
    if (name === "inspect") return send(res, 200, { memories: await this.repository.inspect(identity, Math.min(100, Number(args.limit ?? 20))) });
    if (name === "rate") { await this.repository.rate(identity, String(args.memoryId), String(args.generationId), Number(args.usefulness)); return send(res, 200, { ok: true }); }
    if (name === "forget") {
      if (args.confirm !== `forget:${args.memoryId}`) return send(res, 400, { error: "exact confirmation token required" });
      const forgotten = await this.repository.forget(identity, String(args.memoryId));
      if (forgotten) await this.repository.recordEvent(identity, "forget", undefined, { memoryId: String(args.memoryId) }).catch(() => undefined);
      return send(res, 200, { forgotten });
    }
    return send(res, 404, { error: "unknown tool" });
  }
}
