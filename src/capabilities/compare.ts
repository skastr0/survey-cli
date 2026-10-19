import { Effect } from "effect"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import type { NormalizedResult } from "./normalize"
import { UnifiedSearchInput, unifiedSearch } from "./search"

/**
 * Provider evaluation view over one fan-out search: what each index returned,
 * where they agree, and what only one of them found. Built from the fused
 * result set's per-provider ranks, so it costs exactly one `search`.
 */

export const compareResults = (results: ReadonlyArray<NormalizedResult>, providers: ReadonlyArray<string>) => {
  const lists = new Map<string, Array<NormalizedResult>>()
  for (const provider of providers) lists.set(provider, [])
  for (const result of results) {
    for (const provider of Object.keys(result.ranks ?? {})) {
      lists.get(provider)?.push(result)
    }
  }
  for (const [provider, list] of lists) {
    list.sort((a, b) => (a.ranks?.[provider] ?? 0) - (b.ranks?.[provider] ?? 0))
  }

  const sets = new Map([...lists].map(([provider, list]) => [provider, new Set(list.map((r) => r.canonical_url))]))
  const perProvider = [...lists].map(([provider, list]) => ({
    provider,
    count: list.length,
    unique: list.filter((r) => r.providers.length === 1).length,
    corroborated: list.filter((r) => r.providers.length > 1).length,
    results: list.map((r) => ({
      rank: r.ranks?.[provider] ?? null,
      url: r.url,
      title: r.title ?? null,
      also_in: r.providers.filter((p) => p !== provider),
    })),
  }))

  const names = [...sets.keys()]
  const overlap: Array<{ a: string; b: string; shared: number; jaccard: number }> = []
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = sets.get(names[i]!)!
      const b = sets.get(names[j]!)!
      const shared = [...a].filter((url) => b.has(url)).length
      const union = new Set([...a, ...b]).size
      overlap.push({ a: names[i]!, b: names[j]!, shared, jaccard: union === 0 ? 0 : Number((shared / union).toFixed(3)) })
    }
  }

  const consensus = results
    .filter((r) => r.providers.length > 1)
    .map((r) => ({ url: r.url, title: r.title ?? null, providers: r.providers, ranks: r.ranks ?? {}, fusion_score: r.fusion_score ?? null }))

  return {
    providers: perProvider,
    overlap: overlap.sort((x, y) => y.jaccard - x.jaccard),
    consensus,
    summary: {
      unique_urls: results.length,
      corroborated_urls: consensus.length,
      agreement_rate: results.length === 0 ? 0 : Number((consensus.length / results.length).toFixed(3)),
    },
  }
}

export const compareCommand = makeJsonCommand({
  name: "compare",
  commandName: "compare",
  description:
    "Fan out one search and compare providers: ranked lists, pairwise Jaccard overlap, consensus URLs, agreement rate. Input: same as search {query, providers?, num_results?}. Returns {providers, overlap, consensus, summary}.",
  schema: UnifiedSearchInput,
  run: (input) =>
    Effect.gen(function* () {
      const search = yield* unifiedSearch(input)
      return {
        query: search.query,
        ...compareResults(search.results, search.providers_used),
        failures: search.failures,
        skipped: search.skipped,
      }
    }),
})

registerContract({
  command: "compare",
  description:
    "Fan out one search and compare providers: ranked lists, pairwise Jaccard overlap, consensus URLs, agreement rate. Input: same as search {query, providers?, num_results?}. Returns {providers, overlap, consensus, summary}.",
  output:
    "{ query, providers[{ provider, count, unique, corroborated, results[{ rank, url, title, also_in[] }] }], overlap[{ a, b, shared, jaccard }], consensus[{ url, title, providers[], ranks, fusion_score }], summary: { unique_urls, corroborated_urls, agreement_rate }, failures[{ provider, error }], skipped[{ provider, reason }] }",
  inputSchema: UnifiedSearchInput,
  examples: [
    { name: "all configured providers", input: { query: "vector database benchmarks 2026", num_results: 10 } },
    { name: "two providers", input: { query: "bun sqlite fts5", providers: ["exa", "keenable"] } },
  ],
})
