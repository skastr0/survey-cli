import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { recallDocument, rememberDocument } from "../core/corpus"
import { registerContract } from "../core/discovery"
import { ApiResponseError, ProviderUnsupportedError } from "../core/errors"
import { toErrorDetails } from "../core/output"
import { recordSources } from "../core/runs"
import { loadProviderConfig, ProviderName } from "../core/registry"
import { exaApi } from "../providers/exa"
import { firecrawlApi } from "../providers/firecrawl"
import { keenableApi } from "../providers/keenable"
import { tinyfishApi } from "../providers/tinyfish"

const DEFAULT_ORDER = ["firecrawl", "tinyfish", "keenable", "exa"] as const

export const UnifiedFetchInput = Schema.Struct({
  url: Schema.NonEmptyString,
  format: Schema.optional(Schema.Literals(["markdown", "text", "html", "auto"])),
  timeout_ms: Schema.optional(Schema.Int),
  max_age_ms: Schema.optional(Schema.Int),
  store: Schema.optional(Schema.Boolean),
  tags: Schema.optional(Schema.Array(Schema.String)),
  providers: Schema.optional(Schema.Array(ProviderName)),
  firecrawl: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  keenable: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  exa: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  tinyfish: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type UnifiedFetchInput = typeof UnifiedFetchInput.Type

const extractContent = (payload: unknown): { content?: string; raw: unknown } => {
  if (!payload || typeof payload !== "object") return { raw: payload }
  const record = payload as Record<string, unknown>
  // firecrawl/keenable nest content under `data`
  const candidate =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : record
  for (const key of ["markdown", "content", "text", "body", "html"]) {
    const value = candidate[key] ?? record[key]
    if (typeof value === "string" && value.length > 0) {
      return { content: value, raw: payload }
    }
  }
  // exa contents returns { results: [{ text, ... }] }
  const results = Array.isArray(candidate.results) ? candidate.results : record.results
  if (Array.isArray(results)) {
    const first = results[0] as Record<string, unknown> | undefined
    if (first && typeof first.text === "string") {
      return { content: first.text, raw: payload }
    }
  }
  return { raw: payload }
}

const titleOf = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record
  const metadata = data.metadata && typeof data.metadata === "object" ? (data.metadata as Record<string, unknown>) : {}
  const results = Array.isArray(data.results) ? (data.results[0] as Record<string, unknown> | undefined) : undefined
  for (const candidate of [data.title, metadata.title, results?.title]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

const tryProvider = (
  provider: ProviderName,
  input: UnifiedFetchInput,
) =>
  Effect.gen(function* () {
    const overrides =
      provider === "firecrawl"
        ? (input.firecrawl ?? {})
        : provider === "keenable"
          ? (input.keenable ?? {})
          : provider === "exa"
            ? (input.exa ?? {})
            : provider === "tinyfish"
              ? (input.tinyfish ?? {})
              : {}
    if (provider === "firecrawl") {
      const format = input.format ?? "markdown"
      const payload = yield* firecrawlApi.scrape({
        url: input.url,
        formats: format === "auto" ? ["markdown"] : [format],
        ...overrides,
      } as never)
      return { payload, ...extractContent(payload) }
    }
    if (provider === "keenable") {
      const payload = yield* keenableApi.fetch({ url: input.url, ...overrides } as never)
      return { payload, ...extractContent(payload) }
    }
    if (provider === "tinyfish") {
      const format = input.format === "html" ? "html" : "markdown"
      const payload = yield* tinyfishApi.fetch({ urls: [input.url], format, ...overrides } as never)
      const first = payload.results[0]
      if (first === undefined || typeof first.text !== "string" || first.text.length === 0) {
        return yield* new ApiResponseError({
          provider,
          method: "POST",
          path: "/",
          status: 200,
          message: payload.errors?.[0]?.error ?? `tinyfish returned no content for ${input.url}`,
          body: payload,
        })
      }
      return { payload, content: first.text, raw: payload }
    }
    if (provider === "exa") {
      const payload = yield* exaApi.contents({ url: input.url, ...overrides } as never)
      return { payload, ...extractContent(payload) }
    }
    return yield* new ProviderUnsupportedError({
      provider,
      capability: "fetch",
      message: `${provider} does not support unified fetch`,
    })
  })

export const unifiedFetch = Effect.fn("unifiedFetch")(function* (
  input: UnifiedFetchInput,
) {
  const order = input.providers ?? DEFAULT_ORDER

  if (input.max_age_ms !== undefined) {
    const cached = yield* recallDocument(input.url, input.max_age_ms)
    // Serving from cache cannot add tags, so a hit missing a requested tag refetches and re-stores.
    const hasTags = (input.tags ?? []).every((tag) => cached?.doc.tags.includes(tag))
    if (cached !== undefined && (input.store === false || hasTags)) {
      return {
        url: input.url,
        provider: cached.doc.provider ?? "corpus",
        content: cached.doc.content as string | null,
        raw: null as unknown,
        attempted: [] as Array<{ provider: string; ok: boolean; error?: unknown }>,
        cached: true,
        age_ms: cached.age_ms,
        corpus: { id: cached.doc.id, version: cached.doc.version, changed: false, created: false },
      }
    }
  }

  const attempted: Array<{ provider: string; ok: boolean; error?: unknown }> = []
  for (const provider of order) {
    if (!["firecrawl", "tinyfish", "keenable", "exa"].includes(provider)) {
      attempted.push({ provider, ok: false, error: "provider does not support fetch" })
      continue
    }
    const config = yield* loadProviderConfig(provider)
    if (config.credential === undefined && provider !== "keenable") {
      attempted.push({ provider, ok: false, error: "no API key configured" })
      continue
    }

    const timed = input.timeout_ms
      ? tryProvider(provider, input).pipe(Effect.timeout(input.timeout_ms))
      : tryProvider(provider, input)
    const outcome = yield* Effect.result(timed)

    if (outcome._tag === "Success") {
      const value = outcome.success as { payload: unknown; content?: string }
      yield* recordSources(provider, [{ url: input.url }])
      const remembered =
        input.store === false || value.content === undefined
          ? undefined
          : yield* rememberDocument({
              url: input.url,
              content: value.content,
              title: titleOf(value.payload),
              provider,
              kind: "web",
              tags: input.tags,
            })
      return {
        url: input.url,
        provider,
        content: (value.content ?? null) as string | null,
        raw: value.payload,
        attempted: [...attempted, { provider, ok: true }],
        cached: false,
        ...(remembered === undefined
          ? {}
          : {
              corpus: {
                id: remembered.id,
                version: remembered.version,
                changed: remembered.changed,
                created: remembered.created,
              },
            }),
      }
    }

    const failure = outcome.failure
    attempted.push({
      provider,
      ok: false,
      error: failure && typeof failure === "object" && "_tag" in failure
        ? toErrorDetails(failure)
        : { type: "TimeoutError", message: `timed out after ${input.timeout_ms}ms` },
    })
  }

  return yield* new ApiResponseError({
    provider: order.join(","),
    method: "GET",
    path: input.url,
    status: 0,
    message: `All fetch providers failed for ${input.url}`,
    body: { attempted },
  })
})

export const fetchCommand = makeJsonCommand({
  name: "fetch",
  commandName: "fetch",
  description:
    "Fetch a URL with provider fallback (firecrawl → tinyfish → keenable → exa). Every fetched page is stored in the local corpus (store:false opts out); max_age_ms serves a fresh-enough corpus copy without a provider call. corpus.changed reports content changes since the last fetch.",
  schema: UnifiedFetchInput,
  run: (input) => unifiedFetch(input),
})

registerContract({
  command: "fetch",
  description: "Fetch URL content with provider fallback chain",
  inputSchema: UnifiedFetchInput,
  examples: [
    { name: "default chain", input: { url: "https://effect.website" } },
    {
      name: "keenable first",
      input: { url: "https://example.com", providers: ["keenable", "exa"] },
    },
    {
      name: "tinyfish first",
      input: { url: "https://example.com", providers: ["tinyfish", "keenable"], tinyfish: { ttl: 0 } },
    },
    { name: "cache for an hour", input: { url: "https://effect.website", max_age_ms: 3600000 } },
    { name: "watch for changes", input: { url: "https://example.com/pricing", tags: ["watch"] } },
  ],
})
