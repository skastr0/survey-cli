import { canonicalizeUrl } from "../core/store"

export interface NormalizedResult {
  readonly url: string
  readonly canonical_url: string
  readonly title?: string
  readonly snippet?: string
  readonly providers: ReadonlyArray<string>
  readonly score?: number
  readonly published_at?: string
  /** 1-based rank of this URL in each provider's own result list. */
  readonly ranks?: Readonly<Record<string, number>>
  /** Reciprocal Rank Fusion score across providers (higher is better). */
  readonly fusion_score?: number
}

export interface ProviderOutcome {
  readonly provider: string
  readonly ok: boolean
  readonly results: Array<Omit<NormalizedResult, "providers" | "ranks" | "fusion_score">>
  readonly error?: unknown
}

/** Pull normalized result rows out of any provider payload shape. */
type ProviderRow = Omit<NormalizedResult, "providers" | "ranks" | "fusion_score">

export const toResults = (payload: unknown): Array<ProviderRow> => {
  const rows: Array<ProviderRow> = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (typeof record.url === "string" && /^https?:\/\//.test(record.url)) {
      const snippet =
        typeof record.snippet === "string"
          ? record.snippet
          : typeof record.description === "string"
            ? record.description
            : Array.isArray(record.excerpts)
              ? record.excerpts.filter((e): e is string => typeof e === "string").join(" ")
              : typeof record.text === "string"
                ? record.text.slice(0, 400)
                : undefined
      rows.push({
        url: record.url,
        canonical_url: canonicalizeUrl(record.url),
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(snippet ? { snippet } : {}),
        ...(typeof record.score === "number" ? { score: record.score } : {}),
        ...(typeof record.published_at === "string"
          ? { published_at: record.published_at }
          : typeof record.publishedDate === "string"
            ? { published_at: record.publishedDate }
            : {}),
      })
      return
    }
    for (const nested of Object.values(record)) {
      if (nested !== null && typeof nested === "object") visit(nested)
    }
  }
  visit(payload)
  return rows
}

/** RRF constant from Cormack et al.; dampens the head of each list. */
export const RRF_K = 60

/**
 * Per-provider RRF weights (default 1). Keenable leads the Vals Web Search
 * Index (Oct 2026, Keenable-reported), so its ranks count 1.5×. With k=60
 * that makes fused lists read Keenable-first: its top ~30 outrank any other
 * single provider's #1, while a URL two other providers agree on still leads
 * (2/(k+1) > 1.5/(k+1)). Override per call with `weights` ({keenable: 1} = plain RRF).
 */
export const DEFAULT_FUSION_WEIGHTS: Readonly<Record<string, number>> = { keenable: 1.5 }

/**
 * Merge provider outcomes: dedupe by canonical URL, union provider
 * provenance, and rank with Reciprocal Rank Fusion — sum of 1/(k + rank)
 * over every provider that returned the URL, scaled by the provider's
 * weight. Raw provider scores are not
 * comparable across indexes; ranks are. Corroboration lifts a result
 * naturally because each extra provider adds a term.
 */
export const mergeResults = (
  outcomes: ReadonlyArray<ProviderOutcome>,
  weights: Readonly<Record<string, number>> = DEFAULT_FUSION_WEIGHTS,
): Array<NormalizedResult> => {
  const merged = new Map<
    string,
    NormalizedResult & { providers: string[]; ranks: Record<string, number>; fusion_score: number }
  >()
  for (const outcome of outcomes) {
    const seen = new Set<string>()
    let rank = 0
    for (const result of outcome.results) {
      if (seen.has(result.canonical_url)) continue
      seen.add(result.canonical_url)
      rank += 1
      const contribution = (weights[outcome.provider] ?? 1) / (RRF_K + rank)
      const existing = merged.get(result.canonical_url)
      if (existing) {
        if (!existing.providers.includes(outcome.provider)) {
          existing.providers.push(outcome.provider)
          existing.ranks[outcome.provider] = rank
          existing.fusion_score += contribution
        }
        if (!existing.title && result.title) {
          ;(existing as { title?: string }).title = result.title
        }
        if (!existing.snippet && result.snippet) {
          ;(existing as { snippet?: string }).snippet = result.snippet
        }
      } else {
        merged.set(result.canonical_url, {
          ...result,
          providers: [outcome.provider],
          ranks: { [outcome.provider]: rank },
          fusion_score: contribution,
        })
      }
    }
  }
  return [...merged.values()]
    .map((result) => ({ ...result, fusion_score: Number(result.fusion_score.toFixed(6)) }))
    .sort((a, b) => b.fusion_score - a.fusion_score || b.providers.length - a.providers.length)
}
