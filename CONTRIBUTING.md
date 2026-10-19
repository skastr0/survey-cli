# Contributing

survey-cli is experimental and solo-maintained. Open an issue first for
anything beyond a small bug fix or documentation correction.

## What Helps

- Reproducible bug reports with the command, JSON payload, and envelope
- Small fixes with tests
- Provider endpoint additions grounded in the provider's current docs
- Documentation corrections

## Out Of Scope

- Large rewrites or new subsystems without prior discussion
- Human-mode output, `--json` toggles, or domain values as flags (see the
  interface rules in `AGENTS.md`)
- Public security reports; use `SECURITY.md`

## Local Workflow

```bash
bun install
bun run verify   # typecheck + vitest + platform binaries
bun run smoke    # binary smoke: discovery completeness, failure contract, corpus/pipe/MCP
```

Unit tests never call live provider APIs: point `<PROVIDER>_API_BASE_URL` at a
local `node:http` stub server. `AGENTS.md` covers the Effect v4 conventions,
the provider module shape, and the vitest-under-Node quirks.

## Adding Or Changing A Command

Every command is part of the agent protocol, so a change is complete only when:

1. The input is one JSON object with an Effect Schema (provider-native field
   names); domain values never become flags.
2. Failures are `Schema.TaggedError` classes from `src/core/errors.ts`, never
   plain `Effect.fail({ _tag })` records, and each has a `toErrorDetails`
   branch with `retryable`, `hint`, and `next_step` when one exists.
3. `registerContract(s)` declares `inputSchema`, at least one example, and
   `output` (what `data` contains). `test/contracts.test.ts` decodes every
   example, and `bun run smoke` fails if a command lacks a schema, examples, or
   a resolvable `--help` CONTRACT section.
4. The `Command` description says what it does, its key input fields, and
   what comes back.

## Pull Requests

Use small, atomic Conventional Commits. Include `bun run verify` and
`bun run smoke` results in the PR description. Do not bump versions, tag, or
publish in a PR; releases follow `docs/release.md`.

By contributing, you agree that your contribution is licensed under the MIT
license used by this project.

## Conduct

Be direct, specific, and respectful. Issues or pull requests may be closed
when they are hostile, off-topic, or outside the project's scope.
