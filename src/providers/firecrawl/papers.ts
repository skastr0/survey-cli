import type { SourceLike } from "../../core/runs"
import type { ResearchPaperResult } from "./schemas"

/**
 * Research Index ids → canonical paper refs and resolvable links.
 * `primaryId` (arxiv:<id>, pmid:<id>, pmcid:<id>, doi:<id>) is the canonical
 * ref recorded in the source ledger; `web:<url>` results keep their URL.
 */

const NAMESPACE_PREFERENCE = ["arxiv", "doi", "pmcid", "pmid"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Best canonical ref for a paper record: primaryId, then preferred source id, then paperId. */
export const paperRef = (paper: Partial<ResearchPaperResult>, fallback?: string): string | undefined => {
  if (typeof paper.primaryId === "string" && paper.primaryId.length > 0) {
    return paper.primaryId
  }
  const ids = paper.ids
  if (ids) {
    for (const namespace of NAMESPACE_PREFERENCE) {
      const first = ids[namespace]?.[0]
      if (first) return `${namespace}:${first}`
    }
  }
  if (typeof paper.paperId === "string" && paper.paperId.length > 0) {
    return paper.paperId.startsWith("web:") ? paper.paperId : `firecrawl:${paper.paperId}`
  }
  return fallback
}

/** Resolvable https link for a canonical paper ref, when the namespace has one. */
export const paperUrl = (ref: string): string | undefined => {
  const separator = ref.indexOf(":")
  if (separator < 0) return undefined
  const namespace = ref.slice(0, separator).toLowerCase()
  const id = ref.slice(separator + 1)
  switch (namespace) {
    case "arxiv":
      return `https://arxiv.org/abs/${id}`
    case "doi":
      return `https://doi.org/${id}`
    case "pmid":
      return `https://pubmed.ncbi.nlm.nih.gov/${id}/`
    case "pmcid":
      return `https://pmc.ncbi.nlm.nih.gov/articles/${id.toUpperCase().startsWith("PMC") ? id : `PMC${id}`}/`
    case "web":
      return /^https?:\/\//.test(id) ? id : undefined
    default:
      return undefined
  }
}

/** Canonical arxiv ref for an arxiv.org URL (abs, pdf, html; version stripped). */
export const arxivRefFromUrl = (url: string): string | undefined => {
  const match = /arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})(?:v[0-9]+)?/i.exec(url)
  return match?.[1] ? `arxiv:${match[1]}` : undefined
}

/** Paper records in a search/similar/inspect/read payload. */
export const paperRecords = (payload: unknown): ReadonlyArray<ResearchPaperResult> => {
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.results)) {
    return payload.results.filter(
      (item): item is ResearchPaperResult => isRecord(item) && typeof item.paperId === "string",
    )
  }
  if (isRecord(payload.paper) && typeof payload.paper.paperId === "string") {
    return [payload.paper as unknown as ResearchPaperResult]
  }
  return []
}

/** Ledger rows keyed by canonical paper ref (url column holds e.g. arxiv:1706.03762). */
export const paperSources = (payload: unknown, fallbackRef?: string): ReadonlyArray<SourceLike> =>
  paperRecords(payload).flatMap((paper) => {
    const ref = paperRef(paper, fallbackRef)
    if (ref === undefined) return []
    const url = ref.startsWith("web:") ? (paperUrl(ref) ?? ref) : ref
    return [
      {
        url,
        title: paper.title,
        snippet: paper.abstract?.slice(0, 280),
      },
    ]
  })
