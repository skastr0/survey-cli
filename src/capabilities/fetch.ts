import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { toErrorDetails } from "../core/output"
import { recordSources } from "../core/runs"
import { ProviderName } from "../core/registry"
import { routeProviders, Tier, withTier } from "../core/tiers"
import { exaApi } from "../providers/exa"
import { firecrawlApi } from "../providers/firecrawl"
import { keenableApi } from "../providers/keenable"
import { parallelApi } from "../providers/parallel"

const DEFAULT_ORDER: ReadonlyArray<ProviderName> = ["firecrawl", "keenable", "exa", "parallel"]

export const UnifiedFetchInput = Schema.Struct({
  url: Schema.NonEmptyString,
  format: Schema.optional(Schema.Literals(["markdown", "text", "html", "auto"])),
  timeout_ms: Schema.optional(Schema.Int),
  providers: Schema.optional(Schema.Array(ProviderName)),
  tier: Schema.optional(Tier.annotate({
    description: "free: only keyless/local access (no account credits). any (default): keyed where configured.",
  })),
  firecrawl: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  keenable: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  exa: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  parallel: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
  // exa contents: { results: [{ text }] }; parallel extract: { results: [{ full_content, excerpts }] }
  const results = Array.isArray(candidate.results) ? candidate.results : record.results
  if (Array.isArray(results)) {
    const first = results[0] as Record<string, unknown> | undefined
    if (first && typeof first.text === "string") {
      return { content: first.text, raw: payload }
    }
    if (first && typeof first.full_content === "string" && first.full_content.length > 0) {
      return { content: first.full_content, raw: payload }
    }
    if (first && Array.isArray(first.excerpts) && first.excerpts.length > 0) {
      return { content: first.excerpts.filter((e) => typeof e === "string").join("\n\n"), raw: payload }
    }
  }
  return { raw: payload }
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
            : provider === "parallel"
              ? (input.parallel ?? {})
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
    if (provider === "exa") {
      const payload = yield* exaApi.contents({ url: input.url, ...overrides } as never)
      return { payload, ...extractContent(payload) }
    }
    if (provider === "parallel") {
      const payload = yield* parallelApi.extract({ urls: [input.url], ...overrides } as never)
      return { payload, ...extractContent(payload) }
    }
    return yield* Effect.fail({
      _tag: "ProviderUnsupportedError" as const,
      provider,
      capability: "fetch",
      message: `${provider} does not support unified fetch`,
    })
  })

export const unifiedFetch = Effect.fn("unifiedFetch")(function* (
  input: UnifiedFetchInput,
) {
  const order = input.providers ?? DEFAULT_ORDER
  const { eligible, skipped } = yield* routeProviders({
    requested: order,
    adapters: DEFAULT_ORDER,
    capability: "fetch",
    tier: input.tier,
  })

  const attempted: Array<{ provider: string; ok: boolean; mode?: string; error?: unknown }> =
    skipped.map(({ provider, reason }) => ({ provider, ok: false, error: reason }))
  for (const { provider, access } of eligible) {
    const timed = input.timeout_ms
      ? tryProvider(provider, input).pipe(Effect.timeout(input.timeout_ms))
      : tryProvider(provider, input)
    const outcome = yield* Effect.result(timed.pipe(withTier(input.tier)))

    if (outcome._tag === "Success") {
      const value = outcome.success as { payload: unknown; content?: string }
      yield* recordSources(provider, [{ url: input.url }])
      return {
        url: input.url,
        provider,
        mode: access.mode,
        cost: access.cost,
        content: value.content ?? null,
        raw: value.payload,
        attempted: [...attempted, { provider, ok: true, mode: access.mode }],
      }
    }

    const failure = outcome.failure
    attempted.push({
      provider,
      ok: false,
      mode: access.mode,
      error: failure && typeof failure === "object" && "_tag" in failure
        ? toErrorDetails(failure)
        : { type: "TimeoutError", message: `timed out after ${input.timeout_ms}ms` },
    })
  }

  return yield* Effect.fail({
    _tag: "ApiResponseError" as const,
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
  description: "Fetch a URL with provider fallback (firecrawl → keenable → exa → parallel); keyless where no key is configured",
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
      name: "free tier only",
      input: { url: "https://example.com", tier: "free" },
    },
  ],
})
