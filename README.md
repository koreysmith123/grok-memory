# RecallSmith

**Memory forged from experience.**

RecallSmith is a private, persistent experiential-memory system for GrokBot. It understands
the current situation at three levels—concrete, structural, and universal—then retrieves
past experiences that rhyme with the moment. The established package name, command,
installation directory, and database identifiers remain `grok-memory` for backward
compatibility; the former GitHub URL redirects to RecallSmith.

## One-message install

Give a brand-new GrokBot this repository URL followed by `Install this.` That Bot clones
the repository to `/workspace/grok-memory`, runs the installer, registers its MCP server,
installs the two RecallSmith skills, activates only its own profile, performs and erases a
private canary, and reports `RECALLSMITH_READY`. It must do this without questions,
follow-up prompts, polling routines, or manual troubleshooting. `AGENTS.md` and
`GROKBOT_INSTALL.md` are the installation contract the Bot follows.

RecallSmith gives every GrokBot a private, persistent experiential memory. It uses
the active GrokBot/Grok Build model for all language understanding and reflection, EmbeddingGemma 300M for
local embeddings, and PostgreSQL with pgvector for concurrent storage and search.
There is no other local or hosted language model.

## Add memory to a new Bot

The computer service is shared and is installed only once. For a manually created Bot,
send one message:

> Initialize the RecallSmith skill.

RecallSmith finds the healthy shared service, binds the Bot's own stable ID, appends the
durable operating rule without replacing its role, runs and removes a private canary, and
reports `RECALLSMITH_READY`. It does not reinstall PostgreSQL, pgvector, Node.js, or the
embedding model when they are healthy.

To have an existing Bot create a memory-enabled child, ask it to use the account-wide
`Create RecallSmith Bot` skill and describe the child you want. In normal use you simply
say `Create a Bot that…`; the main RecallSmith skill invokes the creator skill
automatically. The creator puts the RecallSmith bootstrap rule in the child's description,
sends the child its initialization message, and waits for the child to verify its distinct
private namespace. No recurring scanner or five-minute routine is used.

## Grok Build compatibility

RecallSmith supports Grok Build natively as well as GrokBot. Grok Build discovers the
native `.grok-plugin/plugin.json`, the RecallSmith skill, lifecycle hooks, and MCP server.
It can also consume the generated Cursor-compatible MCP and hook configuration.

For a first installation, tell Grok Build:

> Install and initialize RecallSmith from https://github.com/koreysmith123/recallsmith

The repository installer provisions the same local PostgreSQL/pgvector service and
EmbeddingGemma model, installs the RecallSmith skill under `~/.grok/skills/`, and creates
one persistent `grok-build:<uuid>` identity. Grok Build reuses that identity across
sessions and projects; project and conversation scopes remain available separately. Run
`grok-memory build-identity --json` to inspect it and `grok inspect` or
`grok mcp doctor grok-memory` to verify discovery.

Grok Build subagents are temporary sessions, not persistent GrokBots. They share the
parent Grok Build identity and project scope. The `Create RecallSmith Bot` workflow runs
only when GrokBot's native persistent Bot-management tools are present.

## Architecture

The installation has four deliberately separate parts: optional Grok Build lifecycle
hooks, a persistent local daemon and job worker, a standards-compliant GrokBot MCP server,
and PostgreSQL/pgvector. The MCP recall tool is the primary same-turn path. GrokBot
uses the context it is already reasoning over to author three search descriptions;
the daemon owns only embedding, retrieval, and asynchronous reflection,
while PostgreSQL transactions and row-level security make simultaneous multi-Bot
reads and writes safe.

## What happens on every turn

1. GrokBot begins a substantive turn using its normal, already-warm model context.
2. Following the MCP tool description, that same GrokBot turn calls `memory_recall`
   with concrete, abstract, and meta descriptions of the current situation.
3. EmbeddingGemma embeds all three search expressions locally and in parallel.
4. PostgreSQL searches three namespace-filtered vector and full-text lanes in parallel.
5. Distinct results are ranked by semantic match, words, recency, importance, and
   observed usefulness, then returned as the MCP tool result in the same turn.
6. GrokBot treats the returned memories as fallible context and continues its answer.
7. On Grok Build hosts that expose lifecycle hooks, those hooks record bounded turn metadata and fail open.
8. When the turn establishes durable knowledge, that same active GrokBot calls
   `memory_remember` with concrete, abstract, and meta representations.
9. `afterAgentResponse` durably records the completed turn; optional asynchronous
   consolidation can run when the standalone Grok Build CLI is authenticated.

Normal recall and explicit memory writes never start a second Grok Build process or model request. Hooks call the
persistent local daemon and fail open on any timeout or outage. Reflection is asynchronous.

### Latency

The memory service's warm budget is below 2 seconds at p95, measured from the MCP
call arriving to its result returning. Typical warm embedding plus PostgreSQL work
is expected to be tens of milliseconds. GrokBot's normal time to decide to call a
tool is separate host-model latency; the memory system does not add another model
startup or generation before retrieval.

## Install from a GitHub checkout

Ask GrokBot to clone this repository on its computer and run:

```bash
./install.sh
```

On a stock GrokBot Linux computer the installer privately bootstraps checksum-verified
Node.js 22 when necessary. It uses Docker PostgreSQL when available; otherwise it
installs PostgreSQL 17 plus pgvector and creates a dedicated local cluster. It then
applies migrations, warms EmbeddingGemma, starts the daemon, and prints an absolute
stdio manifest from `.grok-memory/grokbot-mcp.json`.

The GrokBot performing the installation automatically finishes the native
`AddMcpServer` registration, both skill installations, profile activation, disposable canary, and health
verification. A shell-written `~/.cursor/mcp.json` is retained only for Grok Build
compatibility; it does not register the server in GrokBot.

### Authentication

Normal recall and `memory_remember` use the already-active
GrokBot model and require no separate Grok CLI login. Optional background consolidation
does require an existing Grok Build login or `XAI_API_KEY`; never put credentials in
the repository.

## Bot identity and privacy

All Bots belonging to one GrokBot user may share a VM, so filesystem or database
location is not an identity boundary. Every query is scoped by owner, Bot, project,
and conversation data. PostgreSQL row-level security is a second barrier.

Identity resolves in this order: explicit Bot ID, configured Bot ID, hook/MCP metadata, a
`.grok-memory/bot-id` workspace binding, a saved conversation binding, then a
conversation-only fallback. GrokBot currently does not inject its Bot ID into MCP
arguments, so every memory-bearing tool makes `botId` schema-required and its description
instructs the active Bot to supply its own stable ID. Omission fails at MCP validation and
never reaches the daemon. Use `memory_bind_bot` or set `GROK_MEMORY_BOT_ID` only for
non-GrokBot clients that cannot supply the ID per call.

The active GrokBot turn writes search descriptions from conversation context. Completed
turn snippets are sent to the asynchronous Grok Build worker for consolidation.
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
grok-memory build-identity --json
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

To uninstall, remove the `grok-memory` MCP server in GrokBot, stop `grok-memory.service`,
remove only the owned entries from `~/.cursor/hooks.json` and `~/.cursor/mcp.json`, and remove the checkout. Preserve
the PostgreSQL volume unless the user explicitly asks to delete all memories.

## Release gates

[REQUIREMENTS.md](./REQUIREMENTS.md) is the source of truth. A release is not
complete until deterministic, PostgreSQL, clean-install, and authenticated Grok
Build checks are all recorded as PASS in `artifacts/validation-report.json`.
`npm run validate:deterministic` is the fast offline check; `npm run validate`
runs the complete release sequence and therefore requires the PostgreSQL test URLs
and an authenticated Grok Build session.
