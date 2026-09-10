import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { toErrorDetails } from "../core/output"
import { recordRun, recordSources, updateRun, extractUrls } from "../core/runs"
import { canonicalizeUrl, Store } from "../core/store"
import { loadProviderConfig, ProviderName } from "../core/registry"
import { exaApi } from "../providers/exa"
import { firecrawlApi } from "../providers/firecrawl"
import { parallelApi } from "../providers/parallel"

export const ResearchInput = Schema.Struct({
  query: Schema.NonEmptyString,
  providers: Schema.optional(Schema.Array(ProviderName)),
  depth: Schema.optional(Schema.Literals(["quick", "standard", "deep"])),
  wait: Schema.optional(Schema.Boolean),
  timeout_ms: Schema.optional(Schema.Int),
  output_schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  exa: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  parallel: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  firecrawl: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
        return { provider, ok: true, remote_id: remoteId, output: checked, sources: collectUrls(checked) }
      }
      if (["failed", "error", "errored", "canceled", "cancelled"].includes(status)) {
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

export const research = Effect.fn("research")(function* (input: ResearchInput) {
  const requested =
    input.providers ?? (["exa", "parallel", "firecrawl"] as const)
  const timeoutMs = input.timeout_ms ?? (input.depth === "deep" ? 900_000 : 300_000)
  const wait = input.wait ?? true

  const run = yield* recordRun({
    provider: "survey",
    kind: "survey.research",
    status: "running",
    payload: input,
  })

  const eligible: Array<ProviderName> = []
  const skipped: Array<{ provider: string; reason: string }> = []
  for (const provider of requested) {
    const config = yield* loadProviderConfig(provider)
    if (config.credential === undefined) {
      skipped.push({ provider, reason: "no API key configured" })
    } else if (!["exa", "parallel", "firecrawl"].includes(provider)) {
      skipped.push({ provider, reason: "provider has no deep-research adapter" })
    } else {
      eligible.push(provider)
    }
  }

  const outcomes = yield* Effect.forEach(
    eligible,
    (provider): Effect.Effect<ProviderResearchOutcome, never, AppEnv> => {
      const overrides = input[provider as "exa" | "parallel" | "firecrawl"] ?? {}
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
  )

  const allSources = outcomes.flatMap((o) => o.sources)
  const sourceMap = new Map<string, { url: string; canonical_url: string; providers: Set<string>; title?: string }>()
  for (const outcome of outcomes) {
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

  const succeeded = outcomes.filter((o) => o.ok)
  yield* updateRun(run?.id, {
    status: succeeded.length > 0 ? "succeeded" : "failed",
  })

  return {
    run_id: run?.id ?? null,
    query: input.query,
    providers: outcomes.map((o) => ({
      provider: o.provider,
      ok: o.ok,
      remote_id: o.remote_id ?? null,
      source_count: o.sources.length,
      ...(o.error ? { error: o.error } : {}),
    })),
    reports: Object.fromEntries(
      outcomes.filter((o) => o.ok).map((o) => [o.provider, o.output]),
    ),
    sources,
    citation_intersection: {
      total_sources: sources.length,
      corroborated: sources.filter((s) => s.corroborated).length,
      providers_succeeded: succeeded.length,
      providers_attempted: outcomes.length,
    },
    skipped,
  }
})

export const researchCommand = makeJsonCommand({
  name: "research",
  commandName: "research",
  description: "Composite deep-research: fan out to Exa/Parallel/Firecrawl agents, fuse sources, score citation intersection",
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
  ],
})
