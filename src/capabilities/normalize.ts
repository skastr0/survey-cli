import { canonicalizeUrl } from "../core/store"

export interface NormalizedResult {
  readonly url: string
  readonly canonical_url: string
  readonly title?: string
  readonly snippet?: string
  readonly providers: ReadonlyArray<string>
  readonly score?: number
  readonly published_at?: string
}

export interface ProviderOutcome {
  readonly provider: string
  readonly ok: boolean
  readonly results: Array<Omit<NormalizedResult, "providers">>
  readonly error?: unknown
}

/** Pull normalized result rows out of any provider payload shape. */
export const toResults = (payload: unknown): Array<Omit<NormalizedResult, "providers">> => {
  const rows: Array<Omit<NormalizedResult, "providers">> = []
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

/** Merge provider outcomes: dedupe by canonical URL, union provider provenance. */
export const mergeResults = (
  outcomes: ReadonlyArray<ProviderOutcome>,
): Array<NormalizedResult> => {
  const merged = new Map<string, NormalizedResult & { providers: string[] }>()
  for (const outcome of outcomes) {
    for (const result of outcome.results) {
      const existing = merged.get(result.canonical_url)
      if (existing) {
        if (!existing.providers.includes(outcome.provider)) {
          existing.providers.push(outcome.provider)
        }
        if (!existing.title && result.title) {
          ;(existing as { title?: string }).title = result.title
        }
        if (!existing.snippet && result.snippet) {
          ;(existing as { snippet?: string }).snippet = result.snippet
        }
      } else {
        merged.set(result.canonical_url, { ...result, providers: [outcome.provider] })
      }
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.providers.length - a.providers.length || (b.score ?? 0) - (a.score ?? 0),
  )
}
