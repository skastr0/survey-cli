import { basename, extname, resolve } from "node:path"

import { Effect, FileSystem, Schema } from "effect"

import { CommandInputError, JobWaitTimeoutError } from "../../core/errors"
import { requestJson } from "../../core/http"
import { summarizeBatchResults, type BatchResultItem, type BatchSummary } from "../../core/batch"
import { setExitCode, toErrorDetails } from "../../core/output"
import { loadProviderConfig } from "../../core/registry"
import type {
  AgentEventsInput,
  AgentListInput,
  AgentStartInput,
  BatchStartInput,
  ChangeTrackingMode,
  CommonScrapeInput,
  CrawlStartInput,
  ExtractStartInput,
  InteractExecuteInput,
  JobCheckInput,
  JobIdInput,
  JsonRecord,
  JsonSchema,
  MapInput,
  NormalizedJobStatus,
  ParseInput,
  ProviderJobKind,
  ProviderJobSnapshot,
  ScrapeInput,
  SearchInput,
  WaitInput,
} from "./schemas"
import { MAX_PARSE_BYTES, PARSE_EXTENSIONS, PARSE_MIME } from "./schemas"

const unknownResponse = Schema.Unknown

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalRecord = (entries: ReadonlyArray<readonly [string, unknown | undefined]>) =>
  Object.fromEntries(
    entries.filter((entry): entry is readonly [string, unknown] => entry[1] !== undefined),
  )

export const failInput = (field: string, message: string) =>
  Effect.fail(new CommandInputError({ field, message }))

export const validateUrl = (field: string, value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: () =>
      new CommandInputError({
        field,
        message: `${field} must be a valid absolute URL; received ${JSON.stringify(value)}`,
      }),
  }).pipe(Effect.as(value))

export const validateNonEmptyString = (field: string, value: string) =>
  value.trim().length > 0
    ? Effect.succeed(value)
    : failInput(field, `${field} must not be empty`)

export const parseJsonSchema = (field: string, value: string | JsonSchema | undefined) => {
  if (value === undefined) {
    return Effect.succeed(undefined)
  }

  if (isRecord(value)) {
    return Effect.succeed(value)
  }

  return Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: () =>
      new CommandInputError({
        field,
        message: `${field} must be valid JSON; pass an object directly or a string containing a JSON object`,
      }),
  }).pipe(
    Effect.flatMap((parsed) =>
      isRecord(parsed)
        ? Effect.succeed(parsed)
        : failInput(field, `${field} must parse to a JSON object`),
    ),
  )
}

/** Narrow `T | readonly T[]` command inputs (Array.isArray loses readonly arrays). */
const isInputArray = <T>(input: T | ReadonlyArray<T>): input is ReadonlyArray<T> =>
  Array.isArray(input)

/** Prefix batch item errors with their positional path (items[i].<field>). */
const withItemPath = (index: number) => (error: CommandInputError) =>
  new CommandInputError({
    field: `items[${index}].${error.field}`,
    message: error.message,
  })

export const normalizeCommonInput = (input: CommonScrapeInput) =>
  Effect.gen(function* () {
    const jsonSchema = yield* parseJsonSchema("json_schema", input.json_schema)
    const changeTrackingSchema = yield* parseJsonSchema(
      "change_tracking.schema",
      input.change_tracking?.schema,
    )
    const changeTrackingModes = new Set(input.change_tracking?.modes ?? [])

    if (changeTrackingSchema !== undefined || input.change_tracking?.prompt !== undefined) {
      changeTrackingModes.add("json")
    }

    if (changeTrackingModes.has("json") && changeTrackingSchema === undefined) {
      return yield* failInput(
        "change_tracking.schema",
        "change_tracking.schema is required for json change tracking",
      )
    }

    return {
      ...input,
      ...(jsonSchema !== undefined ? { json_schema: jsonSchema } : {}),
      ...(input.change_tracking !== undefined
        ? {
            change_tracking: {
              ...input.change_tracking,
              ...(changeTrackingModes.size > 0 ? { modes: [...changeTrackingModes] } : {}),
              ...(changeTrackingSchema !== undefined ? { schema: changeTrackingSchema } : {}),
            },
          }
        : {}),
    } satisfies CommonScrapeInput
  })

export const validateScrapeInput = (input: ScrapeInput) =>
  Effect.gen(function* () {
    const url = yield* validateUrl("url", input.url)
    const common = yield* normalizeCommonInput(input)

    return { ...common, url } satisfies ScrapeInput
  })

export const validateScrapeCommandInput = (
  input: ScrapeInput | ReadonlyArray<ScrapeInput>,
): Effect.Effect<ScrapeInput | ReadonlyArray<ScrapeInput>, CommandInputError> =>
  isInputArray(input)
    ? Effect.forEach(input, (item, index) =>
        validateScrapeInput(item).pipe(Effect.mapError(withItemPath(index))),
      )
    : validateScrapeInput(input)

export const validateBatchStartInput = (input: BatchStartInput) =>
  Effect.gen(function* () {
    const urls = yield* Effect.forEach(input.urls, (url, index) =>
      validateUrl(`urls[${index}]`, url),
    )
    const common = yield* normalizeCommonInput(input)

    return { ...common, urls } satisfies BatchStartInput
  })

export const validateJobIdInput = (input: JobIdInput) =>
  Effect.gen(function* () {
    const id = yield* validateNonEmptyString("id", input.id)

    return { id } satisfies JobIdInput
  })

export const validateJobCheckInput = (input: JobCheckInput) =>
  Effect.gen(function* () {
    const id = yield* validateNonEmptyString("id", input.id)

    if (input.next_url !== undefined) {
      yield* validateUrl("next_url", input.next_url)
    }

    return {
      id,
      ...(input.next_url !== undefined ? { next_url: input.next_url } : {}),
    } satisfies JobCheckInput
  })

export const validateWaitInput = (input: WaitInput) =>
  validateJobCheckInput(input).pipe(
    Effect.map(
      (validated) =>
        ({
          ...validated,
          ...(input.poll_interval_ms !== undefined
            ? { poll_interval_ms: input.poll_interval_ms }
            : {}),
          ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
        }) satisfies WaitInput,
    ),
  )

export const validateCrawlStartInput = (input: CrawlStartInput) =>
  Effect.gen(function* () {
    const url = yield* validateUrl("url", input.url)
    const scrapeOptions =
      input.scrape_options === undefined
        ? undefined
        : yield* normalizeCommonInput(input.scrape_options)

    return {
      ...input,
      url,
      ...(scrapeOptions !== undefined ? { scrape_options: scrapeOptions } : {}),
    } satisfies CrawlStartInput
  })

export const validateMapInput = (input: MapInput) =>
  Effect.gen(function* () {
    const url = yield* validateUrl("url", input.url)

    return { ...input, url } satisfies MapInput
  })

export const validateMapCommandInput = (
  input: MapInput | ReadonlyArray<MapInput>,
): Effect.Effect<MapInput | ReadonlyArray<MapInput>, CommandInputError> =>
  isInputArray(input)
    ? Effect.forEach(input, (item, index) =>
        validateMapInput(item).pipe(Effect.mapError(withItemPath(index))),
      )
    : validateMapInput(input)

export const validateSearchInput = (input: SearchInput) =>
  Effect.gen(function* () {
    if (input.query.trim().length === 0) {
      return yield* failInput("query", "query must not be empty")
    }

    if (input.include_domains !== undefined && input.exclude_domains !== undefined) {
      return yield* failInput(
        "include_domains",
        "include_domains and exclude_domains cannot be used together",
      )
    }

    const scrapeOptions =
      input.scrape_options === undefined
        ? undefined
        : yield* normalizeCommonInput(input.scrape_options)

    return {
      ...input,
      ...(scrapeOptions !== undefined ? { scrape_options: scrapeOptions } : {}),
    } satisfies SearchInput
  })

export const validateSearchCommandInput = (
  input: SearchInput | ReadonlyArray<SearchInput>,
): Effect.Effect<SearchInput | ReadonlyArray<SearchInput>, CommandInputError> =>
  isInputArray(input)
    ? Effect.forEach(input, (item, index) =>
        validateSearchInput(item).pipe(Effect.mapError(withItemPath(index))),
      )
    : validateSearchInput(input)

export const validateExtractStartInput = (input: ExtractStartInput) =>
  Effect.gen(function* () {
    const prompt = input.prompt?.trim()
    const schema = yield* parseJsonSchema("schema", input.schema)
    const urls =
      input.urls === undefined
        ? undefined
        : yield* Effect.forEach(input.urls, (url, index) =>
            validateUrl(`urls[${index}]`, url),
          )

    if (
      (urls === undefined || urls.length === 0) &&
      (prompt === undefined || prompt.length === 0) &&
      schema === undefined
    ) {
      return yield* failInput(
        "prompt",
        "extract requires urls, prompt, or schema; for new work prefer agent start",
      )
    }

    const scrapeOptions =
      input.scrape_options === undefined
        ? undefined
        : yield* normalizeCommonInput(input.scrape_options)

    return {
      ...input,
      ...(prompt !== undefined && prompt.length > 0 ? { prompt } : {}),
      ...(schema !== undefined ? { schema } : {}),
      ...(urls !== undefined ? { urls } : {}),
      ...(scrapeOptions !== undefined ? { scrape_options: scrapeOptions } : {}),
    } satisfies ExtractStartInput
  })

export const validateAgentStartInput = (input: AgentStartInput) =>
  Effect.gen(function* () {
    const prompt = yield* validateNonEmptyString("prompt", input.prompt)
    const urls =
      input.urls === undefined
        ? undefined
        : yield* Effect.forEach(input.urls, (url, index) =>
            validateUrl(`urls[${index}]`, url),
          )
    const schema = yield* parseJsonSchema("schema", input.schema)

    if (input.webhook !== undefined) {
      yield* validateUrl("webhook.url", input.webhook.url)
    }

    return {
      ...input,
      prompt,
      ...(urls !== undefined ? { urls } : {}),
      ...(schema !== undefined ? { schema } : {}),
    } satisfies AgentStartInput
  })

export const validateAgentEventsInput = (input: AgentEventsInput) =>
  validateJobIdInput(input).pipe(
    Effect.map((validated) => ({
      ...validated,
      ...(input.live_view !== undefined ? { live_view: input.live_view } : {}),
    })),
  )

export const validateInteractExecuteInput = (input: InteractExecuteInput) =>
  Effect.gen(function* () {
    const id = yield* validateNonEmptyString("id", input.id)
    const prompt = input.prompt?.trim()
    const code = input.code?.trim()

    if (
      (prompt === undefined || prompt.length === 0) &&
      (code === undefined || code.length === 0)
    ) {
      return yield* failInput(
        "prompt",
        "interact execute requires prompt or code; pass a natural-language prompt or Playwright/agent-browser code",
      )
    }

    if (prompt !== undefined && prompt.length > 0 && code !== undefined && code.length > 0) {
      return yield* failInput(
        "prompt",
        "interact execute accepts prompt or code, not both; Firecrawl POST /scrape/{id}/interact rejects payloads that include both fields",
      )
    }

    if (input.language !== undefined && (code === undefined || code.length === 0)) {
      return yield* failInput("language", "language is only valid with code")
    }

    return {
      id,
      ...(prompt !== undefined && prompt.length > 0 ? { prompt } : {}),
      ...(code !== undefined && code.length > 0 ? { code } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    } satisfies InteractExecuteInput
  })

const isParseExtension = (value: string): value is (typeof PARSE_EXTENSIONS)[number] =>
  (PARSE_EXTENSIONS as ReadonlyArray<string>).includes(value)

export const validateParseInput = (input: ParseInput) =>
  Effect.gen(function* () {
    if (input.path.trim().length === 0) {
      return yield* failInput("path", "path must not be empty")
    }

    const extension = extname(input.path).toLowerCase()
    if (!isParseExtension(extension)) {
      return yield* failInput(
        "path",
        `path must use a Firecrawl-supported document extension (${PARSE_EXTENSIONS.join(", ")})`,
      )
    }

    const jsonSchema = yield* parseJsonSchema("json_schema", input.json_schema)

    return {
      ...input,
      path: resolve(input.path),
      ...(jsonSchema !== undefined ? { json_schema: jsonSchema } : {}),
    } satisfies ParseInput
  })

export const validateParseCommandInput = (
  input: ParseInput | ReadonlyArray<ParseInput>,
): Effect.Effect<ParseInput | ReadonlyArray<ParseInput>, CommandInputError> =>
  isInputArray(input)
    ? Effect.forEach(input, (item, index) =>
        validateParseInput(item).pipe(Effect.mapError(withItemPath(index))),
      )
    : validateParseInput(input)

const buildFormats = (input: CommonScrapeInput) =>
  Effect.gen(function* () {
    const formats: Array<unknown> = [...(input.formats ?? [])]
    const jsonSchema = yield* parseJsonSchema("json_schema", input.json_schema)

    if (jsonSchema !== undefined || input.json_prompt !== undefined) {
      formats.push({
        type: "json",
        ...(jsonSchema !== undefined ? { schema: jsonSchema } : {}),
        ...(input.json_prompt !== undefined ? { prompt: input.json_prompt } : {}),
        ...(input.json_check_prompt_injection !== undefined
          ? { checkPromptInjection: input.json_check_prompt_injection }
          : {}),
      })
    }

    if (input.question !== undefined) {
      formats.push({ type: "question", question: input.question })
    }

    if (input.highlights_query !== undefined) {
      formats.push({ type: "highlights", query: input.highlights_query })
    }

    if (input.screenshot !== undefined) {
      formats.push({ type: "screenshot", ...input.screenshot })
    }

    if (input.change_tracking !== undefined) {
      formats.push({
        type: "changeTracking",
        ...(input.change_tracking as {
          modes?: Array<ChangeTrackingMode>
          schema?: JsonSchema
          prompt?: string
          tag?: string
        }),
      })

      if (!formats.includes("markdown")) {
        formats.unshift("markdown")
      }
    }

    return formats.length > 0 ? formats : ["markdown"]
  })

export const buildScrapeOptions = (input: CommonScrapeInput) =>
  Effect.gen(function* () {
    const formats = yield* buildFormats(input)

    const hasPdfOptions =
      input.pdf_parser_mode !== undefined ||
      input.pdf_max_pages !== undefined ||
      input.pdf_pages !== undefined ||
      input.pdf_blocks !== undefined ||
      input.pdf_page_markers !== undefined

    const redactPii =
      input.redact_pii === undefined || typeof input.redact_pii === "boolean"
        ? input.redact_pii
        : {
            ...(input.redact_pii.mode !== undefined ? { mode: input.redact_pii.mode } : {}),
            ...(input.redact_pii.entities !== undefined
              ? { entities: input.redact_pii.entities }
              : {}),
            ...(input.redact_pii.replace_style !== undefined
              ? { replaceStyle: input.redact_pii.replace_style }
              : {}),
          }

    return {
      formats,
      ...(input.only_main_content !== undefined
        ? { onlyMainContent: input.only_main_content }
        : {}),
      ...(input.only_clean_content !== undefined
        ? { onlyCleanContent: input.only_clean_content }
        : {}),
      ...(input.include_tags !== undefined ? { includeTags: input.include_tags } : {}),
      ...(input.exclude_tags !== undefined ? { excludeTags: input.exclude_tags } : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.wait_for !== undefined ? { waitFor: input.wait_for } : {}),
      ...(input.max_age !== undefined ? { maxAge: input.max_age } : {}),
      ...(input.min_age !== undefined ? { minAge: input.min_age } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
      ...(input.skip_tls_verification !== undefined
        ? { skipTlsVerification: input.skip_tls_verification }
        : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
      ...(input.store_in_cache !== undefined ? { storeInCache: input.store_in_cache } : {}),
      ...(input.remove_base64_images !== undefined
        ? { removeBase64Images: input.remove_base64_images }
        : {}),
      ...(input.block_ads !== undefined ? { blockAds: input.block_ads } : {}),
      ...(input.lockdown !== undefined ? { lockdown: input.lockdown } : {}),
      ...(redactPii !== undefined ? { redactPII: redactPii } : {}),
      ...(input.profile !== undefined
        ? {
            profile: {
              name: input.profile.name,
              ...(input.profile.save_changes !== undefined
                ? { saveChanges: input.profile.save_changes }
                : {}),
            },
          }
        : {}),
      ...(input.zero_data_retention !== undefined
        ? { zeroDataRetention: input.zero_data_retention }
        : {}),
      ...(input.actions !== undefined ? { actions: input.actions } : {}),
      ...(hasPdfOptions
        ? {
            parsers: [
              {
                type: "pdf" as const,
                ...(input.pdf_parser_mode !== undefined
                  ? { mode: input.pdf_parser_mode }
                  : {}),
                ...(input.pdf_max_pages !== undefined
                  ? { maxPages: input.pdf_max_pages }
                  : {}),
                ...(input.pdf_pages !== undefined ? { pages: input.pdf_pages } : {}),
                ...(input.pdf_blocks !== undefined ? { blocks: input.pdf_blocks } : {}),
                ...(input.pdf_page_markers !== undefined
                  ? { pageMarkers: input.pdf_page_markers }
                  : {}),
              },
            ],
          }
        : {}),
    }
  })

/* ------------------------------------------------------------------------ */
/* Job snapshots                                                             */
/* ------------------------------------------------------------------------ */

const extractString = (value: unknown, key: string) =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined

const extractNumber = (value: unknown, key: string) =>
  isRecord(value) && typeof value[key] === "number" ? value[key] : undefined

const extractDataCount = (value: unknown) =>
  isRecord(value) && Array.isArray(value.data) ? value.data.length : undefined

const normalizeStatus = (status: string | undefined): NormalizedJobStatus => {
  switch (status?.toLowerCase()) {
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelled":
    case "canceled":
      return "canceled"
    case "scraping":
    case "active":
    case "running":
    case "processing":
      return "running"
    case "queued":
    case "pending":
      return "queued"
    default:
      return "unknown"
  }
}

const isTerminalStatus = (status: NormalizedJobStatus) =>
  status === "succeeded" || status === "failed" || status === "canceled"

export const normalizeJobSnapshot = (
  kind: ProviderJobKind,
  response: unknown,
  fallbackId?: string,
  submitted = false,
): ProviderJobSnapshot => {
  const providerStatus = submitted ? "submitted" : extractString(response, "status")
  const status = submitted ? "submitted" : normalizeStatus(providerStatus)
  const id = extractString(response, "id") ?? fallbackId
  const completed = extractNumber(response, "completed")
  const total = extractNumber(response, "total")
  const creditsUsed = extractNumber(response, "creditsUsed")
  const progress = optionalRecord([
    ["completed", completed],
    ["total", total],
    ["credits_used", creditsUsed],
  ]) as NonNullable<ProviderJobSnapshot["progress"]>
  const next = isRecord(response) && "next" in response ? response.next : undefined
  const expiresAt = extractString(response, "expiresAt")
  const dataCount = extractDataCount(response)

  return {
    provider: "firecrawl",
    kind,
    ...(id !== undefined ? { id } : {}),
    status,
    ...(providerStatus !== undefined ? { provider_status: providerStatus } : {}),
    terminal: isTerminalStatus(status),
    ...(Object.keys(progress).length > 0 ? { progress } : {}),
    ...(typeof next === "string" || next === null ? { next_url: next } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(dataCount !== undefined ? { data_count: dataCount } : {}),
    provider_response: response,
  }
}

export const unsupportedEventStream = (kind: ProviderJobKind, input: JobIdInput) => ({
  provider: "firecrawl",
  kind,
  id: input.id,
  capability: `${kind}.events`,
  supported: false,
  reason:
    kind === "batch_scrape"
      ? "Firecrawl's REST batch scrape API exposes polling, pagination, cancellation, errors, and webhooks, but this CLI has no provider event stream endpoint to subscribe to."
      : kind === "crawl"
        ? "Firecrawl crawl realtime updates are exposed through SDK/WebSocket watcher workflows; this CLI exposes REST polling through check and wait."
        : kind === "extract"
          ? "Firecrawl extract exposes job polling through GET /extract/{id}, but no cancel or event-stream endpoint."
          : "Firecrawl agent jobs expose REST polling and a trace snapshot; this CLI has no SSE event stream.",
  alternatives:
    kind === "batch_scrape"
      ? ["batch check", "batch wait", "batch errors", "batch start with provider webhook"]
      : kind === "crawl"
        ? ["crawl check", "crawl wait", "crawl errors", "crawl start with provider webhook"]
        : kind === "extract"
          ? ["extract check", "extract wait", "agent start"]
          : ["agent check", "agent wait", "agent events"],
})

/* ------------------------------------------------------------------------ */
/* Local (client-side) ordered batching                                      */
/* ------------------------------------------------------------------------ */

export interface LocalBatchItem extends BatchResultItem {
  readonly target: Readonly<Record<string, string>>
}

export interface LocalBatchResult extends BatchSummary {
  readonly results: ReadonlyArray<LocalBatchItem>
}

/**
 * Run provider calls for an ordered input array with per-item results.
 * Mirrors `runMutationBatch` semantics (exit code 1 on partial failure) while
 * keeping the firecrawl-cli `target` field on each item.
 */
export const runLocalBatch = <A, E, R>(
  inputs: ReadonlyArray<A>,
  concurrency: number,
  target: (input: A) => Readonly<Record<string, string>>,
  run: (input: A) => Effect.Effect<unknown, E, R>,
): Effect.Effect<LocalBatchResult, never, R> =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(
      inputs,
      (input, index) =>
        run(input).pipe(
          Effect.result,
          Effect.map(
            (result): LocalBatchItem =>
              result._tag === "Success"
                ? { index, ok: true, target: target(input), data: result.success }
                : {
                    index,
                    ok: false,
                    target: target(input),
                    error: toErrorDetails(result.failure),
                  },
          ),
        ),
      { concurrency },
    )

    const summary = summarizeBatchResults(concurrency, results)
    if (summary.error_count > 0) {
      yield* setExitCode(1)
    }
    return { ...summary, results } satisfies LocalBatchResult
  })

export const validateConcurrency = (concurrency: number) =>
  concurrency >= 1
    ? Effect.succeed(concurrency)
    : failInput("concurrency", "concurrency must be at least 1")

/* ------------------------------------------------------------------------ */
/* Provider calls                                                            */
/* ------------------------------------------------------------------------ */

/**
 * `check` accepts an absolute `next_url` (Firecrawl paginates job results with
 * absolute URLs). The shared HTTP client always prepends the configured base
 * URL, so translate next_url into a path relative to that base — keeping the
 * bearer credential on the configured host rather than forwarding it to
 * whatever origin appears in the payload.
 */
const resolveJobPath = (nextUrl: string | undefined, fallbackPath: string) =>
  Effect.gen(function* () {
    if (nextUrl === undefined) {
      return fallbackPath
    }
    if (nextUrl.startsWith("/")) {
      return nextUrl
    }
    const config = yield* loadProviderConfig("firecrawl")
    const base = new URL(config.apiBaseUrl)
    const target = yield* Effect.try({
      try: () => new URL(nextUrl),
      catch: () =>
        new CommandInputError({
          field: "next_url",
          message: "next_url must be a valid absolute URL",
        }),
    })
    const basePath = base.pathname.replace(/\/+$/, "")
    const path =
      basePath.length > 0 && target.pathname.startsWith(basePath)
        ? target.pathname.slice(basePath.length)
        : target.pathname
    return `${path.startsWith("/") ? path : `/${path}`}${target.search}`
  })

export const scrape = (input: ScrapeInput) =>
  Effect.gen(function* () {
    const options = yield* buildScrapeOptions(input)

    return yield* requestJson({
      provider: "firecrawl",
      method: "POST",
      path: "/scrape",
      body: {
        url: input.url,
        ...options,
      },
      responseSchema: unknownResponse,
    })
  })

export const runScrapeCommand = (
  input: ScrapeInput | ReadonlyArray<ScrapeInput>,
  concurrency: number,
) =>
  isInputArray(input)
    ? runLocalBatch(input, concurrency, (item) => ({ url: item.url }), scrape)
    : scrape(input)

export const batchScrapeStart = (input: BatchStartInput) =>
  Effect.gen(function* () {
    const options = yield* buildScrapeOptions(input)
    const response = yield* requestJson({
      provider: "firecrawl",
      method: "POST",
      path: "/batch/scrape",
      body: {
        urls: input.urls,
        ...options,
        ...(input.max_concurrency !== undefined
          ? { maxConcurrency: input.max_concurrency }
          : {}),
        ...(input.ignore_invalid_urls !== undefined
          ? { ignoreInvalidURLs: input.ignore_invalid_urls }
          : {}),
        ...(input.webhook !== undefined ? { webhook: input.webhook } : {}),
      },
      responseSchema: unknownResponse,
    })

    return normalizeJobSnapshot("batch_scrape", response, undefined, true)
  })

export const batchScrapeCheck = (input: JobCheckInput) =>
  Effect.gen(function* () {
    const path = yield* resolveJobPath(
      input.next_url,
      `/batch/scrape/${encodeURIComponent(input.id)}`,
    )
    const response = yield* requestJson({
      provider: "firecrawl",
      method: "GET",
      path,
      responseSchema: unknownResponse,
    })
    return normalizeJobSnapshot("batch_scrape", response, input.id)
  })

export const batchScrapeCancel = (input: JobIdInput) =>
  requestJson({
    provider: "firecrawl",
    method: "DELETE",
    path: `/batch/scrape/${encodeURIComponent(input.id)}`,
    responseSchema: unknownResponse,
  }).pipe(
    Effect.map((response) => ({
      provider: "firecrawl" as const,
      kind: "batch_scrape" as const,
      id: input.id,
      status: "canceled" as const,
      terminal: true,
      provider_response: response,
    })),
  )

export const batchScrapeErrors = (input: JobIdInput) =>
  requestJson({
    provider: "firecrawl",
    method: "GET",
    path: `/batch/scrape/${encodeURIComponent(input.id)}/errors`,
    responseSchema: unknownResponse,
  }).pipe(
    Effect.map((response) => ({
      provider: "firecrawl" as const,
      kind: "batch_scrape" as const,
      id: input.id,
      errors_count:
        isRecord(response) && Array.isArray(response.errors)
          ? response.errors.length
          : undefined,
      robots_blocked_count:
        isRecord(response) && Array.isArray(response.robotsBlocked)
          ? response.robotsBlocked.length
          : undefined,
      provider_response: response,
    })),
  )

export const crawlStart = (input: CrawlStartInput) =>
  Effect.gen(function* () {
    const scrapeOptions =
      input.scrape_options === undefined
        ? undefined
        : yield* buildScrapeOptions(input.scrape_options)
    const response = yield* requestJson({
      provider: "firecrawl",
      method: "POST",
      path: "/crawl",
      body: {
        url: input.url,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.exclude_paths !== undefined ? { excludePaths: input.exclude_paths } : {}),
        ...(input.include_paths !== undefined ? { includePaths: input.include_paths } : {}),
        ...(input.max_discovery_depth !== undefined
          ? { maxDiscoveryDepth: input.max_discovery_depth }
          : {}),
        ...(input.sitemap !== undefined ? { sitemap: input.sitemap } : {}),
        ...(input.ignore_query_parameters !== undefined
          ? { ignoreQueryParameters: input.ignore_query_parameters }
          : {}),
        ...(input.regex_on_full_url !== undefined
          ? { regexOnFullURL: input.regex_on_full_url }
          : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.crawl_entire_domain !== undefined
          ? { crawlEntireDomain: input.crawl_entire_domain }
          : {}),
        ...(input.allow_external_links !== undefined
          ? { allowExternalLinks: input.allow_external_links }
          : {}),
        ...(input.allow_subdomains !== undefined
          ? { allowSubdomains: input.allow_subdomains }
          : {}),
        ...(input.ignore_robots_txt !== undefined
          ? { ignoreRobotsTxt: input.ignore_robots_txt }
          : {}),
        ...(input.robots_user_agent !== undefined
          ? { robotsUserAgent: input.robots_user_agent }
          : {}),
        ...(input.delay !== undefined ? { delay: input.delay } : {}),
        ...(input.max_concurrency !== undefined
          ? { maxConcurrency: input.max_concurrency }
          : {}),
        ...(input.webhook !== undefined ? { webhook: input.webhook } : {}),
        ...(scrapeOptions !== undefined ? { scrapeOptions } : {}),
        ...(input.zero_data_retention !== undefined
          ? { zeroDataRetention: input.zero_data_retention }
          : {}),
      },
      responseSchema: unknownResponse,
    })

    return normalizeJobSnapshot("crawl", response, undefined, true)
  })

export const crawlCheck = (input: JobCheckInput) =>
  Effect.gen(function* () {
    const path = yield* resolveJobPath(input.next_url, `/crawl/${encodeURIComponent(input.id)}`)
    const response = yield* requestJson({
      provider: "firecrawl",
      method: "GET",
      path,
      responseSchema: unknownResponse,
    })
    return normalizeJobSnapshot("crawl", response, input.id)
  })

export const crawlCancel = (input: JobIdInput) =>
  requestJson({
    provider: "firecrawl",
    method: "DELETE",
    path: `/crawl/${encodeURIComponent(input.id)}`,
    responseSchema: unknownResponse,
  }).pipe(
    Effect.map((response) => ({
      provider: "firecrawl" as const,
      kind: "crawl" as const,
      id: input.id,
      status: "canceled" as const,
      terminal: true,
      provider_response: response,
    })),
  )

export const crawlErrors = (input: JobIdInput) =>
  requestJson({
    provider: "firecrawl",
    method: "GET",
    path: `/crawl/${encodeURIComponent(input.id)}/errors`,
    responseSchema: unknownResponse,
  }).pipe(
    Effect.map((response) => ({
      provider: "firecrawl" as const,
      kind: "crawl" as const,
      id: input.id,
      errors_count:
        isRecord(response) && Array.isArray(response.errors)
          ? response.errors.length
          : undefined,
      robots_blocked_count:
        isRecord(response) && Array.isArray(response.robotsBlocked)
          ? response.robotsBlocked.length
          : undefined,
      provider_response: response,
    })),
  )

export const mapSite = (input: MapInput) =>
  requestJson({
    provider: "firecrawl",
    method: "POST",
    path: "/map",
    body: {
      url: input.url,
      ...(input.search !== undefined ? { search: input.search } : {}),
      ...(input.sitemap !== undefined ? { sitemap: input.sitemap } : {}),
      ...(input.include_subdomains !== undefined
        ? { includeSubdomains: input.include_subdomains }
        : {}),
      ...(input.ignore_query_parameters !== undefined
        ? { ignoreQueryParameters: input.ignore_query_parameters }
        : {}),
      ...(input.ignore_cache !== undefined ? { ignoreCache: input.ignore_cache } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
    },
    responseSchema: unknownResponse,
  })

export const runMapCommand = (input: MapInput | ReadonlyArray<MapInput>, concurrency: number) =>
  isInputArray(input)
    ? runLocalBatch(input, concurrency, (item) => ({ url: item.url }), mapSite)
    : mapSite(input)

type SearchSourceInput = NonNullable<SearchInput["sources"]>[number]
type SearchCategoryInput = NonNullable<SearchInput["categories"]>[number]

const normalizeSource = (source: SearchSourceInput) =>
  typeof source === "string"
    ? { type: source }
    : {
        type: source.type,
        ...(source.tbs !== undefined ? { tbs: source.tbs } : {}),
        ...(source.location !== undefined ? { location: source.location } : {}),
      }

const normalizeCategory = (category: SearchCategoryInput) =>
  typeof category === "string" ? { type: category } : { type: category.type }

export const searchWeb = (input: SearchInput) =>
  Effect.gen(function* () {
    const scrapeOptions =
      input.scrape_options === undefined
        ? undefined
        : yield* buildScrapeOptions(input.scrape_options)

    return yield* requestJson({
      provider: "firecrawl",
      method: "POST",
      path: "/search",
      body: {
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.sources !== undefined
          ? { sources: input.sources.map(normalizeSource) }
          : {}),
        ...(input.categories !== undefined
          ? { categories: input.categories.map(normalizeCategory) }
          : {}),
        ...(input.include_domains !== undefined
          ? { includeDomains: input.include_domains }
          : {}),
        ...(input.exclude_domains !== undefined
          ? { excludeDomains: input.exclude_domains }
          : {}),
        ...(input.tbs !== undefined ? { tbs: input.tbs } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
        ...(input.safe !== undefined ? { safe: input.safe } : {}),
        ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
        ...(input.ignore_invalid_urls !== undefined
          ? { ignoreInvalidURLs: input.ignore_invalid_urls }
          : {}),
        ...(input.highlights !== undefined ? { highlights: input.highlights } : {}),
        ...(input.enterprise !== undefined ? { enterprise: input.enterprise } : {}),
        ...(scrapeOptions !== undefined ? { scrapeOptions } : {}),
      },
      responseSchema: unknownResponse,
    })
  })

export const runSearchCommand = (
  input: SearchInput | ReadonlyArray<SearchInput>,
  concurrency: number,
) =>
  isInputArray(input)
    ? runLocalBatch(input, concurrency, (item) => ({ query: item.query }), searchWeb)
    : searchWeb(input)

const encodeParseRedactPii = (value: ParseInput["redact_pii"]) => {
  if (value === undefined || typeof value === "boolean") {
    return value
  }

  return {
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
    ...(value.entities !== undefined ? { entities: value.entities } : {}),
    ...(value.replace_style !== undefined ? { replaceStyle: value.replace_style } : {}),
  }
}

const buildParseOptions = (input: ParseInput) =>
  Effect.gen(function* () {
    const formats: Array<unknown> = [...(input.formats ?? [])]
    const jsonSchema = yield* parseJsonSchema("json_schema", input.json_schema)

    if (jsonSchema !== undefined || input.json_prompt !== undefined) {
      formats.push({
        type: "json",
        ...(jsonSchema !== undefined ? { schema: jsonSchema } : {}),
        ...(input.json_prompt !== undefined ? { prompt: input.json_prompt } : {}),
      })
    }

    const hasPdfOptions =
      input.pdf_parser_mode !== undefined ||
      input.pdf_max_pages !== undefined ||
      input.pdf_pages !== undefined ||
      input.pdf_blocks !== undefined ||
      input.pdf_page_markers !== undefined

    return {
      ...(formats.length > 0 ? { formats } : {}),
      ...(input.only_main_content !== undefined
        ? { onlyMainContent: input.only_main_content }
        : {}),
      ...(input.include_tags !== undefined ? { includeTags: input.include_tags } : {}),
      ...(input.exclude_tags !== undefined ? { excludeTags: input.exclude_tags } : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
      ...(hasPdfOptions
        ? {
            parsers: [
              {
                type: "pdf" as const,
                ...(input.pdf_parser_mode !== undefined
                  ? { mode: input.pdf_parser_mode }
                  : {}),
                ...(input.pdf_max_pages !== undefined
                  ? { maxPages: input.pdf_max_pages }
                  : {}),
                ...(input.pdf_pages !== undefined ? { pages: input.pdf_pages } : {}),
                ...(input.pdf_blocks !== undefined ? { blocks: input.pdf_blocks } : {}),
                ...(input.pdf_page_markers !== undefined
                  ? { pageMarkers: input.pdf_page_markers }
                  : {}),
              },
            ],
          }
        : {}),
      ...(input.skip_tls_verification !== undefined
        ? { skipTlsVerification: input.skip_tls_verification }
        : {}),
      ...(input.remove_base64_images !== undefined
        ? { removeBase64Images: input.remove_base64_images }
        : {}),
      ...(input.block_ads !== undefined ? { blockAds: input.block_ads } : {}),
      ...(input.redact_pii !== undefined
        ? { redactPII: encodeParseRedactPii(input.redact_pii) }
        : {}),
      ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
      ...(input.zero_data_retention !== undefined
        ? { zeroDataRetention: input.zero_data_retention }
        : {}),
    }
  })

const readParseFile = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const info = yield* fileSystem.stat(path).pipe(
      Effect.mapError(
        (error) =>
          new CommandInputError({
            field: "path",
            message: `path must point to a readable local file: ${error.message ?? "stat failed"}`,
          }),
      ),
    )

    if (info.type !== "File") {
      return yield* failInput("path", "path must point to a regular file")
    }

    if (info.size > MAX_PARSE_BYTES) {
      return yield* failInput(
        "path",
        `file exceeds the Firecrawl 50 MB parse limit (received ${info.size} bytes)`,
      )
    }

    const bytes = yield* fileSystem.readFile(path).pipe(
      Effect.mapError(
        (error) =>
          new CommandInputError({
            field: "path",
            message: `path must point to a readable local file: ${error.message ?? "read failed"}`,
          }),
      ),
    )

    return bytes
  })

export const parseFile = (input: ParseInput) =>
  Effect.gen(function* () {
    const extension = extname(input.path).toLowerCase()
    if (!isParseExtension(extension)) {
      return yield* failInput(
        "path",
        `path must use a Firecrawl-supported document extension (${PARSE_EXTENSIONS.join(", ")})`,
      )
    }

    const bytes = yield* readParseFile(input.path)
    const options = yield* buildParseOptions(input)
    const formData = new FormData()
    formData.append(
      "file",
      new Blob([Uint8Array.from(bytes)], { type: PARSE_MIME[extension] }),
      basename(input.path),
    )

    if (Object.keys(options).length > 0) {
      formData.append(
        "options",
        new Blob([JSON.stringify(options)], { type: "application/json" }),
      )
    }

    return yield* requestJson({
      provider: "firecrawl",
      method: "POST",
      path: "/parse",
      formData,
      responseSchema: unknownResponse,
    })
  })

export const runParseCommand = (
  input: ParseInput | ReadonlyArray<ParseInput>,
  concurrency: number,
) =>
  isInputArray(input)
    ? runLocalBatch(input, concurrency, (item) => ({ path: item.path }), parseFile)
    : parseFile(input)

export const extractStart = (input: ExtractStartInput) =>
  Effect.gen(function* () {
    const schema = yield* parseJsonSchema("schema", input.schema)
    const scrapeOptions =
      input.scrape_options === undefined
        ? undefined
        : yield* buildScrapeOptions(input.scrape_options)
    const response = yield* requestJson({
      provider: "firecrawl",
      method: "POST",
      path: "/extract",
      body: {
        urls: input.urls ?? [],
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(schema !== undefined ? { schema } : {}),
        ...(input.enable_web_search !== undefined
          ? { enableWebSearch: input.enable_web_search }
          : {}),
        ...(input.ignore_sitemap !== undefined
          ? { ignoreSitemap: input.ignore_sitemap }
          : {}),
        ...(input.include_subdomains !== undefined
          ? { includeSubdomains: input.include_subdomains }
          : {}),
        ...(input.show_sources !== undefined ? { showSources: input.show_sources } : {}),
        ...(scrapeOptions !== undefined ? { scrapeOptions } : {}),
        ...(input.ignore_invalid_urls !== undefined
          ? { ignoreInvalidURLs: input.ignore_invalid_urls }
          : {}),
      },
      responseSchema: unknownResponse,
    })

    return normalizeJobSnapshot("extract", response, undefined, true)
  })

export const extractCheck = (input: JobCheckInput) =>
  Effect.gen(function* () {
    const path = yield* resolveJobPath(
      input.next_url,
      `/extract/${encodeURIComponent(input.id)}`,
    )
    const response = yield* requestJson({
      provider: "firecrawl",
      method: "GET",
      path,
      responseSchema: unknownResponse,
    })
    return normalizeJobSnapshot("extract", response, input.id)
  })

export const agentStart = (input: AgentStartInput) =>
  Effect.gen(function* () {
    const schema = yield* parseJsonSchema("schema", input.schema)
    const response = yield* requestJson({
      provider: "firecrawl",
      method: "POST",
      path: "/agent",
      body: {
        prompt: input.prompt,
        ...(input.urls !== undefined ? { urls: input.urls } : {}),
        ...(schema !== undefined ? { schema } : {}),
        ...(input.max_credits !== undefined ? { maxCredits: input.max_credits } : {}),
        ...(input.strict_constrain_to_urls !== undefined
          ? { strictConstrainToURLs: input.strict_constrain_to_urls }
          : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.webhook !== undefined ? { webhook: input.webhook } : {}),
      },
      responseSchema: unknownResponse,
    })

    return normalizeJobSnapshot("agent", response, undefined, true)
  })

export const agentCheck = (input: JobCheckInput) =>
  Effect.gen(function* () {
    const path = yield* resolveJobPath(input.next_url, `/agent/${encodeURIComponent(input.id)}`)
    const response = yield* requestJson({
      provider: "firecrawl",
      method: "GET",
      path,
      responseSchema: unknownResponse,
    })
    return normalizeJobSnapshot("agent", response, input.id)
  })

export const agentCancel = (input: JobIdInput) =>
  requestJson({
    provider: "firecrawl",
    method: "DELETE",
    path: `/agent/${encodeURIComponent(input.id)}`,
    responseSchema: unknownResponse,
  }).pipe(
    Effect.map((response) => ({
      provider: "firecrawl" as const,
      kind: "agent" as const,
      id: input.id,
      status: "canceled" as const,
      terminal: true,
      provider_response: response,
    })),
  )

export const agentEvents = (input: AgentEventsInput) =>
  requestJson({
    provider: "firecrawl",
    method: "GET",
    path: `/agent/${encodeURIComponent(input.id)}/trace`,
    urlParams: {
      liveView: input.live_view === true ? "true" : input.live_view === false ? "false" : undefined,
    },
    responseSchema: unknownResponse,
  }).pipe(
    Effect.map((response) => ({
      provider: "firecrawl" as const,
      kind: "agent" as const,
      id: input.id,
      capability: "agent.events",
      supported: true,
      transport: "rest-trace",
      notes: [
        "This is GET /agent/{id}/trace, a snapshot of execution events, not an SSE or NDJSON stream.",
      ],
      provider_response: response,
    })),
  )

export const agentList = (input: AgentListInput) =>
  requestJson({
    provider: "firecrawl",
    method: "GET",
    path: "/agent",
    urlParams: {
      before: input.before !== undefined ? String(input.before) : undefined,
    },
    responseSchema: unknownResponse,
  })

export const interactExecute = (input: InteractExecuteInput) =>
  requestJson({
    provider: "firecrawl",
    method: "POST",
    path: `/scrape/${encodeURIComponent(input.id)}/interact`,
    body: {
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    },
    responseSchema: unknownResponse,
  })

export const interactStop = (input: JobIdInput) =>
  requestJson({
    provider: "firecrawl",
    method: "DELETE",
    path: `/scrape/${encodeURIComponent(input.id)}/interact`,
    responseSchema: unknownResponse,
  }).pipe(
    Effect.map((response) => ({
      provider: "firecrawl" as const,
      kind: "interact" as const,
      id: input.id,
      stopped: true,
      provider_response: response,
    })),
  )

/**
 * Poll a job's status URL until it reaches a terminal state.
 * `next` on crawl/batch snapshots is result pagination, not a wait cursor —
 * the poll input stays fixed on the job status URL (firecrawl-cli 7d21790).
 */
export const waitForJob = <E, R>(
  input: WaitInput,
  check: (
    input: JobCheckInput,
  ) => Effect.Effect<ProviderJobSnapshot, E, R>,
): Effect.Effect<
  ProviderJobSnapshot & { waited_ms: number; poll_interval_ms: number },
  E | JobWaitTimeoutError,
  R
> =>
  Effect.gen(function* () {
    const pollIntervalMs = input.poll_interval_ms ?? 2000
    const timeoutMs = input.timeout_ms ?? 120000
    const startedAt = Date.now()
    const pollInput: JobCheckInput = {
      id: input.id,
      ...(input.next_url !== undefined ? { next_url: input.next_url } : {}),
    }
    let latest = yield* check(pollInput)

    while (!latest.terminal) {
      if (Date.now() - startedAt >= timeoutMs) {
        return yield* Effect.fail(
          new JobWaitTimeoutError({
            provider: "firecrawl",
            jobId: input.id,
            timeoutMs,
            lastStatus: latest.status,
            message: `wait timed out after ${timeoutMs}ms; job ${input.id} is still ${latest.status}`,
          }),
        )
      }

      yield* Effect.sleep(`${pollIntervalMs} millis`)
      latest = yield* check(pollInput)
    }

    return {
      ...latest,
      waited_ms: Date.now() - startedAt,
      poll_interval_ms: pollIntervalMs,
    }
  })
