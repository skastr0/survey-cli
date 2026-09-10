import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { toErrorDetails } from "../core/output"
import { recordSources } from "../core/runs"
import { loadProviderConfig, ProviderName } from "../core/registry"
import { mergeResults, toResults, type NormalizedResult, type ProviderOutcome } from "./normalize"
import { exaApi } from "../providers/exa"
import { parallelApi } from "../providers/parallel"
import { keenableApi } from "../providers/keenable"
import { firecrawlApi } from "../providers/firecrawl"

const SearchProviders = Schema.Array(ProviderName)

export const UnifiedSearchInput = Schema.Struct({
  query: Schema.NonEmptyString,
  num_results: Schema.optional(Schema.Int),
  providers: Schema.optional(SearchProviders),
  timeout_ms: Schema.optional(Schema.Int),
  exa: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  parallel: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  keenable: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  firecrawl: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
  const requested = input.providers ?? (["exa", "parallel", "keenable", "firecrawl"] as const)

  const eligible: Array<ProviderName> = []
  const skipped: Array<{ provider: string; reason: string }> = []
  for (const provider of requested) {
    if (!["exa", "parallel", "keenable", "firecrawl"].includes(provider)) {
      skipped.push({ provider, reason: "provider does not support unified search" })
      continue
    }
    const config = yield* loadProviderConfig(provider)
    if (config.credential === undefined && provider !== "keenable") {
      skipped.push({ provider, reason: "no API key configured" })
      continue
    }
    eligible.push(provider)
  }

  const outcomes = yield* Effect.forEach(eligible, (p) => runProvider(p, input), {
    concurrency: "unbounded",
  })

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
  description: "Fan out a web search across Exa, Parallel, Keenable, and Firecrawl; dedupe by canonical URL with provider provenance",
  schema: UnifiedSearchInput,
  run: (input) => unifiedSearch(input),
})

registerContract({
  command: "search",
  description: "Unified cross-provider web search (Exa, Parallel, Keenable, Firecrawl) with dedupe and provenance",
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
  ],
})
