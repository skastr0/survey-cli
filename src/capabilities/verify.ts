import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { groupSources, independenceView } from "../core/independence"
import { toErrorDetails } from "../core/output"
import { canonicalizeUrl, Store } from "../core/store"
import { ProviderName } from "../core/registry"
import { routeProviders, Tier, withTier } from "../core/tiers"
import { exaApi } from "../providers/exa"
import { parallelApi } from "../providers/parallel"
import { Domain, wantsPapers } from "./academic"
import { papers } from "./papers"
import { corpusRef, rememberReport, shortHash } from "./report"

const VERIFY_ADAPTERS: ReadonlyArray<ProviderName> = ["exa", "parallel"]

export const VerifyInput = Schema.Struct({
  claim: Schema.NonEmptyString,
  providers: Schema.optional(Schema.Array(ProviderName)),
  timeout_ms: Schema.optional(Schema.Int),
  domain: Schema.optional(Domain),
  tier: Schema.optional(Tier.annotate({
    description: "free: skip keyed answer/task providers; rely on the keyless paper index. any (default).",
  })),
  /** Remember the verification report in the corpus as kind "report" (default true). */
  store: Schema.optional(Schema.Boolean),
  tags: Schema.optional(Schema.Array(Schema.String)),
})
export type VerifyInput = typeof VerifyInput.Type

interface Verdict {
  readonly provider: string
  readonly ok: boolean
  readonly answer?: string
  readonly sources: ReadonlyArray<string>
  readonly evidence?: unknown
  readonly error?: unknown
}

/** Paper-index evidence: top passages for the claim from the most relevant papers. */
const papersVerdict = (input: VerifyInput): Effect.Effect<Verdict, unknown, AppEnv> =>
  papers({
    query: input.claim,
    question: input.claim,
    k: 5,
    read_top: 3,
    passages: 2,
    ...(input.tier ? { tier: input.tier } : {}),
  }).pipe(
    Effect.map((result): Verdict => {
      const evidence = result.papers.map((paper) => ({
        primary_id: paper.primary_id,
        title: paper.title,
        url: paper.url,
        passages: paper.passages ?? [],
      }))
      const answer = evidence
        .flatMap((paper) =>
          paper.passages.length > 0
            ? paper.passages.map((passage) => `[${paper.primary_id}] ${passage.text.slice(0, 500)}`)
            : paper.title
              ? [`[${paper.primary_id}] ${paper.title}`]
              : [],
        )
        .join("\n\n")
      return {
        provider: "papers",
        ok: result.count > 0,
        ...(answer.length > 0 ? { answer } : {}),
        sources: result.papers.flatMap((paper) => (paper.url ? [canonicalizeUrl(paper.url)] : [])),
        evidence: { source: result.source, papers: evidence },
        ...(result.count === 0 ? { error: { type: "NoPapersFound", failures: result.failures } } : {}),
      }
    }),
  )

const exaVerdict = (claim: string): Effect.Effect<Verdict, unknown, AppEnv> =>
  Effect.gen(function* () {
    const result = yield* exaApi.answer({
      // No `text: true`: it embeds every citation's full page (live: ~1MB per
      // verdict); the verdict uses only the answer and citation URLs.
      query: `Is this claim accurate? Answer concisely and cite sources. Claim: ${claim}`,
    } as never) as Effect.Effect<unknown, unknown, never>
    const record = result as Record<string, unknown>
    const answer =
      typeof record.answer === "string"
        ? record.answer
        : typeof record.text === "string"
          ? record.text
          : JSON.stringify(result).slice(0, 2000)
    const sources = collectUrls(result)
    return { provider: "exa", ok: true, answer, sources } satisfies Verdict
  })

const parallelVerdict = (claim: string): Effect.Effect<Verdict, unknown, AppEnv> =>
  Effect.gen(function* () {
    const result = yield* parallelApi.deepResearchRun?.({
      input: `Verify this claim with sources: ${claim}`,
      processor: "base",
    } as never) as Effect.Effect<unknown, unknown, never>
    const record = result as Record<string, unknown>
    const answer =
      typeof record.output === "string"
        ? record.output
        : typeof record.result === "string"
          ? record.result
          : JSON.stringify(result).slice(0, 2000)
    return { provider: "parallel", ok: true, answer, sources: collectUrls(result) } satisfies Verdict
  })

const collectUrls = (value: unknown): Array<string> => {
  const urls = new Set<string>()
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object") return
    if (Array.isArray(v)) {
      v.forEach((item) => visit(item, depth + 1))
      return
    }
    const record = v as Record<string, unknown>
    if (typeof record.url === "string" && /^https?:\/\//.test(record.url)) {
      urls.add(canonicalizeUrl(record.url))
    }
    // exaApi.answer wraps the response as { answer, data: { answer, citations } }.
    for (const key of ["data", "citations", "sources", "results", "basis", "fields", "output"]) {
      if (key in record) visit(record[key], depth + 1)
    }
  }
  visit(value, 0)
  return [...urls]
}

const verifyMarkdown = (
  claim: string,
  confidence: string,
  verdicts: ReadonlyArray<Verdict>,
  shared: ReadonlyArray<{ canonical_url: string; provider_count: number }>,
) => {
  const sections = [`# Verify: ${claim}`, `Confidence: **${confidence}**`]
  for (const verdict of verdicts) {
    sections.push(
      verdict.ok
        ? `## ${verdict.provider}\n\n${verdict.answer ?? "(no answer text)"}${
            verdict.sources.length > 0 ? `\n\nSources:\n${verdict.sources.map((url) => `- ${url}`).join("\n")}` : ""
          }`
        : `## ${verdict.provider} (failed)`,
    )
  }
  if (shared.length > 0) {
    sections.push(`## Shared sources\n\n${shared.map((s) => `- ${s.canonical_url} (${s.provider_count} providers)`).join("\n")}`)
  }
  return sections.join("\n\n")
}

export const verify = Effect.fn("verify")(function* (input: VerifyInput) {
  const { eligible: routed, skipped } = yield* routeProviders({
    requested: input.providers ?? VERIFY_ADAPTERS,
    adapters: VERIFY_ADAPTERS,
    capability: (provider) => (provider === "exa" ? "answer" : "deep_research"),
    tier: input.tier,
  })
  const academic = wantsPapers(input.domain, input.claim)
  const eligible: Array<string> = [
    ...routed.map(({ provider }) => provider),
    ...(academic ? ["papers"] : []),
  ]

  const verdicts = yield* Effect.forEach(
    eligible,
    (provider): Effect.Effect<Verdict, never, AppEnv> =>
      Effect.gen(function* () {
        if (provider === "exa") {
          return yield* exaVerdict(input.claim)
        }
        if (provider === "parallel") {
          return yield* parallelVerdict(input.claim)
        }
        if (provider === "papers") {
          return yield* papersVerdict(input)
        }
        return {
          provider,
          ok: false,
          sources: [],
          error: { type: "ProviderUnsupportedError", message: `${provider} has no verify adapter` },
        } satisfies Verdict
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            provider,
            ok: false,
            sources: [],
            error: toErrorDetails(error),
          } satisfies Verdict),
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(withTier(input.tier))

  const allSources = verdicts.flatMap((v) => v.sources)
  const counts = new Map<string, number>()
  for (const url of allSources) {
    counts.set(url, (counts.get(url) ?? 0) + 1)
  }
  const sharedSources = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([canonical_url, count]) => ({ canonical_url, provider_count: count }))

  const okVerdicts = verdicts.filter((v) => v.ok)
  // Confidence counts independent sources (distinct page, publisher and title
  // groups), so several providers echoing one page or one site count once.
  const independence = groupSources(
    okVerdicts.flatMap((verdict) => verdict.sources.map((url) => ({ url, provider: verdict.provider }))),
  )
  const independent = independence.independent_sources
  const confidence =
    okVerdicts.length === 0
      ? "none"
      : okVerdicts.length === 1
        ? independent >= 3
          ? "medium"
          : "low"
        : independent >= 3
          ? "high"
          : independent >= 2
            ? "medium"
            : "low"
  const confidenceBasis = {
    providers_succeeded: okVerdicts.length,
    citations: independence.citations,
    independent_sources: independent,
    rule: "2+ providers: high at >=3 independent sources, medium at 2; one provider: medium at >=3; else low; none when no provider answered",
  }

  const reportUrl = `survey://verify/${shortHash(input.claim)}`
  const remembered =
    input.store === false || okVerdicts.length === 0
      ? undefined
      : yield* rememberReport({
          url: reportUrl,
          title: `Verify: ${input.claim}`,
          tags: input.tags,
          content: verifyMarkdown(input.claim, confidence, verdicts, sharedSources),
          metadata: {
            claim: input.claim,
            confidence,
            domain: academic ? "academic" : "web",
            providers_attempted: verdicts.map((v) => v.provider),
            providers_succeeded: okVerdicts.map((v) => v.provider),
            shared_sources: sharedSources.length,
            citations: independence.citations,
            independent_sources: independent,
          },
        })

  return {
    claim: input.claim,
    ...corpusRef(remembered, reportUrl),
    verdicts,
    shared_sources: sharedSources,
    corroborated_providers: okVerdicts.length,
    citations: independence.citations,
    independent_sources: independent,
    source_groups: independenceView(independence).groups,
    confidence,
    confidence_basis: confidenceBasis,
    domain: academic ? "academic" : "web",
    routing: routed.map(({ provider, access }) => ({ provider, mode: access.mode, cost: access.cost })),
    skipped,
  }
})

export const verifyCommand = makeJsonCommand({
  name: "verify",
  commandName: "verify",
  description:
    "Check a claim with Exa answer and Parallel research (plus the paper index for academic claims). Input: claim, providers, domain, tier, store, tags. Returns verdicts and a confidence scored on independent sources.",
  schema: VerifyInput,
  run: (input) => verify(input),
})

registerContract({
  command: "verify",
  description:
    "Check a claim with Exa answer and Parallel research (plus the paper index for academic claims). Input: claim, providers, domain, tier, store, tags. Returns verdicts and a confidence scored on independent sources.",
  output:
    "{ claim, verdicts: [{ provider (exa | parallel | papers), ok, answer?, sources[] (canonical URLs), evidence? (papers), error? }], shared_sources: [{ canonical_url, provider_count }], corroborated_providers, citations, independent_sources, source_groups: [{ key, domains[], urls[], titles[], providers[], citations, merged_by[] }], confidence (none | low | medium | high), confidence_basis: { providers_succeeded, citations, independent_sources, rule }, domain (web | academic), routing: [{ provider, mode, cost }], skipped[], corpus?: { id, version, changed, created, url (survey://verify/<hash>) } }.",
  inputSchema: VerifyInput,
  examples: [
    {
      name: "fact check",
      input: { claim: "Bun 1.3 added support for compiling to bytecode" },
    },
    {
      name: "do not remember the report",
      description: "Verification reports are remembered as kind report at survey://verify/<claim hash> unless store is false; the response carries corpus {id, version, changed, created, url}.",
      input: { claim: "Bun 1.3 added support for compiling to bytecode", store: false, tags: ["fact-check"] },
    },
    {
      name: "academic claim against papers",
      input: {
        claim: "The original Transformer paper reports 28.4 BLEU on WMT 2014 English-to-German",
        domain: "academic",
      },
    },
    {
      name: "free tier academic check",
      input: { claim: "Diffusion models beat GANs on ImageNet image synthesis", domain: "academic", tier: "free" },
    },
  ],
})
