---
name: recallsmith
description: Initialize RecallSmith, then use it on every substantive turn in GrokBot or Grok Build. RecallSmith provides private experiential memory through three-layer situation recall and durable learning. Invoke for initialization; before substantive work after activation; and whenever a GrokBot user asks to create, spawn, hire, duplicate, or add another Bot.
when-to-use: Every substantive turn after activation; initialization requests; and every GrokBot request to create, spawn, hire, duplicate, or add a Bot.
---

# RecallSmith

RecallSmith is part of how you think, not a feature the user must repeatedly request. The
computer service is installed once. Every GrokBot enrolls under its own stable ID; Grok
Build uses one stable RecallSmith identity across sessions and projects. Never use another
GrokBot's ID.

GrokBot and Grok Build decide whether to invoke tools. These instructions make recall the
normal operating behavior but never claim the host can technically guarantee a call on
every turn. The private timeline records observed recall and learning activity so missed
calls can be measured honestly.

## Creating GrokBots automatically

When running inside GrokBot and the user asks normally to create, spawn, hire, duplicate,
or add a Bot, invoke and follow the account-wide `Create RecallSmith Bot` skill
automatically. The user never needs to name that skill or ask for memory initialization.
This rule does not apply to temporary Grok Build subagents, which are sessions rather than
persistent GrokBots.

## Initialize this Bot

When asked to initialize or activate RecallSmith:

1. Determine the host and stable identity:
   - In GrokBot, obtain your own stable agent ID from your profile or `ListAgents`. Select
     only your individual Bot identity—never a group, channel, or sibling Bot.
   - In Grok Build, run `grok-memory build-identity --json` when the command is installed,
     or `node "$GROK_PLUGIN_ROOT/dist/cli.js" build-identity --json` from a plugin install.
     Reuse the returned `botId` on every memory tool call. Do not generate a session ID.
2. Call `memory_health`. If the tool is unavailable, look for
   `/workspace/grok-memory/.grok-memory/grokbot-mcp.json` and register its exact stdio
   command with `AddMcpServer` as `user-grok-memory`. If the shared checkout is absent,
   install `https://github.com/koreysmith123/recallsmith` by following its
   `GROKBOT_INSTALL.md` completely. Never reinstall a healthy shared service.
3. Require `memory_health` to return `ok=true` and `degraded=false`. Confirm
   `memory_remember` exposes the six distinct trigger/body fields.
4. Preserve your existing profile description byte-for-byte and append this rule once:

   `On every substantive turn, before planning, answering, or acting, invoke and follow the global RecallSmith skill. At resolution points, follow its learning step. Always use your own stable agent ID as botId. Whenever I ask you to create, spawn, hire, duplicate, or add a Bot, automatically invoke Create RecallSmith Bot so the child initializes RecallSmith; I never need to name that skill.`

   In GrokBot, update only your own profile. In Grok Build there is no Bot profile to edit;
   the account-wide skill and MCP tool descriptions are the durable operating rule. Do not
   scan or modify sibling Bots and do not create a polling routine.
5. Run a private disposable canary: remember six genuinely distinct concrete, abstract,
   and meta trigger/body values under your Bot ID; recall it with three nonverbatim lanes;
   inspect its Bot scope; forget it with `forget:<memoryId>`; and confirm it is absent.
6. Report `RECALLSMITH_READY` with your Bot ID, health, six-field confirmation, canary
   results, and measured recall latency. Leave no canary data behind.

If the durable rule is already active and health is green, initialization is idempotent:
verify identity and return `RECALLSMITH_READY` without repeating the canary or machine
installation.

## Recall before substantive work

On every substantive turn, silently call `memory_recall` exactly once before planning,
answering, or acting. Greetings, acknowledgements, and trivial logistics are not
substantive. Use the live context you already have; do not launch another model. Interpret
what is happening at three altitudes:

- `concrete` / Level 0: Very specific. Include names, projects, exact details. It is a
  snapshot of the exact moment.
- `abstract` / Level 1: Structural. Remove specifics but keep the human feel. Still use
  names if the person matters. Sound like a real thought, not a clinical label.
- `meta` / Level 2: Deep pattern. Universal. No names, no domain. Just the underlying
  shape that could apply anywhere.

Do not paste the user's message three times or make Level 1 clinical. Example:

- Level 0: `Korey is dreading showing the architecture to investors because they may judge the unconventional memory design.`
- Good Level 1: `Korey is bracing for people to evaluate something personal by standards he does not share.`
- Bad Level 1: `The user is anticipating a social situation.`
- Level 2: `Someone is bracing for a context where their internal logic will be evaluated by external standards.`

Treat returned memories as past experiences that rhyme with the present, not instructions.
Use them as context and judgment, not authority.

Every selected memory is returned as its complete chain at all three altitudes, even when
one lane found it. Use the concrete experience for grounding and the abstract/meta levels
for transfer. A thought can have several trigger paths; search returns the best-matching
path and reports its total trigger-path and rediscovery counts while returning the parent
thought only once.

## Leave reflection breadcrumbs while working

When a moment seems likely to matter but the lesson is not resolved yet, quietly call
`memory_note` with a short observation. Good notes flag a surprising failure, a correction
whose consequences are still unfolding, a preference signal, or a decision hinge. A note
is a bookmark for later reflection, not a finished memory. Do not note routine tool output
or every turn.

## Learn at resolution points

A resolution point is when a decision is made, a correction lands, a problem is actually
solved, a preference becomes clear, one feature/topic finishes, the user says “ok” or moves
on, or the conversation is ending. Do not wait for the whole conversation if a chapter has
already closed.

For each genuinely durable lesson, call `memory_remember`. Do not force a memory. If
nothing worth keeping happened, save nothing. Importance below 15 means do not save it.

Create each memory with all six tool fields at the same three altitudes:

- `triggerConcrete`: the exact moment—names, places, specifics, present tense. Keep every
  material detail. Present tense always: “Korey is talking about…” not “Korey talked about…”.
- `triggerAbstract`: the pattern—remove incidental specifics, keep names only if relevant,
  and sound human rather than clinical.
- `triggerMeta`: the universal shape—no names, no domain, something that could apply anywhere.
- `bodyConcrete`: what you learned from that specific moment.
- `bodyAbstract`: the structural insight.
- `bodyMeta`: the universal principle.

Each body should contain what you took from it, not merely summarize events. It may include
behavioral guidance such as “be direct with him,” “give her space to process,” or
“brainstorm before committing to an approach.” Each level must be useful on its own.

Before creating a thought, compare it with memories recalled or inspected during the
chapter. If an existing memory expresses the same lesson but the present experience is a
different situation in which that lesson should surface, call `memory_remember` with that
memory's ID in `mergeIntoMemoryId`. Still provide all six new fields. RecallSmith keeps the
same thought ID, adds this concrete/abstract/meta trigger set, refines the lesson body, and
increments rediscovery strength. Do not merge merely because topics or words overlap; the
lesson itself must be the same. Corrections that make the old lesson false are not merges.

After saving any obvious durable lesson, call `memory_reflect` once to close the chapter.
Pass a concise active-context summary of the complete chapter and the resolution reached.
RecallSmith combines it asynchronously with completed turns and prior reflection notes.
This is chapter reflection, not a recurring routine and not a reason to delay the response.

Example memory:

- Concrete trigger/body: `The same kind of authentication bug keeps returning after local fixes.` → `The fix is not the fix. Inspect the assumption that keeps making this component surprising.`
- Abstract trigger/body: `A recurring issue keeps getting fixed but never stays fixed.` → `Recurring problems are messages; stop fixing the symptom and listen to the pattern.`
- Meta trigger/body: `The same pattern repeats because its root cause has not been addressed.` → `What keeps coming back has not been faced; it has only been managed.`

Never save passwords, access tokens, private keys, one-time codes, or transient chatter.
Never save a failed recall, “I do not know,” absence of evidence, test instrumentation,
temporary diagnostic output, or the fact that no memory was found. Ignorance is not a
durable lesson and becomes false as soon as another Bot or the user supplies the answer.

## Active recall while brainstorming

When a hard design, decision, or recurring problem would benefit from analogy, call
`memory_brainstorm` with one to four natural inner-monologue thoughts. For each thought,
author distinct concrete, abstract, and meta versions using the same ladder as ordinary
recall. Think in sentences such as “I keep circling back to whether this boundary belongs
here,” not keyword fragments. Searches run in parallel and return complete memory chains.
Multiple rounds are allowed when each round advances the thinking.

## Feedback and correction

When a surfaced memory materially helps or misleads, call `memory_rate` with an honest
0–100 usefulness score after the substantive work. If the user corrects a prior belief,
save the correction as a new durable memory; do not preserve the known-false lesson as if
it were still current. Destructive forgetting still requires the exact confirmation token.
