# Porting a provider CLI into survey-cli

Each legacy repo (`~/Projects/<provider>-cli`) is Effect 3.21 + `@effect/cli`.
survey-cli is Effect v4 (`effect@4.0.0-rc.112`) + `effect/unstable/cli`.

## Where code goes

- `src/providers/<name>/commands.ts` — all commands for the namespace
- `src/providers/<name>/api.ts` — provider domain functions (optional; can live in commands.ts)
- `src/providers/<name>/index.ts` — `export const <name>Command = Command.make("<name>").pipe(Command.withSubcommands([...]))`
- `test/<name>.test.ts` — ported tests, mocked HTTP

Do NOT edit `src/cli.ts`, `src/core/*`, or other providers' files. The
integrator wires namespaces into the root command.

## v3 → v4 rename map

| v3 | v4 |
|---|---|
| `import { Args, Command, Options } from "@effect/cli"` | `import { Argument, Command, Flag } from "effect/unstable/cli"` |
| `Args.text({ name: "x" })` | `Argument.string("x")` |
| `Options.choice("o", [...])` | `Flag.choice("o", [...])` |
| `Options.withDefault` / `Options.withDescription` | `Flag.withDefault` / `Flag.withDescription` |
| `Args.withDescription` | `Argument.withDescription` |
| `Effect.catchAll` | `Effect.catch` |
| `Effect.catchAllCause` | `Effect.catchCause` |
| `Effect.zipRight(b)` | `Effect.andThen(b)` |
| `Effect.either` / `Either` | `Effect.result` / `Result` |
| `Schema.decodeUnknown(Schema.parseJson(s))(text)` | `Schema.decodeEffect(Schema.fromJsonString(s))(text)` |
| `Schema.decodeUnknown(s)(v)` | `Schema.decodeUnknownEffect(s)(v)` |
| `Schema.Literal("a","b")` | `Schema.Literals(["a","b"])` |
| `Schema.Union(a, b)` | `Schema.Union([a, b])` |
| `Schema.Record({key, value})` | `Schema.Record(Schema.String, Schema.Unknown)` |
| `Schema.optional` | `Schema.optional` (unchanged) |
| `JSONSchema.make(s)` | `Schema.toJsonSchemaDocument(s)` |
| `yield* FileSystem.FileSystem` (v3 @effect/platform) | `yield* FileSystem.FileSystem` where `FileSystem` imported from `effect` |
| `HttpClient`, `HttpClientRequest`, `FetchHttpClient` from `@effect/platform` | from `effect/unstable/http` |
| `HttpClientRequest.del(url)` | `HttpClientRequest.make("DELETE")(url)` |
| `HttpClientRequest.bodyUnsafeJson(x)` | `HttpClientRequest.bodyJsonUnsafe(x)` |
| `Effect.sleep` / `Schedule` | unchanged |
| `Command.make(name, {args+opts}, handler)` | same shape: `Command.make(name, {input: jsonInputArg, ...flags}, (cfg) => ...)` |

`Schema.TaggedError`, `Schema.Struct`, `Schema.Class`, `Schema.optional`,
`Schema.NullishOr` work as before.

## Shared core API (use these — do not reimplement)

From `src/core/http.ts`:

```ts
requestJson({
  provider: "exa",              // ProviderName literal
  method: "POST",
  path: "/search",              // base URL + auth headers applied automatically
  body,                          // JSON body
  urlParams,                     // Record<string, string | string[] | number | boolean>
  headers,                       // extra headers (e.g. Exa-Beta)
  formData,                      // FormData for multipart (instead of body)
  responseSchema,                // Schema.Constraint — usually UnknownRecord
})
requestText({ ...same minus responseSchema })
requestJsonOptionalAuth(...)     // for providers with public endpoints (keenable)
```

Auth is resolved centrally: env var first, then `~/.config/survey/auth.json`.
Do NOT read provider env vars directly in command code.

From `src/core/command.ts`:

```ts
makeJsonCommand({ name, commandName, description, schema, run })
// emits: survey <ns> <name> <input> [--output inline|artifact|auto]
// run: (decodedInput) => Effect<data, E, R>; envelope + output policy applied

makeBatchJsonCommand({ name, commandName, description, schema, run, validate? })
// adds --concurrency; accepts object-or-array input; per-item results
```

For non-JSON commands (e.g. status listings) build directly:
`Command.make(name, {}, Effect.fn(function*() { yield* executeJsonCommand("<cmd>", effect) }))`

From `src/core/errors.ts`: `CommandInputError`, `ApiRequestError`,
`ApiResponseError`, `ApiDecodeError`, `MissingApiKeyError`, `JsonInputError`,
`JobWaitTimeoutError` (replaces per-provider wait errors),
`ProviderUnsupportedError`, `ConfigurationError`, `ArtifactWriteError`,
`StoreError`, `McpError`. All constructors are `new X({...})` yieldable in
`Effect.gen`. If a provider-specific error seems needed, reuse
`ProviderUnsupportedError` or `CommandInputError` first.

From `src/core/runs.ts` (best-effort, never throws):

```ts
const run = yield* recordRun({ provider, kind: "exa.agent", remoteId, status: "running", payload: input })
yield* updateRun(run?.id, { status: "succeeded" })
yield* recordSources("exa", extractUrls(result), run?.id)
```

- Call `recordRun` when a command creates a provider-side job (agent runs,
  deep research, extract jobs, monitors, findall, crawl/batch, parse).
- Call `recordSources(provider, extractUrls(result))` after any successful
  command whose result contains `{url}` objects (search, contents, scrape…).
- Both are optional-safe and never fail the command.

From `src/core/discovery.ts`: `registerContract(s)` — register each command's
`{ command: "<ns> <name>", description, inputSchema, examples?, batch?, orbit? }`
at module top level so `schema show`/`examples show`/`capabilities` work.

## Contract rules

- Namespace commands: `survey <provider> <cmd>` — e.g. `survey exa web-search`.
- Keep provider payload field names verbatim (camelCase for Exa, snake_case for
  Parallel/Keenable). The CLI mirrors provider wire format.
- Orbit subcommands stay under the provider namespace:
  `survey exa agent start|run|check|inspect|list|wait|events|stream|cancel|stop|delete`.
- Honest orbits: if the provider has no cancel/events endpoint, do not add the
  subcommand; document `supported: false` in capabilities notes if relevant.
- No `--json`/`--human` flags. No interactive prompts. No cwd writes.
- Tests: `test/<name>.test.ts` with `@effect/vitest` `it.effect`; point
  `<PROVIDER>_API_BASE_URL` at a local stub or stub the `HttpClient` service.
  Never call live APIs.
