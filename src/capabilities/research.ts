import { Effect, FileSystem, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import type { AppEnv } from "../core/env"

import { writeArtifact } from "../core/artifacts"
import { makeJsonCommand } from "../core/command"
import { registerContracts } from "../core/discovery"
import { CommandInputError, JobWaitTimeoutError, StoreError } from "../core/errors"
import { groupSources, independenceView } from "../core/independence"
import { toErrorDetails } from "../core/output"
import { recordRun, recordSources, updateRun, extractUrls, type SourceLike } from "../core/runs"
import { canonicalizeUrl, Store, type RunStatus } from "../core/store"
import { ProviderName } from "../core/registry"
import { routeProviders, Tier, withTier, type RoutedProvider, type SkippedProvider } from "../core/tiers"
import { exaApi } from "../providers/exa"
import { firecrawlApi } from "../providers/firecrawl"
import { parallelApi } from "../providers/parallel"
import { tinyfishApi } from "../providers/tinyfish"
import { Domain, wantsPapers } from "./academic"
import { papers as searchPapers } from "./papers"
import { corpusRef, renderOutput, rememberReport, shortHash } from "./report"
import { normalizeStatus } from "./runs"
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
  readonly sources: ReadonlyArray<SourceLike>
  readonly error?: unknown
}

const collectUrls = (value: unknown): ReadonlyArray<SourceLike> => extractUrls(value)

type JuryProvider = "exa" | "parallel" | "firecrawl" | "tinyfish"

/** One deep-research jury member: how to start it, poll it, and read its sources. */
interface JuryMember {
  readonly provider: JuryProvider
  /** Run kind recorded in the run registry (matches `survey runs` adapters). */
  readonly kind: string
  readonly start: Effect.Effect<unknown, unknown, AppEnv>
  readonly check: (remoteId: string) => Effect.Effect<unknown, unknown, AppEnv>
  readonly remoteIdOf: (startResult: unknown) => string | undefined
  readonly sourcesOf: (output: unknown) => ReadonlyArray<SourceLike>
}

const stringField = (value: unknown, ...keys: ReadonlyArray<string>) => {
  const record = (value ?? {}) as Record<string, unknown>
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string
  }
  return undefined
}

const juryMember = (provider: JuryProvider, input: ResearchInput): JuryMember => {
  const overrides = input[provider] ?? {}
  if (provider === "exa") {
    const effort = input.depth === "deep" ? "high" : input.depth === "quick" ? "low" : "medium"
    return {
      provider,
      kind: "exa.agent",
      start: exaApi.agentStart({ query: input.query, effort, outputSchema: input.output_schema, ...overrides } as never),
      check: (id) => exaApi.agentCheck({ id } as never),
      remoteIdOf: (result) => stringField(result, "id", "runId"),
      sourcesOf: collectUrls,
    }
  }
  if (provider === "parallel") {
    return {
      provider,
      kind: "parallel.task",
      start: parallelApi.deepResearchStart({
        input: input.query,
        processor: input.depth === "deep" ? "pro" : "base",
        ...(input.output_schema ? { output_schema: { type: "json", json_schema: input.output_schema } } : {}),
        ...overrides,
      } as never),
      check: (id) => parallelApi.taskCheck({ run_id: id } as never),
      remoteIdOf: (result) => stringField(result, "task_id", "run_id", "id"),
      sourcesOf: collectUrls,
    }
  }
  if (provider === "tinyfish") {
    // Research API (beta): deep = 5-20 min, max = 5-45 min. No output_schema support.
    return {
      provider,
      kind: "tinyfish.research",
      start: tinyfishApi.researchStart({ query: input.query, mode: input.depth === "deep" ? "max" : "deep", ...overrides } as never),
      check: (id) => tinyfishApi.researchCheck({ research_run_id: id }),
      remoteIdOf: (result) => stringField(result, "research_run_id"),
      sourcesOf: (output) => {
        const run = (output as { run?: unknown }).run
        return run ? tinyfishApi.researchSources(run as never) : collectUrls(output)
      },
    }
  }
  return {
    provider,
    kind: "firecrawl.agent",
    start: firecrawlApi.agentStart({
      prompt: input.query,
      ...(input.output_schema ? { schema: input.output_schema } : {}),
      ...overrides,
    } as never),
    check: (id) => firecrawlApi.agentCheck({ id } as never),
    remoteIdOf: (result) => stringField(result, "id"),
    sourcesOf: collectUrls,
  }
}

const statusText = (checked: unknown) =>
  checked && typeof checked === "object" && "status" in checked
    ? String((checked as Record<string, unknown>).status).toLowerCase()
    : "unknown"

const startAndWait = (member: JuryMember, timeoutMs: number): Effect.Effect<ProviderResearchOutcome, never, AppEnv> =>
  Effect.gen(function* () {
    const { provider } = member
    const started = yield* member.start
    const remoteId = member.remoteIdOf(started)
    if (!remoteId) {
      return { provider, ok: true, output: started, sources: collectUrls(started) }
    }
    const deadline = Date.now() + timeoutMs
    let latest: unknown = started
    while (Date.now() < deadline) {
      const checked = yield* member.check(remoteId)
      latest = checked
      const status = statusText(checked)
      if (["completed", "succeeded", "success", "done"].includes(status)) {
        return { provider, ok: true, remote_id: remoteId, output: checked, sources: member.sourcesOf(checked) }
      }
      if (["failed", "error", "errored", "canceled", "cancelled", "timed_out"].includes(status)) {
        return {
          provider,
          ok: false,
          remote_id: remoteId,
          output: checked,
          sources: collectUrls(checked),
          error: {
            type: "JobFailed",
            message: `${provider} run ended with status ${status}`,
            details: { retryable: false, hint: "Inspect the member run with `survey runs inspect`." },
          },
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
      error: {
        type: "JobWaitTimeoutError",
        message: `${provider} run exceeded ${timeoutMs}ms`,
        details: { retryable: true, hint: "Use `survey research start` + `research check` for long runs." },
      },
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        provider: member.provider,
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

/**
 * Keyless evidence lanes: the paper index for academic questions, and a
 * keyless web search when no deep-research agent can run.
 */
const evidenceLanes = (input: ResearchInput, juryCount: number) => {
  const papersLane = wantsPapers(input.domain, input.query)
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
    juryCount === 0
      ? unifiedSearch({ query: input.query, num_results: 10, ...(input.tier ? { tier: input.tier } : {}) }).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error: toErrorDetails(error) })),
        )
      : Effect.succeed(undefined)
  return Effect.all([papersLane, webLane], { concurrency: "unbounded" })
}

type EvidenceLanes = Effect.Success<ReturnType<typeof evidenceLanes>>

interface RoutingEntry {
  readonly provider: string
  readonly mode: string
  readonly cost: string | null
}

/**
 * Fuse jury outcomes and evidence lanes into the final research result: source
 * ledger, citation intersection, independent source groups, run status, and
 * the report remembered in the corpus (report.ts). Shared by blocking
 * `research` and async `research check|wait`.
 */
const assembleResearch = Effect.fn("assembleResearch")(function* (parts: {
  readonly input: ResearchInput
  readonly runId: string | undefined
  readonly outcomes: ReadonlyArray<ProviderResearchOutcome>
  readonly lanes: EvidenceLanes
  readonly routing: ReadonlyArray<RoutingEntry>
  readonly skipped: ReadonlyArray<SkippedProvider>
}) {
  const { input, runId, outcomes } = parts
  const [papersOutcome, webOutcome] = parts.lanes
  const academic = wantsPapers(input.domain, input.query)

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

  // Same page, same publisher (eTLD+1) or a syndicated title is one source.
  const independence = groupSources(
    fused.flatMap((o) => o.sources.map((source) => ({ url: source.url, title: source.title, provider: o.provider }))),
  )

  const sources = [...sourceMap.values()]
    .map((s) => ({
      url: s.url,
      canonical_url: s.canonical_url,
      title: s.title,
      providers: [...s.providers],
      corroborated: s.providers.size > 1,
      independent_group: independence.group_of.get(s.canonical_url) ?? s.canonical_url,
    }))
    .sort((a, b) => b.providers.length - a.providers.length)
  // Groups reached by more than one provider; several pages of one group still count once.
  const independentCorroborated = independence.groups.filter((g) => g.providers.length > 1).length

  if (runId) {
    yield* recordSources("survey", allSources, runId)
  }

  const succeeded = fused.filter((o) => o.ok)
  yield* updateRun(runId, {
    status: succeeded.length > 0 ? "succeeded" : "failed",
  })

  const reports = Object.fromEntries(outcomes.filter((o) => o.ok).map((o) => [o.provider, o.output]))
  const reportUrl = `survey://research/${runId ?? shortHash(`${input.query}\n${Date.now()}`)}`
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
            run_id: runId ?? null,
            query: input.query,
            depth: input.depth ?? "standard",
            domain: academic ? "academic" : "web",
            providers_attempted: fused.map((o) => o.provider),
            providers_succeeded: succeeded.map((o) => o.provider),
            source_count: sources.length,
            corroborated: sources.filter((s) => s.corroborated).length,
            independent_sources: independence.independent_sources,
          },
        })

  return {
    run_id: runId ?? null,
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
    routing: parts.routing,
    domain: academic ? "academic" : "web",
    papers: papersOutcome === undefined ? null : papersOutcome.ok ? papersOutcome.result : { error: papersOutcome.error },
    web_search: webOutcome === undefined ? null : webOutcome.ok ? webOutcome.result : { error: webOutcome.error },
    sources,
    source_groups: independenceView(independence).groups,
    citation_intersection: {
      total_sources: sources.length,
      corroborated: sources.filter((s) => s.corroborated).length,
      citations: independence.citations,
      independent_sources: independence.independent_sources,
      independent_corroborated: independentCorroborated,
      providers_succeeded: succeeded.length,
      providers_attempted: fused.length,
    },
    skipped: parts.skipped,
  }
})

const routingOf = (eligible: ReadonlyArray<RoutedProvider>): ReadonlyArray<RoutingEntry> =>
  eligible.map(({ provider, access }) => ({ provider, mode: access.mode, cost: access.cost }))

const timeoutOf = (input: ResearchInput) => input.timeout_ms ?? (input.depth === "deep" ? 900_000 : 300_000)

const routeJury = (input: ResearchInput) =>
  routeProviders({
    requested: input.providers ?? RESEARCH_ADAPTERS,
    adapters: RESEARCH_ADAPTERS,
    capability: "deep_research",
    tier: input.tier,
  })

export const research = Effect.fn("research")(function* (input: ResearchInput) {
  const timeoutMs = timeoutOf(input)

  const run = yield* recordRun({
    provider: "survey",
    kind: "survey.research",
    status: "running",
    payload: input,
  })

  const routed = yield* routeJury(input)
  const eligible = routed.eligible.map(({ provider }) => provider as JuryProvider)

  const [outcomes, lanes] = yield* Effect.all([
    Effect.forEach(eligible, (provider) => startAndWait(juryMember(provider, input), timeoutMs), {
      concurrency: "unbounded",
    }).pipe(withTier(input.tier)),
    evidenceLanes(input, eligible.length),
  ], { concurrency: "unbounded" })

  return yield* assembleResearch({
    input,
    runId: run?.id,
    outcomes,
    lanes,
    routing: routingOf(routed.eligible),
    skipped: routed.skipped,
  })
})

/* ------------------------------------------------------------------------ */
/* Non-blocking research: start → check | wait | inspect                    */
/* ------------------------------------------------------------------------ */

/** A jury member as recorded in the async research run's payload. */
interface MemberRecord {
  readonly provider: JuryProvider
  readonly kind: string
  readonly run_id: string | null
  readonly remote_id: string | null
  /** Terminal at start: a synchronous result, or a start failure. */
  readonly status: RunStatus
  readonly output?: unknown
  readonly error?: unknown
}

interface AsyncResearchPayload {
  readonly mode: "async"
  readonly input: ResearchInput
  readonly started_at: number
  readonly members: ReadonlyArray<MemberRecord>
  readonly routing: ReadonlyArray<RoutingEntry>
  readonly skipped: ReadonlyArray<SkippedProvider>
}

interface MemberState {
  readonly provider: JuryProvider
  readonly run_id: string | null
  readonly remote_id: string | null
  readonly status: RunStatus | "timed_out"
  readonly terminal: boolean
  readonly outcome?: ProviderResearchOutcome
  readonly check_error?: unknown
}

const TERMINAL: ReadonlyArray<string> = ["succeeded", "failed", "canceled"]

const memberView = (state: MemberState) => ({
  provider: state.provider,
  run_id: state.run_id,
  remote_id: state.remote_id,
  status: state.status,
  ...(state.outcome ? { source_count: state.outcome.sources.length } : {}),
  ...(state.outcome?.error ? { error: state.outcome.error } : {}),
  ...(state.check_error ? { check_error: state.check_error } : {}),
})

export const ResearchIdInput = Schema.Struct({
  id: Schema.NonEmptyString.annotate({ description: "research_id returned by `research start`." }),
})

export const ResearchWaitInput = Schema.Struct({
  ...ResearchIdInput.fields,
  interval_ms: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 600_000 }))),
  timeout_ms: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 86_400_000 }))),
})

export const researchStart = Effect.fn("researchStart")(function* (input: ResearchInput) {
  const routed = yield* routeJury(input)

  const members = yield* Effect.forEach(
    routed.eligible,
    ({ provider }): Effect.Effect<MemberRecord, never, AppEnv> => {
      const member = juryMember(provider as JuryProvider, input)
      const base = { provider: member.provider, kind: member.kind }
      return member.start.pipe(
        withTier(input.tier),
        Effect.flatMap((started) => {
          const remoteId = member.remoteIdOf(started)
          const status: RunStatus = remoteId ? "running" : "succeeded"
          return recordRun({
            provider: member.provider,
            kind: member.kind,
            remoteId,
            status,
            payload: { research_query: input.query },
          }).pipe(
            Effect.map((child): MemberRecord => ({
              ...base,
              run_id: child?.id ?? null,
              remote_id: remoteId ?? null,
              status,
              ...(remoteId ? {} : { output: started }),
            })),
          )
        }),
        Effect.catch((error) =>
          Effect.succeed<MemberRecord>({ ...base, run_id: null, remote_id: null, status: "failed", error: toErrorDetails(error) }),
        ),
      )
    },
    { concurrency: "unbounded" },
  )

  const payload: AsyncResearchPayload = {
    mode: "async",
    input,
    started_at: Date.now(),
    members,
    routing: routingOf(routed.eligible),
    skipped: routed.skipped,
  }
  const run = yield* recordRun({ provider: "survey", kind: "survey.research", status: "running", payload })
  if (!run) {
    return yield* new StoreError({
      operation: "recordRun",
      message: "Could not record the research run; use blocking `research` instead",
    })
  }
  return {
    research_id: run.id,
    status: "running" as const,
    query: input.query,
    timeout_ms: timeoutOf(input),
    members: members.map((m) => ({
      provider: m.provider,
      run_id: m.run_id,
      remote_id: m.remote_id,
      status: m.status,
      ...(m.error ? { error: m.error } : {}),
    })),
    routing: payload.routing,
    skipped: payload.skipped,
    next: `survey research check '{"id":"${run.id}"}'`,
  }
})

const loadResearch = Effect.fn("loadResearch")(function* (id: string) {
  const store = yield* Store
  const run = yield* store.getRun(id)
  if (!run || run.kind !== "survey.research") {
    return yield* new CommandInputError({ field: "id", message: `No research run ${id}` })
  }
  const payload = (() => {
    try {
      return run.payload ? (JSON.parse(run.payload) as unknown) : undefined
    } catch {
      return undefined
    }
  })()
  const async =
    payload && typeof payload === "object" && (payload as { mode?: unknown }).mode === "async"
      ? (payload as AsyncResearchPayload)
      : undefined
  return { run, async }
})

/** Poll every member once (no polling for members already terminal at start). */
const pollMembers = (payload: AsyncResearchPayload) =>
  Effect.gen(function* () {
    const store = yield* Store
    const expired = Date.now() > payload.started_at + timeoutOf(payload.input)
    return yield* Effect.forEach(
      payload.members,
      (record): Effect.Effect<MemberState, never, AppEnv> =>
        Effect.gen(function* () {
          const ids = { provider: record.provider, run_id: record.run_id, remote_id: record.remote_id }
          if (record.remote_id === null) {
            return {
              ...ids,
              status: record.status,
              terminal: true,
              outcome: {
                provider: record.provider,
                ok: record.status === "succeeded",
                output: record.output,
                sources: collectUrls(record.output),
                ...(record.error ? { error: record.error } : {}),
              },
            }
          }
          const member = juryMember(record.provider, payload.input)
          const checked = yield* Effect.result(member.check(record.remote_id).pipe(withTier(payload.input.tier)))
          if (checked._tag === "Failure") {
            const check_error = toErrorDetails(checked.failure)
            return expired
              ? {
                  ...ids,
                  status: "timed_out" as const,
                  terminal: true,
                  check_error,
                  outcome: { provider: record.provider, ok: false, remote_id: record.remote_id, sources: [], error: check_error },
                }
              : { ...ids, status: "running" as const, terminal: false, check_error }
          }
          const output = checked.success
          const status = normalizeStatus(output)
          if (record.run_id) {
            yield* store.updateRun(record.run_id, { status }).pipe(Effect.catch(() => Effect.void))
          }
          if (status === "succeeded") {
            return {
              ...ids,
              status,
              terminal: true,
              outcome: { provider: record.provider, ok: true, remote_id: record.remote_id, output, sources: member.sourcesOf(output) },
            }
          }
          if (status === "failed" || status === "canceled" || expired) {
            return {
              ...ids,
              status: TERMINAL.includes(status) ? status : ("timed_out" as const),
              terminal: true,
              outcome: {
                provider: record.provider,
                ok: false,
                remote_id: record.remote_id,
                output,
                sources: collectUrls(output),
                error: TERMINAL.includes(status)
                  ? {
                      type: "JobFailed",
                      message: `${record.provider} run ended with status ${statusText(output)}`,
                      details: { retryable: false },
                    }
                  : {
                      type: "JobWaitTimeoutError",
                      message: `${record.provider} run exceeded ${timeoutOf(payload.input)}ms`,
                      details: { retryable: true },
                    },
              },
            }
          }
          return { ...ids, status, terminal: false }
        }),
      { concurrency: "unbounded" },
    )
  })

const finalizeWith = Effect.fn("finalizeWith")(function* (
  researchId: string,
  payload: AsyncResearchPayload,
  states: ReadonlyArray<MemberState>,
) {
  const outcomes = states.map(
    (state): ProviderResearchOutcome =>
      state.outcome ?? {
        provider: state.provider,
        ok: false,
        ...(state.remote_id ? { remote_id: state.remote_id } : {}),
        sources: [],
        error: {
          type: "Incomplete",
          message: `${state.provider} was still ${state.status} at finalize`,
          details: { retryable: true },
        },
      },
  )
  const lanes = yield* evidenceLanes(payload.input, payload.members.length).pipe(withTier(payload.input.tier))
  const result = yield* assembleResearch({
    input: payload.input,
    runId: researchId,
    outcomes,
    lanes,
    routing: payload.routing,
    skipped: payload.skipped,
  })
  // Keep the final result so later checks answer without re-polling providers.
  const artifact = yield* writeArtifact({
    key: `research-${researchId}`,
    kind: "json",
    contents: JSON.stringify(result),
  }).pipe(Effect.option)
  if (artifact._tag === "Some") {
    yield* updateRun(researchId, { resultRef: artifact.value.absolute_path })
  }
  return result
})

/**
 * Finalize an async research run now: poll members once, fuse whatever has
 * finished (unfinished members are reported as Incomplete), store the report
 * in the corpus and the result on the run. The seam for callers that need the
 * final report without waiting for every member.
 */
export const finalizeResearch = Effect.fn("finalizeResearch")(function* (researchId: string) {
  const { async } = yield* loadResearch(researchId)
  if (!async) {
    return yield* new CommandInputError({ field: "id", message: `Research ${researchId} ran in blocking mode; it is already final` })
  }
  const states = yield* pollMembers(async)
  return yield* finalizeWith(researchId, async, states)
})

const storedResult = (resultRef: string | null) =>
  resultRef === null
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return JSON.parse(yield* fs.readFileString(resultRef)) as unknown
      }).pipe(Effect.catch(() => Effect.succeed(undefined)), Effect.catchDefect(() => Effect.succeed(undefined)))

export const researchCheck = Effect.fn("researchCheck")(function* (input: typeof ResearchIdInput.Type) {
  const { run, async } = yield* loadResearch(input.id)
  if (!async) {
    return {
      research_id: run.id,
      mode: "blocking" as const,
      status: run.status,
      complete: TERMINAL.includes(run.status),
      corpus_url: `survey://research/${run.id}`,
    }
  }
  if (TERMINAL.includes(run.status)) {
    const result = yield* storedResult(run.result_ref)
    if (result !== undefined) {
      return { research_id: run.id, mode: "async" as const, status: run.status, complete: true, result }
    }
  }
  const states = yield* pollMembers(async)
  if (states.every((state) => state.terminal)) {
    const result = yield* finalizeWith(run.id, async, states)
    return {
      research_id: run.id,
      mode: "async" as const,
      status: result.citation_intersection.providers_succeeded > 0 ? ("succeeded" as const) : ("failed" as const),
      complete: true,
      members: states.map(memberView),
      result,
    }
  }
  return {
    research_id: run.id,
    mode: "async" as const,
    status: "running" as const,
    complete: false,
    pending: states.filter((state) => !state.terminal).map((state) => state.provider),
    members: states.map(memberView),
  }
})

export const researchWait = Effect.fn("researchWait")(function* (input: typeof ResearchWaitInput.Type) {
  const intervalMs = input.interval_ms ?? 5000
  const timeoutMs = input.timeout_ms ?? 900_000
  const deadline = Date.now() + timeoutMs
  const started = Date.now()
  while (true) {
    const checked = yield* researchCheck({ id: input.id })
    if (checked.complete) {
      return { ...checked, waited_ms: Date.now() - started }
    }
    if (Date.now() + intervalMs > deadline) {
      return yield* new JobWaitTimeoutError({
        provider: "survey",
        jobId: input.id,
        timeoutMs,
        lastStatus: checked.status,
        message: `Research ${input.id} did not complete within ${timeoutMs}ms; check again later`,
      })
    }
    yield* Effect.sleep(intervalMs)
  }
})

/** Local view only: run registry rows and the stored result, no provider calls. */
export const researchInspect = Effect.fn("researchInspect")(function* (input: typeof ResearchIdInput.Type) {
  const store = yield* Store
  const { run, async } = yield* loadResearch(input.id)
  const members = async
    ? yield* Effect.forEach(async.members, (member) =>
        (member.run_id ? store.getRun(member.run_id) : Effect.succeed(undefined)).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
          Effect.map((child) => ({
            provider: member.provider,
            kind: member.kind,
            run_id: member.run_id,
            remote_id: member.remote_id,
            status: child?.status ?? member.status,
            updated_at: child?.updated_at ?? null,
            ...(member.error ? { error: member.error } : {}),
          })),
        ),
      )
    : []
  return {
    research_id: run.id,
    mode: async ? ("async" as const) : ("blocking" as const),
    status: run.status,
    created_at: run.created_at,
    updated_at: run.updated_at,
    query: async?.input.query ?? null,
    members,
    routing: async?.routing ?? [],
    skipped: async?.skipped ?? [],
    result_ref: run.result_ref,
    result: yield* storedResult(run.result_ref),
  }
})

const researchStartCommand = makeJsonCommand({
  name: "start",
  commandName: "research start",
  description: "Start every jury member and return a research_id immediately; follow with research check|wait",
  schema: ResearchInput,
  run: (input) => researchStart(input),
})

const researchCheckCommand = makeJsonCommand({
  name: "check",
  commandName: "research check",
  description: "Poll each jury member once; when all are terminal, fuse citations and store the final report",
  schema: ResearchIdInput,
  run: (input) => researchCheck(input),
})

const researchWaitCommand = makeJsonCommand({
  name: "wait",
  commandName: "research wait",
  description: "Poll research check until the research completes or timeout_ms passes",
  schema: ResearchWaitInput,
  run: (input) => researchWait(input),
})

const researchInspectCommand = makeJsonCommand({
  name: "inspect",
  commandName: "research inspect",
  description: "Show the recorded research run, its member runs and the stored result without calling providers",
  schema: ResearchIdInput,
  run: (input) => researchInspect(input),
})

/** `research` stays blocking; `research start|check|wait|inspect` are the non-blocking path. */
export const researchCommand = makeJsonCommand({
  name: "research",
  commandName: "research",
  description:
    "Composite deep-research: fan out to Exa/Parallel/Firecrawl agents and TinyFish Research (plus the keyless paper index for academic queries), fuse sources, score citation intersection",
  schema: ResearchInput,
  run: (input) => research(input),
}).pipe(
  Command.withSubcommands([researchStartCommand, researchCheckCommand, researchWaitCommand, researchInspectCommand]),
)

const RESEARCH_ID = "srv_mf0k2a1b_4h7d9q2x"

registerContracts([
{
  command: "research",
  description:
    "Cross-provider composite deep research (blocking). Sources carry independent_group; citation_intersection reports citations vs independent_sources (same page, registrable domain or syndicated title count once).",
  inputSchema: ResearchInput,
  orbit: ["research start", "research check", "research wait", "research inspect"],
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
},
{
  command: "research start",
  description:
    "Non-blocking research: start each jury member, record member runs, return research_id at once. Same input as research; timeout_ms bounds how long members may run before check reports them timed_out.",
  inputSchema: ResearchInput,
  examples: [
    { name: "start deep research", input: { query: "State of WASI preview 2 adoption", depth: "deep" } },
    { name: "start with two members", input: { query: "Who maintains the Bun runtime?", providers: ["exa", "parallel"] } },
  ],
},
{
  command: "research check",
  description:
    "Poll each member once. While any member runs: complete false with pending members. Once all are terminal: fuse citations, store the report in the corpus, return complete true with the same result shape as research. Later checks return the stored result.",
  inputSchema: ResearchIdInput,
  examples: [{ name: "check research", input: { id: RESEARCH_ID } }],
},
{
  command: "research wait",
  description: "Repeat research check every interval_ms (default 5000) until complete; JobWaitTimeoutError after timeout_ms (default 900000).",
  inputSchema: ResearchWaitInput,
  examples: [
    { name: "wait for research", input: { id: RESEARCH_ID } },
    { name: "wait with bounds", input: { id: RESEARCH_ID, interval_ms: 10000, timeout_ms: 1800000 } },
  ],
},
{
  command: "research inspect",
  description: "Local view of a research run: member runs, routing, result_ref and the stored result. Never calls providers.",
  inputSchema: ResearchIdInput,
  examples: [{ name: "inspect research", input: { id: RESEARCH_ID } }],
},
])
