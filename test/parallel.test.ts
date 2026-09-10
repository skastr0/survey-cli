import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: unknown
}

interface CliResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const PROJECT_ROOT = resolve(dirname(import.meta.filename), "..")
const ENTRYPOINT = "./src/providers/parallel/cli.ts"

let cachedSurveyHome: string | undefined
const defaultSurveyHome = () =>
  (cachedSurveyHome ??= mkdtempSync(join(tmpdir(), "survey-parallel-home-")))

// Env vars that must not leak from the developer's real environment.
const CONTROLLED_ENV = [
  "PARALLEL_API_KEY",
  "PARALLEL_API_BASE_URL",
  "SURVEY_HOME",
  "SURVEY_ARTIFACT_DIR",
] as const

const runCli = (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
  options?: { readonly stdinText?: string },
): Effect.Effect<CliResult> =>
  Effect.promise(
    () =>
      new Promise((resolvePromise, reject) => {
        const processEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !(CONTROLLED_ENV as ReadonlyArray<string>).includes(key),
          ),
        )
        processEnv.SURVEY_HOME = defaultSurveyHome()

        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) {
            delete processEnv[key]
          } else {
            processEnv[key] = value
          }
        }

        const subprocess = spawn("bun", ["run", ENTRYPOINT, ...args], {
          cwd: PROJECT_ROOT,
          env: processEnv,
          stdio: ["pipe", "pipe", "pipe"],
        })

        let stdout = ""
        let stderr = ""

        subprocess.stdout.on("data", (data) => {
          stdout += data
        })
        subprocess.stderr.on("data", (data) => {
          stderr += data
        })
        subprocess.on("close", (code) => {
          resolvePromise({ stdout, stderr, exitCode: code ?? -1 })
        })
        subprocess.on("error", reject)

        if (options?.stdinText !== undefined) {
          subprocess.stdin.write(options.stdinText)
        }
        subprocess.stdin.end()
      }),
  )

const expectJson = <T>(text: string): T => {
  expect(text.trim().length).toBeGreaterThan(0)
  return JSON.parse(text) as T
}

const withMockServer = <A>(
  handler: (request: RecordedRequest) => {
    readonly status?: number
    readonly body?: unknown
    readonly rawBody?: string
    readonly contentType?: string
  },
  run: (
    baseUrl: string,
    requests: ReadonlyArray<RecordedRequest>,
  ) => Effect.Effect<A>,
) =>
  Effect.callback<A>((resume) => {
    const requests: RecordedRequest[] = []
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => {
        body += chunk
      })
      request.on("end", () => {
        const recorded = {
          method: request.method ?? "GET",
          url: request.url ?? "/",
          headers: request.headers,
          body: body.trim().length > 0 ? JSON.parse(body) : undefined,
        } satisfies RecordedRequest
        requests.push(recorded)

        const result = handler(recorded)
        response.statusCode = result.status ?? 200
        response.setHeader(
          "content-type",
          result.contentType ?? "application/json",
        )
        response.end(result.rawBody ?? JSON.stringify(result.body))
      })
    })

    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        resume(Effect.die("mock server did not bind to a TCP port"))
        return
      }

      run(`http://127.0.0.1:${address.port}`, requests).pipe(
        Effect.ensuring(
          Effect.promise(
            () =>
              new Promise<void>((done) => {
                // Force-close keep-alive sockets so close() cannot hang.
                server.closeAllConnections()
                server.close(() => done())
              }),
          ),
        ),
        Effect.matchEffect({
          onFailure: (error) => Effect.sync(() => resume(Effect.fail(error))),
          onSuccess: (value) => Effect.sync(() => resume(Effect.succeed(value))),
        }),
        Effect.runFork,
      )
    })
  })

describe("parallel provider", () => {
  it.effect("search posts /v1/search and returns a batch summary envelope", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("POST")
        expect(request.url).toBe("/v1/search")
        expect(request.headers["x-api-key"]).toBe("test-key")
        expect(request.headers["parallel-beta"]).toBeUndefined()
        expect(request.body).toEqual({
          objective: "find docs",
          search_queries: ["find docs"],
          mode: "advanced",
          advanced_settings: { max_results: 3 },
        })

        return {
          body: {
            search_id: "search_1",
            session_id: "session_1",
            results: [
              { url: "https://example.com", title: "Example", excerpts: ["A"] },
            ],
          },
        }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            [
              "search",
              '{"objective":"find docs","mode":"agentic","max_results":3}',
            ],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            ok: boolean
            command: string
            data: {
              outcome: string
              results: ReadonlyArray<{
                index: number
                ok: boolean
                data: {
                  search_id: string
                  session_id: string
                  result_count: number
                }
              }>
            }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          expect(result.stderr.trim()).toBe("")
          expect(payload.command).toBe("parallel search")
          expect(payload.data.outcome).toBe("succeeded")
          const item = payload.data.results[0]
          expect(item?.ok).toBe(true)
          expect(item?.data.search_id).toBe("search_1")
          expect(item?.data.session_id).toBe("session_1")
          expect(item?.data.result_count).toBe(1)
        }),
    ),
  )

  it.effect("search accepts @file and stdin input modes", () =>
    withMockServer(
      (request) => ({
        body: {
          search_id:
            request.body &&
            typeof request.body === "object" &&
            "objective" in request.body
              ? `search_${request.body.objective}`
              : "search_unknown",
          session_id: "session_input",
          results: [],
        },
      }),
      (baseUrl, requests) =>
        Effect.gen(function* () {
          const dir = yield* Effect.promise(() =>
            mkdtemp(join(tmpdir(), "survey-parallel-input-")),
          )
          const filePath = join(dir, "search.json")
          yield* Effect.promise(() =>
            writeFile(filePath, '{"objective":"file"}\n', "utf8"),
          )

          const fileResult = yield* runCli(["search", `@${filePath}`], {
            PARALLEL_API_KEY: "test-key",
            PARALLEL_API_BASE_URL: baseUrl,
          })
          const stdinResult = yield* runCli(
            ["search", "-"],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
            { stdinText: '{"objective":"stdin"}' },
          )

          expect(fileResult.exitCode).toBe(0)
          expect(stdinResult.exitCode).toBe(0)
          expect(requests.map((request) => request.body)).toEqual([
            { objective: "file", search_queries: ["file"], mode: "fast" },
            { objective: "stdin", search_queries: ["stdin"], mode: "fast" },
          ])
        }),
    ),
  )

  it.effect("search array input returns ordered batch partial failures", () =>
    withMockServer(
      (request) => ({
        body: {
          search_id: `search_${(request.body as { objective: string }).objective}`,
          session_id: "session_batch",
          results: [],
        },
      }),
      (baseUrl, requests) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            [
              "search",
              "--concurrency",
              "2",
              '[{"objective":"first"},{"bad":true},{"objective":"third"}]',
            ],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            ok: boolean
            data: {
              outcome: string
              total: number
              success_count: number
              error_count: number
              concurrency: number
              results: ReadonlyArray<{ index: number; ok: boolean }>
            }
          }>(result.stdout)

          expect(result.exitCode).toBe(1)
          expect(result.stderr.trim()).toBe("")
          expect(payload.ok).toBe(true)
          expect(payload.data.outcome).toBe("partial_failure")
          expect(payload.data.total).toBe(3)
          expect(payload.data.success_count).toBe(2)
          expect(payload.data.error_count).toBe(1)
          expect(payload.data.concurrency).toBe(2)
          expect(
            payload.data.results.map((item) => [item.index, item.ok]),
          ).toEqual([
            [0, true],
            [1, false],
            [2, true],
          ])
          expect(
            requests.map(
              (request) => (request.body as { objective: string }).objective,
            ),
          ).toEqual(["first", "third"])
        }),
    ),
  )

  it.effect("extract posts v1 payload with advanced_settings", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("POST")
        expect(request.url).toBe("/v1/extract")
        expect(request.headers["parallel-beta"]).toBeUndefined()
        expect(request.body).toEqual({
          urls: ["https://parallel.ai"],
          objective: "Extract product names",
          session_id: "session_extract",
          client_model: "grok-4",
          max_chars_total: 20000,
          advanced_settings: {
            excerpt_settings: { max_chars_per_result: 4000 },
            full_content: true,
          },
        })

        return {
          body: {
            extract_id: "extract_1",
            session_id: "session_extract",
            results: [
              {
                url: "https://parallel.ai",
                title: "Parallel",
                excerpts: ["API"],
                full_content: "# Parallel",
              },
            ],
            errors: [],
          },
        }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            [
              "extract",
              JSON.stringify({
                urls: ["https://parallel.ai"],
                objective: "Extract product names",
                session_id: "session_extract",
                client_model: "grok-4",
                max_chars_total: 20000,
                excerpts: { max_chars_per_result: 4000 },
                full_content: true,
              }),
            ],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            data: {
              results: ReadonlyArray<{
                ok: boolean
                data: {
                  extract_id: string
                  session_id: string
                  result_count: number
                }
              }>
            }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          const item = payload.data.results[0]
          expect(item?.ok).toBe(true)
          expect(item?.data.extract_id).toBe("extract_1")
          expect(item?.data.session_id).toBe("session_extract")
          expect(item?.data.result_count).toBe(1)
        }),
    ),
  )

  it.effect(
    "extract rejects excerpts false because v1 always returns excerpts",
    () =>
      Effect.gen(function* () {
        const result = yield* runCli(
          ["extract", '{"urls":["https://example.com"],"excerpts":false}'],
          { PARALLEL_API_KEY: "test-key", PARALLEL_API_BASE_URL: "http://127.0.0.1:9" },
        )
        const payload = expectJson<{
          ok: boolean
          data: {
            outcome: string
            results: ReadonlyArray<{
              ok: boolean
              error: { type: string; details: { field?: string } }
            }>
          }
        }>(result.stdout)

        expect(result.exitCode).toBe(1)
        expect(payload.data.outcome).toBe("failed")
        const item = payload.data.results[0]
        expect(item?.ok).toBe(false)
        expect(item?.error.type).toBe("CommandInputError")
        expect(item?.error.details.field).toBe("excerpts")
      }),
  )

  it.effect("findall entity-search posts the beta entity-search path", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("POST")
        expect(request.url).toBe("/v1beta/findall/entity-search")
        expect(request.headers["parallel-beta"]).toBeUndefined()
        expect(request.body).toEqual({
          entity_type: "companies",
          objective: "AI startups in San Francisco",
          match_limit: 25,
        })

        return {
          body: {
            entity_set_id: "entity_set_1",
            entities: [
              {
                name: "Figure AI",
                url: "https://www.figure.ai",
                description: "Humanoid robots",
              },
            ],
          },
        }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            [
              "findall",
              "entity-search",
              '{"entity_type":"companies","objective":"AI startups in San Francisco","match_limit":25}',
            ],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            command: string
            data: {
              results: ReadonlyArray<{
                ok: boolean
                data: { entity_set_id: string; entity_count: number }
              }>
            }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          expect(payload.command).toBe("parallel findall entity-search")
          const item = payload.data.results[0]
          expect(item?.data.entity_set_id).toBe("entity_set_1")
          expect(item?.data.entity_count).toBe(1)
        }),
    ),
  )

  it.effect("findall entity-search rejects match_limit below 5", () =>
    Effect.gen(function* () {
      const result = yield* runCli(
        [
          "findall",
          "entity-search",
          '{"entity_type":"people","objective":"AI researchers","match_limit":2}',
        ],
        { PARALLEL_API_KEY: "test-key", PARALLEL_API_BASE_URL: "http://127.0.0.1:9" },
      )
      const payload = expectJson<{
        data: {
          outcome: string
          results: ReadonlyArray<{
            ok: boolean
            error: { type: string; details: { field?: string } }
          }>
        }
      }>(result.stdout)

      expect(result.exitCode).toBe(1)
      expect(payload.data.outcome).toBe("failed")
      const item = payload.data.results[0]
      expect(item?.error.type).toBe("CommandInputError")
      expect(item?.error.details.field).toBe("match_limit")
    }),
  )

  it.effect(
    "findall start ingests, creates a run, then applies enrichments",
    () =>
      withMockServer(
        (request) => {
          if (request.url === "/v1beta/findall/ingest") {
            expect(request.body).toEqual({
              objective: "Find AI companies that raised Series A in 2024",
            })
            expect(request.headers["parallel-beta"]).toBeUndefined()
            return {
              body: {
                objective: "Find AI companies that raised Series A in 2024",
                entity_type: "companies",
                match_conditions: [
                  { name: "series_a_2024", description: "Raised Series A in 2024" },
                ],
                enrichments: [
                  {
                    processor: "core",
                    output_schema: {
                      json_schema: {
                        type: "object",
                        properties: { ceo_name: { type: "string" } },
                      },
                    },
                  },
                ],
                generator: "core",
              },
            }
          }

          if (request.url === "/v1beta/findall/runs") {
            expect(request.body).toEqual({
              objective: "Find AI companies that raised Series A in 2024",
              entity_type: "companies",
              match_conditions: [
                { name: "series_a_2024", description: "Raised Series A in 2024" },
              ],
              generator: "core",
              match_limit: 10,
            })
            expect(
              (request.body as { enrichments?: unknown }).enrichments,
            ).toBeUndefined()
            return { body: { findall_id: "fa_start" } }
          }

          expect(request.method).toBe("POST")
          expect(request.url).toBe("/v1beta/findall/runs/fa_start/enrich")
          expect(request.body).toEqual({
            processor: "core",
            output_schema: {
              type: "json",
              json_schema: {
                type: "object",
                properties: { ceo_name: { type: "string" } },
              },
            },
          })
          return {
            body: {
              objective: "Find AI companies that raised Series A in 2024",
              entity_type: "companies",
              match_conditions: [
                { name: "series_a_2024", description: "Raised Series A in 2024" },
              ],
              generator: "core",
              match_limit: 10,
            },
          }
        },
        (baseUrl, requests) =>
          Effect.gen(function* () {
            const result = yield* runCli(
              [
                "findall",
                "start",
                '{"objective":"Find AI companies that raised Series A in 2024"}',
              ],
              {
                PARALLEL_API_KEY: "test-key",
                PARALLEL_API_BASE_URL: baseUrl,
              },
            )
            const payload = expectJson<{
              data: {
                results: ReadonlyArray<{
                  ok: boolean
                  data: {
                    findall_id: string
                    entity_type: string
                    generator: string
                  }
                }>
              }
            }>(result.stdout)

            expect(result.exitCode).toBe(0)
            const item = payload.data.results[0]
            expect(item?.data.findall_id).toBe("fa_start")
            expect(item?.data.entity_type).toBe("companies")
            expect(item?.data.generator).toBe("core")
            expect(
              requests.map((request) => `${request.method} ${request.url}`),
            ).toEqual([
              "POST /v1beta/findall/ingest",
              "POST /v1beta/findall/runs",
              "POST /v1beta/findall/runs/fa_start/enrich",
            ])
          }),
      ),
  )

  it.effect("findall start rejects string exclude_list values", () =>
    Effect.gen(function* () {
      const result = yield* runCli(
        [
          "findall",
          "start",
          '{"objective":"Find AI companies","exclude_list":["Example Corp"]}',
        ],
        { PARALLEL_API_KEY: "test-key", PARALLEL_API_BASE_URL: "http://127.0.0.1:9" },
      )
      const payload = expectJson<{
        data: {
          results: ReadonlyArray<{
            ok: boolean
            error: { type: string; details: { field?: string } }
          }>
        }
      }>(result.stdout)

      expect(result.exitCode).toBe(1)
      const item = payload.data.results[0]
      expect(item?.ok).toBe(false)
      expect(item?.error.type).toBe("CommandInputError")
      expect(item?.error.details.field).toBe("items[0]")
    }),
  )

  it.effect("monitors create posts the v1 event_stream payload", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("POST")
        expect(request.url).toBe("/v1/monitors")
        expect(request.body).toEqual({
          type: "event_stream",
          frequency: "1d",
          processor: "lite",
          settings: { query: "Notable news about Parallel Web Systems" },
        })

        return {
          body: {
            type: "event_stream",
            monitor_id: "mon_created",
            status: "active",
            frequency: "1d",
            processor: "lite",
            created_at: "2026-04-24T00:00:00.000Z",
            settings: { query: "Notable news about Parallel Web Systems" },
          },
        }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            [
              "monitors",
              "create",
              '{"query":"Notable news about Parallel Web Systems","cadence":"daily"}',
            ],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            data: {
              results: ReadonlyArray<{
                ok: boolean
                data: { monitor_id: string; type?: string; query?: string }
              }>
            }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          const item = payload.data.results[0]
          expect(item?.data.monitor_id).toBe("mon_created")
          expect(item?.data.type).toBe("event_stream")
          expect(item?.data.query).toBe(
            "Notable news about Parallel Web Systems",
          )
        }),
    ),
  )

  it.effect("monitors events rejects lookback_period removed in v1", () =>
    Effect.gen(function* () {
      const result = yield* runCli(
        [
          "monitors",
          "events",
          '{"monitor_id":"mon_1","lookback_period":"7d"}',
        ],
        { PARALLEL_API_KEY: "test-key", PARALLEL_API_BASE_URL: "http://127.0.0.1:9" },
      )
      const payload = expectJson<{
        error: { type: string; details: { field?: string } }
      }>(result.stderr)

      expect(result.exitCode).toBe(1)
      expect(payload.error.type).toBe("CommandInputError")
      expect(payload.error.details.field).toBe("lookback_period")
    }),
  )

  it.effect("monitors trigger posts the v1 trigger endpoint", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("POST")
        expect(request.url).toBe("/v1/monitors/mon_1/trigger")
        return { status: 204, rawBody: "" }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            ["monitors", "trigger", '{"monitor_id":"mon_1"}'],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            data: { monitor_id: string; triggered: boolean }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          expect(payload.data.monitor_id).toBe("mon_1")
          expect(payload.data.triggered).toBe(true)
        }),
    ),
  )

  it.effect("artifact output writes compact summary and JSON artifact", () =>
    withMockServer(
      () => ({
        body: {
          search_id: "search_artifact",
          session_id: "session_artifact",
          results: [
            {
              url: "https://example.com",
              title: "Example",
              excerpts: ["A".repeat(128)],
            },
          ],
        },
      }),
      (baseUrl) =>
        Effect.gen(function* () {
          const dir = yield* Effect.promise(() =>
            mkdtemp(join(tmpdir(), "survey-parallel-artifacts-")),
          )
          const result = yield* runCli(
            ["search", "--output", "artifact", '{"objective":"artifact"}'],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
              SURVEY_ARTIFACT_DIR: dir,
            },
          )
          const payload = expectJson<{
            data: {
              kind: string
              artifact: { absolute_path: string; size_bytes: number }
            }
          }>(result.stdout)
          const artifactText = yield* Effect.promise(() =>
            readFile(payload.data.artifact.absolute_path, "utf8"),
          )

          expect(result.exitCode).toBe(0)
          expect(payload.data.kind).toBe("summary+artifact")
          expect(payload.data.artifact.size_bytes).toBeGreaterThan(0)
          const artifact = JSON.parse(artifactText)
          expect(artifact.results[0].data.search_id).toBe("search_artifact")
        }),
    ),
  )

  it.effect(
    "deep-research check reports in-progress tasks as structured data",
    () =>
      withMockServer(
        (request) => {
          expect(request.method).toBe("GET")
          expect(request.url).toBe("/v1/tasks/runs/run_1")
          return {
            body: {
              run_id: "run_1",
              status: "running",
              is_active: true,
              processor: "base",
              created_at: "2026-04-24T00:00:00.000Z",
              modified_at: "2026-04-24T00:00:01.000Z",
            },
          }
        },
        (baseUrl) =>
          Effect.gen(function* () {
            const result = yield* runCli(
              ["deep-research", "check", '{"run_id":"run_1"}'],
              {
                PARALLEL_API_KEY: "test-key",
                PARALLEL_API_BASE_URL: baseUrl,
              },
            )
            const payload = expectJson<{
              ok: boolean
              command: string
              data: { completed: boolean; status: string; next_action: string }
            }>(result.stdout)

            expect(result.exitCode).toBe(0)
            expect(payload.command).toBe("parallel deep-research check")
            expect(payload.data.completed).toBe(false)
            expect(payload.data.status).toBe("running")
            expect(payload.data.next_action).toBe("parallel deep-research check")
          }),
      ),
  )

  it.effect("deep-research events parses provider SSE frames", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("GET")
        expect(request.url).toBe("/v1/tasks/runs/run_1/events")
        expect(request.headers["parallel-beta"]).toBe(
          "events-sse-2025-07-24",
        )
        return {
          contentType: "text/event-stream",
          rawBody:
            'event: message\ndata: {"type":"task_run.progress_msg.plan","message":"Planning","timestamp":"2026-04-24T00:00:00.000Z"}\n\n',
        }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            ["deep-research", "events", '{"run_id":"run_1"}'],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            data: {
              run_id: string
              event_count: number
              events: ReadonlyArray<{ type: string }>
            }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          expect(payload.data.run_id).toBe("run_1")
          expect(payload.data.event_count).toBe(1)
          expect(payload.data.events[0]?.type).toBe(
            "task_run.progress_msg.plan",
          )
        }),
    ),
  )

  it.effect("deep-research start replays local idempotency receipts", () =>
    withMockServer(
      () => ({
        body: {
          run_id: "run_idem",
          status: "queued",
          is_active: true,
          processor: "base",
          interaction_id: "int_1",
          created_at: "2026-04-24T00:00:00.000Z",
          modified_at: "2026-04-24T00:00:01.000Z",
        },
      }),
      (baseUrl, requests) =>
        Effect.gen(function* () {
          const home = yield* Effect.promise(() =>
            mkdtemp(join(tmpdir(), "survey-parallel-idem-")),
          )
          const env = {
            PARALLEL_API_KEY: "test-key",
            PARALLEL_API_BASE_URL: baseUrl,
            SURVEY_HOME: home,
          }
          const args = [
            "deep-research",
            "start",
            "--idempotency-key",
            "idem-1",
            '{"input":"research"}',
          ]
          const first = yield* runCli(args, env)
          const second = yield* runCli(args, env)

          expect(first.exitCode).toBe(0)
          expect(second.exitCode).toBe(0)
          expect(requests.length).toBe(1)

          const firstPayload = expectJson<{
            data: {
              results: ReadonlyArray<{
                data: { idempotency: { status: string; scope: string } }
              }>
            }
          }>(first.stdout)
          const secondPayload = expectJson<{
            data: {
              results: ReadonlyArray<{
                data: { idempotency: { status: string; scope: string } }
              }>
            }
          }>(second.stdout)

          expect(
            firstPayload.data.results[0]?.data.idempotency.status,
          ).toBe("stored")
          expect(
            firstPayload.data.results[0]?.data.idempotency.scope,
          ).toBe("local_success_receipt")
          expect(
            secondPayload.data.results[0]?.data.idempotency.status,
          ).toBe("replayed")

          const receiptEntries = yield* Effect.promise(() =>
            readdir(join(home, "idempotency")),
          )
          expect(receiptEntries.length).toBe(1)
          expect(receiptEntries[0]?.endsWith(".json")).toBe(true)
        }),
    ),
  )

  it.effect("findall check fetches result after completed status", () =>
    withMockServer(
      (request) => {
        if (request.url === "/v1beta/findall/runs/fa_1") {
          return {
            body: {
              findall_id: "fa_1",
              status: {
                status: "completed",
                is_active: false,
                metrics: {
                  generated_candidates_count: 2,
                  matched_candidates_count: 1,
                },
              },
              generator: "core",
              created_at: "2026-04-24T00:00:00.000Z",
              modified_at: "2026-04-24T00:00:01.000Z",
            },
          }
        }

        expect(request.url).toBe("/v1beta/findall/runs/fa_1/result")
        return {
          body: {
            findall_id: "fa_1",
            status: {
              status: "completed",
              is_active: false,
              metrics: {
                generated_candidates_count: 2,
                matched_candidates_count: 1,
              },
            },
            candidates: [
              {
                candidate_id: "cand_1",
                name: "Acme",
                url: "https://acme.example",
                description: "Example company",
                match_status: "matched",
                output: {
                  market: { value: "AI", type: "match_condition", is_matched: true },
                },
                basis: [],
              },
            ],
          },
        }
      },
      (baseUrl, requests) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            ["findall", "check", '{"findall_id":"fa_1"}'],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            ok: boolean
            data: {
              completed: boolean
              total_matched: number
              candidates: unknown[]
            }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          expect(payload.data.completed).toBe(true)
          expect(payload.data.total_matched).toBe(1)
          expect(payload.data.candidates.length).toBe(1)
          expect(requests.map((request) => request.url)).toEqual([
            "/v1beta/findall/runs/fa_1",
            "/v1beta/findall/runs/fa_1/result",
          ])
        }),
    ),
  )

  it.effect("findall cancel calls the provider cancel endpoint", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("POST")
        expect(request.url).toBe("/v1beta/findall/runs/fa_1/cancel")
        expect(request.headers["parallel-beta"]).toBeUndefined()
        return { rawBody: "" }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            ["findall", "cancel", '{"findall_id":"fa_1"}'],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            data: { findall_id: string; cancelled: boolean }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          expect(payload.data.findall_id).toBe("fa_1")
          expect(payload.data.cancelled).toBe(true)
        }),
    ),
  )

  it.effect("monitors cancel posts the v1 cancel endpoint", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("POST")
        expect(request.url).toBe("/v1/monitors/mon_1/cancel")
        return {
          body: {
            monitor_id: "mon_1",
            type: "event_stream",
            status: "cancelled",
            frequency: "1d",
            processor: "lite",
            created_at: "2026-04-24T00:00:00.000Z",
            settings: { query: "news" },
          },
        }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(
            ["monitors", "cancel", '{"monitor_id":"mon_1"}'],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
            },
          )
          const payload = expectJson<{
            data: { monitor_id: string; cancelled: boolean }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          expect(payload.data.monitor_id).toBe("mon_1")
          expect(payload.data.cancelled).toBe(true)
        }),
    ),
  )

  it.effect(
    "deep-research run polls a queued run and returns the completed result",
    () =>
      withMockServer(
        (request) => {
          if (request.method === "POST" && request.url === "/v1/tasks/runs") {
            expect(request.body).toEqual({
              input: "research",
              processor: "base",
              task_spec: { output_schema: { type: "auto" } },
            })
            return {
              body: {
                run_id: "run_wait",
                status: "queued",
                is_active: true,
                processor: "base",
                created_at: "2026-04-24T00:00:00.000Z",
              },
            }
          }

          if (request.url === "/v1/tasks/runs/run_wait") {
            return {
              body: {
                run_id: "run_wait",
                status: "completed",
                is_active: false,
                processor: "base",
                created_at: "2026-04-24T00:00:00.000Z",
                modified_at: "2026-04-24T00:00:01.000Z",
              },
            }
          }

          expect(request.url).toBe("/v1/tasks/runs/run_wait/result")
          return {
            body: {
              run: {
                run_id: "run_wait",
                status: "completed",
                is_active: false,
                processor: "base",
              },
              output: {
                content: { answer: "done" },
                type: "json",
              },
            },
          }
        },
        (baseUrl, requests) =>
          Effect.gen(function* () {
            const result = yield* runCli(
              [
                "deep-research",
                "run",
                '{"input":"research","max_wait_seconds":5,"poll_interval_seconds":1}',
              ],
              {
                PARALLEL_API_KEY: "test-key",
                PARALLEL_API_BASE_URL: baseUrl,
              },
            )
            const payload = expectJson<{
              data: {
                completed: boolean
                run_id: string
                status: string
                output: unknown
              }
            }>(result.stdout)

            expect(result.exitCode).toBe(0)
            expect(payload.data.completed).toBe(true)
            expect(payload.data.run_id).toBe("run_wait")
            expect(payload.data.status).toBe("completed")
            expect(payload.data.output).toEqual({ answer: "done" })
            expect(
              requests.map((request) => `${request.method} ${request.url}`),
            ).toEqual([
              "POST /v1/tasks/runs",
              "GET /v1/tasks/runs/run_wait",
              "GET /v1/tasks/runs/run_wait/result",
            ])
          }),
      ),
  )

  it.effect("monitors events supports artifact output", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("GET")
        expect(request.url).toBe("/v1/monitors/mon_1/events?limit=20")
        return {
          body: {
            events: [
              { event_type: "completion", timestamp: "2026-04-24T00:00:00Z" },
            ],
          },
        }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const dir = yield* Effect.promise(() =>
            mkdtemp(join(tmpdir(), "survey-parallel-monitor-artifacts-")),
          )
          const result = yield* runCli(
            [
              "monitors",
              "events",
              "--output",
              "artifact",
              '{"monitor_id":"mon_1","limit":20}',
            ],
            {
              PARALLEL_API_KEY: "test-key",
              PARALLEL_API_BASE_URL: baseUrl,
              SURVEY_ARTIFACT_DIR: dir,
            },
          )
          const payload = expectJson<{
            data: { kind: string; artifact: { absolute_path: string } }
          }>(result.stdout)
          const artifact = JSON.parse(
            yield* Effect.promise(() =>
              readFile(payload.data.artifact.absolute_path, "utf8"),
            ),
          )

          expect(result.exitCode).toBe(0)
          expect(payload.data.kind).toBe("summary+artifact")
          expect(artifact.monitor_id).toBe("mon_1")
          expect(artifact.event_count).toBe(1)
        }),
    ),
  )

  it.effect("monitors list accepts provider array responses", () =>
    withMockServer(
      (request) => {
        expect(request.method).toBe("GET")
        expect(request.url).toBe("/v1/monitors")
        return {
          body: {
            monitors: [
              {
                type: "event_stream",
                monitor_id: "mon_1",
                status: "active",
                frequency: "1d",
                processor: "lite",
                created_at: "2026-04-24T00:00:00.000Z",
                settings: { query: "news" },
              },
            ],
          },
        }
      },
      (baseUrl) =>
        Effect.gen(function* () {
          const result = yield* runCli(["monitors", "list"], {
            PARALLEL_API_KEY: "test-key",
            PARALLEL_API_BASE_URL: baseUrl,
          })
          const payload = expectJson<{
            data: {
              monitor_count: number
              monitors: ReadonlyArray<{ monitor_id: string }>
            }
          }>(result.stdout)

          expect(result.exitCode).toBe(0)
          expect(payload.data.monitor_count).toBe(1)
          expect(payload.data.monitors[0]?.monitor_id).toBe("mon_1")
        }),
    ),
  )

  it.effect(
    "provider API errors include recovery metadata and redact secrets",
    () =>
      withMockServer(
        () => ({
          status: 429,
          body: {
            error: {
              message: "rate limited",
              api_key: "secret-key",
            },
          },
        }),
        (baseUrl) =>
          Effect.gen(function* () {
            const result = yield* runCli(
              ["search", '{"objective":"docs"}'],
              {
                PARALLEL_API_KEY: "test-key",
                PARALLEL_API_BASE_URL: baseUrl,
              },
            )
            const payload = expectJson<{
              data: {
                outcome: string
                results: ReadonlyArray<{
                  ok: boolean
                  error: {
                    type: string
                    details: {
                      retryable: boolean
                      provider: string
                      method: string
                      path: string
                      status: number
                      body: { error: { api_key: string } }
                    }
                  }
                }>
              }
            }>(result.stdout)

            expect(result.exitCode).toBe(1)
            expect(payload.data.outcome).toBe("failed")
            const item = payload.data.results[0]
            expect(item?.error.type).toBe("ApiResponseError")
            expect(item?.error.details.retryable).toBe(true)
            expect(item?.error.details.provider).toBe("parallel")
            expect(item?.error.details.method).toBe("POST")
            expect(item?.error.details.path).toBe("/v1/search")
            expect(item?.error.details.status).toBe(429)
            expect(item?.error.details.body.error.api_key).toBe(
              "[redacted]",
            )
          }),
      ),
  )

  it.effect("returns structured error for missing API key", () =>
    Effect.gen(function* () {
      const result = yield* runCli(
        ["extract", '{"urls":["https://example.com"]}'],
        { PARALLEL_API_KEY: undefined },
      )

      const payload = expectJson<{
        ok: boolean
        command: string
        data: {
          outcome: string
          results: ReadonlyArray<{
            ok: boolean
            error: { type: string; details: { env_var: string } }
          }>
        }
      }>(result.stdout)

      expect(result.exitCode).toBe(1)
      expect(payload.ok).toBe(true)
      expect(payload.command).toBe("parallel extract")
      expect(payload.data.outcome).toBe("failed")
      const item = payload.data.results[0]
      expect(item?.error.type).toBe("MissingApiKeyError")
      expect(item?.error.details.env_var).toBe("PARALLEL_API_KEY")
    }),
  )
})
