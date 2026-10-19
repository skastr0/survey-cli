import { Clock, Duration, Effect, Option, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

import { USER_AGENT } from "../../core/constants"
import { ApiRequestError, ApiResponseError, CommandInputError } from "../../core/errors"
import { rememberDocument } from "../../core/corpus"
import { requestJson, requestText } from "../../core/http"
import { loadProviderConfig, requireCredential } from "../../core/registry"
import { extractUrls, recordRun, recordSources, updateRun } from "../../core/runs"
import { Store, type RunStatus } from "../../core/store"
import {
  AgentAsyncResponseSchema,
  AgentCancelSchema,
  AgentRunListSchema,
  AgentRunSchema,
  BrowserSessionSchema,
  FetchResponseSchema,
  JsonRecord,
  ResearchAsyncResponseSchema,
  ResearchListSchema,
  ResearchRunSchema,
  SearchResponseSchema,
  type AgentCheckInput,
  type AgentListInput,
  type AgentRun,
  type AgentRunIdInput,
  type AgentRunInput,
  type AgentStartInput,
  type AgentStreamInput,
  type AgentWaitInput,
  type BrowserCreateInput,
  type BrowserListInput,
  type BrowserSessionIdInput,
  type FetchCommandInput,
  type FetchInput,
  type MonitorCreateInput,
  type MonitorIdInput,
  type MonitorUpdateInput,
  type ProfileCreateInput,
  type ProfileIdInput,
  type ProfileUpdateInput,
  type ResearchEventsInput,
  type ResearchIdInput,
  type ResearchListInput,
  type ResearchRun,
  type ResearchRunInput,
  type ResearchStartInput,
  type ResearchWaitInput,
  type SearchInput,
  type UsageInput,
} from "./schemas"

/* ------------------------------------------------------------------------ */
/* Hosts                                                                     */
/* ------------------------------------------------------------------------ */

// Search, Fetch, and Browser live on dedicated hosts; Agent, Research, and
// Monitor share agent.tinyfish.ai (TINYFISH_API_BASE_URL).
const PRODUCT_HOSTS = {
  search: { env: "TINYFISH_SEARCH_API_BASE_URL", url: "https://api.search.tinyfish.ai" },
  fetch: { env: "TINYFISH_FETCH_API_BASE_URL", url: "https://api.fetch.tinyfish.ai" },
  browser: { env: "TINYFISH_BROWSER_API_BASE_URL", url: "https://api.browser.tinyfish.ai" },
} as const
type Product = keyof typeof PRODUCT_HOSTS

export const productBaseUrl = (product: Product) =>
  Effect.gen(function* () {
    const host = PRODUCT_HOSTS[product]
    const raw = (Bun.env[host.env] ?? host.url).trim()
    const url = yield* Effect.try({
      try: () => new URL(raw),
      catch: () => new CommandInputError({ field: host.env, message: "Invalid API base URL" }),
    })
    return url.toString().replace(/\/+$/, "")
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const defined = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))

const toUrlParams = (record: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, typeof value === "string" ? value : String(value)] as const],
    ),
  )

const pathId = (value: string) => encodeURIComponent(value)

/* ------------------------------------------------------------------------ */
/* Run registry (best-effort)                                                */
/* ------------------------------------------------------------------------ */

export const agentRunStatus = (status: string): RunStatus => {
  switch (status.toUpperCase()) {
    case "COMPLETED":
      return "succeeded"
    case "FAILED":
    case "TIMED_OUT":
      return "failed"
    case "CANCELLED":
      return "canceled"
    case "PENDING":
    case "QUEUED":
      return "queued"
    default:
      return "running"
  }
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"])
export const isTerminal = (status: string) => TERMINAL.has(status.toUpperCase())

const syncRunByRemote = (remoteId: string, status: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    const existing = yield* store.findRunByRemote("tinyfish", remoteId)
    yield* updateRun(existing?.id, { status: agentRunStatus(status) })
  }).pipe(Effect.catchCause(() => Effect.void))

/* ------------------------------------------------------------------------ */
/* Search + Fetch (free daily allowance, key required)                       */
/* ------------------------------------------------------------------------ */

const joinDomains = (value: string | ReadonlyArray<string> | undefined) =>
  value === undefined ? undefined : typeof value === "string" ? value : value.join(",")

export const search = Effect.fn("tinyfish.search")(function* (input: SearchInput) {
  if (input.recency_minutes !== undefined && (input.after_date || input.before_date)) {
    return yield* new CommandInputError({
      field: "recency_minutes",
      message: "recency_minutes cannot be combined with after_date/before_date",
    })
  }
  const data = yield* requestJson({
    provider: "tinyfish",
    baseUrl: yield* productBaseUrl("search"),
    method: "GET",
    path: "/",
    urlParams: toUrlParams({
      ...input,
      include_domains: joinDomains(input.include_domains),
      exclude_domains: joinDomains(input.exclude_domains),
      include_thumbnail: input.include_thumbnail === undefined ? undefined : String(input.include_thumbnail),
    }),
    responseSchema: SearchResponseSchema,
  })
  yield* recordSources("tinyfish", extractUrls(data))
  return data
})

export const fetchPages = Effect.fn("tinyfish.fetch")(function* (input: FetchInput) {
  if ((input.if_none_match || input.if_modified_since) && input.urls.length > 1) {
    return yield* new CommandInputError({
      field: "urls",
      message: "if_none_match/if_modified_since are single-URL only",
    })
  }
  const data = yield* requestJson({
    provider: "tinyfish",
    baseUrl: yield* productBaseUrl("fetch"),
    method: "POST",
    path: "/",
    body: defined(input),
    responseSchema: FetchResponseSchema,
  })
  yield* recordSources(
    "tinyfish",
    data.results.map((result) => ({
      url: result.url,
      ...(typeof result.title === "string" ? { title: result.title } : {}),
    })),
  )
  return data
})

interface CorpusOptions {
  readonly store?: boolean | undefined
  readonly tags?: ReadonlyArray<string> | undefined
}

const corpusRef = (put: { id: number; version: number; changed: boolean; created: boolean }) => ({
  id: put.id,
  version: put.version,
  changed: put.changed,
  created: put.created,
})

/**
 * `tinyfish fetch` command: fetch, then keep each string result (markdown or
 * html) in the local corpus. format=json returns a document tree, not text,
 * so it is not stored. The unified `fetch` stores on its own and calls
 * fetchPages directly, so it never double-writes.
 */
export const fetchAndRemember = Effect.fn("tinyfish.fetchAndRemember")(function* (input: FetchCommandInput) {
  const { store, tags, ...request } = input
  const data = yield* fetchPages(request)
  if (store === false) return data
  const corpus = yield* Effect.forEach(data.results, (result) =>
    typeof result.text !== "string" || result.text.length === 0
      ? Effect.succeed([])
      : rememberDocument({
          url: result.url,
          content: result.text,
          title: typeof result.title === "string" ? result.title : undefined,
          provider: "tinyfish",
          kind: "web",
          tags,
          metadata: { final_url: result.final_url ?? null, format: result.format ?? null },
        }).pipe(Effect.map((put) => (put === undefined ? [] : [{ url: result.url, ...corpusRef(put) }]))),
  )
  return { ...data, corpus: corpus.flat() }
})

/** Agent results are structured JSON keyed by run id; only COMPLETED runs with a result are kept. */
const rememberAgentRun = (
  run: { readonly run_id: string; readonly status: string; readonly result?: unknown; readonly goal?: unknown },
  options: CorpusOptions & { readonly target_url?: string | undefined },
) =>
  options.store === false || run.status !== "COMPLETED" || run.result === undefined || run.result === null
    ? Effect.succeed(undefined)
    : rememberDocument({
        url: `tinyfish://agent/runs/${run.run_id}`,
        content: JSON.stringify(run.result, null, 2),
        title: typeof run.goal === "string" ? run.goal : undefined,
        provider: "tinyfish",
        kind: "agent",
        tags: options.tags,
        metadata: {
          run_id: run.run_id,
          ...(typeof run.goal === "string" ? { goal: run.goal } : {}),
          ...(options.target_url !== undefined ? { target_url: options.target_url } : {}),
        },
      }).pipe(Effect.map((put) => (put === undefined ? undefined : corpusRef(put))))

const withCorpus = (ref: ReturnType<typeof corpusRef> | undefined) => (ref === undefined ? {} : { corpus: ref })

export const usage = Effect.fn("tinyfish.usage")(function* (input: UsageInput) {
  const { product, ...query } = input
  if (query.session_id !== undefined && product !== "browser") {
    return yield* new CommandInputError({ field: "session_id", message: "session_id applies to product=browser only" })
  }
  return yield* requestJson({
    provider: "tinyfish",
    baseUrl: yield* productBaseUrl(product),
    method: "GET",
    path: "/usage",
    urlParams: toUrlParams(query),
    responseSchema: JsonRecord,
  })
})

/* ------------------------------------------------------------------------ */
/* Browser sessions                                                          */
/* ------------------------------------------------------------------------ */

export const browserCreate = Effect.fn("tinyfish.browserCreate")(function* (input: BrowserCreateInput) {
  const session = yield* requestJson({
    provider: "tinyfish",
    baseUrl: yield* productBaseUrl("browser"),
    method: "POST",
    path: "/",
    body: defined(input),
    responseSchema: BrowserSessionSchema,
  })
  yield* recordRun({
    provider: "tinyfish",
    kind: "tinyfish.browser",
    remoteId: session.session_id,
    status: "running",
    payload: input,
  })
  return {
    ...session,
    next_actions: {
      inspect: "tinyfish browser inspect",
      close: "tinyfish browser close",
    },
  }
})

export const browserClose = Effect.fn("tinyfish.browserClose")(function* (input: BrowserSessionIdInput) {
  // 204 No Content, idempotent.
  yield* requestText({
    provider: "tinyfish",
    baseUrl: yield* productBaseUrl("browser"),
    method: "DELETE",
    path: `/${pathId(input.session_id)}`,
  })
  yield* syncRunByRemote(input.session_id, "COMPLETED")
  return { session_id: input.session_id, closed: true }
})

export const browserList = (input: BrowserListInput) => usage({ product: "browser", ...input })

/** No get-session endpoint exists; the usage list filtered by session_id is the closest view. */
export const browserInspect = Effect.fn("tinyfish.browserInspect")(function* (input: BrowserSessionIdInput) {
  const page = yield* usage({ product: "browser", session_id: input.session_id })
  const items = Array.isArray(page.items) ? page.items : []
  return { session_id: input.session_id, session: items[0] ?? null, source: "GET /usage?session_id" }
})

/* ------------------------------------------------------------------------ */
/* Server-sent events                                                        */
/* ------------------------------------------------------------------------ */

export interface SseFrame {
  readonly event?: string
  readonly id?: string
  readonly data: unknown
}

export const parseSseChunk = (chunk: string): SseFrame | undefined => {
  let event: string | undefined
  let id: string | undefined
  const dataLines: Array<string> = []
  for (const line of chunk.split("\n")) {
    if (line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "id") id = value
    else if (field === "data") dataLines.push(value)
  }
  if (dataLines.length === 0 && event === undefined) return undefined
  const text = dataLines.join("\n")
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {
    // keep raw text
  }
  return {
    ...(event !== undefined ? { event } : {}),
    ...(id !== undefined ? { id } : {}),
    data,
  }
}

/**
 * Read a TinyFish text/event-stream until `isFinal` matches a frame, the
 * stream ends, or `maxWaitMs` elapses. Frames read so far are always returned.
 */
const readEventStream = (options: {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly maxWaitMs: number
  readonly isFinal: (frame: SseFrame) => boolean
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const config = yield* loadProviderConfig("tinyfish")
    const credential = yield* requireCredential("tinyfish")
    const url = `${config.apiBaseUrl}${options.path}`
    const toRequestError = (error: { readonly message?: string; readonly _tag?: string }) =>
      new ApiRequestError({
        provider: "tinyfish",
        method: options.method,
        path: options.path,
        reason: String(error._tag ?? "RequestError"),
        message: error.message ?? "HTTP request failed",
      })

    let request = (options.method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)).pipe(
      HttpClientRequest.setHeader("user-agent", USER_AGENT),
      HttpClientRequest.setHeader("x-api-key", credential),
      HttpClientRequest.setHeader("accept", "text/event-stream"),
    )
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      request = request.pipe(HttpClientRequest.setHeader(key, value))
    }
    if (options.body !== undefined) {
      request = request.pipe(HttpClientRequest.bodyJsonUnsafe(options.body))
    }

    const response = yield* client.execute(request).pipe(Effect.mapError(toRequestError))
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // keep raw text
      }
      const message =
        isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
          ? body.error.message
          : `tinyfish API request failed with status ${response.status}`
      return yield* new ApiResponseError({
        provider: "tinyfish",
        method: options.method,
        path: options.path,
        status: response.status,
        message,
        body,
      })
    }

    const frames: Array<SseFrame> = []
    let buffer = ""
    let finished = false
    const decoder = new TextDecoder()
    const consume = response.stream.pipe(
      Stream.runForEachWhile((bytes) =>
        Effect.sync(() => {
          buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, "\n")
          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const frame = parseSseChunk(buffer.slice(0, boundary))
            buffer = buffer.slice(boundary + 2)
            if (frame) {
              frames.push(frame)
              if (options.isFinal(frame)) {
                finished = true
                return false
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
          return true
        }),
      ),
      Effect.mapError(toRequestError),
    )
    const completed = yield* consume.pipe(Effect.timeoutOption(Duration.millis(options.maxWaitMs)))
    if (Option.isSome(completed) && !finished && buffer.trim().length > 0) {
      const frame = parseSseChunk(buffer.trim())
      if (frame) {
        frames.push(frame)
        finished = options.isFinal(frame)
      }
    }
    return {
      frames,
      finished,
      stream_ended: Option.isSome(completed),
      timed_out: Option.isNone(completed),
    }
  })

/* ------------------------------------------------------------------------ */
/* Agent runs                                                                */
/* ------------------------------------------------------------------------ */

const AGENT_NEXT_ACTIONS = {
  check: "tinyfish agent check",
  inspect: "tinyfish agent inspect",
  wait: "tinyfish agent wait",
  cancel: "tinyfish agent cancel",
  list: "tinyfish agent list",
}

type LocalFields = "max_wait_seconds" | "poll_interval_seconds" | "store" | "tags"

/** Drop CLI-local controls before a body goes to TinyFish. */
const stripLocal = <
  A extends {
    readonly max_wait_seconds?: number | undefined
    readonly poll_interval_seconds?: number | undefined
    readonly store?: boolean | undefined
    readonly tags?: ReadonlyArray<string> | undefined
  },
>(
  input: A,
): Omit<A, LocalFields> => {
  const { max_wait_seconds: _max, poll_interval_seconds: _poll, store: _store, tags: _tags, ...rest } = input
  return rest
}

export const agentStart = Effect.fn("tinyfish.agentStart")(function* (input: AgentStartInput) {
  const started = yield* requestJson({
    provider: "tinyfish",
    method: "POST",
    path: "/v1/automation/run-async",
    body: defined(input),
    responseSchema: AgentAsyncResponseSchema,
  })
  if (!started.run_id) {
    return yield* new ApiResponseError({
      provider: "tinyfish",
      method: "POST",
      path: "/v1/automation/run-async",
      status: 200,
      message: "TinyFish did not return a run_id",
      body: started,
    })
  }
  yield* recordRun({
    provider: "tinyfish",
    kind: "tinyfish.agent",
    remoteId: started.run_id,
    status: "queued",
    payload: input,
  })
  return {
    run_id: started.run_id,
    status: "PENDING",
    lifecycle: {
      provider_async: true,
      supported_actions: ["check", "inspect", "wait", "cancel", "list", "stream"],
      unsupported_actions: [
        {
          action: "events",
          reason: "TinyFish has no run-events endpoint; events arrive only on the run-sse stream (tinyfish agent stream) or webhooks.",
        },
      ],
    },
    next_actions: AGENT_NEXT_ACTIONS,
  }
})

export const agentGet = (input: AgentRunIdInput) =>
  requestJson({
    provider: "tinyfish",
    method: "GET",
    path: `/v1/runs/${pathId(input.run_id)}`,
    urlParams: toUrlParams({ screenshots: input.screenshots, html: input.html }),
    responseSchema: AgentRunSchema,
  })

const agentSnapshot = (run: AgentRun) => ({
  completed: run.status === "COMPLETED",
  terminal: isTerminal(run.status),
  run_id: run.run_id,
  status: run.status,
  result: run.result ?? null,
  error: run.error ?? null,
  run,
  ...(isTerminal(run.status) ? {} : { next_action: "tinyfish agent wait", next_actions: AGENT_NEXT_ACTIONS }),
})

export const agentCheck = Effect.fn("tinyfish.agentCheck")(function* (input: AgentCheckInput) {
  const run = yield* agentGet({ run_id: input.run_id, screenshots: input.screenshots, html: input.html })
  if (!isTerminal(run.status)) return agentSnapshot(run)
  yield* syncRunByRemote(run.run_id, run.status)
  yield* recordSources("tinyfish", extractUrls(run.result ?? null))
  return { ...agentSnapshot(run), ...withCorpus(yield* rememberAgentRun(run, input)) }
})

const pollUntilTerminal = <A extends { readonly status: string }, E, R>(options: {
  readonly fetch: Effect.Effect<A, E, R>
  readonly maxWaitSeconds: number
  readonly pollIntervalSeconds: number
}) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + options.maxWaitSeconds * 1000
    let current = yield* options.fetch
    while (!isTerminal(current.status)) {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return { current, timed_out: true }
      }
      yield* Effect.sleep(Duration.seconds(options.pollIntervalSeconds))
      current = yield* options.fetch
    }
    return { current, timed_out: false }
  })

export const agentWait = Effect.fn("tinyfish.agentWait")(function* (input: AgentWaitInput) {
  const { current, timed_out } = yield* pollUntilTerminal({
    fetch: agentGet({ run_id: input.run_id }),
    maxWaitSeconds: input.max_wait_seconds ?? 300,
    pollIntervalSeconds: input.poll_interval_seconds ?? 5,
  })
  if (timed_out) return { ...agentSnapshot(current), timed_out }
  yield* syncRunByRemote(current.run_id, current.status)
  yield* recordSources("tinyfish", extractUrls(current.result ?? null))
  return { ...agentSnapshot(current), timed_out, ...withCorpus(yield* rememberAgentRun(current, input)) }
})

export const agentRun = Effect.fn("tinyfish.agentRun")(function* (input: AgentRunInput) {
  const started = yield* agentStart(stripLocal(input))
  return yield* agentWait({
    run_id: started.run_id,
    max_wait_seconds: input.max_wait_seconds,
    poll_interval_seconds: input.poll_interval_seconds,
    store: input.store,
    tags: input.tags,
  })
})

/** Start a run on POST /v1/automation/run-sse and collect events until COMPLETE. */
export const agentStream = Effect.fn("tinyfish.agentStream")(function* (input: AgentStreamInput) {
  const { max_wait_seconds, store, tags, ...body } = input
  const streamed = yield* readEventStream({
    method: "POST",
    path: "/v1/automation/run-sse",
    body: defined(body),
    maxWaitMs: (max_wait_seconds ?? 300) * 1000,
    isFinal: (frame) => isRecord(frame.data) && frame.data.type === "COMPLETE",
  })
  const events = streamed.frames.map((frame) => frame.data)
  const runId = events.flatMap((event) =>
    isRecord(event) && typeof event.run_id === "string" ? [event.run_id] : [],
  )[0]
  const complete = events.find((event) => isRecord(event) && event.type === "COMPLETE") as
    | Record<string, unknown>
    | undefined
  const status = typeof complete?.status === "string" ? complete.status : "RUNNING"
  if (runId) {
    yield* recordRun({
      provider: "tinyfish",
      kind: "tinyfish.agent",
      remoteId: runId,
      status: agentRunStatus(status),
      payload: body,
    })
  }
  yield* recordSources("tinyfish", extractUrls(complete?.result ?? null))
  const remembered =
    runId === undefined
      ? undefined
      : yield* rememberAgentRun(
          { run_id: runId, status, result: complete?.result, goal: body.goal },
          { store, tags, target_url: body.url },
        )
  return {
    run_id: runId ?? null,
    status,
    completed: status === "COMPLETED",
    result: complete?.result ?? null,
    error: complete?.error ?? null,
    timed_out: streamed.timed_out,
    event_count: events.length,
    events,
    ...(runId && !complete ? { next_action: "tinyfish agent wait" } : {}),
    ...withCorpus(remembered),
  }
})

export const agentCancel = Effect.fn("tinyfish.agentCancel")(function* (input: { readonly run_id: string }) {
  const cancelled = yield* requestJson({
    provider: "tinyfish",
    method: "POST",
    path: `/v1/runs/${pathId(input.run_id)}/cancel`,
    responseSchema: AgentCancelSchema,
  })
  yield* syncRunByRemote(input.run_id, cancelled.status)
  return cancelled
})

export const agentList = (input: AgentListInput) =>
  requestJson({
    provider: "tinyfish",
    method: "GET",
    path: "/v1/runs",
    urlParams: toUrlParams(input),
    responseSchema: AgentRunListSchema,
  })

export const agentEventsUnsupported = (input: { readonly run_id: string }) => ({
  provider: "tinyfish",
  run_id: input.run_id,
  capability: "agent.events",
  supported: false,
  reason:
    "TinyFish exposes no run-events endpoint. Live events are only emitted on the POST /v1/automation/run-sse stream, and terminal events via webhook_url.",
  alternatives: ["tinyfish agent stream", "tinyfish agent check", "tinyfish agent wait", "agent start with webhook_url"],
})

/* ------------------------------------------------------------------------ */
/* Browser Context Profiles, Vault, Wallet                                   */
/* ------------------------------------------------------------------------ */

export const profileList = requestJson({
  provider: "tinyfish",
  method: "GET",
  path: "/v1/profiles",
  responseSchema: JsonRecord,
})

export const profileCreate = (input: ProfileCreateInput) =>
  requestJson({
    provider: "tinyfish",
    method: "POST",
    path: "/v1/profiles",
    body: defined(input),
    responseSchema: JsonRecord,
  })

export const profileInspect = (input: ProfileIdInput) =>
  requestJson({
    provider: "tinyfish",
    method: "GET",
    path: `/v1/profiles/${pathId(input.profile_id)}`,
    responseSchema: JsonRecord,
  })

export const profileUpdate = ({ profile_id, ...patch }: ProfileUpdateInput) =>
  requestJson({
    provider: "tinyfish",
    method: "PATCH",
    path: `/v1/profiles/${pathId(profile_id)}`,
    body: defined(patch),
    responseSchema: JsonRecord,
  })

export const profileDelete = (input: ProfileIdInput) =>
  requestJson({
    provider: "tinyfish",
    method: "DELETE",
    path: `/v1/profiles/${pathId(input.profile_id)}`,
    responseSchema: JsonRecord,
  })

export const vaultConnections = requestJson({
  provider: "tinyfish",
  method: "GET",
  path: "/v1/vault/connections",
  responseSchema: JsonRecord,
})

export const vaultItems = requestJson({
  provider: "tinyfish",
  method: "GET",
  path: "/v1/vault/items",
  responseSchema: JsonRecord,
})

export const vaultSync = requestJson({
  provider: "tinyfish",
  method: "POST",
  path: "/v1/vault/items/sync",
  responseSchema: JsonRecord,
})

export const wallet = requestJson({
  provider: "tinyfish",
  method: "GET",
  path: "/v1/wallet",
  responseSchema: JsonRecord,
})

/* ------------------------------------------------------------------------ */
/* Research (beta)                                                           */
/* ------------------------------------------------------------------------ */

const RESEARCH_NEXT_ACTIONS = {
  check: "tinyfish research check",
  inspect: "tinyfish research inspect",
  wait: "tinyfish research wait",
  events: "tinyfish research events",
  cancel: "tinyfish research cancel",
}

/** deep_result.citations is a list of URL strings; evidence[] carries url+title. */
export const researchSources = (run: ResearchRun) => {
  const cited = (run.deep_result?.citations ?? []).map((url) => ({ url }))
  return [...extractUrls(run.evidence ?? null), ...cited]
}

export const researchStart = Effect.fn("tinyfish.researchStart")(function* (input: ResearchStartInput) {
  const started = yield* requestJson({
    provider: "tinyfish",
    method: "POST",
    path: "/v1/automation/run-research-async",
    body: defined(input),
    responseSchema: ResearchAsyncResponseSchema,
  })
  if (!started.research_run_id) {
    return yield* new ApiResponseError({
      provider: "tinyfish",
      method: "POST",
      path: "/v1/automation/run-research-async",
      status: 200,
      message: "TinyFish did not return a research_run_id",
      body: started,
    })
  }
  yield* recordRun({
    provider: "tinyfish",
    kind: "tinyfish.research",
    remoteId: started.research_run_id,
    status: "queued",
    payload: input,
  })
  return {
    research_run_id: started.research_run_id,
    status: "QUEUED",
    lifecycle: {
      provider_async: true,
      supported_actions: ["check", "inspect", "wait", "events", "cancel", "list"],
      unsupported_actions: [],
    },
    next_actions: RESEARCH_NEXT_ACTIONS,
  }
})

export const researchGet = (input: ResearchIdInput) =>
  requestJson({
    provider: "tinyfish",
    method: "GET",
    path: `/v1/research-run/${pathId(input.research_run_id)}`,
    responseSchema: ResearchRunSchema,
  })

const researchSnapshot = (run: ResearchRun) => ({
  completed: run.status === "COMPLETED",
  terminal: isTerminal(run.status),
  research_run_id: run.research_run_id,
  status: run.status,
  report: run.deep_result?.result ?? null,
  citations: run.deep_result?.citations ?? [],
  run,
  ...(isTerminal(run.status) ? {} : { next_action: "tinyfish research wait", next_actions: RESEARCH_NEXT_ACTIONS }),
})

const settleResearch = (run: ResearchRun) =>
  Effect.gen(function* () {
    yield* syncRunByRemote(run.research_run_id, run.status)
    yield* recordSources("tinyfish", researchSources(run))
  })

export const researchCheck = Effect.fn("tinyfish.researchCheck")(function* (input: ResearchIdInput) {
  const run = yield* researchGet(input)
  if (isTerminal(run.status)) yield* settleResearch(run)
  return researchSnapshot(run)
})

export const researchWait = Effect.fn("tinyfish.researchWait")(function* (input: ResearchWaitInput) {
  const { current, timed_out } = yield* pollUntilTerminal({
    fetch: researchGet({ research_run_id: input.research_run_id }),
    // Research runs take 5-20 min (deep) or 5-45 min (max).
    maxWaitSeconds: input.max_wait_seconds ?? 1800,
    pollIntervalSeconds: input.poll_interval_seconds ?? 15,
  })
  if (!timed_out) yield* settleResearch(current)
  return { ...researchSnapshot(current), timed_out }
})

export const researchRun = Effect.fn("tinyfish.researchRun")(function* (input: ResearchRunInput) {
  const started = yield* researchStart(stripLocal(input))
  return yield* researchWait({
    research_run_id: started.research_run_id,
    max_wait_seconds: input.max_wait_seconds,
    poll_interval_seconds: input.poll_interval_seconds,
  })
})

export const researchCancel = Effect.fn("tinyfish.researchCancel")(function* (input: ResearchIdInput) {
  const cancelled = yield* requestJson({
    provider: "tinyfish",
    method: "POST",
    path: `/v1/research-run/${pathId(input.research_run_id)}/cancel`,
    responseSchema: JsonRecord,
  })
  if (typeof cancelled.status === "string") {
    yield* syncRunByRemote(input.research_run_id, cancelled.status)
  }
  return cancelled
})

export const researchList = (input: ResearchListInput) =>
  requestJson({
    provider: "tinyfish",
    method: "GET",
    path: "/v1/research-run",
    urlParams: toUrlParams(input),
    responseSchema: ResearchListSchema,
  })

export const researchEvents = Effect.fn("tinyfish.researchEvents")(function* (input: ResearchEventsInput) {
  const streamed = yield* readEventStream({
    method: "GET",
    path: `/v1/research-run/${pathId(input.research_run_id)}/events`,
    ...(input.last_event_id ? { headers: { "last-event-id": input.last_event_id } } : {}),
    maxWaitMs: (input.max_wait_seconds ?? 30) * 1000,
    isFinal: (frame) => frame.event === "done",
  })
  const lastId = [...streamed.frames].reverse().find((frame) => frame.id !== undefined)?.id
  return {
    research_run_id: input.research_run_id,
    event_count: streamed.frames.length,
    done: streamed.finished,
    timed_out: streamed.timed_out,
    last_event_id: lastId ?? null,
    events: streamed.frames,
    ...(streamed.finished ? {} : { next_action: "tinyfish research events", resume_with: { last_event_id: lastId } }),
  }
})

/* ------------------------------------------------------------------------ */
/* Monitors                                                                  */
/* ------------------------------------------------------------------------ */

const MonitorRecord = JsonRecord

const monitorIdOf = (value: unknown) => {
  const monitor = isRecord(value) && isRecord(value.monitor) ? value.monitor : value
  return isRecord(monitor) && typeof monitor.id === "string" ? monitor.id : undefined
}

export const monitorCreate = Effect.fn("tinyfish.monitorCreate")(function* (input: MonitorCreateInput) {
  const created = yield* requestJson({
    provider: "tinyfish",
    method: "POST",
    path: "/v1/monitors",
    body: defined(input),
    responseSchema: MonitorRecord,
  })
  const run = yield* recordRun({
    provider: "tinyfish",
    kind: "tinyfish.monitor",
    remoteId: monitorIdOf(created),
    status: "running",
    payload: input,
  })
  yield* recordSources("tinyfish", extractUrls(created.run ?? null), run?.id)
  return created
})

export const monitorList = requestJson({
  provider: "tinyfish",
  method: "GET",
  path: "/v1/monitors",
  responseSchema: MonitorRecord,
})

export const monitorInspect = (input: MonitorIdInput) =>
  requestJson({
    provider: "tinyfish",
    method: "GET",
    path: `/v1/monitors/${pathId(input.id)}`,
    responseSchema: MonitorRecord,
  })

export const monitorUpdate = Effect.fn("tinyfish.monitorUpdate")(function* (input: MonitorUpdateInput) {
  const { id, status, ...edits } = input
  const editFields = Object.entries(edits).filter(([, value]) => value !== undefined)
  if (status !== undefined && editFields.length > 0) {
    return yield* new CommandInputError({
      field: "status",
      message: "status updates cannot be combined with field edits; send them separately",
    })
  }
  if (status === undefined && editFields.length === 0) {
    return yield* new CommandInputError({ field: "id", message: "nothing to update" })
  }
  return yield* requestJson({
    provider: "tinyfish",
    method: "PATCH",
    path: `/v1/monitors/${pathId(id)}`,
    body: status !== undefined ? { status } : Object.fromEntries(editFields),
    responseSchema: MonitorRecord,
  })
})

export const monitorDelete = Effect.fn("tinyfish.monitorDelete")(function* (input: MonitorIdInput) {
  const deleted = yield* requestJson({
    provider: "tinyfish",
    method: "DELETE",
    path: `/v1/monitors/${pathId(input.id)}`,
    responseSchema: MonitorRecord,
  })
  yield* syncRunByRemote(input.id, "CANCELLED")
  return deleted
})

export const monitorTrigger = Effect.fn("tinyfish.monitorTrigger")(function* (input: MonitorIdInput) {
  const triggered = yield* requestJson({
    provider: "tinyfish",
    method: "POST",
    path: `/v1/monitors/${pathId(input.id)}/runs`,
    responseSchema: MonitorRecord,
  })
  yield* recordSources("tinyfish", extractUrls(triggered.run ?? null))
  return triggered
})

export const monitorEventsUnsupported = (input: MonitorIdInput) => ({
  provider: "tinyfish",
  id: input.id,
  capability: "monitor.events",
  supported: false,
  reason:
    "TinyFish does not provide a Monitor run-history endpoint (history is dashboard-only). Scheduled runs are delivered to webhook_url.",
  alternatives: ["tinyfish monitor trigger", "tinyfish monitor inspect", "monitor create with webhook_url"],
})
