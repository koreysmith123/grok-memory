# RecallSmith v0.2.0 live GrokBot validation

Validated 2026-08-30 in the production GrokBot desktop app.

## Upgrade and account-wide skills

The existing Bot was given the renamed GitHub repository and instructed to follow
`GROKBOT_INSTALL.md`. It updated the shared checkout while preserving the existing
PostgreSQL memory database, registered the existing MCP service, removed the superseded
`Memory Operating Loop` workflow, and installed these account-wide skills:

- `RecallSmith`
- `Create RecallSmith Bot`

The Bot returned `RECALLSMITH_READY` under stable Bot ID
`1ed19561-7e85-4898-b77d-b1ec7061cab3`. Health was green, pgvector was `0.8.0`, schema was
`1`, all six memory fields were confirmed, and its disposable canary was exactly deleted.
Measured recall latency was 167 ms.

## Parent-created child gate

The activated parent was given one instruction: use `Create RecallSmith Bot` to create
`RecallSmith Child Test`, a concise release-validation assistant, and wait for the child to
return `RECALLSMITH_READY`.

The parent used GrokBot's native Bot-management exchange. It created the child with the
RecallSmith bootstrap paragraph in its description and immediately sent the prescribed
initialization message. No manual message or profile edit was sent to the child by the
tester.

The child returned:

- stable Bot ID `a1da311f-b5c7-4e88-8e88-6cd3a789fff9`, distinct from the parent;
- `ok=true`, non-degraded recall, pgvector `0.8.0`, schema `1`, empty queue;
- explicit confirmation that the already-healthy shared service was not reinstalled;
- confirmation of all six trigger/body fields;
- a Bot-scoped disposable canary that was recalled and exactly deleted;
- measured recall latency of 151 ms.

Independent profile inspection showed the original role text remained intact, followed by
the child bootstrap paragraph and the permanent RecallSmith operating-loop rule. No polling
routine was created.

This satisfies the live portions of `BOT-010` and `BOT-011` for v0.2.0.
