import { canonicalizeUrl } from "./store"

/**
 * Source independence: citations that share a page, a publisher (registrable
 * domain, eTLD+1) or a syndicated title are one source, not corroboration.
 *
 * eTLD+1 uses a compact subset of the Public Suffix List
 * (https://publicsuffix.org/list/public_suffix_list.dat) instead of a dependency:
 * - a generic second level (co, com, org, net, ac, edu, gov, gob, go, or, ne, mil)
 *   under a two-letter ccTLD is treated as a public suffix (co.uk, com.au, ac.jp, …);
 * - PUBLIC_SUFFIXES adds ICANN suffixes that rule misses and the PSL private
 *   section hosts whose subdomains belong to different owners (github.io, …).
 * Every explicit entry was checked against the list on 2026-10-19. Suffixes
 * missing here fall back to the last two labels, which merges more sites into
 * one publisher, so independence is under-counted, never over-counted.
 */
const GENERIC_SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "edu", "gov", "gob", "go", "or", "ne", "mil"])

export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // ICANN, not covered by the generic second-level rule
  "ltd.uk", "plc.uk", "me.uk", "nhs.uk", "police.uk", "govt.nz", "nic.in", "res.in", "gv.at", "asn.au", "id.au",
  // PSL private section: each subdomain is a separate site
  "github.io", "gitlab.io", "blogspot.com", "herokuapp.com", "netlify.app", "vercel.app", "pages.dev",
  "workers.dev", "readthedocs.io", "appspot.com", "web.app", "firebaseapp.com", "cloudfront.net",
  "azurewebsites.net", "s3.amazonaws.com", "fly.dev", "onrender.com", "notion.site",
])

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** Registrable domain (eTLD+1) of a URL or host: `news.bbc.co.uk` → `bbc.co.uk`. */
export const registrableDomain = (urlOrHost: string): string => {
  let host = urlOrHost.trim().toLowerCase()
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname
  } catch {
    // Not a URL; treat the input as a host.
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "")
  if (IPV4.test(host) || host.includes(":") || !host.includes(".")) return host
  const labels = host.split(".")
  for (let take = Math.min(3, labels.length - 1); take >= 1; take--) {
    const suffix = labels.slice(-take).join(".")
    const generic =
      take === 2 && labels[labels.length - 1]!.length === 2 && GENERIC_SECOND_LEVEL.has(labels[labels.length - 2]!)
    if (PUBLIC_SUFFIXES.has(suffix) || generic) {
      return labels.slice(-(take + 1)).join(".")
    }
  }
  return labels.slice(-2).join(".")
}

/**
 * Scholarly repositories host independently authored works, so their records
 * are keyed per work (arXiv id without version, else canonical URL) instead of
 * per domain: two arXiv papers are two sources.
 */
const REPOSITORIES = new Set([
  "arxiv.org", "biorxiv.org", "medrxiv.org", "doi.org", "nih.gov", "openreview.net", "aclanthology.org",
  "semanticscholar.org", "europepmc.org",
])

const ARXIV_ID = /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i

const publisherKey = (canonical: string, domain: string) => {
  if (!REPOSITORIES.has(domain)) return `domain:${domain}`
  const arxiv = ARXIV_ID.exec(canonical)
  return arxiv?.[1] ? `arxiv:${arxiv[1].toLowerCase()}` : `url:${canonical}`
}

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are", "with", "by", "at"])

/** Title tokens without site-name suffixes (" - Site", " | Site") and stopwords. */
export const titleTokens = (title: string): ReadonlyArray<string> =>
  title
    .toLowerCase()
    .replace(/\s+[|–—-]\s+[^|–—-]{1,40}$/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))

const MIN_TITLE_TOKENS = 4
const TITLE_SIMILARITY = 0.8

/** Near-duplicate titles: token Jaccard ≥ 0.8 over titles of at least 4 content words. */
export const similarTitles = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  if (a.length < MIN_TITLE_TOKENS || b.length < MIN_TITLE_TOKENS) return false
  const left = new Set(a)
  const right = new Set(b)
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared) >= TITLE_SIMILARITY
}

export interface Citation {
  readonly url: string
  readonly provider: string
  readonly title?: string | undefined
}

export interface SourceGroup {
  /** Stable group id: the publisher key of its first citation. */
  readonly key: string
  readonly domains: ReadonlyArray<string>
  readonly urls: ReadonlyArray<string>
  readonly titles: ReadonlyArray<string>
  readonly providers: ReadonlyArray<string>
  readonly citations: number
  /** Why citations were merged: same_page, same_domain, same_work, similar_title. */
  readonly merged_by: ReadonlyArray<string>
}

export interface Independence {
  readonly citations: number
  readonly unique_urls: number
  readonly independent_sources: number
  readonly groups: ReadonlyArray<SourceGroup>
  /** canonical URL → group key */
  readonly group_of: ReadonlyMap<string, string>
}

/** Group citations into independent sources (union-find over page, publisher, title). */
export const groupSources = (citations: ReadonlyArray<Citation>): Independence => {
  const nodes = citations.map((citation) => {
    const canonical = canonicalizeUrl(citation.url)
    const domain = registrableDomain(canonical)
    return {
      citation,
      canonical,
      domain,
      publisher: publisherKey(canonical, domain),
      tokens: citation.title ? titleTokens(citation.title) : [],
    }
  })
  const parent = nodes.map((_, index) => index)
  const reasons = nodes.map(() => new Set<string>())
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  const union = (a: number, b: number, reason: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    const [root, child] = ra < rb ? [ra, rb] : [rb, ra]
    parent[child] = root
    for (const r of reasons[child]!) reasons[root]!.add(r)
    reasons[root]!.add(reason)
  }

  const firstBy = (key: (index: number) => string, reason: (index: number) => string) => {
    const seen = new Map<string, number>()
    nodes.forEach((_, index) => {
      const k = key(index)
      const prior = seen.get(k)
      if (prior === undefined) seen.set(k, index)
      else union(prior, index, reason(index))
    })
  }
  firstBy((i) => nodes[i]!.canonical, () => "same_page")
  firstBy(
    (i) => nodes[i]!.publisher,
    (i) => (nodes[i]!.publisher.startsWith("domain:") ? "same_domain" : "same_work"),
  )
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (find(i) !== find(j) && similarTitles(nodes[i]!.tokens, nodes[j]!.tokens)) union(i, j, "similar_title")
    }
  }

  const byRoot = new Map<number, Array<number>>()
  nodes.forEach((_, index) => {
    const root = find(index)
    byRoot.set(root, [...(byRoot.get(root) ?? []), index])
  })
  const groupOf = new Map<string, string>()
  const groups = [...byRoot.entries()].map(([root, members]): SourceGroup => {
    const key = nodes[root]!.publisher
    const unique = <A>(values: ReadonlyArray<A>) => [...new Set(values)]
    for (const index of members) groupOf.set(nodes[index]!.canonical, key)
    return {
      key,
      domains: unique(members.map((i) => nodes[i]!.domain)),
      urls: unique(members.map((i) => nodes[i]!.canonical)),
      titles: unique(members.flatMap((i) => (nodes[i]!.citation.title ? [nodes[i]!.citation.title!] : []))),
      providers: unique(members.map((i) => nodes[i]!.citation.provider)),
      citations: members.length,
      merged_by: [...reasons[root]!].sort(),
    }
  })
  groups.sort((a, b) => b.providers.length - a.providers.length || b.citations - a.citations)
  return {
    citations: citations.length,
    unique_urls: new Set(nodes.map((n) => n.canonical)).size,
    independent_sources: groups.length,
    groups,
    group_of: groupOf,
  }
}

/** JSON view of an Independence result (drops the lookup map). */
export const independenceView = (independence: Independence) => ({
  citations: independence.citations,
  unique_urls: independence.unique_urls,
  independent_sources: independence.independent_sources,
  groups: independence.groups,
})
