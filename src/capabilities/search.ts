import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { toErrorDetails } from "../core/output"
import { recordSources } from "../core/runs"
import { ProviderName } from "../core/registry"
import { routeProviders, Tier, withTier } from "../core/tiers"
import { mergeResults, toResults, type NormalizedResult, type ProviderOutcome } from "./normalize"
import { exaApi } from "../providers/exa"
import { parallelApi } from "../providers/parallel"
import { keenableApi } from "../providers/keenable"
import { firecrawlApi } from "../providers/firecrawl"
import { tinyfishApi } from "../providers/tinyfish"
import { unifiedFetch } from "./fetch"

const SearchProviders = Schema.Array(ProviderName)
const SEARCH_ADAPTERS: ReadonlyArray<ProviderName> = ["exa", "parallel", "keenable", "firecrawl", "tinyfish"]

export const UnifiedSearchInput = Schema.Struct({
  query: Schema.NonEmptyString,
  num_results: Schema.optional(Schema.Int),
  providers: Schema.optional(SearchProviders),
  timeout_ms: Schema.optional(Schema.Int),
  tier: Schema.optional(Tier.annotate({
    description: "free: only keyless/local access (no account credits). any (default): keyed where configured.",
  })),
  /** Read the top n fused results into the corpus after searching (default 0 = search only). */
  read_top: Schema.optional(Schema.Int),
  read_concurrency: Schema.optional(Schema.Int),
  /** Reuse a corpus copy younger than this instead of fetching again. */
  max_age_ms: Schema.optional(Schema.Int),
  /** Fetch provider order for the read step (default: the unified fetch order). */
  read_providers: Schema.optional(Schema.Array(ProviderName)),
  /** Corpus tags for the documents read. */
  tags: Schema.optional(Schema.Array(Schema.String)),
  exa: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  parallel: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  keenable: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  firecrawl: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  tinyfish: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type UnifiedSearchInput = typeof UnifiedSearchInput.Type

const runProvider = (
  provider: ProviderName,
  input: UnifiedSearchInput,
): Effect.Effect<ProviderOutcome, never, AppEnv> =>
  Effect.gen(function* () {
    const numResults = input.num_results ?? 8
    const overrides =
      provider === "exa"
        ? (input.exa ?? {})
        : provider === "parallel"
          ? (input.parallel ?? {})
          : provider === "keenable"
            ? (input.keenable ?? {})
            : provider === "tinyfish"
              ? (input.tinyfish ?? {})
              : {}
    let payload: unknown
    if (provider === "exa") {
      payload = yield* exaApi.webSearch({ query: input.query, numResults: numResults, ...overrides } as never)
    } else if (provider === "parallel") {
      payload = yield* parallelApi.search({ objective: input.query, max_results: numResults, ...overrides } as never)
    } else if (provider === "keenable") {
      payload = yield* keenableApi.search({ query: input.query, max_results: numResults, ...overrides } as never)
    } else if (provider === "firecrawl") {
      payload = yield* firecrawlApi.search({ query: input.query, limit: numResults, ...overrides } as never)
    } else if (provider === "tinyfish") {
      // No result-count parameter; trim the first page locally.
      const page = yield* tinyfishApi.search({ query: input.query, ...overrides } as never)
      payload = { ...page, results: page.results.slice(0, numResults) }
    } else {
      return {
        provider,
        ok: false,
        results: [],
        error: { type: "ProviderUnsupportedError", message: `${provider} does not support search` },
      } satisfies ProviderOutcome
    }
    return { provider, ok: true, results: toResults(payload), raw: payload } as unknown as ProviderOutcome
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        provider,
        ok: false,
        results: [],
        error: toErrorDetails(error),
      } satisfies ProviderOutcome),
    ),
  ) as Effect.Effect<ProviderOutcome, never, AppEnv>

const DEFAULT_READ_CONCURRENCY = 3

/** Fetch the top `read_top` results into the corpus; each row gets `corpus` or `read_error`. */
const readTop = (results: ReadonlyArray<NormalizedResult>, input: UnifiedSearchInput) =>
  Effect.gen(function* () {
    const count = Math.max(0, input.read_top ?? 0)
    if (count === 0) return results
    const concurrency = Math.max(1, input.read_concurrency ?? DEFAULT_READ_CONCURRENCY)

    const reads = yield* Effect.forEach(
      results.slice(0, count),
      (result) =>
        Effect.result(
          unifiedFetch({
            url: result.url,
            ...(input.tier ? { tier: input.tier } : {}),
            ...(input.read_providers ? { providers: input.read_providers } : {}),
            ...(input.max_age_ms !== undefined ? { max_age_ms: input.max_age_ms } : {}),
            ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
            ...(input.tags ? { tags: input.tags } : {}),
          }),
        ),
      { concurrency },
    )

    return results.map((result, index) => {
      const read = reads[index]
      if (read === undefined) return result
      if (read._tag === "Failure") return { ...result, read_error: toErrorDetails(read.failure) }
      const fetched = read.success
      return {
        ...result,
        read: {
          provider: fetched.provider,
          cached: fetched.cached,
          chars: fetched.content?.length ?? 0,
        },
        ...("corpus" in fetched && fetched.corpus
          ? {
              corpus: {
                id: fetched.corpus.id,
                version: fetched.corpus.version,
                changed: fetched.corpus.changed,
              },
            }
          : {}),
      }
    })
  })

export const unifiedSearch = Effect.fn("unifiedSearch")(function* (
  input: UnifiedSearchInput,
) {
  const { eligible, skipped } = yield* routeProviders({
    requested: input.providers ?? SEARCH_ADAPTERS,
    adapters: SEARCH_ADAPTERS,
    capability: "search",
    tier: input.tier,
  })

  const outcomes = yield* Effect.forEach(eligible, ({ provider }) => runProvider(provider, input), {
    concurrency: "unbounded",
  }).pipe(withTier(input.tier))

  for (const outcome of outcomes) {
    if (outcome.ok) {
      yield* recordSources(
        outcome.provider,
        outcome.results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet })),
      )
    }
  }

  const merged = mergeResults(outcomes)
  const results = yield* readTop(merged, input)

  return {
    query: input.query,
    results,
    providers_used: outcomes.filter((o) => o.ok).map((o) => o.provider),
    routing: eligible.map(({ provider, access }) => ({ provider, mode: access.mode, cost: access.cost })),
    failures: outcomes
      .filter((o) => !o.ok)
      .map((o) => ({ provider: o.provider, error: o.error })),
    skipped,
    dedupe: {
      before: outcomes.reduce((acc, o) => acc + o.results.length, 0),
      after: results.length,
      corroborated: results.filter((r) => r.providers.length > 1).length,
    },
  }
})

export const searchCommand = makeJsonCommand({
  name: "search",
  commandName: "search",
  description: "Fan out a web search across Exa, Parallel, Keenable, Firecrawl, and TinyFish; dedupe by canonical URL with provider provenance",
  schema: UnifiedSearchInput,
  run: (input) => unifiedSearch(input),
})

registerContract({
  command: "search",
  description: "Unified cross-provider web search (Exa, Parallel, Keenable, Firecrawl, TinyFish) with dedupe and provenance",
  inputSchema: UnifiedSearchInput,
  examples: [
    {
      name: "basic fan-out",
      input: { query: "effect typescript schema v4", num_results: 5 },
    },
    {
      name: "explicit providers",
      input: { query: "firecrawl v2 extract", providers: ["exa", "keenable"] },
    },
    {
      name: "free tier only",
      description: "Route only to keyless endpoints; never spends account credits",
      input: { query: "bun sqlite wal mode", tier: "free" },
    },
    {
      name: "search and read the top 3 into the corpus",
      description: "One call = search + read: the top fused results are fetched (tier/read_providers/max_age_ms respected) and stored; each carries corpus {id, version, changed} or read_error.",
      input: { query: "bun sqlite fts5 bm25", read_top: 3, tier: "free", max_age_ms: 86400000, tags: ["sqlite"] },
    },
    {
      name: "tinyfish news override",
      input: { query: "web agents", providers: ["tinyfish"], tinyfish: { domain_type: "news", recency_minutes: 1440 } },
    },
  ],
})
