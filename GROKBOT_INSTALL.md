# RecallSmith zero-intervention GrokBot installer contract

Complete every phase below without asking the user questions. Do not stop at
`GROK_MEMORY_VM_READY`, and do not report success until every `RECALLSMITH_READY` condition
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
   schema. Confirm all thirteen tools are advertised: `memory_recall`, `memory_search`,
   `memory_brainstorm`, `memory_note`, `memory_reflect`, `memory_remember`, `memory_rate`,
   `memory_bind_bot`, `memory_inspect`, `memory_timeline`, `memory_compliance`,
   `memory_forget`, and `memory_health`. Confirm `memory_remember` exposes all six distinct fields: `bodyConcrete`,
   `bodyAbstract`, `bodyMeta`, `triggerConcrete`, `triggerAbstract`, and `triggerMeta`.
2. Call `memory_health`. Require `ok=true`, `degraded=false`, and `schema_version>=3`.
3. Determine your own stable agent ID from your profile or `ListAgents`. Select only your
   individual Bot identity—never a group, channel, or another Bot.
4. Read `skills/recallsmith/SKILL.md` and
   `skills/create-recallsmith-bot/SKILL.md` completely. Use `update_state` with
   `target=workflow`, `action=write` to install their exact descriptions and bodies as the
   account-wide `RecallSmith` and `Create RecallSmith Bot` skills.
5. Preserve your own existing profile description byte-for-byte and append this rule once
   if absent:

   `On every substantive turn, before planning, answering, or acting, invoke and follow the global RecallSmith skill. At resolution points, follow its learning step. Always use your own stable agent ID as botId. Whenever I ask you to create, spawn, hire, duplicate, or add a Bot, automatically invoke Create RecallSmith Bot so the child initializes RecallSmith; I never need to name that skill.`

   Update only your own profile with `update_state target=profile action=set`. Do not scan,
   edit, message, or provision sibling Bots. Do not create a polling routine.

## Phase 3: private disposable canary

1. Call `memory_remember` under your own stable agent ID with a unique synthetic canary.
   Provide genuinely distinct values for all six concrete, abstract, and meta fields.
2. Call `memory_recall` with three distinct, nonverbatim concrete, abstract, and meta search
   lanes. Require the canary memory ID to return with `degraded=false`.
3. Call `memory_inspect` for that exact ID. Require your own Bot scope and all six fields.
4. Call `memory_remember` again with a distinct second three-level
   trigger set and `mergeIntoMemoryId` equal to the canary ID. Require the returned ID to
   remain unchanged, `trigger_count=2`, `merge_count=1`, and recall through both trigger
   paths to return the parent once.
5. Call `memory_forget` for that exact ID with its exact confirmation token
   `forget:<memoryId>`, then inspect again and require it to be absent. Leave no canary data.

## Phase 4: completion

All of these must be true: daemon doctor green; MCP registered; all thirteen tools advertised;
`memory_health` green on schema 3 or newer; six-field plus `mergeIntoMemoryId` schema confirmed; both exact skills installed; only this Bot's profile activated; multi-trigger merge, recall,
inspect, and exact-delete canary passed; no polling routine created; no canary remains.

Your final response must begin exactly `RECALLSMITH_READY` and include the stable Bot ID,
health result, thirteen-tool and six-field schema confirmation, all canary results, and measured recall latency.
If an unrecoverable permission failure remains after autonomous self-repair, begin exactly
`GROK_MEMORY_BLOCKED` and provide concrete evidence. Do not ask an open question and do not
claim partial success.
