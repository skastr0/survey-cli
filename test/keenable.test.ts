import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

// survey-cli internals read Bun.env; vitest runs under Node, so alias it to
// process.env before any effect executes. bun:sqlite is never instantiated —
// the Store service is stubbed below.
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  ;(globalThis as { Bun?: unknown }).Bun = { env: process.env }
}

import { getContract } from "../src/core/discovery"
import { Store, type SourceRecord } from "../src/core/store"
import { fetchPage, search, selectQuery, selectReport, selectRevoke } from "../src/providers/keenable/api"
import { runKeenableBatch } from "../src/providers/keenable/commands"
import {
  FetchInputSchema,
  FetchResponseSchema,
  SearchInputSchema,
  SearchResponseSchema,
  SelectInputSchema,
  SelectReportInputSchema,
  SelectRevokeInputSchema,
} from "../src/providers/keenable/schemas"

afterEach(() => {
  process.exitCode = undefined
})

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly pathname: string
  readonly searchParams: Record<string, string>
  readonly headers: IncomingMessage["headers"]
  readonly body: unknown
}

interface TestServer {
  readonly baseUrl: string
  readonly requests: ReadonlyArray<RecordedRequest>
  readonly close: Effect.Effect<void>
}

const ENV_KEYS = [
  "KEENABLE_API_KEY",
  "KEENABLE_API_BASE_URL",
  "KEENABLE_SELECT_MCP_URL",
  "KEENABLE_TITLE",
  "KEENABLE_APP_TITLE",
  "SURVEY_HOME",
  "SURVEY_ARTIFACT_DIR",
] as const

/** Set env vars for the duration of the current effect scope. Only the keys
 * present in `env` are touched; `undefined` deletes the key. */
const setEnv = (env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = new Map<string, string | undefined>()
      for (const key of Object.keys(env)) {
        previous.set(key, process.env[key])
        const value = env[key as (typeof ENV_KEYS)[number]]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of previous) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }),
  )

const makeStoreStub = () => {
  const sources: Array<{
    provider: string
    url: string
    title?: string | undefined
    snippet?: string | undefined
    runId?: string | undefined
  }> = []
  const runs: Array<{ id: string; provider: string; kind: string; status: string }> = []
  const layer = Layer.succeed(
    Store,
    Store.of({
      upsertRun: (run) =>
        Effect.sync(() => {
          runs.push(run)
          const ts = new Date().toISOString()
          return {
            id: run.id,
            provider: run.provider,
            kind: run.kind,
            remote_id: run.remoteId ?? null,
            status: run.status,
            payload: run.payload === undefined ? null : JSON.stringify(run.payload),
            result_ref: run.resultRef ?? null,
            created_at: ts,
            updated_at: ts,
          }
        }),
      getRun: () => Effect.succeed(undefined),
      findRunByRemote: () => Effect.succeed(undefined),
      listRuns: () => Effect.succeed([]),
      updateRun: () => Effect.void,
      insertSources: (items) =>
        Effect.sync(() => {
          sources.push(...items)
          return items.length
        }),
      sourcesForRun: () => Effect.succeed([] as ReadonlyArray<SourceRecord>),
      listSources: () => Effect.succeed([] as ReadonlyArray<SourceRecord>),
      citationOverlap: () => Effect.succeed([]),
    }),
  )
  return { layer, sources, runs }
}

const makeTestLayer = (store: ReturnType<typeof makeStoreStub>) =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    FileSystem.layerNoop({
      exists: () => Effect.succeed(false),
      makeDirectory: () => Effect.void,
      readFileString: (path: string) =>
        Effect.promise(() => readFile(path, "utf8")) as never,
      writeFileString: () => Effect.void,
      chmod: () => Effect.void,
    }),
    Path.layer,
    store.layer,
  )

const parseRequestUrl = (rawUrl: string) => {
  const url = new URL(rawUrl, "http://127.0.0.1")
  return {
    pathname: url.pathname,
    searchParams: Object.fromEntries(url.searchParams.entries()),
  }
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
          const parsed = parseRequestUrl(request.url ?? "")
          requests.push({
            method: request.method ?? "",
            path: request.url ?? "",
            pathname: parsed.pathname,
            searchParams: parsed.searchParams,
            headers: request.headers,
            body,
          })
        }

        handler(request, response, record).catch((error: unknown) => {
          response.writeHead(500, { "content-type": "application/json" })
          response.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          )
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

const withTempDir = <A, E, R>(use: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "survey-keenable-test-"))),
    use,
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  )

const searchResult = {
  query: "Effect Schema",
  mode: "realtime",
  usage: { sku: "search.realtime", credits: 1 },
  results: [
    {
      title: "Effect Schema",
      url: "https://effect.website",
      description: null,
      snippet: "Effect Schema lets you decode JSON.",
      published_at: "2026-01-15T10:30:00Z",
      acquired_at: null,
      extra_rank: 1,
    },
  ],
}

const fetchResult = {
  url: "https://example.com",
  title: "Example",
  description: null,
  author: "IANA",
  published_at: 1768435200,
  content: "# Example Domain\n\nThis domain is for use in illustrative examples.",
}

const echoHandler = async (request: IncomingMessage, response: ServerResponse, record: (body: unknown) => void) => {
  const body = await readRequestBody(request)
  record(body)
  writeJson(response, 200, request.method === "GET" ? fetchResult : searchResult)
}

describe("keenable search", () => {
  it.effect("posts to /v1/search with X-API-Key when a key is configured", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_test",
              KEENABLE_API_BASE_URL: server.baseUrl,
            })

            const result = yield* search({
              query: "Effect Schema",
              site: "effect.website",
              max_results: 5,
              mode: "standard",
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(result.auth_mode).toBe("keyed")
            expect(result.endpoint).toBe("/v1/search")
            expect(result.title).toBe("survey")
            expect(result.data.query).toBe("Effect Schema")
            expect(result.data.mode).toBe("realtime")
            // explicit nulls and extra fields survive the wire
            expect(result.data.results[0]?.description).toBeNull()
            expect(result.data.results[0]?.extra_rank).toBe(1)
            expect(result.data.usage).toEqual({ sku: "search.realtime", credits: 1 })

            expect(server.requests).toHaveLength(1)
            expect(server.requests[0]?.method).toBe("POST")
            expect(server.requests[0]?.pathname).toBe("/v1/search")
            expect(server.requests[0]?.headers["x-api-key"]).toBe("keen_test")
            expect(server.requests[0]?.headers["content-type"]).toContain("application/json")
            expect(server.requests[0]?.headers["x-keenable-title"]).toBe("survey")
            expect(server.requests[0]?.body).toMatchObject({
              query: "Effect Schema",
              site: "effect.website",
              max_results: 5,
              mode: "realtime",
            })
            expect(server.requests[0]?.body).not.toHaveProperty("keenable_title")

            // recordSources fed the shared ledger
            expect(store.sources.map((item) => item.url)).toEqual(["https://effect.website"])
          }),
      ),
    ),
  )

  it.effect("posts to /v1/search/public with X-Keenable-Title when no key is configured", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: undefined,
              KEENABLE_API_BASE_URL: server.baseUrl,
              KEENABLE_TITLE: "env-title",
            })

            const result = yield* search({
              query: "Effect Schema",
              keenable_title: "my-agent",
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(result.auth_mode).toBe("public")
            expect(result.endpoint).toBe("/v1/search/public")
            expect(result.title).toBe("my-agent")
            expect(server.requests[0]?.pathname).toBe("/v1/search/public")
            expect(server.requests[0]?.headers["x-api-key"]).toBeUndefined()
            expect(server.requests[0]?.headers["x-keenable-title"]).toBe("my-agent")
          }),
      ),
    ),
  )

  it.effect("uses KEENABLE_TITLE, then KEENABLE_APP_TITLE, for the public title header", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: undefined,
              KEENABLE_API_BASE_URL: server.baseUrl,
              KEENABLE_TITLE: undefined,
              KEENABLE_APP_TITLE: "official-alias",
            })

            yield* search({ query: "a" }).pipe(Effect.provide(makeTestLayer(store)))
            expect(server.requests[0]?.headers["x-keenable-title"]).toBe("official-alias")

            yield* setEnv({ KEENABLE_TITLE: "env-title" })
            yield* search({ query: "b" }).pipe(Effect.provide(makeTestLayer(store)))
            expect(server.requests[1]?.headers["x-keenable-title"]).toBe("env-title")
          }),
      ),
    ),
  )

  it.effect("accepts a bare JSON string, an array of strings, and @file input", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_test",
              KEENABLE_API_BASE_URL: server.baseUrl,
            })
            const layer = makeTestLayer(store)

            const inputPath = join(home, "search.json")
            yield* Effect.promise(() => writeFile(inputPath, JSON.stringify({ query: "from-file" })))

            const single = yield* runKeenableBatch({
              input: '"inline-query"',
              concurrency: 2,
              itemSchema: SearchInputSchema,
              prepare: (value) => (typeof value === "string" ? { query: value } : value),
              run: (item) => search(item),
            }).pipe(Effect.provide(layer))

            const mixed = yield* runKeenableBatch({
              input: '["rust async", {"query": "bun compile"}]',
              concurrency: 2,
              itemSchema: SearchInputSchema,
              prepare: (value) => (typeof value === "string" ? { query: value } : value),
              run: (item) => search(item),
            }).pipe(Effect.provide(layer))

            const fromFile = yield* runKeenableBatch({
              input: `@${inputPath}`,
              concurrency: 2,
              itemSchema: SearchInputSchema,
              prepare: (value) => (typeof value === "string" ? { query: value } : value),
              run: (item) => search(item),
            }).pipe(Effect.provide(layer))

            expect(single.outcome).toBe("succeeded")
            expect(mixed.outcome).toBe("succeeded")
            expect(mixed.total).toBe(2)
            expect(fromFile.outcome).toBe("succeeded")
            expect(server.requests.map((request) => (request.body as { query?: string })?.query)).toEqual([
              "inline-query",
              "rust async",
              "bun compile",
              "from-file",
            ])
          }),
      ),
    ),
  )

  it.effect("rejects invalid schema values per item without calling the API", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_test",
              KEENABLE_API_BASE_URL: server.baseUrl,
            })

            const summary = yield* runKeenableBatch({
              input: '[{"query":"ok","max_results":99},{"query":"fine"}]',
              concurrency: 2,
              itemSchema: SearchInputSchema,
              run: (item) => search(item),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("partial_failure")
            expect(summary.error_count).toBe(1)
            expect(summary.results[0]?.ok).toBe(false)
            expect((summary.results[0]?.error as { type?: string })?.type).toBe("CommandInputError")
            expect(summary.results[1]?.ok).toBe(true)
            expect(server.requests).toHaveLength(1)
          }),
      ),
    ),
  )

  it.effect("records ApiResponseError details on partial API failure", () =>
    withTempDir((home) =>
      withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          if (body && typeof body === "object" && "query" in body && body.query === "rate limited") {
            response.writeHead(429, {
              "content-type": "application/json",
              "retry-after": "12",
            })
            response.end(
              JSON.stringify({ error: "Rate limit exceeded", message: "slow down", retryAfter: 12 }),
            )
            return
          }
          writeJson(response, 200, searchResult)
        },
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_test",
              KEENABLE_API_BASE_URL: server.baseUrl,
            })

            const summary = yield* runKeenableBatch({
              input: '[{"query":"ok"},{"query":"rate limited"}]',
              concurrency: 2,
              itemSchema: SearchInputSchema,
              run: (item) => search(item),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("partial_failure")
            expect(summary.success_count).toBe(1)
            expect(summary.error_count).toBe(1)
            const error = summary.results[1]?.error as {
              type?: string
              details?: { status?: number; retryable?: boolean }
            }
            expect(error?.type).toBe("ApiResponseError")
            expect(error?.details?.status).toBe(429)
            expect(error?.details?.retryable).toBe(true)
            expect(server.requests).toHaveLength(2)
          }),
      ),
    ),
  )
})

describe("keenable fetch", () => {
  it.effect("gets /v1/fetch with query params and X-API-Key when keyed", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_test",
              KEENABLE_API_BASE_URL: server.baseUrl,
            })

            const result = yield* fetchPage({
              url: "https://example.com",
              live: true,
              max_chars: 20000,
              prompt: "Summarize",
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(result.auth_mode).toBe("keyed")
            expect(result.endpoint).toBe("/v1/fetch")
            expect(result.data.content).toContain("Example Domain")
            expect(result.data.published_at).toBe(1768435200)
            expect(result.data.description).toBeNull()

            expect(server.requests[0]?.method).toBe("GET")
            expect(server.requests[0]?.pathname).toBe("/v1/fetch")
            expect(server.requests[0]?.searchParams).toMatchObject({
              url: "https://example.com",
              live: "true",
              max_chars: "20000",
              prompt: "Summarize",
            })
            expect(server.requests[0]?.headers["x-api-key"]).toBe("keen_test")

            expect(store.sources.map((item) => item.url)).toEqual(["https://example.com"])
          }),
      ),
    ),
  )

  it.effect("gets /v1/fetch/public without a key", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: undefined,
              KEENABLE_API_BASE_URL: server.baseUrl,
              KEENABLE_TITLE: "public-app",
            })

            const result = yield* fetchPage({ url: "https://example.com" }).pipe(
              Effect.provide(makeTestLayer(store)),
            )

            expect(result.auth_mode).toBe("public")
            expect(result.endpoint).toBe("/v1/fetch/public")
            expect(server.requests[0]?.pathname).toBe("/v1/fetch/public")
            expect(server.requests[0]?.headers["x-api-key"]).toBeUndefined()
            expect(server.requests[0]?.headers["x-keenable-title"]).toBe("public-app")
            expect(server.requests[0]?.searchParams.url).toBe("https://example.com")
          }),
      ),
    ),
  )

  it.effect("rejects a non-http URL without calling the API", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_test",
              KEENABLE_API_BASE_URL: server.baseUrl,
            })

            const summary = yield* runKeenableBatch({
              input: '{"url":"ftp://example.com"}',
              concurrency: 1,
              itemSchema: FetchInputSchema,
              prepare: (value) => (typeof value === "string" ? { url: value } : value),
              run: (item) => fetchPage(item),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("failed")
            const error = summary.results[0]?.error as {
              type?: string
              details?: { field?: string }
            }
            expect(error?.type).toBe("CommandInputError")
            expect(error?.details?.field).toBe("url")
            expect(server.requests).toHaveLength(0)
          }),
      ),
    ),
  )

  it.effect("accepts a bare URL string as input", () =>
    withTempDir((home) =>
      withTestServer(
        echoHandler,
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_test",
              KEENABLE_API_BASE_URL: server.baseUrl,
            })

            const summary = yield* runKeenableBatch({
              input: '"https://example.com"',
              concurrency: 1,
              itemSchema: FetchInputSchema,
              prepare: (value) => (typeof value === "string" ? { url: value } : value),
              run: (item) => fetchPage(item),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("succeeded")
            expect(server.requests[0]?.searchParams.url).toBe("https://example.com")
          }),
      ),
    ),
  )
})

const mcpHandler =
  (toolText: (name: string | undefined, args: unknown) => string, options?: { delayCallMs?: number }) =>
  async (request: IncomingMessage, response: ServerResponse, record: (body: unknown) => void) => {
    const body = await readRequestBody(request)
    record(body)
    const method =
      body && typeof body === "object" && "method" in body && typeof body.method === "string"
        ? body.method
        : undefined
    const id = body && typeof body === "object" && "id" in body ? (body as { id?: unknown }).id : undefined

    if (method === "initialize") {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "sess-select-1",
      })
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "keenable-select", version: "1" },
          },
        }),
      )
      return
    }

    if (method === "notifications/initialized") {
      response.writeHead(204)
      response.end()
      return
    }

    if (method === "tools/call") {
      const params =
        body && typeof body === "object" && "params" in body && body.params && typeof body.params === "object"
          ? (body.params as { name?: string; arguments?: unknown })
          : {}
      const respond = () => {
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess-select-1",
        })
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: toolText(params.name, params.arguments) }],
            },
          }),
        )
      }
      if (options?.delayCallMs) {
        setTimeout(respond, options.delayCallMs)
      } else {
        respond()
      }
      return
    }

    writeJson(response, 400, { error: `unexpected MCP method ${String(method)}` })
  }

describe("keenable select", () => {
  it.effect("fails with MissingApiKeyError when no key is configured", () =>
    withTempDir((home) =>
      withTestServer(
        mcpHandler(() => "{}"),
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: undefined,
              KEENABLE_SELECT_MCP_URL: `${server.baseUrl}/mcp`,
            })

            const summary = yield* runKeenableBatch({
              input: JSON.stringify({ query: "SELECT url FROM WEB_SEARCH('effect schema') LIMIT 1" }),
              concurrency: 1,
              itemSchema: SelectInputSchema,
              run: (item) => selectQuery(item),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("failed")
            expect((summary.results[0]?.error as { type?: string })?.type).toBe("MissingApiKeyError")
            expect(server.requests).toHaveLength(0)
          }),
      ),
    ),
  )

  it.effect("rejects a non-SELECT statement without calling MCP", () =>
    withTempDir((home) =>
      withTestServer(
        mcpHandler(() => "{}"),
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_select",
              KEENABLE_SELECT_MCP_URL: `${server.baseUrl}/mcp`,
            })

            const summary = yield* runKeenableBatch({
              input: '{"query":"DROP TABLE web"}',
              concurrency: 1,
              itemSchema: SelectInputSchema,
              run: (item) => selectQuery(item),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("failed")
            const error = summary.results[0]?.error as { type?: string; details?: { field?: string } }
            expect(error?.type).toBe("CommandInputError")
            expect(error?.details?.field).toBe("query")
            expect(server.requests).toHaveLength(0)
          }),
      ),
    ),
  )

  it.effect("initializes an MCP session and calls the select tool", () =>
    withTempDir((home) =>
      withTestServer(
        mcpHandler((_name, args) =>
          JSON.stringify({
            result_set_id: "ra84968f0532",
            rows: [{ url: "https://effect.website", title: "Effect Schema" }],
            args,
          }),
        ),
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_select",
              KEENABLE_SELECT_MCP_URL: `${server.baseUrl}/mcp`,
            })

            const result = yield* selectQuery({
              query: "SELECT url, title FROM WEB_SEARCH('Effect Schema official docs') LIMIT 5",
              show_preview: true,
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(result.tool).toBe("select")
            expect(result.auth_mode).toBe("keyed")
            expect(result.protocol_version).toBe("2025-03-26")
            expect(result.session_id).toBe("sess-select-1")
            expect(result.result_set_id).toBe("ra84968f0532")
            expect((result.content as { rows?: Array<{ url?: string }> }).rows?.[0]?.url).toBe(
              "https://effect.website",
            )

            const methods = server.requests.map(
              (item) => (item.body as { method?: string } | undefined)?.method,
            )
            expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"])
            expect(server.requests[0]?.headers["x-api-key"]).toBe("keen_select")
            expect(server.requests[0]?.headers["mcp-protocol-version"]).toBe("2025-03-26")
            expect(server.requests[2]?.headers["mcp-session-id"]).toBe("sess-select-1")
            const callBody = server.requests[2]?.body as {
              params?: { name?: string; arguments?: { show_preview?: boolean; query?: string } }
            }
            expect(callBody.params?.name).toBe("select")
            expect(callBody.params?.arguments?.show_preview).toBe(true)
          }),
      ),
    ),
  )

  it.effect("select accepts a bare SQL string as {query}", () =>
    withTempDir((home) =>
      withTestServer(
        mcpHandler(() => JSON.stringify({ ok: true })),
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_select",
              KEENABLE_SELECT_MCP_URL: `${server.baseUrl}/mcp`,
            })

            const summary = yield* runKeenableBatch({
              input: '"SELECT 1"',
              concurrency: 1,
              itemSchema: SelectInputSchema,
              prepare: (value) => (typeof value === "string" ? { query: value } : value),
              run: (item) => selectQuery(item),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("succeeded")
            const callBody = server.requests.at(-1)?.body as {
              params?: { arguments?: { query?: string } }
            }
            expect(callBody.params?.arguments?.query).toBe("SELECT 1")
          }),
      ),
    ),
  )

  it.effect("select-report and select-revoke call the matching MCP tools", () =>
    withTempDir((home) =>
      withTestServer(
        mcpHandler((name) => JSON.stringify({ tool: name, ok: true })),
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_select",
              KEENABLE_SELECT_MCP_URL: `${server.baseUrl}/mcp`,
            })
            const layer = makeTestLayer(store)

            const report = yield* runKeenableBatch({
              input: JSON.stringify({
                brief: "Summarize electric cars in Europe",
                result_set_ids: ["ra84968f0532"],
              }),
              concurrency: 1,
              itemSchema: SelectReportInputSchema,
              run: (item) => selectReport(item),
            }).pipe(Effect.provide(layer))

            const revoke = yield* runKeenableBatch({
              input: JSON.stringify({ report_url: "https://select.keenable.ai/r/example/id" }),
              concurrency: 1,
              itemSchema: SelectRevokeInputSchema,
              run: (item) => selectRevoke(item),
            }).pipe(Effect.provide(layer))

            expect(report.outcome).toBe("succeeded")
            expect(revoke.outcome).toBe("succeeded")
            const toolNames = server.requests
              .map((item) => {
                const body = item.body as { method?: string; params?: { name?: string } } | undefined
                return body?.method === "tools/call" ? body.params?.name : undefined
              })
              .filter((name): name is string => typeof name === "string")
            expect(toolNames).toEqual(["generate_html_report", "revoke_html_report"])
          }),
      ),
    ),
  )

  it.effect("parses SSE MCP tool results", () =>
    withTempDir((home) =>
      withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          const method =
            body && typeof body === "object" && "method" in body && typeof body.method === "string"
              ? body.method
              : undefined
          const id =
            body && typeof body === "object" && "id" in body ? (body as { id?: unknown }).id : undefined

          if (method === "initialize") {
            writeJson(response, 200, {
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                serverInfo: { name: "keenable-select" },
              },
            })
            return
          }

          if (method === "notifications/initialized") {
            response.writeHead(204)
            response.end()
            return
          }

          const payload = JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: "url,title\nhttps://effect.website,Effect" }],
            },
          })
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.end(`event: message\ndata: ${payload}\n\n`)
        },
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_select",
              KEENABLE_SELECT_MCP_URL: `${server.baseUrl}/mcp`,
            })

            const result = yield* selectQuery({
              query: "SELECT url, title FROM WEB_SEARCH('effect') LIMIT 1",
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(result.text).toContain("https://effect.website")
          }),
      ),
    ),
  )

  it.effect("maps JSON-RPC errors to McpError", () =>
    withTempDir((home) =>
      withTestServer(
        async (request, response, record) => {
          const body = await readRequestBody(request)
          record(body)
          const method =
            body && typeof body === "object" && "method" in body && typeof body.method === "string"
              ? body.method
              : undefined
          const id =
            body && typeof body === "object" && "id" in body ? (body as { id?: unknown }).id : undefined

          if (method === "initialize") {
            writeJson(response, 200, {
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} },
            })
            return
          }
          if (method === "notifications/initialized") {
            response.writeHead(204)
            response.end()
            return
          }
          writeJson(response, 200, {
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "query failed: syntax error" },
          })
        },
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_select",
              KEENABLE_SELECT_MCP_URL: `${server.baseUrl}/mcp`,
            })

            const summary = yield* runKeenableBatch({
              input: '{"query":"SELECT * FROM broken"}',
              concurrency: 1,
              itemSchema: SelectInputSchema,
              run: (item) => selectQuery(item),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("failed")
            const error = summary.results[0]?.error as { type?: string; message?: string }
            expect(error?.type).toBe("McpError")
            expect(error?.message).toContain("query failed: syntax error")
          }),
      ),
    ),
  )

  it.live("times out a slow SELECT MCP call with McpError", () =>
    withTempDir((home) =>
      withTestServer(
        mcpHandler(() => JSON.stringify({ ok: true }), { delayCallMs: 3000 }),
        (server) =>
          Effect.gen(function* () {
            const store = makeStoreStub()
            yield* setEnv({
              SURVEY_HOME: home,
              KEENABLE_API_KEY: "keen_select",
              KEENABLE_SELECT_MCP_URL: `${server.baseUrl}/mcp`,
            })

            const summary = yield* runKeenableBatch({
              input: '{"query":"SELECT 1","timeout_seconds":1}',
              concurrency: 1,
              itemSchema: SelectInputSchema,
              run: (item) => selectQuery(item, item.timeout_seconds ?? 300),
            }).pipe(Effect.provide(makeTestLayer(store)))

            expect(summary.outcome).toBe("failed")
            const error = summary.results[0]?.error as { type?: string; message?: string }
            expect(error?.type).toBe("McpError")
            expect(error?.message).toContain("timed out")
          }),
      ),
    ),
  )
})

describe("keenable input schemas", () => {
  it.effect("accepts documented search fields and rejects out-of-range max_results", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(SearchInputSchema)({
        query: "rust async",
        site: "docs.rs",
        acquired_after: "7d",
        snippet_max_length: 2000,
        max_results: 25,
        mode: "pro",
      })
      expect(decoded.query).toBe("rust async")
      expect(decoded.max_results).toBe(25)

      const failed = yield* Schema.decodeUnknownEffect(SearchInputSchema)({
        query: "rust async",
        max_results: 99,
      }).pipe(Effect.result)
      expect(failed._tag).toBe("Failure")
    }),
  )

  it.effect("accepts documented fetch fields", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(FetchInputSchema)({
        url: "https://example.com",
        live: true,
        max_chars: 50000,
        prompt: "List pricing",
      })
      expect(decoded.live).toBe(true)
      expect(decoded.prompt).toBe("List pricing")
    }),
  )

  it.effect("select input accepts a query with timeout_seconds", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(SelectInputSchema)({
        query: "SELECT 1",
        show_preview: true,
        timeout_seconds: 30,
      })
      expect(decoded.timeout_seconds).toBe(30)

      const report = yield* Schema.decodeUnknownEffect(SelectReportInputSchema)({
        brief: "b",
        result_set_ids: ["r12345678"],
      })
      expect(report.result_set_ids).toHaveLength(1)

      const revoke = yield* Schema.decodeUnknownEffect(SelectRevokeInputSchema)({
        report_url: "https://select.keenable.ai/r/x",
      })
      expect(revoke.report_url).toBe("https://select.keenable.ai/r/x")
    }),
  )
})

describe("keenable response schemas", () => {
  it.effect("keeps search mode, extra fields, and null optional result fields", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(SearchResponseSchema)({
        query: "rust async",
        mode: "pro",
        usage: { sku: "search.pro", credits: 1 },
        results: [
          {
            title: "Rust Async",
            url: "https://example.com/rust",
            snippet: "async rust",
            description: null,
            acquired_at: "2026-01-16T08:12:34Z",
            published_at: null,
            extra_rank: 4,
          },
        ],
      })

      expect(decoded.query).toBe("rust async")
      expect(decoded.mode).toBe("pro")
      expect(decoded.usage).toEqual({ sku: "search.pro", credits: 1 })
      expect(decoded.results[0]?.description).toBeNull()
      expect(decoded.results[0]?.published_at).toBeNull()
      expect(decoded.results[0]?.extra_rank).toBe(4)
    }),
  )

  it.effect("accepts fetch published_at as integer or string and keeps extra fields", () =>
    Effect.gen(function* () {
      const asNumber = yield* Schema.decodeUnknownEffect(FetchResponseSchema)({
        url: "https://example.com",
        content: "# Example",
        published_at: 1768435200,
        truncated: true,
      })
      const asString = yield* Schema.decodeUnknownEffect(FetchResponseSchema)({
        url: "https://example.com",
        content: "# Example",
        published_at: "2026-01-15T10:30:00Z",
        title: null,
      })

      expect(asNumber.published_at).toBe(1768435200)
      expect(asNumber.truncated).toBe(true)
      expect(asString.published_at).toBe("2026-01-15T10:30:00Z")
      expect(asString.title).toBeNull()
    }),
  )
})

describe("keenable contracts", () => {
  it("registers contracts for all namespace commands", () => {
    const commands = [
      "keenable search",
      "keenable fetch",
      "keenable select",
      "keenable select-report",
      "keenable select-revoke",
    ]
    for (const command of commands) {
      const contract = getContract(command)
      expect(contract, command).toBeDefined()
      expect(contract?.batch).toBe(true)
      expect(contract?.inputSchema).toBeDefined()
    }
  })
})
