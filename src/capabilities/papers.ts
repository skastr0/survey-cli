import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { toErrorDetails } from "../core/output"
import { recordSources } from "../core/runs"
import { routeProviders, Tier, withTier, type SkippedProvider } from "../core/tiers"
import { firecrawlApi } from "../providers/firecrawl"
import {
  arxivRefFromUrl,
  paperRecords,
  paperRef,
  paperSources,
  paperUrl,
} from "../providers/firecrawl/papers"
import type { ResearchPassage } from "../providers/firecrawl/schemas"
import { unifiedSearch } from "./search"

const StringOrList = Schema.Union([Schema.String, Schema.Array(Schema.String)])

export const PapersInput = Schema.Struct({
  query: Schema.optional(Schema.NonEmptyString.annotate({ description: "Literature search query." })),
  id: Schema.optional(
    Schema.NonEmptyString.annotate({
      description: "Read one known paper instead of searching (paperId or arxiv:/pmid:/pmcid:/doi: ref).",
    }),
  ),
  question: Schema.optional(
    Schema.NonEmptyString.annotate({ description: "Read full-text passages answering this question from the top papers." }),
  ),
  k: Schema.optional(Schema.Int.annotate({ description: "Papers to return (default 10)." })),
  read_top: Schema.optional(Schema.Int.annotate({ description: "How many top papers to read passages from (default 3)." })),
  passages: Schema.optional(Schema.Int.annotate({ description: "Passages per paper, 1-50 (default 4)." })),
  authors: Schema.optional(StringOrList),
  categories: Schema.optional(StringOrList),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  fallback: Schema.optional(
    Schema.Boolean.annotate({
      description: "When the paper index is unavailable, search the web for arXiv papers instead (default true).",
    }),
  ),
  tier: Schema.optional(Tier),
})
export type PapersInput = typeof PapersInput.Type

export interface Paper {
  readonly paper_id: string | null
  readonly primary_id: string | null
  readonly ids?: Readonly<Record<string, ReadonlyArray<string>>> | undefined
  readonly url: string | null
  readonly title: string | null
  readonly abstract: string | null
  readonly authors?: string | undefined
  readonly score: number | null
  readonly passages?: ReadonlyArray<ResearchPassage>
  readonly read_error?: unknown
}

const toPaper = (record: ReturnType<typeof paperRecords>[number], fallbackRef?: string): Paper => {
  const ref = paperRef(record, fallbackRef) ?? null
  return {
    paper_id: record.paperId ?? null,
    primary_id: ref,
    ...(record.ids ? { ids: record.ids } : {}),
    url: ref ? (paperUrl(ref) ?? null) : null,
    title: record.title ?? null,
    abstract: record.abstract ?? null,
    ...(record.authors ? { authors: record.authors } : {}),
    score: typeof record.score === "number" ? record.score : null,
  }
}

const passagesOf = (payload: unknown): ReadonlyArray<ResearchPassage> =>
  payload && typeof payload === "object" && Array.isArray((payload as { passages?: unknown }).passages)
    ? ((payload as { passages: ReadonlyArray<ResearchPassage> }).passages)
    : []

const authModeOf = (payload: unknown) =>
  payload && typeof payload === "object" && "auth_mode" in payload
    ? String((payload as { auth_mode: unknown }).auth_mode)
    : null

/** Web fallback: keep arXiv hits from unified search, keyed by their arxiv ref. */
const webFallback = (input: PapersInput, query: string, k: number) =>
  unifiedSearch({
    query: `${query} arxiv paper`,
    num_results: k,
    ...(input.tier ? { tier: input.tier } : {}),
  }).pipe(
    Effect.map((search) => {
      const seen = new Set<string>()
      const papers: Array<Paper> = []
      for (const result of search.results) {
        const ref = arxivRefFromUrl(result.url)
        if (!ref || seen.has(ref)) continue
        seen.add(ref)
        papers.push({
          paper_id: null,
          primary_id: ref,
          url: paperUrl(ref) ?? result.url,
          title: result.title ?? null,
          abstract: result.snippet ?? null,
          score: null,
        })
      }
      return { papers: papers.slice(0, k), providers: search.providers_used }
    }),
  )

/**
 * Academic literature: Research Index search (or one paper by id), optional
 * passage reads for a question, and an arXiv web fallback when the index is
 * unavailable. Every paper carries its canonical ref (arxiv:/pmid:/pmcid:/doi:).
 */
export const papers = Effect.fn("papers")(function* (input: PapersInput) {
  if (input.query === undefined && input.id === undefined) {
    return yield* new CommandInputError({ field: "query", message: "Provide query (search) or id (one paper)" })
  }
  const k = input.k ?? 10
  const readTop = input.read_top ?? 3
  const passageCount = input.passages ?? 4

  const { eligible, skipped } = yield* routeProviders({
    requested: ["firecrawl"],
    adapters: ["firecrawl"],
    capability: "papers",
    tier: input.tier,
  })
  const failures: Array<{ stage: string; error: unknown }> = []
  const skippedAll: Array<SkippedProvider> = [...skipped]

  let found: ReadonlyArray<Paper> = []
  let source: "research_index" | "web_fallback" | "none" = "none"
  let authMode: string | null = null
  let fallbackProviders: ReadonlyArray<string> = []

  if (eligible.length > 0) {
    const lookup =
      input.id !== undefined
        ? (input.question !== undefined
            ? firecrawlApi.readPaper({ id: input.id, query: input.question, k: passageCount })
            : firecrawlApi.inspectPaper({ id: input.id }))
        : firecrawlApi.searchPapers({
            query: input.query ?? "",
            k,
            ...(input.authors !== undefined ? { authors: input.authors } : {}),
            ...(input.categories !== undefined ? { categories: input.categories } : {}),
            ...(input.from !== undefined ? { from: input.from } : {}),
            ...(input.to !== undefined ? { to: input.to } : {}),
          })
    const outcome = yield* Effect.result(lookup.pipe(withTier(input.tier)))
    if (outcome._tag === "Success") {
      source = "research_index"
      authMode = authModeOf(outcome.success)
      found = paperRecords(outcome.success).slice(0, k).map((record) => {
        const paper = toPaper(record, input.id)
        return input.id !== undefined && input.question !== undefined
          ? { ...paper, passages: passagesOf(outcome.success) }
          : paper
      })
      yield* recordSources("firecrawl", paperSources(outcome.success, input.id))
    } else {
      failures.push({ stage: "research_index", error: toErrorDetails(outcome.failure) })
    }
  }

  if (source === "none" && input.query !== undefined && input.fallback !== false) {
    const fallback = yield* Effect.result(webFallback(input, input.query, k))
    if (fallback._tag === "Success") {
      source = "web_fallback"
      found = fallback.success.papers
      fallbackProviders = fallback.success.providers
    } else {
      failures.push({ stage: "web_fallback", error: toErrorDetails(fallback.failure) })
    }
  }

  // Passage reads only exist in the index; fallback papers keep abstracts only.
  if (input.question !== undefined && input.id === undefined && source === "research_index") {
    const question = input.question
    found = yield* Effect.forEach(
      found,
      (paper, index): Effect.Effect<Paper, never, AppEnv> =>
        index >= readTop || paper.primary_id === null
          ? Effect.succeed(paper)
          : firecrawlApi
              .readPaper({ id: paper.primary_id, query: question, k: passageCount })
              .pipe(
                withTier(input.tier),
                Effect.map((payload): Paper => ({ ...paper, passages: passagesOf(payload) })),
                Effect.catch((error) => Effect.succeed<Paper>({ ...paper, read_error: toErrorDetails(error) })),
              ),
      { concurrency: readTop },
    )
  }

  return {
    query: input.query ?? null,
    id: input.id ?? null,
    question: input.question ?? null,
    source,
    auth_mode: authMode,
    ...(source === "web_fallback" ? { fallback_providers: fallbackProviders } : {}),
    count: found.length,
    papers: found,
    failures,
    skipped: skippedAll,
  }
})

export const papersCommand = makeJsonCommand({
  name: "papers",
  commandName: "papers",
  description:
    "Academic literature search over the Firecrawl Research Index (keyless): ranked papers with canonical ids, optional full-text passage reads for a question, arXiv web fallback",
  schema: PapersInput,
  run: (input) => papers(input),
})

registerContract({
  command: "papers",
  description:
    "Search ~43M papers (arXiv, PubMed, bioRxiv, medRxiv) via the keyless Firecrawl Research Index; with question, read the top papers' full-text passages. Papers carry primary_id (arxiv:/pmid:/pmcid:/doi:) and a resolvable url; sources are recorded under primary_id. Falls back to arXiv hits from unified web search when the index refuses (source: web_fallback).",
  inputSchema: PapersInput,
  orbit: ["firecrawl research search-papers", "firecrawl research read-paper", "firecrawl research related-papers"],
  examples: [
    { name: "literature search", input: { query: "retrieval augmented generation evaluation", k: 10 } },
    {
      name: "search and read passages",
      input: {
        query: "diffusion models image synthesis",
        question: "What FID does the model reach on ImageNet 256x256?",
        read_top: 3,
      },
    },
    {
      name: "read one paper",
      input: { id: "arxiv:1706.03762", question: "How is multi-head attention computed?" },
    },
    { name: "free tier only", input: { query: "sparse mixture of experts", tier: "free" } },
  ],
})
