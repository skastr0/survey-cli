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

  const results = mergeResults(outcomes)

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
      name: "tinyfish news override",
      input: { query: "web agents", providers: ["tinyfish"], tinyfish: { domain_type: "news", recency_minutes: 1440 } },
    },
  ],
})
