import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

// survey-cli targets Bun, but vitest runs under Node: shim the Bun.env reads in
// core/registry.ts + core/paths.ts and stub the bun:sqlite-backed Store service.
const globalScope = globalThis as Record<string, unknown>
if (globalScope.Bun === undefined) {
  globalScope.Bun = { env: process.env }
}

vi.mock("../src/core/store", async () => {
  const { Context, Effect } = await import("effect")

  interface RunRecord {
    readonly id: string
    readonly provider: string
    readonly kind: string
    readonly remote_id: string | null
    readonly status: string
    readonly payload: string | null
    readonly result_ref: string | null
    readonly created_at: string
    readonly updated_at: string
  }

  interface SourceRecord {
    readonly id: number
    readonly run_id: string | null
    readonly provider: string
    readonly url: string
    readonly canonical_url: string
    readonly title: string | null
    readonly snippet: string | null
    readonly content_hash: string | null
    readonly fetched_at: string
  }

  class Store extends Context.Service<Store, {
    readonly upsertRun: (run: {
      readonly id: string
      readonly provider: string
      readonly kind: string
      readonly remoteId?: string | undefined
      readonly status: string
      readonly payload?: unknown
      readonly resultRef?: string | undefined
    }) => Effect.Effect<RunRecord, never>
    readonly getRun: (id: string) => Effect.Effect<RunRecord | undefined, never>
    readonly findRunByRemote: (
      provider: string,
      remoteId: string,
    ) => Effect.Effect<RunRecord | undefined, never>
    readonly listRuns: (options?: {
      readonly provider?: string | undefined
      readonly status?: string | undefined
      readonly limit?: number | undefined
    }) => Effect.Effect<ReadonlyArray<RunRecord>, never>
    readonly updateRun: (
      id: string,
      patch: {
        readonly status?: string | undefined
        readonly remoteId?: string | undefined
        readonly resultRef?: string | undefined
      },
    ) => Effect.Effect<void, never>
    readonly insertSources: (
      sources: ReadonlyArray<{
        readonly runId?: string | undefined
        readonly provider: string
        readonly url: string
        readonly title?: string | undefined
        readonly snippet?: string | undefined
        readonly contentHash?: string | undefined
      }>,
    ) => Effect.Effect<number, never>
    readonly sourcesForRun: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<SourceRecord>, never>
    readonly listSources: (options?: {
      readonly provider?: string | undefined
      readonly canonicalUrl?: string | undefined
      readonly limit?: number | undefined
    }) => Effect.Effect<ReadonlyArray<SourceRecord>, never>
    readonly citationOverlap: (
      urls: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<{ canonical_url: string; providers: string }>, never>
  }>()("survey/Store") {}

  return {
    Store,
    canonicalizeUrl: (url: string) => url,
    RunStatus: ["queued", "running", "succeeded", "failed", "canceled", "unsupported"] as const,
  }
})

import { exaApi } from "../src/providers/exa"
import { Store, type RunRecord } from "../src/core/store"

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingMessage["headers"]
  readonly body: unknown
}

interface TestServer {
  readonly baseUrl: string
  readonly requests: ReadonlyArray<RecordedRequest>
  readonly close: Effect.Effect<void>
}

const readRequestBody = (request: IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    let text = ""
    request.on("data", (chunk) => {
      text += chunk
    })
    request.on("end", () => {
      if (text.trim().length === 0) {
        resolve(undefined)
        return
      }

      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })

const writeJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const withTestServer = <A, E, R>(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    record: (body: unknown) => void,
  ) => Promise<void>,
  use: (server: TestServer) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.callback<TestServer>((resume) => {
      const requests: RecordedRequest[] = []
      const server = createServer((request, response) => {
        const record = (body: unknown) => {
          requests.push({
            method: request.method ?? "",
            path: request.url ?? "",
            headers: request.headers,
            body,
          })
        }

        handler(request, response, record).catch((error: unknown) => {
          response.writeHead(500, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        })
      })

      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") {
          resume(Effect.die(new Error("failed to bind test server")))
          return
        }

        resume(
          Effect.succeed({
            baseUrl: `http://127.0.0.1:${address.port}`,
            requests,
            close: Effect.promise(
              () => new Promise<void>((resolve) => server.close(() => resolve())),
            ),
          }),
        )
      })
    }),
    use,
    (server) => server.close,
  )

interface StubSource {
  readonly runId?: string | undefined
  readonly provider: string
  readonly url: string
  readonly title?: string | undefined
  readonly snippet?: string | undefined
  readonly contentHash?: string | undefined
}

const makeStore = () => {
  const runs: Array<RunRecord> = []
  const sources: Array<StubSource> = []
  let counter = 0

  const service = Store.of({
    upsertRun: (input) =>
      Effect.sync(() => {
        const ts = new Date().toISOString()
        const record: RunRecord = {
          id: input.id || `run_${++counter}`,
          provider: input.provider,
          kind: input.kind,
          remote_id: input.remoteId ?? null,
          status: input.status,
          payload: input.payload === undefined ? null : JSON.stringify(input.payload),
          result_ref: input.resultRef ?? null,
          created_at: ts,
          updated_at: ts,
        }
        const existing = runs.findIndex((run) => run.id === record.id)
        if (existing >= 0) {
          runs[existing] = record
        } else {
          runs.push(record)
        }
        return record
      }),
    getRun: (id) => Effect.succeed(runs.find((run) => run.id === id)),
    findRunByRemote: (provider, remoteId) =>
      Effect.succeed(
        [...runs].reverse().find((run) => run.provider === provider && run.remote_id === remoteId),
      ),
    listRuns: (options) =>
      Effect.succeed(
        runs
          .filter(
            (run) =>
              (options?.provider === undefined || run.provider === options.provider) &&
              (options?.status === undefined || run.status === options.status),
          )
          .slice(0, options?.limit ?? 100),
      ),
    updateRun: (id, patch) =>
      Effect.sync(() => {
        const run = runs.find((entry) => entry.id === id)
        if (!run) {
          return
        }
        const next = {
          ...run,
          status: patch.status ?? run.status,
          remote_id: patch.remoteId ?? run.remote_id,
          result_ref: patch.resultRef ?? run.result_ref,
          updated_at: new Date().toISOString(),
        }
        runs[runs.indexOf(run)] = next
      }),
    insertSources: (items) =>
      Effect.sync(() => {
        sources.push(...items)
        return items.length
      }),
    sourcesForRun: (runId) =>
      Effect.succeed(
        sources
          .filter((source) => source.runId === runId)
          .map((source, index) => ({
            id: index + 1,
            run_id: source.runId ?? null,
            provider: source.provider,
            url: source.url,
            canonical_url: source.url,
            title: source.title ?? null,
            snippet: source.snippet ?? null,
            content_hash: source.contentHash ?? null,
            fetched_at: new Date().toISOString(),
          })),
      ),
    listSources: () =>
      Effect.succeed(
        sources.map((source, index) => ({
          id: index + 1,
          run_id: source.runId ?? null,
          provider: source.provider,
          url: source.url,
          canonical_url: source.url,
          title: source.title ?? null,
          snippet: source.snippet ?? null,
          content_hash: source.contentHash ?? null,
          fetched_at: new Date().toISOString(),
        })),
      ),
    citationOverlap: () => Effect.succeed([]),
  })

  return { service, runs, sources }
}

const testLayer = (store: ReturnType<typeof makeStore>) =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(Store, store.service),
    Path.layer,
    FileSystem.layerNoop({ makeDirectory: () => Effect.void }),
  )

const withEnv =
  (env: Record<string, string | undefined>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous: Record<string, string | undefined> = {}
        for (const key of Object.keys(env)) {
          previous[key] = process.env[key]
          const value = env[key]
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
        return previous
      }),
      () => effect,
      (previous) =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) {
              delete process.env[key]
            } else {
              process.env[key] = value
            }
          }
        }),
    )

type ExaRequirements =
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | Store

const runExa = <A, E>(
  env: Record<string, string | undefined>,
  effect: Effect.Effect<A, E, ExaRequirements>,
  store: ReturnType<typeof makeStore>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(testLayer(store)), withEnv(env))

describe("exa provider", () => {
  it.effect("web-search posts to /search and records sources", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, {
            requestId: "req_1",
            resolvedSearchType: "instant",
            context: "search context",
            results: [{ id: "1", title: "Result", url: "https://example.com" }],
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const result = yield* exaApi.webSearch({
                query: "Effect Schema",
                includeText: "Effect",
                contextMaxCharacters: 4000,
              })

              expect("context" in result ? result.context : undefined).toBe("search context")
              expect("data" in result ? result.data : undefined).toMatchObject({
                requestId: "req_1",
              })
              expect(server.requests).toHaveLength(1)
              expect(server.requests[0]?.method).toBe("POST")
              expect(server.requests[0]?.path).toBe("/search")
              expect(server.requests[0]?.headers["x-api-key"]).toBe("test-key")
              expect(server.requests[0]?.headers["x-exa-integration"]).toBe("exa-cli-web-search")
              expect(server.requests[0]?.body).toMatchObject({
                query: "Effect Schema",
                type: "auto",
                numResults: 8,
                includeText: ["Effect"],
                contents: {
                  text: true,
                  context: { maxCharacters: 4000 },
                },
              })
              expect(
                (server.requests[0]?.body as { contents?: { livecrawl?: string } } | undefined)
                  ?.contents?.livecrawl,
              ).toBeUndefined()

              expect(store.sources).toHaveLength(1)
              expect(store.sources[0]).toMatchObject({
                provider: "exa",
                url: "https://example.com",
                title: "Result",
              })
            }),
            store,
          ),
      )
    }),
  )

  it.effect("web-search rejects neural, category conflicts, phrase filters, and stream without outputSchema", () =>
    Effect.gen(function* () {
      const store = makeStore()
      const env = { EXA_API_KEY: "test-key" }

      const neural = yield* Effect.result(
        exaApi.webSearch({ query: "Effect", type: "neural" }),
      ).pipe(Effect.provide(testLayer(store)), withEnv(env))
      const entityText = yield* Effect.result(
        exaApi.webSearch({ query: "Acme", category: "company", includeText: "GmbH" }),
      ).pipe(Effect.provide(testLayer(store)), withEnv(env))
      const phrase = yield* Effect.result(
        exaApi.webSearch({ query: "Effect", includeText: ["one", "two"] }),
      ).pipe(Effect.provide(testLayer(store)), withEnv(env))
      const financial = yield* Effect.result(
        exaApi.webSearch({ query: "10-K", category: "financial report", excludeText: "draft" }),
      ).pipe(Effect.provide(testLayer(store)), withEnv(env))
      const additional = yield* Effect.result(
        exaApi.webSearch({ query: "Exa API", additionalQueries: ["other"] }),
      ).pipe(Effect.provide(testLayer(store)), withEnv(env))
      const stream = yield* Effect.result(
        exaApi.webSearch({ query: "Exa API", stream: true }),
      ).pipe(Effect.provide(testLayer(store)), withEnv(env))

      const failureField = (outcome: { _tag: string; failure?: unknown }) =>
        outcome._tag === "Failure" && outcome.failure && typeof outcome.failure === "object" &&
          "field" in outcome.failure
          ? (outcome.failure as { field: string }).field
          : undefined

      expect(neural._tag).toBe("Failure")
      expect(failureField(neural)).toBe("type")
      expect(entityText._tag).toBe("Failure")
      expect(failureField(entityText)).toBe("category")
      expect(phrase._tag).toBe("Failure")
      expect(failureField(phrase)).toBe("includeText")
      expect(financial._tag).toBe("Failure")
      expect(failureField(financial)).toBe("excludeText")
      expect(additional._tag).toBe("Failure")
      expect(failureField(additional)).toBe("additionalQueries")
      expect(stream._tag).toBe("Failure")
      expect(failureField(stream)).toBe("stream")
    }),
  )

  it.effect("web-search sends deep-reasoning outputSchema and dynamic highlights beta header", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, {
            results: [],
            output: { content: { summary: "ok" }, grounding: [] },
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              yield* exaApi.webSearch({
                query: "Exa API",
                type: "deep-reasoning",
                outputSchema: { type: "object", properties: { summary: { type: "string" } } },
                contents: { highlights: { dynamic: true }, maxAgeHours: 24 },
              })

              expect(server.requests[0]?.body).toMatchObject({
                query: "Exa API",
                type: "deep-reasoning",
                outputSchema: { type: "object" },
                contents: { highlights: { dynamic: true }, maxAgeHours: 24 },
              })
              expect(server.requests[0]?.headers["exa-beta"]).toBe(
                "dynamic-highlights-2026-08-28",
              )
            }),
            store,
          ),
      )
    }),
  )

  it.effect("web-search collects provider SSE when stream is set with outputSchema", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.end(
            'event: update\ndata: {"status":"running"}\n\nevent: done\ndata: {"status":"completed"}\n\n',
          )
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const result = yield* exaApi.webSearch({
                query: "stream me",
                stream: true,
                outputSchema: { type: "object" },
              })

              expect("event_count" in result ? result.event_count : -1).toBe(2)
              expect(server.requests[0]?.headers.accept).toBe("text/event-stream")
              expect(server.requests[0]?.body).toMatchObject({
                query: "stream me",
                stream: true,
              })
            }),
            store,
          ),
      )
    }),
  )

  it.effect("code-context validates token bounds and posts to /context", () =>
    Effect.gen(function* () {
      const store = makeStore()
      const invalid = yield* Effect.result(
        exaApi.codeContext({ query: "React useState", tokensNum: 49 }),
      ).pipe(
        Effect.provide(testLayer(store)),
        withEnv({ EXA_API_KEY: "test-key" }),
      )
      expect(invalid._tag).toBe("Failure")
      if (invalid._tag === "Failure") {
        expect(invalid.failure).toMatchObject({ _tag: "CommandInputError", field: "tokensNum" })
      }

      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, { response: "code context", results: [] })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const result = yield* exaApi.codeContext({ query: "React useState" })
              expect(result.context).toBe("code context")
              expect(server.requests[0]?.path).toBe("/context")
              expect(server.requests[0]?.headers["x-exa-integration"]).toBe(
                "exa-cli-code-context",
              )
              expect(server.requests[0]?.body).toMatchObject({
                query: "React useState",
                tokensNum: 5000,
              })
            }),
            store,
          ),
      )
    }),
  )

  it.effect("contents sends top-level options, dynamic highlights beta, and rejects mixed identifiers", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, {
            results: [{ id: "https://example.com", url: "https://example.com", text: "page" }],
            statuses: [{ id: "https://example.com", status: "success", source: "cached" }],
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              yield* exaApi.contents({
                ids: ["https://example.com"],
                highlights: { query: "API", dynamic: true },
                summary: { query: "overview" },
              })

              expect(server.requests[0]?.path).toBe("/contents")
              expect(server.requests[0]?.headers["exa-beta"]).toBe(
                "dynamic-highlights-2026-08-28",
              )
              expect(server.requests[0]?.body).toMatchObject({
                ids: ["https://example.com"],
                highlights: { query: "API", dynamic: true },
                summary: { query: "overview" },
              })

              const mixed = yield* Effect.result(
                exaApi.contents({
                  ids: ["https://example.com"],
                  urls: ["https://example.com"],
                }),
              )
              expect(mixed._tag).toBe("Failure")
              if (mixed._tag === "Failure") {
                expect(mixed.failure).toMatchObject({
                  _tag: "CommandInputError",
                  field: "ids",
                })
              }

              const mutex = yield* Effect.result(
                exaApi.contents({ url: "https://example.com", livecrawl: "always", maxAgeHours: 1 }),
              )
              expect(mutex._tag).toBe("Failure")
              if (mutex._tag === "Failure") {
                expect(mutex.failure).toMatchObject({
                  _tag: "CommandInputError",
                  field: "livecrawl",
                })
              }
            }),
            store,
          ),
      )
    }),
  )

  it.effect("crawl posts the thin /contents request shape", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, {
            results: [{ id: "https://example.com", url: "https://example.com", text: "page text" }],
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              yield* exaApi.crawl({ url: "https://example.com", maxCharacters: 1200 })
              expect(server.requests[0]?.path).toBe("/contents")
              expect(server.requests[0]?.headers["x-exa-integration"]).toBe("exa-cli-crawling")
              expect(server.requests[0]?.body).toMatchObject({
                urls: ["https://example.com"],
                text: { maxCharacters: 1200 },
                maxAgeHours: 0,
              })
            }),
            store,
          ),
      )
    }),
  )

  it.effect("answer posts to /answer and unwraps the answer field", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, {
            answer: "Paris",
            citations: [{ title: "France", url: "https://example.com" }],
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const result = yield* exaApi.answer({ query: "Capital of France", model: "exa" })
              expect("answer" in result ? result.answer : undefined).toBe("Paris")
              expect(server.requests[0]?.path).toBe("/answer")
              expect(server.requests[0]?.body).toMatchObject({
                query: "Capital of France",
                model: "exa",
              })
              expect(store.sources[0]).toMatchObject({ provider: "exa", url: "https://example.com" })
            }),
            store,
          ),
      )
    }),
  )

  it.effect("company-research and linkedin-search build the right /search bodies", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, { results: [] })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              yield* exaApi.companyResearch({ companyName: "Acme" })
              yield* exaApi.linkedinSearch({ query: "Jane Doe", searchType: "profiles" })
              yield* exaApi.linkedinSearch({ query: "Jane Doe" })

              expect(server.requests[0]?.path).toBe("/search")
              expect(server.requests[0]?.body).toMatchObject({
                query: "Acme",
                type: "auto",
                category: "company",
              })
              expect(server.requests[1]?.body).toMatchObject({
                query: "Jane Doe",
                type: "auto",
                category: "people",
              })
              expect(server.requests[2]?.body).toMatchObject({
                query: "Jane Doe LinkedIn",
                type: "auto",
                includeDomains: ["linkedin.com"],
              })
            }),
            store,
          ),
      )
    }),
  )

  it.effect("find-similar posts the legacy /findSimilar shape", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, { results: [] })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              yield* exaApi.findSimilar({ url: "https://example.com/article" })
              expect(server.requests[0]?.path).toBe("/findSimilar")
              expect(server.requests[0]?.body).toMatchObject({
                url: "https://example.com/article",
                numResults: 10,
                contents: { text: true },
              })
            }),
            store,
          ),
      )
    }),
  )

  it.effect("agent lifecycle: start records a run, cancel/stop/delete hit run endpoints", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)

          if (request.method === "DELETE") {
            writeJson(response, 200, { id: "agent_run_1", object: "agent_run.deleted", deleted: true })
            return
          }

          writeJson(response, 200, {
            id: "agent_run_1",
            object: "agent_run",
            status: request.url?.endsWith("/cancel") ? "cancelled" : "running",
            stopReason: request.url?.endsWith("/cancel") ? "cancelled" : null,
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const start = yield* exaApi.agentStart({ query: "Research Effect", effort: "max" })

              expect(store.runs).toHaveLength(1)
              expect(store.runs[0]).toMatchObject({
                provider: "exa",
                kind: "exa.agent",
                remote_id: "agent_run_1",
                status: "running",
              })

              yield* exaApi.agentCancel({ id: "agent_run_1" })
              yield* exaApi.agentStop({ id: "agent_run_1" })
              yield* exaApi.agentDelete({ id: "agent_run_1" })

              expect(start.runId).toBe("agent_run_1")
              expect(start.researchId).toBe("agent_run_1")
              expect(start.status).toBe("running")
              expect(server.requests[0]?.method).toBe("POST")
              expect(server.requests[0]?.path).toBe("/agent/runs")
              expect(server.requests[0]?.headers["exa-beta"]).toBe(
                "agent-max-effort-2026-07-27",
              )
              expect(server.requests[0]?.body).toMatchObject({
                query: "Research Effect",
                effort: "max",
              })
              expect(server.requests[1]?.method).toBe("POST")
              expect(server.requests[1]?.path).toBe("/agent/runs/agent_run_1/cancel")
              expect(server.requests[1]?.body).toBeUndefined()
              expect(server.requests[2]?.path).toBe("/agent/runs/agent_run_1/stop")
              expect(server.requests[2]?.headers["exa-beta"]).toBe(
                "agent-max-effort-2026-07-27",
              )
              expect(server.requests[3]?.method).toBe("DELETE")
              expect(server.requests[3]?.path).toBe("/agent/runs/agent_run_1")

              expect(store.runs).toHaveLength(1)
              expect(store.runs[0]).toMatchObject({
                provider: "exa",
                kind: "exa.agent",
                remote_id: "agent_run_1",
                status: "canceled",
              })
            }),
            store,
          ),
      )
    }),
  )

  it.live("agent wait polls until a terminal status and times out with JobWaitTimeoutError", () =>
    Effect.gen(function* () {
      const store = makeStore()
      let polls = 0
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          polls += 1
          writeJson(response, 200, {
            id: "agent_run_1",
            object: "agent_run",
            status: polls >= 2 ? "completed" : "running",
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const result = yield* exaApi.agentWait({
                id: "agent_run_1",
                intervalMs: 1,
                timeoutMs: 5000,
              })

              expect(result.status).toBe("completed")
              expect(result.runId).toBe("agent_run_1")
              expect(server.requests.length).toBeGreaterThanOrEqual(2)
            }),
            store,
          ),
      )

      const timeout = yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, { id: "agent_run_2", status: "running" })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.result(
              exaApi.agentWait({ id: "agent_run_2", intervalMs: 1, timeoutMs: 10 }),
            ),
            store,
          ),
      )

      expect(timeout._tag).toBe("Failure")
      if (timeout._tag === "Failure") {
        expect(timeout.failure).toMatchObject({
          _tag: "JobWaitTimeoutError",
          provider: "exa",
          jobId: "agent_run_2",
        })
      }
    }),
  )

  it.effect("agent events and stream read the events endpoint", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)

          if (request.headers.accept === "text/event-stream") {
            response.writeHead(200, { "content-type": "text/event-stream" })
            response.end(
              'event: update\ndata: {"status":"running"}\n\nevent: done\ndata: {"status":"completed"}\n\n',
            )
            return
          }

          writeJson(response, 200, {
            object: "list",
            data: [
              {
                id: "2",
                event: "agent_run.completed",
                data: { status: "completed" },
                createdAt: "2026-09-09T00:00:00.000Z",
              },
            ],
            hasMore: false,
            nextCursor: null,
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const events = yield* exaApi.agentEvents({ id: "agent_run_1", limit: 10 })
              const stream = yield* exaApi.agentStream({ id: "agent_run_1" })

              expect(server.requests[0]?.path).toBe("/agent/runs/agent_run_1/events?limit=10")
              expect(events).toMatchObject({ object: "list" })
              expect(server.requests[1]?.path).toBe("/agent/runs/agent_run_1/events")
              expect(stream.event_count).toBe(2)
              expect(stream.runId).toBe("agent_run_1")
            }),
            store,
          ),
      )
    }),
  )

  it.effect("deep-research start maps instructions to agent query and records exa.deep-research", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          if (request.method === "POST") {
            writeJson(response, 200, {
              id: "agent_run_task_123",
              object: "agent_run",
              status: "running",
            })
            return
          }
          writeJson(response, 200, {
            id: "agent_run_task_123",
            object: "agent_run",
            status: "completed",
            stopReason: "schema_satisfied",
          })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const start = yield* exaApi.deepResearchStart({ instructions: "Research Effect" })
              const check = yield* exaApi.deepResearchCheck({ researchId: "agent_run_task_123" })

              expect(start.runId).toBe("agent_run_task_123")
              expect(start.researchId).toBe("agent_run_task_123")
              expect(server.requests[0]?.method).toBe("POST")
              expect(server.requests[0]?.path).toBe("/agent/runs")
              expect(server.requests[0]?.body).toMatchObject({
                query: "Research Effect",
                effort: "auto",
              })
              expect(server.requests[1]?.method).toBe("GET")
              expect(server.requests[1]?.path).toBe("/agent/runs/agent_run_task_123")
              expect(check).toMatchObject({ status: "completed" })

              expect(store.runs[0]).toMatchObject({
                provider: "exa",
                kind: "exa.deep-research",
                remote_id: "agent_run_task_123",
              })
            }),
            store,
          ),
      )
    }),
  )

  it.effect("deep-research start rejects the retired model field", () =>
    Effect.gen(function* () {
      const store = makeStore()
      const outcome = yield* Effect.result(
        exaApi.deepResearchStart({ instructions: "Research Effect", model: "exa-research" }),
      ).pipe(
        Effect.provide(testLayer(store)),
        withEnv({ EXA_API_KEY: "test-key" }),
      )

      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure).toMatchObject({
          _tag: "CommandInputError",
          field: "model",
        })
      }
    }),
  )

  it.live("deep-research wait fails with JobWaitTimeoutError on timeout", () =>
    Effect.gen(function* () {
      const store = makeStore()
      const outcome = yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 200, { id: "task_9", status: "running" })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.result(
              exaApi.deepResearchWait({ researchId: "task_9", intervalMs: 1, timeoutMs: 10 }),
            ),
            store,
          ),
      )

      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure).toMatchObject({
          _tag: "JobWaitTimeoutError",
          provider: "exa",
          jobId: "task_9",
        })
      }
    }),
  )

  it.effect("agent start validates budget and dataSources before calling Exa", () =>
    Effect.gen(function* () {
      const store = makeStore()
      const env = { EXA_API_KEY: "test-key" }

      const budget = yield* Effect.result(
        exaApi.agentStart({
          query: "Research Effect",
          effort: "medium",
          budget: { maxCostDollars: 10 },
        }),
      ).pipe(Effect.provide(testLayer(store)), withEnv(env))
      const sources = yield* Effect.result(
        exaApi.agentStart({
          query: "Research Effect",
          dataSources: [
            { provider: "fiber" },
            { provider: "similarweb" },
            { provider: "baselayer" },
            { provider: "affiliate" },
            { provider: "particle" },
            { provider: "jinko" },
          ],
        }),
      ).pipe(Effect.provide(testLayer(store)), withEnv(env))

      const failureField = (outcome: { _tag: string; failure?: unknown }) =>
        outcome._tag === "Failure" && outcome.failure && typeof outcome.failure === "object" &&
          "field" in outcome.failure
          ? (outcome.failure as { field: string }).field
          : undefined

      expect(failureField(budget)).toBe("budget")
      expect(failureField(sources)).toBe("dataSources")
    }),
  )

  it.effect("maps HTTP errors to ApiResponseError", () =>
    Effect.gen(function* () {
      const store = makeStore()
      yield* withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          writeJson(response, 429, { error: { message: "Too many requests" } })
        },
        (server) =>
          runExa(
            { EXA_API_KEY: "test-key", EXA_API_BASE_URL: server.baseUrl },
            Effect.gen(function* () {
              const outcome = yield* Effect.result(exaApi.webSearch({ query: "rate limited" }))
              expect(outcome._tag).toBe("Failure")
              if (outcome._tag === "Failure") {
                expect(outcome.failure).toMatchObject({
                  _tag: "ApiResponseError",
                  provider: "exa",
                  status: 429,
                  message: "Too many requests",
                })
              }
            }),
            store,
          ),
      )
    }),
  )

  it.effect("fails with MissingApiKeyError when no credential is configured", () =>
    Effect.gen(function* () {
      const store = makeStore()
      const outcome = yield* Effect.result(exaApi.webSearch({ query: "Effect" })).pipe(
        Effect.provide(testLayer(store)),
        withEnv({ EXA_API_KEY: undefined, EXA_API_BASE_URL: "http://127.0.0.1:1" }),
      )

      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure).toMatchObject({
          _tag: "MissingApiKeyError",
          provider: "exa",
          envVar: "EXA_API_KEY",
        })
      }
    }),
  )
})
