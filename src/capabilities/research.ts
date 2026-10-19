import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { toErrorDetails } from "../core/output"
import { recordRun, recordSources, updateRun, extractUrls } from "../core/runs"
import { canonicalizeUrl, Store } from "../core/store"
import { ProviderName } from "../core/registry"
import { routeProviders, Tier, withTier } from "../core/tiers"
import { exaApi } from "../providers/exa"
import { firecrawlApi } from "../providers/firecrawl"
import { parallelApi } from "../providers/parallel"
import { tinyfishApi } from "../providers/tinyfish"
import { Domain, wantsPapers } from "./academic"
import { papers as searchPapers } from "./papers"
import { corpusRef, renderOutput, rememberReport, shortHash } from "./report"
import { unifiedSearch } from "./search"

const RESEARCH_ADAPTERS: ReadonlyArray<ProviderName> = ["exa", "parallel", "firecrawl", "tinyfish"]

export const ResearchInput = Schema.Struct({
  query: Schema.NonEmptyString,
  providers: Schema.optional(Schema.Array(ProviderName)),
  depth: Schema.optional(Schema.Literals(["quick", "standard", "deep"])),
  wait: Schema.optional(Schema.Boolean),
  timeout_ms: Schema.optional(Schema.Int),
  output_schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  domain: Schema.optional(Domain),
  tier: Schema.optional(Tier.annotate({
    description:
      "free: skip keyed deep-research agents; use keyless paper index and keyless web search instead. any (default).",
  })),
  /** Remember the final report in the corpus as kind "report" (default true). */
  store: Schema.optional(Schema.Boolean),
  tags: Schema.optional(Schema.Array(Schema.String)),
  exa: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  parallel: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  firecrawl: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  tinyfish: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type ResearchInput = typeof ResearchInput.Type

interface ProviderResearchOutcome {
  readonly provider: string
  readonly ok: boolean
  readonly remote_id?: string
  readonly output?: unknown
  readonly sources: ReadonlyArray<{ url: string; title?: string | undefined; snippet?: string | undefined }>
  readonly error?: unknown
}

const collectUrls = (value: unknown): ReadonlyArray<{ url: string; title?: string | undefined; snippet?: string | undefined }> =>
  extractUrls(value)

const startAndWait = (
  provider: string,
  start: Effect.Effect<unknown, unknown, AppEnv>,
  check: (remoteId: string) => Effect.Effect<unknown, unknown, AppEnv>,
  remoteIdOf: (startResult: unknown) => string | undefined,
  timeoutMs: number,
  sourcesOf: (output: unknown) => ProviderResearchOutcome["sources"] = collectUrls,
): Effect.Effect<ProviderResearchOutcome, never, AppEnv> =>
  Effect.gen(function* () {
    const started = yield* start
    const remoteId = remoteIdOf(started)
    if (!remoteId) {
      return { provider, ok: true, output: started, sources: collectUrls(started) }
    }
    const deadline = Date.now() + timeoutMs
    let latest: unknown = started
    while (Date.now() < deadline) {
      const checked = yield* check(remoteId)
      latest = checked
      const status =
        checked && typeof checked === "object" && "status" in checked
          ? String((checked as Record<string, unknown>).status).toLowerCase()
          : "unknown"
      if (["completed", "succeeded", "success", "done"].includes(status)) {
        return { provider, ok: true, remote_id: remoteId, output: checked, sources: sourcesOf(checked) }
      }
      if (["failed", "error", "errored", "canceled", "cancelled", "timed_out"].includes(status)) {
        return {
          provider,
          ok: false,
          remote_id: remoteId,
          output: checked,
          sources: collectUrls(checked),
          error: { type: "JobFailed", message: `${provider} run ended with status ${status}` },
        }
      }
      yield* Effect.sleep(2500)
    }
    return {
      provider,
      ok: false,
      remote_id: remoteId,
      output: latest,
      sources: collectUrls(latest),
      error: { type: "JobWaitTimeoutError", message: `${provider} run exceeded ${timeoutMs}ms` },
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        provider,
        ok: false,
        sources: [],
        error: toErrorDetails(error),
      } satisfies ProviderResearchOutcome),
    ),
  ) as Effect.Effect<ProviderResearchOutcome, never, AppEnv>

const researchMarkdown = (parts: {
  readonly query: string
  readonly reports: Record<string, unknown>
  readonly lanes: ReadonlyArray<ProviderResearchOutcome>
  readonly sources: ReadonlyArray<{ url: string; title?: string | undefined; providers: ReadonlyArray<string>; corroborated: boolean }>
  readonly failed: ReadonlyArray<ProviderResearchOutcome>
}) => {
  const sections = [`# Research: ${parts.query}`]
  for (const [provider, output] of Object.entries(parts.reports)) {
    sections.push(`## ${provider}\n\n${renderOutput(output)}`)
  }
  for (const lane of parts.lanes) {
    sections.push(`## ${lane.provider} (evidence)\n\n${renderOutput(lane.output)}`)
  }
  if (parts.sources.length > 0) {
    sections.push(
      `## Sources\n\n${parts.sources
        .map((s) => `- ${s.title ? `${s.title} — ` : ""}${s.url} (${s.providers.join(", ")}${s.corroborated ? ", corroborated" : ""})`)
        .join("\n")}`,
    )
  }
  if (parts.failed.length > 0) {
    sections.push(`## Providers that failed\n\n${parts.failed.map((o) => `- ${o.provider}`).join("\n")}`)
  }
  return sections.join("\n\n")
}

export const research = Effect.fn("research")(function* (input: ResearchInput) {
  const timeoutMs = input.timeout_ms ?? (input.depth === "deep" ? 900_000 : 300_000)
  const wait = input.wait ?? true

  const run = yield* recordRun({
    provider: "survey",
    kind: "survey.research",
    status: "running",
    payload: input,
  })

  const routed = yield* routeProviders({
    requested: input.providers ?? RESEARCH_ADAPTERS,
    adapters: RESEARCH_ADAPTERS,
    capability: "deep_research",
    tier: input.tier,
  })
  const eligible = routed.eligible.map(({ provider }) => provider)
  const skipped = routed.skipped

  // Keyless evidence lanes: the paper index for academic questions, and a
  // keyless web search when no deep-research agent can run.
  const academic = wantsPapers(input.domain, input.query)
  const papersLane = academic
    ? searchPapers({
        query: input.query,
        question: input.query,
        k: input.depth === "deep" ? 20 : 10,
        read_top: input.depth === "quick" ? 1 : 3,
        ...(input.tier ? { tier: input.tier } : {}),
      }).pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error: toErrorDetails(error) })),
      )
    : Effect.succeed(undefined)
  const webLane =
    eligible.length === 0
      ? unifiedSearch({ query: input.query, num_results: 10, ...(input.tier ? { tier: input.tier } : {}) }).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error: toErrorDetails(error) })),
        )
      : Effect.succeed(undefined)

  const [outcomes, papersOutcome, webOutcome] = yield* Effect.all([
    Effect.forEach(
    eligible,
    (provider): Effect.Effect<ProviderResearchOutcome, never, AppEnv> => {
      const overrides = input[provider as "exa" | "parallel" | "firecrawl" | "tinyfish"] ?? {}
      if (provider === "exa") {
        const effort = input.depth === "deep" ? "high" : input.depth === "quick" ? "low" : "medium"
        return startAndWait(
          provider,
          exaApi.agentStart({
            query: input.query,
            effort,
            outputSchema: input.output_schema,
            ...overrides,
          } as never),
          (id) => exaApi.agentCheck({ id } as never),
          (result) => {
            const r = result as Record<string, unknown>
            return typeof r.id === "string" ? r.id : typeof r.runId === "string" ? r.runId : undefined
          },
          timeoutMs,
        )
      }
      if (provider === "parallel") {
        const processor = input.depth === "deep" ? "pro" : "base"
        return startAndWait(
          provider,
          parallelApi.deepResearchStart({
            input: input.query,
            processor,
            ...(input.output_schema
              ? { output_schema: { type: "json", json_schema: input.output_schema } }
              : {}),
            ...overrides,
          } as never),
          (id) => parallelApi.taskCheck({ run_id: id } as never),
          (result) => {
            const r = result as Record<string, unknown>
            return typeof r.task_id === "string"
              ? r.task_id
              : typeof r.run_id === "string"
                ? r.run_id
                : typeof r.id === "string"
                  ? r.id
                  : undefined
          },
          timeoutMs,
        )
      }
      if (provider === "tinyfish") {
        // Research API (beta): deep = 5-20 min, max = 5-45 min. No output_schema support.
        return startAndWait(
          provider,
          tinyfishApi.researchStart({
            query: input.query,
            mode: input.depth === "deep" ? "max" : "deep",
            ...overrides,
          } as never),
          (id) => tinyfishApi.researchCheck({ research_run_id: id }),
          (result) => {
            const r = result as Record<string, unknown>
            return typeof r.research_run_id === "string" ? r.research_run_id : undefined
          },
          timeoutMs,
          (output) => {
            const run = (output as { run?: unknown }).run
            return run ? tinyfishApi.researchSources(run as never) : collectUrls(output)
          },
        )
      }
      return startAndWait(
        provider,
        firecrawlApi.agentStart({
          prompt: input.query,
          ...(input.output_schema ? { schema: input.output_schema } : {}),
          ...overrides,
        } as never),
        (id) => firecrawlApi.agentCheck({ id } as never),
        (result) => {
          const r = result as Record<string, unknown>
          return typeof r.id === "string" ? r.id : undefined
        },
        timeoutMs,
      )
    },
    { concurrency: "unbounded" },
    ).pipe(withTier(input.tier)),
    papersLane,
    webLane,
  ], { concurrency: "unbounded" })

  const laneOutcomes: Array<ProviderResearchOutcome> = []
  if (papersOutcome?.ok && papersOutcome.result.count > 0) {
    laneOutcomes.push({
      provider: "papers",
      ok: true,
      output: papersOutcome.result,
      sources: papersOutcome.result.papers.flatMap((paper) =>
        paper.url ? [{ url: paper.url, title: paper.title ?? undefined }] : [],
      ),
    })
  }
  if (webOutcome?.ok && webOutcome.result.results.length > 0) {
    laneOutcomes.push({
      provider: "web",
      ok: true,
      output: webOutcome.result,
      sources: webOutcome.result.results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet })),
    })
  }
  const fused = [...outcomes, ...laneOutcomes]

  const allSources = fused.flatMap((o) => o.sources)
  const sourceMap = new Map<string, { url: string; canonical_url: string; providers: Set<string>; title?: string }>()
  for (const outcome of fused) {
    for (const source of outcome.sources) {
      const canonical = canonicalizeUrl(source.url)
      const existing = sourceMap.get(canonical)
      if (existing) {
        existing.providers.add(outcome.provider)
      } else {
        sourceMap.set(canonical, {
          url: source.url,
          canonical_url: canonical,
          providers: new Set([outcome.provider]),
          ...(source.title ? { title: source.title } : {}),
        })
      }
    }
  }

  const sources = [...sourceMap.values()]
    .map((s) => ({
      url: s.url,
      canonical_url: s.canonical_url,
      title: s.title,
      providers: [...s.providers],
      corroborated: s.providers.size > 1,
    }))
    .sort((a, b) => b.providers.length - a.providers.length)

  if (run?.id) {
    yield* recordSources("survey", allSources, run.id)
  }

  const succeeded = fused.filter((o) => o.ok)
  yield* updateRun(run?.id, {
    status: succeeded.length > 0 ? "succeeded" : "failed",
  })

  const reports = Object.fromEntries(outcomes.filter((o) => o.ok).map((o) => [o.provider, o.output]))
  const reportUrl = `survey://research/${run?.id ?? shortHash(`${input.query}\n${Date.now()}`)}`
  const remembered =
    input.store === false || succeeded.length === 0
      ? undefined
      : yield* rememberReport({
          url: reportUrl,
          title: `Research: ${input.query}`,
          tags: input.tags,
          content: researchMarkdown({
            query: input.query,
            reports,
            lanes: laneOutcomes,
            sources,
            failed: fused.filter((o) => !o.ok),
          }),
          metadata: {
            run_id: run?.id ?? null,
            query: input.query,
            depth: input.depth ?? "standard",
            domain: academic ? "academic" : "web",
            providers_attempted: fused.map((o) => o.provider),
            providers_succeeded: succeeded.map((o) => o.provider),
            source_count: sources.length,
            corroborated: sources.filter((s) => s.corroborated).length,
          },
        })

  return {
    run_id: run?.id ?? null,
    ...corpusRef(remembered, reportUrl),
    query: input.query,
    providers: outcomes.map((o) => ({
      provider: o.provider,
      ok: o.ok,
      remote_id: o.remote_id ?? null,
      source_count: o.sources.length,
      ...(o.error ? { error: o.error } : {}),
    })),
    reports,
    routing: routed.eligible.map(({ provider, access }) => ({ provider, mode: access.mode, cost: access.cost })),
    domain: academic ? "academic" : "web",
    papers: papersOutcome === undefined ? null : papersOutcome.ok ? papersOutcome.result : { error: papersOutcome.error },
    web_search: webOutcome === undefined ? null : webOutcome.ok ? webOutcome.result : { error: webOutcome.error },
    sources,
    citation_intersection: {
      total_sources: sources.length,
      corroborated: sources.filter((s) => s.corroborated).length,
      providers_succeeded: succeeded.length,
      providers_attempted: fused.length,
    },
    skipped,
  }
})

export const researchCommand = makeJsonCommand({
  name: "research",
  commandName: "research",
  description:
    "Composite deep-research: fan out to Exa/Parallel/Firecrawl agents and TinyFish Research (plus the keyless paper index for academic queries), fuse sources, score citation intersection",
  schema: ResearchInput,
  run: (input) => research(input),
})

registerContract({
  command: "research",
  description: "Cross-provider composite deep research with citation intersection",
  inputSchema: ResearchInput,
  examples: [
    {
      name: "standard research",
      input: { query: "Compare the pricing of managed Bun hosting providers", depth: "standard" },
    },
    {
      name: "exa only",
      input: { query: "What is effect cluster?", providers: ["exa"], depth: "quick" },
    },
    {
      name: "academic with paper index",
      input: { query: "How do state space models compare to transformers on long-context benchmarks?", domain: "academic" },
    },
    {
      name: "free tier",
      description: "No account credits: keyless paper index plus keyless web search",
      input: { query: "Evidence on intermittent fasting and longevity in clinical trials", tier: "free" },
    },
    {
      name: "keep the report out of the corpus / tag it",
      description: "Reports are remembered as kind report at survey://research/<run id> unless store is false; the response carries corpus {id, version, changed, created, url}.",
      input: { query: "Who maintains the Bun runtime?", store: false },
    },
    {
      name: "tagged report",
      input: { query: "State of WASI preview 2 adoption", tags: ["wasm", "q4"] },
    },
    {
      name: "exa + tinyfish jury",
      input: { query: "Who maintains the Bun runtime?", providers: ["exa", "tinyfish"], tinyfish: { recency_minutes: 525600 } },
    },
  ],
})
