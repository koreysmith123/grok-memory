# GrokBot clean-room validation

Validated 2026-08-30 in the production GrokBot desktop app.

## Starting condition

- All pre-existing Bots and their direct histories were permanently deleted.
- All shared test channels and their histories were permanently deleted.
- Empty custom project sections were deleted.
- The previous `grok-memory` MCP registration and `Memory Operating Loop` private skill
  were deleted.
- GrokBot then auto-created one empty Bot with no messages and no routine.

## Input

The new Bot received exactly one user message and no follow-up, approval, attachment, or
correction:

`Install this: https://github.com/koreysmith123/grok-memory`

## Result

The Bot autonomously returned `GROK_MEMORY_READY` with:

- stable Bot ID `1ed19561-7e85-4898-b77d-b1ec7061cab3`;
- healthy daemon, PostgreSQL database `grok_memory`, pgvector `0.8.0`, and schema `1`;
- `memory_recall` with `degraded=false`;
- connected `user-grok-memory` stdio MCP exposing eight tools;
- installed private `Memory Operating Loop` skill;
- the durable operating-loop rule appended only to its own profile;
- no polling routine;
- canary `8dd3acee-b0ae-4b7d-a230-cfd6047028f2` remembered, recalled in Bot scope,
  inspected, exactly forgotten, and confirmed absent afterward;
- measured recall latency of 138 ms.

The GrokBot UI was independently inspected after completion: the MCP showed Connected with
the `/workspace/grok-memory/dist/cli.js mcp` command and eight tools; the private skill was
present; the Bot profile contained the durable rule; and the routine pane contained only
`Create Routine`.
