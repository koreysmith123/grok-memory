# RecallSmith v0.2.1 Grok Build validation

Validated 2026-08-30 on the same Linux VM used by the production GrokBot desktop app.

## Native discovery passed

The VM pulled commit `09dba1c83a673218378ddc8f370edf6e39d735cc` and exercised the
real Grok Build 1.0.13 CLI. The following checks passed:

- `grok plugin validate` accepted the native `recallsmith` v0.2.1 manifest;
- trusted plugin installation completed successfully;
- `grok inspect --json` discovered the `recallsmith` and
  `create-recallsmith-bot` skills;
- the `beforeSubmitPrompt` and `afterAgentResponse` hooks were discovered;
- the RecallSmith stdio MCP server was discovered and `grok mcp doctor` reported all
  eight tools healthy;
- two calls to the Build identity command returned the persistent identity
  `grok-build:db5332ad-a145-4e96-94e9-c8cef619602b`;
- the existing RecallSmith daemon and PostgreSQL database remained healthy and were not
  reinstalled or wiped.

This validates the native packaging and discovery portions of `BLD-001` through `BLD-004`
and `BLD-006` on a real GrokBot-managed VM.

## Authenticated two-session gate pending

The requested two-session Aurora 742 test was not run. Grok Build on this VM had no
`~/.grok/auth.json` and no `XAI_API_KEY`; the CLI opened xAI's device-code sign-in flow.
The flow was stopped without entering credentials. No Aurora 742 memory was created, so
there was nothing to clean up.

Consequently, `BLD-005` is implemented and deterministically tested, but its authenticated
live gate remains pending. Completing a one-time `grok login` (or supplying an
`XAI_API_KEY`) is required before the active Grok Build model can author the three search
lanes in the first session and prove automatic recall in the second.
