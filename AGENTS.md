# survey-cli - Agent Guide

## Project Intent

Consolidated researcher toolkit CLI. One JSON-first Effect v4 binary that exposes
Exa, Firecrawl, Parallel, Keenable, and LlamaCloud operations under
`survey <provider> <command>` namespaces, plus unified cross-provider commands
(`search`, `fetch`, `extract`, `research`, `verify`, `monitor`, `sql`, `runs`,
`sources`) that fan out, route, and fuse provider results.

## Interface Rules

- Every domain operation accepts one JSON object: inline JSON, `@file`, `-`, or `@-`.
- Stdout is always a deterministic success envelope `{ ok: true, command, data }`.
- Stderr is always a deterministic failure envelope `{ ok: false, command, error }`.
- Flags are execution controls only: `--output`, `--concurrency`, `--timeout`, `--wait`, `--idempotency-key`.
- Provider payloads keep the provider's own field names (usually `snake_case`).
- Runtime data lives under `~/.config/survey` (`SURVEY_HOME` override). Never cwd.

## Stack

- Runtime: Bun
- Effect v4: `effect@4.0.0-rc.112`, `@effect/platform-bun@4.0.0-rc.112` (exact pins)
- CLI: `effect/unstable/cli` (`Command`, `Flag`, `Argument`)
- HTTP: `effect/unstable/http` (`HttpClient` service, `FetchHttpClient.layer`)
- Store: `bun:sqlite` via `src/core/store.ts`
- Tests: vitest + `@effect/vitest`

## v4 Notes

- Services: `Context.Service<Self, Shape>()("pkg/path/Name")` with `static layer`.
- `yield* FileSystem.FileSystem`, `yield* Path.Path`, `yield* HttpClient.HttpClient`.
- `Effect.catch` / `catchTag` / `catchCause` (no `catchAll`); `Effect.andThen` (no `zipRight`).
- `Schema.decodeUnknownEffect`, `Schema.decodeEffect(Schema.fromJsonString(s))`,
  `Schema.toJsonSchemaDocument`, `Schema.optional` / `optionalKey` / `NullishOr`.
- `HttpClientRequest.make("DELETE")`; `bodyJsonUnsafe`, `bodyFormData`, `setUrlParams`.

## Provider Module Shape

Each provider lives in `src/providers/<name>/` and exports:

- `api.ts` — provider calls via `requestJson`/`requestText` from `src/core/http.ts`
- `schemas.ts` — input/output codecs (provider-native field names)
- `commands.ts` — `Command`s built with `makeJsonCommand`/`makeBatchJsonCommand`
- `capabilities.ts` — `CommandContract` registrations via `registerContract(s)`
- `index.ts` — `export const <name>Command` for the namespace group

Tests mock HTTP via `<PROVIDER>_API_BASE_URL` pointing at a local server.
Never hit live provider APIs in unit tests.

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
bun run verify
```

Do not call live provider APIs from default tests.
