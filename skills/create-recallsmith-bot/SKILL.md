---
name: create-recallsmith-bot
description: Create a new GrokBot that automatically initializes its own private RecallSmith memory. Use whenever creating, spawning, hiring, or duplicating a Bot that should remember and learn across conversations.
---

# Create a RecallSmith Bot

Use GrokBot's native Bot-management tools. The shared RecallSmith computer service must be
installed only once; every child gets a distinct private memory namespace.

1. Confirm the account-wide `RecallSmith` skill exists. If it does not, install the
   repository at `https://github.com/koreysmith123/recallsmith` first.
2. Ask for the new Bot's role only when the user has not already supplied enough detail.
3. Call `CreateAgent` with the requested name and role. Preserve the user's role text and
   append this bootstrap paragraph to the new Bot's description:

   `Before doing substantive work, read and execute the account-wide RecallSmith skill and initialize it for your own stable Bot ID. Do not reinstall a healthy shared service. Do not use another Bot's ID. Continue until you report RECALLSMITH_READY.`
4. Immediately call `SendToAgent` for the new Bot with exactly:

   `Initialize the RecallSmith skill for your own Bot identity. Continue autonomously until RECALLSMITH_READY, then report your Bot ID and health. Do not reinstall the shared service if it is already healthy.`
5. Read the child's result. Require `RECALLSMITH_READY`, a distinct stable Bot ID, green
   health, six-field schema confirmation, and a deleted private canary. If an ordinary
   activation step failed, send the evidence back to the child once for self-repair.
6. Report the new Bot's name and ID to the user. Do not copy the parent's Bot ID or private
   memories, do not patch unrelated Bots, and do not create a polling routine.

When duplicating an already activated RecallSmith Bot, retain its role/profile and enabled
skills, but still send the initialization message so the duplicate verifies its new identity
and private namespace. Initialization is intentionally idempotent.
