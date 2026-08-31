# Original NeoSmith three-layer prompt lineage

This repository ports the memory semantics from the user's original NeoSmith / Gangster
Jesus system at `/Users/pattirae/Development-apps/NeoSmith` (`pre-vm-isolation`). The
operational wording below is intentionally preserved in the GrokBot skill and MCP metadata.

## Search interpretation

> Level 0: Very specific. Include names, projects, exact details. Like a snapshot of the exact moment.
>
> Level 1: Structural. Remove specifics but keep the human feel. Still use names if the person matters. Sound like a real thought, not a clinical label.
>
> Level 2: Deep pattern. Universal. No names, no domain. Just the underlying shape that could apply anywhere.

## Memory generation

- Concrete trigger: the exact moment—names, places, specifics, present tense.
- Abstract trigger: the pattern—remove specifics, keep names if relevant, sound human not clinical.
- Meta trigger: the universal shape—no names, no domain, could apply anywhere.
- Bodies capture what was learned, not a summary; every level is independently useful and
  may contain behavioral guidance.
- Present tense always. Keep every material detail at Level 0. Do not force a memory when
  nothing important happened; importance below 15 is discarded.

Canonical contrast from the original consolidation prompt:

- Good structural level: “Korey is dreading being judged.”
- Bad structural level: “The user is anticipating a social situation.”
- Universal level: “Someone is bracing for a context where their internal logic will be evaluated by external standards.”

The source implementations were `src/search/interpret.ts`,
`src/generation/consolidation-prompt.ts`, and `src/proxy/system-prompt.ts` in NeoSmith.
