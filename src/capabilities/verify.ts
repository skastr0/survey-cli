import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { toErrorDetails } from "../core/output"
import { canonicalizeUrl, Store } from "../core/store"
import { loadProviderConfig, ProviderName } from "../core/registry"
import { exaApi } from "../providers/exa"
import { parallelApi } from "../providers/parallel"

export const VerifyInput = Schema.Struct({
  claim: Schema.NonEmptyString,
  providers: Schema.optional(Schema.Array(ProviderName)),
  timeout_ms: Schema.optional(Schema.Int),
})
export type VerifyInput = typeof VerifyInput.Type

interface Verdict {
  readonly provider: string
  readonly ok: boolean
  readonly answer?: string
  readonly sources: ReadonlyArray<string>
  readonly error?: unknown
}

const exaVerdict = (claim: string): Effect.Effect<Verdict, unknown, AppEnv> =>
  Effect.gen(function* () {
    const result = yield* exaApi.answer({
      query: `Is this claim accurate? Answer concisely and cite sources. Claim: ${claim}`,
      text: true,
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
    for (const key of ["citations", "sources", "results", "basis", "fields", "output"]) {
      if (key in record) visit(record[key], depth + 1)
    }
  }
  visit(value, 0)
  return [...urls]
}

export const verify = Effect.fn("verify")(function* (input: VerifyInput) {
  const requested = input.providers ?? (["exa", "parallel"] as const)
  const eligible: Array<ProviderName> = []
  const skipped: Array<{ provider: string; reason: string }> = []

  for (const provider of requested) {
    const config = yield* loadProviderConfig(provider)
    if (config.credential === undefined) {
      skipped.push({ provider, reason: "no API key configured" })
    } else {
      eligible.push(provider)
    }
  }

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
  )

  const allSources = verdicts.flatMap((v) => v.sources)
  const counts = new Map<string, number>()
  for (const url of allSources) {
    counts.set(url, (counts.get(url) ?? 0) + 1)
  }
  const sharedSources = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([canonical_url, count]) => ({ canonical_url, provider_count: count }))

  const okVerdicts = verdicts.filter((v) => v.ok)
  const confidence =
    okVerdicts.length === 0
      ? "none"
      : okVerdicts.length === 1
        ? "low"
        : sharedSources.length > 0
          ? "high"
          : "medium"

  return {
    claim: input.claim,
    verdicts,
    shared_sources: sharedSources,
    corroborated_providers: okVerdicts.length,
    confidence,
    skipped,
  }
})

export const verifyCommand = makeJsonCommand({
  name: "verify",
  commandName: "verify",
  description: "Check a claim across providers; confidence scales with source overlap",
  schema: VerifyInput,
  run: (input) => verify(input),
})

registerContract({
  command: "verify",
  description: "Cross-provider claim verification with citation overlap",
  inputSchema: VerifyInput,
  examples: [
    {
      name: "fact check",
      input: { claim: "Bun 1.3 added support for compiling to bytecode" },
    },
  ],
})
