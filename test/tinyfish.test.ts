import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

// survey-cli internals read Bun.env; vitest runs under Node.
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  ;(globalThis as { Bun?: unknown }).Bun = { env: process.env }
}

import { unifiedFetch } from "../src/capabilities/fetch"
import { research } from "../src/capabilities/research"
import { unifiedSearch } from "../src/capabilities/search"
import { getContract, listContracts } from "../src/core/discovery"
import { Store, type RunRecord, type SourceRecord } from "../src/core/store"
import {
  agentCancel,
  agentCheck,
  agentList,
  agentStart,
  agentStream,
  agentWait,
  browserClose,
  browserCreate,
  browserInspect,
  fetchPages,
  monitorCreate,
  monitorDelete,
  monitorTrigger,
  monitorUpdate,
  parseSseChunk,
  researchCheck,
  researchEvents,
  researchStart,
  search,
  usage,
} from "../src/providers/tinyfish/api"
import "../src/capabilities/monitor"
import "../src/providers/tinyfish"

afterEach(() => {
  process.exitCode = undefined
})

/* ------------------------------------------------------------------------ */
/* Harness                                                                   */
/* ------------------------------------------------------------------------ */

interface RecordedRequest {
  readonly method: string
  readonly pathname: string
  readonly searchParams: Record<string, string>
  readonly headers: IncomingMessage["headers"]
  readonly body: unknown
}

type Handler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>

const ENV_KEYS = [
  "TINYFISH_API_KEY",
  "TINYFISH_API_BASE_URL",
  "TINYFISH_SEARCH_API_BASE_URL",
  "TINYFISH_FETCH_API_BASE_URL",
  "TINYFISH_BROWSER_API_BASE_URL",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "FIRECRAWL_API_KEY",
  "KEENABLE_API_KEY",
  "SURVEY_HOME",
] as const

const setEnv = (env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = new Map<string, string | undefined>()
      for (const key of ENV_KEYS) {
        previous.set(key, process.env[key])
        const value = env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

const makeStore = () => {
  const sources: Array<{ provider: string; url: string; title?: string | undefined; runId?: string | undefined }> = []
  const runs: Array<RunRecord> = []
  const layer = Layer.succeed(
    Store,
    Store.of({
      upsertRun: (run) =>
        Effect.sync(() => {
          const ts = new Date().toISOString()
          const record: RunRecord = {
            id: run.id,
            provider: run.provider,
            kind: run.kind,
            remote_id: run.remoteId ?? null,
            status: run.status,
            payload: run.payload === undefined ? null : JSON.stringify(run.payload),
            result_ref: null,
            created_at: ts,
            updated_at: ts,
          }
          runs.push(record)
          return record
        }),
      getRun: () => Effect.succeed(undefined),
      findRunByRemote: (provider, remoteId) =>
        Effect.succeed(runs.find((run) => run.provider === provider && run.remote_id === remoteId)),
      listRuns: () => Effect.succeed([]),
      updateRun: (id, patch) =>
        Effect.sync(() => {
          const index = runs.findIndex((run) => run.id === id)
          const current = runs[index]
          if (current && patch.status) runs[index] = { ...current, status: patch.status }
        }),
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

const testLayer = (store: ReturnType<typeof makeStore>) =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    FileSystem.layerNoop({
      exists: () => Effect.succeed(false),
      makeDirectory: () => Effect.void,
      writeFileString: () => Effect.void,
      chmod: () => Effect.void,
    }),
    Path.layer,
    store.layer,
  )

const readBody = (request: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let text = ""
    request.on("data", (chunk) => (text += chunk))
    request.on("end", () => {
      if (text.trim().length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(text)
      }
    })
  })

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const sse = (response: ServerResponse, frames: ReadonlyArray<string>, keepOpen = false) => {
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const frame of frames) response.write(`${frame}\n\n`)
  if (!keepOpen) response.end()
}

/**
 * Starts a stub server, points every TinyFish host at it (search/fetch/browser
 * under path prefixes), runs `use`, and closes the server.
 */
const withServer = <A, E, R>(
  handler: Handler,
  use: (requests: ReadonlyArray<RecordedRequest>) => Effect.Effect<A, E, R>,
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {},
) =>
  Effect.acquireUseRelease(
    Effect.callback<{ baseUrl: string; requests: Array<RecordedRequest>; close: () => Promise<void> }>((resume) => {
      const requests: Array<RecordedRequest> = []
      const open = new Set<ServerResponse>()
      const server = createServer(async (request, response) => {
        open.add(response)
        response.on("close", () => open.delete(response))
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        const recorded: RecordedRequest = {
          method: request.method ?? "",
          pathname: url.pathname,
          searchParams: Object.fromEntries(url.searchParams.entries()),
          headers: request.headers,
          body: await readBody(request),
        }
        requests.push(recorded)
        await handler(recorded, response)
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") return
        resume(
          Effect.succeed({
            baseUrl: `http://127.0.0.1:${address.port}`,
            requests,
            close: () =>
              new Promise<void>((resolve) => {
                for (const response of open) response.destroy()
                server.close(() => resolve())
              }),
          }),
        )
      })
    }),
    (server) =>
      Effect.scoped(
        setEnv({
          TINYFISH_API_KEY: "tf_test_key",
          TINYFISH_API_BASE_URL: server.baseUrl,
          TINYFISH_SEARCH_API_BASE_URL: `${server.baseUrl}/search`,
          TINYFISH_FETCH_API_BASE_URL: `${server.baseUrl}/fetch`,
          TINYFISH_BROWSER_API_BASE_URL: `${server.baseUrl}/browser`,
          SURVEY_HOME: "/nonexistent-survey-home",
          ...env,
        }).pipe(Effect.andThen(use(server.requests))),
      ),
    (server) => Effect.promise(server.close),
  )

const searchPage = {
  query: "web agents",
  results: [
    { position: 1, site_name: "a", title: "A", url: "https://a.example/x", snippet: "first" },
    { position: 2, site_name: "b", title: "B", url: "https://b.example/y", snippet: "second", date: "2026-10-01" },
    { position: 3, site_name: "c", title: "C", url: "https://c.example/z", snippet: "third" },
  ],
  total_results: 3,
  page: 0,
  request_id: "req_1",
}

const fetchPayload = {
  results: [
    {
      url: "https://example.com",
      final_url: "https://example.com/",
      title: "Example Domain",
      description: null,
      language: "en",
      format: "markdown",
      text: "# Example Domain",
      author: null,
      published_date: null,
      latency_ms: 120,
    },
  ],
  errors: [{ url: "https://bad.example", error: "DNS failure", status: 502 }],
  request_id: "req_2",
}

const completedResearch = {
  research_run_id: "11111111-1111-1111-1111-111111111111",
  status: "COMPLETED",
  query: "q",
  quick_result: null,
  quick_result_summary: null,
  deep_result: {
    result: "Report body [1]",
    citations: ["https://cited.example/one", "https://cited.example/two"],
    termination_reason: "planner_done",
  },
  evidence: [
    { url: "https://evidence.example/a", title: "Evidence A", subquestions_covered: [], claims: [], source_quality: "primary" },
  ],
  run_ids: [],
  created_at: "2026-10-19T00:00:00Z",
  completed_at: "2026-10-19T00:10:00Z",
}

/* ------------------------------------------------------------------------ */
/* Search / fetch / usage                                                    */
/* ------------------------------------------------------------------------ */

describe("tinyfish search", () => {
  it.effect("GETs the search host with query params and X-API-Key", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, searchPage),
      (requests) =>
        Effect.gen(function* () {
          const data = yield* search({
            query: "web agents",
            include_domains: ["a.example", "b.example"],
            include_thumbnail: true,
            domain_type: "news",
            page: 1,
          })
          expect(data.results).toHaveLength(3)
          expect(data.results[1]?.date).toBe("2026-10-01")
          const [request] = requests
          expect(request?.method).toBe("GET")
          expect(request?.pathname).toBe("/search/")
          expect(request?.headers["x-api-key"]).toBe("tf_test_key")
          expect(request?.searchParams).toEqual({
            query: "web agents",
            include_domains: "a.example,b.example",
            include_thumbnail: "true",
            domain_type: "news",
            page: "1",
          })
          expect(store.sources.map((s) => s.url)).toContain("https://a.example/x")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("rejects recency_minutes combined with dates before any request", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, searchPage),
      (requests) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(search({ query: "x", recency_minutes: 60, after_date: "2026-01-01" }))
          expect(error._tag).toBe("CommandInputError")
          expect(requests).toHaveLength(0)
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("maps the TinyFish error envelope into ApiResponseError", () => {
    const store = makeStore()
    return withServer(
      (_request, response) =>
        json(response, 401, { error: { code: "INVALID_API_KEY", message: "Invalid or expired API key" }, request_id: "r" }),
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(search({ query: "x" }))
          expect(error._tag).toBe("ApiResponseError")
          if (error._tag === "ApiResponseError") {
            expect(error.status).toBe(401)
            expect(error.message).toBe("Invalid or expired API key")
          }
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("fails with MissingApiKeyError when no key is configured", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, searchPage),
      (requests) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(search({ query: "x" }))
          expect(error._tag).toBe("MissingApiKeyError")
          expect(requests).toHaveLength(0)
        }),
      { TINYFISH_API_KEY: undefined },
    ).pipe(Effect.provide(testLayer(store)))
  })
})

describe("tinyfish fetch + usage", () => {
  it.effect("POSTs urls to the fetch host and keeps per-URL errors", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, fetchPayload),
      (requests) =>
        Effect.gen(function* () {
          const data = yield* fetchPages({ urls: ["https://example.com", "https://bad.example"], links: true })
          expect(data.results[0]?.text).toBe("# Example Domain")
          expect(data.errors?.[0]?.error).toBe("DNS failure")
          expect(requests[0]?.method).toBe("POST")
          expect(requests[0]?.pathname).toBe("/fetch/")
          expect(requests[0]?.body).toEqual({ urls: ["https://example.com", "https://bad.example"], links: true })
          expect(store.sources).toEqual([{ provider: "tinyfish", url: "https://example.com", title: "Example Domain" }])
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("rejects conditional headers on multi-URL fetches", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, fetchPayload),
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(fetchPages({ urls: ["https://a.example", "https://b.example"], if_none_match: "etag" }))
          expect(error._tag).toBe("CommandInputError")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("routes usage to the product host and validates session_id", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, { items: [], total: 0, limit: 5, page: 1, total_pages: 0, has_more: false }),
      (requests) =>
        Effect.gen(function* () {
          yield* usage({ product: "fetch", status: "failed", limit: 5 })
          expect(requests[0]?.pathname).toBe("/fetch/usage")
          expect(requests[0]?.searchParams).toEqual({ status: "failed", limit: "5" })
          const error = yield* Effect.flip(usage({ product: "search", session_id: "s" }))
          expect(error._tag).toBe("CommandInputError")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })
})

/* ------------------------------------------------------------------------ */
/* Browser                                                                   */
/* ------------------------------------------------------------------------ */

describe("tinyfish browser", () => {
  it.effect("creates, inspects via usage, and closes a session (204)", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        if (request.method === "POST" && request.pathname === "/browser/") {
          return json(response, 201, {
            session_id: "sess_1",
            cdp_url: "wss://cdp.example/sess_1",
            base_url: "https://sess_1.browser.example",
          })
        }
        if (request.method === "GET" && request.pathname === "/browser/usage") {
          return json(response, 200, {
            items: [{ session_id: "sess_1", status: "running", mode: "stealth" }],
            total: 1,
            limit: 100,
            page: 1,
            total_pages: 1,
            has_more: false,
          })
        }
        if (request.method === "DELETE" && request.pathname === "/browser/sess_1") {
          response.writeHead(204)
          return void response.end()
        }
        json(response, 404, { error: { code: "NOT_FOUND", message: "nope" } })
      },
      (requests) =>
        Effect.gen(function* () {
          const created = yield* browserCreate({ url: "https://example.com", timeout_seconds: 60 })
          expect(created.cdp_url).toBe("wss://cdp.example/sess_1")
          expect(requests[0]?.body).toEqual({ url: "https://example.com", timeout_seconds: 60 })
          expect(store.runs[0]).toMatchObject({ provider: "tinyfish", kind: "tinyfish.browser", remote_id: "sess_1" })

          const inspected = yield* browserInspect({ session_id: "sess_1" })
          expect(inspected.session).toMatchObject({ status: "running" })
          expect(requests[1]?.searchParams).toEqual({ session_id: "sess_1" })

          const closed = yield* browserClose({ session_id: "sess_1" })
          expect(closed).toEqual({ session_id: "sess_1", closed: true })
          expect(store.runs[0]?.status).toBe("succeeded")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })
})

/* ------------------------------------------------------------------------ */
/* Agent                                                                     */
/* ------------------------------------------------------------------------ */

describe("tinyfish agent", () => {
  it.effect("start records the run; check settles a terminal run", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        if (request.pathname === "/v1/automation/run-async") return json(response, 200, { run_id: "run_1", error: null })
        if (request.pathname === "/v1/runs/run_1") {
          return json(response, 200, {
            run_id: "run_1",
            status: "COMPLETED",
            goal: "g",
            result: { items: [{ url: "https://found.example", title: "Found" }] },
            error: null,
            steps: [],
          })
        }
        json(response, 404, {})
      },
      (requests) =>
        Effect.gen(function* () {
          const started = yield* agentStart({ url: "https://example.com", goal: "find it", agent_config: { max_steps: 10 } })
          expect(started.run_id).toBe("run_1")
          expect(started.lifecycle.unsupported_actions[0]?.action).toBe("events")
          expect(requests[0]?.body).toEqual({ url: "https://example.com", goal: "find it", agent_config: { max_steps: 10 } })
          expect(store.runs[0]).toMatchObject({ kind: "tinyfish.agent", remote_id: "run_1", status: "queued" })

          const checked = yield* agentCheck({ run_id: "run_1", screenshots: "none" })
          expect(checked.completed).toBe(true)
          expect(checked.result).toEqual({ items: [{ url: "https://found.example", title: "Found" }] })
          expect(requests[1]?.searchParams).toEqual({ screenshots: "none" })
          expect(store.runs[0]?.status).toBe("succeeded")
          expect(store.sources.map((s) => s.url)).toContain("https://found.example")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("start fails loudly when the provider returns no run_id", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, { run_id: null, error: { code: "INSUFFICIENT_CREDITS", message: "top up" } }),
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(agentStart({ url: "https://example.com", goal: "g" }))
          expect(error._tag).toBe("ApiResponseError")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.live("wait polls until terminal", () => {
    const store = makeStore()
    let polls = 0
    return withServer(
      (_request, response) => {
        polls += 1
        json(response, 200, { run_id: "run_2", status: polls < 2 ? "RUNNING" : "FAILED", error: { message: "blocked", category: "AGENT_FAILURE" } })
      },
      () =>
        Effect.gen(function* () {
          const waited = yield* agentWait({ run_id: "run_2", poll_interval_seconds: 1, max_wait_seconds: 10 })
          expect(waited.status).toBe("FAILED")
          expect(waited.timed_out).toBe(false)
          expect(waited.terminal).toBe(true)
          expect(polls).toBe(2)
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.live("wait returns timed_out with the last snapshot", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, { run_id: "run_3", status: "RUNNING" }),
      () =>
        Effect.gen(function* () {
          const waited = yield* agentWait({ run_id: "run_3", poll_interval_seconds: 1, max_wait_seconds: 1 })
          expect(waited.timed_out).toBe(true)
          expect(waited.status).toBe("RUNNING")
          expect(waited.next_action).toBe("tinyfish agent wait")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.live("stream collects run-sse events until COMPLETE", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        expect(request.headers.accept).toBe("text/event-stream")
        sse(
          response,
          [
            `data: ${JSON.stringify({ type: "STARTED", run_id: "run_4", timestamp: "t0" })}`,
            `data: ${JSON.stringify({ type: "PROGRESS", run_id: "run_4", purpose: "Clicking", timestamp: "t1" })}`,
            `: keep-alive comment`,
            `data: ${JSON.stringify({ type: "COMPLETE", run_id: "run_4", status: "COMPLETED", result: { answer: 42 }, timestamp: "t2" })}`,
          ],
          true,
        )
      },
      (requests) =>
        Effect.gen(function* () {
          const streamed = yield* agentStream({ url: "https://example.com", goal: "answer", max_wait_seconds: 10 })
          expect(requests[0]?.pathname).toBe("/v1/automation/run-sse")
          expect(requests[0]?.body).toEqual({ url: "https://example.com", goal: "answer" })
          expect(streamed).toMatchObject({ run_id: "run_4", status: "COMPLETED", completed: true, result: { answer: 42 }, timed_out: false })
          expect(streamed.event_count).toBe(3)
          expect(store.runs[0]).toMatchObject({ remote_id: "run_4", status: "succeeded" })
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("cancel and list hit the documented paths", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        if (request.pathname === "/v1/runs/run_5/cancel") {
          return json(response, 200, { run_id: "run_5", status: "CANCELLED", cancelled_at: "t", message: null })
        }
        json(response, 200, { data: [{ run_id: "run_5", status: "CANCELLED" }], pagination: { total: 1, next_cursor: null, has_more: false } })
      },
      (requests) =>
        Effect.gen(function* () {
          const cancelled = yield* agentCancel({ run_id: "run_5" })
          expect(cancelled.status).toBe("CANCELLED")
          expect(requests[0]?.method).toBe("POST")
          const listed = yield* agentList({ status: "CANCELLED", limit: 5 })
          expect(listed.data).toHaveLength(1)
          expect(requests[1]?.searchParams).toEqual({ status: "CANCELLED", limit: "5" })
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })
})

/* ------------------------------------------------------------------------ */
/* Research                                                                  */
/* ------------------------------------------------------------------------ */

describe("tinyfish research", () => {
  it.effect("start + check returns report, citations, and fused sources", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        if (request.pathname === "/v1/automation/run-research-async") {
          return json(response, 200, { research_run_id: completedResearch.research_run_id, error: null })
        }
        json(response, 200, completedResearch)
      },
      (requests) =>
        Effect.gen(function* () {
          const started = yield* researchStart({ query: "q", mode: "max", domain_filter: { mode: "include", domains: ["a.example"] } })
          expect(started.research_run_id).toBe(completedResearch.research_run_id)
          expect(requests[0]?.body).toEqual({ query: "q", mode: "max", domain_filter: { mode: "include", domains: ["a.example"] } })

          const checked = yield* researchCheck({ research_run_id: started.research_run_id })
          expect(checked.completed).toBe(true)
          expect(checked.report).toBe("Report body [1]")
          expect(checked.citations).toEqual(["https://cited.example/one", "https://cited.example/two"])
          expect(store.runs[0]).toMatchObject({ kind: "tinyfish.research", status: "succeeded" })
          expect(store.sources.map((s) => s.url).sort()).toEqual([
            "https://cited.example/one",
            "https://cited.example/two",
            "https://evidence.example/a",
          ])
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.live("events reads named SSE frames until done", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        expect(request.pathname).toBe(`/v1/research-run/${completedResearch.research_run_id}/events`)
        sse(
          response,
          [
            `id: 1\nevent: created\ndata: {"research_run_id":"x"}`,
            `id: 2\nevent: plan_updated\ndata: {"summary":"plan"}`,
            `id: 3\nevent: done\ndata: {}`,
          ],
          true,
        )
      },
      () =>
        Effect.gen(function* () {
          const events = yield* researchEvents({ research_run_id: completedResearch.research_run_id, max_wait_seconds: 10 })
          expect(events.done).toBe(true)
          expect(events.timed_out).toBe(false)
          expect(events.last_event_id).toBe("3")
          expect(events.events.map((e) => e.event)).toEqual(["created", "plan_updated", "done"])
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.live("events stops at max_wait_seconds and offers a resume cursor", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        expect(request.headers["last-event-id"]).toBe("7")
        sse(response, [`id: 8\nevent: heartbeat\ndata: {}`], true)
      },
      () =>
        Effect.gen(function* () {
          const events = yield* researchEvents({ research_run_id: "r", last_event_id: "7", max_wait_seconds: 1 })
          expect(events.timed_out).toBe(true)
          expect(events.done).toBe(false)
          expect(events.resume_with).toEqual({ last_event_id: "8" })
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it("parses SSE chunks with fields, comments, and raw data", () => {
    expect(parseSseChunk(`event: x\nid: 9\ndata: {"a":1}`)).toEqual({ event: "x", id: "9", data: { a: 1 } })
    expect(parseSseChunk(`: comment only`)).toBeUndefined()
    expect(parseSseChunk(`data: not json`)).toEqual({ data: "not json" })
  })
})

/* ------------------------------------------------------------------------ */
/* Monitors                                                                  */
/* ------------------------------------------------------------------------ */

describe("tinyfish monitors", () => {
  it.effect("create, pause, edit, trigger, delete", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        if (request.method === "POST" && request.pathname === "/v1/monitors") {
          return json(response, 201, {
            monitor: { id: "mon_1", type: "fetch", status: "active" },
            run: { id: "mr_1", is_baseline: true, results: [{ url: "https://watched.example", title: "W" }], errors: [] },
          })
        }
        if (request.method === "PATCH") return json(response, 200, { id: "mon_1", status: "paused" })
        if (request.method === "POST" && request.pathname === "/v1/monitors/mon_1/runs") {
          return json(response, 201, { run: { id: "mr_2", results: [], errors: [] } })
        }
        if (request.method === "DELETE") return json(response, 200, { deleted: true, id: "mon_1" })
        json(response, 404, {})
      },
      (requests) =>
        Effect.gen(function* () {
          yield* monitorCreate({
            type: "fetch",
            config: { url: "https://watched.example" },
            schedule_cron: "0 9 * * *",
            purpose: "price changes",
          })
          expect(store.runs[0]).toMatchObject({ kind: "tinyfish.monitor", remote_id: "mon_1" })
          expect(store.sources.map((s) => s.url)).toContain("https://watched.example")

          yield* monitorUpdate({ id: "mon_1", status: "paused" })
          expect(requests[1]?.body).toEqual({ status: "paused" })
          yield* monitorUpdate({ id: "mon_1", schedule_cron: "0 * * * *", name: null })
          expect(requests[2]?.body).toEqual({ schedule_cron: "0 * * * *", name: null })

          const conflict = yield* Effect.flip(monitorUpdate({ id: "mon_1", status: "active", name: "x" }))
          expect(conflict._tag).toBe("CommandInputError")

          yield* monitorTrigger({ id: "mon_1" })
          expect(requests[3]?.pathname).toBe("/v1/monitors/mon_1/runs")
          const deleted = yield* monitorDelete({ id: "mon_1" })
          expect(deleted).toEqual({ deleted: true, id: "mon_1" })
          expect(store.runs[0]?.status).toBe("canceled")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })
})

/* ------------------------------------------------------------------------ */
/* Unified commands                                                          */
/* ------------------------------------------------------------------------ */

describe("tinyfish in unified commands", () => {
  it.effect("search fan-out trims tinyfish results to num_results", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, searchPage),
      () =>
        Effect.gen(function* () {
          const result = yield* unifiedSearch({ query: "web agents", providers: ["tinyfish"], num_results: 2 })
          expect(result.providers_used).toEqual(["tinyfish"])
          expect(result.results.map((r) => r.url)).toEqual(["https://a.example/x", "https://b.example/y"])
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("search skips tinyfish without a key", () => {
    const store = makeStore()
    return withServer(
      (_request, response) => json(response, 200, searchPage),
      () =>
        Effect.gen(function* () {
          const result = yield* unifiedSearch({ query: "x", providers: ["tinyfish"] })
          expect(result.skipped).toEqual([{ provider: "tinyfish", reason: "no API key configured" }])
        }),
      { TINYFISH_API_KEY: undefined },
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("fetch chain returns tinyfish content and falls through on per-URL errors", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        const urls = (request.body as { urls: Array<string> }).urls
        if (urls[0] === "https://example.com") return json(response, 200, fetchPayload)
        json(response, 200, { results: [], errors: [{ url: urls[0], error: "blocked" }] })
      },
      () =>
        Effect.gen(function* () {
          const ok = yield* unifiedFetch({ url: "https://example.com", providers: ["tinyfish"] })
          expect(ok.provider).toBe("tinyfish")
          expect(ok.content).toBe("# Example Domain")

          const failed = yield* Effect.flip(unifiedFetch({ url: "https://blocked.example", providers: ["tinyfish"] }))
          const attempted = (failed as { body: { attempted: Array<{ provider: string; ok: boolean; error?: { message?: string } }> } }).body
            .attempted
          expect(attempted[0]).toMatchObject({ provider: "tinyfish", ok: false })
          expect(attempted[0]?.error?.message).toBe("blocked")
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })

  it.effect("research jury maps depth to mode and fuses tinyfish citations", () => {
    const store = makeStore()
    return withServer(
      (request, response) => {
        if (request.pathname === "/v1/automation/run-research-async") {
          return json(response, 200, { research_run_id: completedResearch.research_run_id, error: null })
        }
        json(response, 200, completedResearch)
      },
      (requests) =>
        Effect.gen(function* () {
          const result = yield* research({ query: "q", providers: ["tinyfish"], depth: "deep" })
          expect((requests[0]?.body as { mode: string }).mode).toBe("max")
          expect(result.providers[0]).toMatchObject({ provider: "tinyfish", ok: true, source_count: 3 })
          expect(result.sources.map((s) => s.url).sort()).toEqual([
            "https://cited.example/one",
            "https://cited.example/two",
            "https://evidence.example/a",
          ])
        }),
    ).pipe(Effect.provide(testLayer(store)))
  })
})

/* ------------------------------------------------------------------------ */
/* Contracts                                                                 */
/* ------------------------------------------------------------------------ */

describe("tinyfish contracts", () => {
  const tinyfishContracts = listContracts().filter((contract) => contract.command.startsWith("tinyfish "))

  it("registers the full command surface", () => {
    expect(tinyfishContracts.map((c) => c.command)).toEqual(
      expect.arrayContaining([
        "tinyfish search",
        "tinyfish fetch",
        "tinyfish browser create",
        "tinyfish agent start",
        "tinyfish agent stream",
        "tinyfish research start",
        "tinyfish research events",
        "tinyfish monitor create",
        "tinyfish usage",
      ]),
    )
    expect(tinyfishContracts.length).toBe(40)
  })

  it("every command has examples that decode against its input schema", () => {
    const commands = [...tinyfishContracts, ...["monitor create", "monitor list", "monitor inspect", "monitor cancel"].map((c) => getContract(c)!)]
    for (const contract of commands) {
      expect(contract.examples?.length, contract.command).toBeGreaterThan(0)
      expect(contract.inputSchema, contract.command).toBeDefined()
      for (const example of contract.examples ?? []) {
        const items = contract.batch && Array.isArray(example.input) ? example.input : [example.input]
        for (const item of items) {
          const decoded = Schema.decodeUnknownResult(contract.inputSchema as Schema.Codec<unknown, unknown>)(item)
          expect(decoded._tag, `${contract.command} / ${example.name}`).toBe("Success")
        }
      }
    }
  })
})
