# Zero-intervention GrokBot installer contract

Complete every phase below without asking the user questions. Do not stop at
`GROK_MEMORY_VM_READY`, and do not report success until every `GROK_MEMORY_READY` condition
is true.

## Phase 1: VM installation

1. Clone or update this repository at `/workspace/grok-memory`, then run `./install.sh`.
2. Read `.grok-memory/install-result.json`. Require `status=VM_READY` and
   `doctor.daemon.ok=true`.
3. Self-repair ordinary dependency, port, service, migration, and stale-process failures,
   rerunning the installer as needed. Never delete or replace an existing memory database.

## Phase 2: native GrokBot activation

1. Read `.grok-memory/grokbot-mcp.json`. Invoke `AddMcpServer` with its exact stdio command
   under the stable name `user-grok-memory`. Re-register it if GrokBot cached an older
   schema. Confirm `memory_remember` exposes all six distinct fields: `bodyConcrete`,
   `bodyAbstract`, `bodyMeta`, `triggerConcrete`, `triggerAbstract`, and `triggerMeta`.
2. Call `memory_health`. Require `ok=true` and `degraded=false`.
3. Determine your own stable agent ID from your profile or `ListAgents`. Select only your
   individual Bot identity—never a group, channel, or another Bot.
4. Read `skills/grok-memory/SKILL.md` completely. Use `update_state` with
   `target=workflow`, `action=write`, and name `Memory Operating Loop` to install its exact
   description and body.
5. Preserve your own existing profile description byte-for-byte and append this rule once
   if absent:

   `On every substantive turn, before planning, answering, or acting, invoke and follow the global Memory Operating Loop skill. At resolution points, follow its learning step. Always use your own stable agent ID as botId.`

   Update only your own profile with `update_state target=profile action=set`. Do not scan,
   edit, message, or provision sibling Bots. Do not create a polling routine.

## Phase 3: private disposable canary

1. Call `memory_remember` under your own stable agent ID with a unique synthetic canary.
   Provide genuinely distinct values for all six concrete, abstract, and meta fields.
2. Call `memory_recall` with three distinct, nonverbatim concrete, abstract, and meta search
   lanes. Require the canary memory ID to return with `degraded=false`.
3. Call `memory_inspect` for that exact ID. Require your own Bot scope and all six fields.
4. Call `memory_forget` for that exact ID with its exact confirmation token
   `forget:<memoryId>`, then inspect again and require it to be absent. Leave no canary data.

## Phase 4: completion

All of these must be true: daemon doctor green; MCP registered; `memory_health` green;
six-field schema confirmed; exact skill installed; only this Bot's profile activated; recall,
inspect, and exact-delete canary passed; no polling routine created; no canary remains.

Your final response must begin exactly `GROK_MEMORY_READY` and include the stable Bot ID,
health result, six-field schema confirmation, all canary results, and measured recall latency.
If an unrecoverable permission failure remains after autonomous self-repair, begin exactly
`GROK_MEMORY_BLOCKED` and provide concrete evidence. Do not ask an open question and do not
claim partial success.
