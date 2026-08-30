# Grok Memory

Grok Memory gives every GrokBot a private, persistent experiential memory. It uses
Grok Build for all language understanding and reflection, EmbeddingGemma 300M for
local embeddings, and PostgreSQL with pgvector for concurrent storage and search.
There is no other local or hosted language model.

## Architecture

The installation has four deliberately separate parts: tiny GrokBot lifecycle
hooks, a persistent local daemon and job worker, a standards-compliant MCP server,
and PostgreSQL/pgvector. Hooks only exchange bounded JSON with the daemon. The
daemon owns all interpretation, embedding, retrieval, and asynchronous reflection,
while PostgreSQL transactions and row-level security make simultaneous multi-Bot
reads and writes safe.

## What happens on every turn

1. GrokBot runs the `beforeSubmitPrompt` command hook.
2. The hook sends the prompt and stable conversation metadata to the local daemon.
3. Grok Build expresses the situation at concrete, abstract, and universal levels.
4. EmbeddingGemma embeds each search expression locally.
5. PostgreSQL searches three namespace-filtered vector and full-text lanes.
6. Distinct results are ranked by semantic match, words, recency, importance, and
   observed usefulness, then returned as `additional_context`.
7. GrokBot receives the memories in a sanitized system-reminder carrier.
8. `afterAgentResponse` durably records the completed turn and queues reflection.
9. The persistent worker asks Grok Build to create, update, merge, supersede,
   reinforce, or decline memories; embeddings are stored once at write time.

Hooks never start Grok Build themselves. They call the persistent local daemon and
fail open on any timeout or outage. Reflection is asynchronous.

## Install from a GitHub checkout

Ask GrokBot to clone this repository on its computer and run:

```bash
./install.sh
```

The installer builds the package, starts a local pgvector PostgreSQL service,
applies migrations, adds the MCP server and lifecycle hooks without replacing
unrelated configuration, and starts the daemon. If Grok Build has not been signed
in on that VM, complete the one-time authentication device flow:

```bash
grok login --device-auth
```

An `XAI_API_KEY` is also supported by Grok Build. Never put it in the repository.

## Bot identity and privacy

All Bots belonging to one GrokBot user may share a VM, so filesystem or database
location is not an identity boundary. Every query is scoped by owner, Bot, project,
and conversation data. PostgreSQL row-level security is a second barrier.

Identity resolves in this order: configured Bot ID, hook/MCP metadata, a
`.grok-memory/bot-id` workspace binding, a saved conversation binding, then a
conversation-only fallback. The fallback deliberately sacrifices cross-conversation
recall rather than risk leaking another Bot's memories. Use `memory_bind_bot` or set
`GROK_MEMORY_BOT_ID` when GrokBot does not expose a stable agent identifier.

Conversation snippets are sent to Grok Build for interpretation and consolidation.
Embeddings and memories remain on the GrokBot computer. Raw turns default to a
30-day retention setting; distilled memories remain until forgotten.

## Emulator

The emulator invokes the production hook executables and production MCP server—it
does not use an emulator-only memory path. Start the daemon, then replay a fixture:

```bash
npm run build
node dist/cli.js daemon
node dist/cli.js emulate --replay test/fixtures/conversation.json
```

Or open a console with `node dist/cli.js emulate test-bot`. Deterministic tests use
saved Grok Build JSON fixtures; `npm run test:live` uses the authenticated real
Grok Build installation.

## Operations

```bash
grok-memory doctor --json
grok-memory migrate
grok-memory emulate test-bot
npm run validate
npm run test:postgres
npm run test:e2e
npm run test:live
```

Resource needs are approximately 300 MB for the quantized EmbeddingGemma model,
plus Node.js 22 and PostgreSQL 17 with pgvector. CPU-only inference is supported;
more memory and CPU primarily reduce first-turn and concurrent-search latency.

Back up the Docker volume `grok-memory-postgres` (or use `pg_dump`). Upgrades are
performed by pulling the repository, running `npm ci && npm run build`, and running
`grok-memory migrate`; migrations are transactional and repeatable.

To uninstall, stop `grok-memory.service`, remove only the `grok-memory` entries from
`~/.cursor/hooks.json` and `~/.cursor/mcp.json`, and remove the checkout. Preserve
the PostgreSQL volume unless the user explicitly asks to delete all memories.

## Release gates

[REQUIREMENTS.md](./REQUIREMENTS.md) is the source of truth. A release is not
complete until deterministic, PostgreSQL, clean-install, and authenticated Grok
Build checks are all recorded as PASS in `artifacts/validation-report.json`.
`npm run validate:deterministic` is the fast offline check; `npm run validate`
runs the complete release sequence and therefore requires the PostgreSQL test URLs
and an authenticated Grok Build session.
