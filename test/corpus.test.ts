import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

;(globalThis as { Bun?: unknown }).Bun ??= { env: process.env }

import { corpusDiff, corpusGrep, corpusRead, corpusSearch, locateLines, queryTerms } from "../src/capabilities/corpus"
import { Corpus, type DocumentRecord, documentKey, hashContent, toFtsQuery } from "../src/core/corpus"
import { diffLines } from "../src/core/diff"

const doc = (id: number, url: string, content: string, version = 1): DocumentRecord => ({
  id,
  url,
  canonical_url: documentKey(url),
  domain: "",
  title: `doc ${id}`,
  provider: "test",
  kind: "note",
  content,
  content_hash: hashContent(content),
  bytes: content.length,
  version,
  tags: [],
  metadata: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  changed_at: "2026-01-01T00:00:00.000Z",
})

const stubCorpus = (docs: ReadonlyArray<DocumentRecord>, versions: Record<string, string> = {}) => {
  const searched: Array<string> = []
  const service = Corpus.of({
    put: () => Effect.die("unused"),
    get: (ref) => Effect.succeed(docs.find((d) => d.id === ref.id || (ref.url !== undefined && d.canonical_url === documentKey(ref.url)))),
    versions: () => Effect.succeed([]),
    versionContent: (id, version) => Effect.succeed(versions[`${id}:${version}`]),
    search: (options) => {
      searched.push(options.query)
      return Effect.succeed(
        docs.slice(0, 1).map(({ content: _content, ...rest }) => ({ ...rest, score: -1, snippet: "…" })),
      )
    },
    list: () => Effect.succeed([]),
    scan: (options) =>
      Effect.succeed(options.ids === undefined ? docs : docs.filter((d) => options.ids!.includes(d.id))),
    remove: () => Effect.succeed(0),
    stats: Effect.die("unused"),
  })
  return { layer: Layer.succeed(Corpus, service), searched }
}

describe("toFtsQuery", () => {
  it("quotes bare terms so punctuation never breaks FTS5", () => {
    expect(toFtsQuery("effect-ts v4.0 rate:limit")).toBe('"effect-ts" "v4.0" "rate:limit"')
  })

  it("keeps phrases and boolean operators", () => {
    expect(toFtsQuery('"deep research" OR agents')).toBe('"deep research" OR "agents"')
  })
})

describe("documentKey", () => {
  it("canonicalizes URLs and keeps non-URL keys verbatim", () => {
    expect(documentKey("https://www.Example.com/a/?utm_source=x#frag")).toBe("https://example.com/a")
    expect(documentKey("  notes/today  ")).toBe("notes/today")
  })
})

describe("diffLines", () => {
  it("emits removals before additions with context", () => {
    const result = diffLines("a\nb\nc\nd", "a\nB\nc\nd", 1)
    expect(result.mode).toBe("lcs")
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
    expect(result.hunks).toEqual([{ old_start: 1, new_start: 1, lines: [" a", "-b", "+B", " c"] }])
  })

  it("reports no hunks for identical input", () => {
    expect(diffLines("same\ntext", "same\ntext").hunks).toEqual([])
  })
})

describe("corpus commands", () => {
  const docs = [
    doc(1, "https://a.com/x", "alpha\nRate limit: 100 rpm\nomega"),
    doc(2, "https://b.com/y", "nothing here\nrate LIMIT again"),
  ]

  it.effect("grep finds literal matches with context", () =>
    Effect.gen(function* () {
      const result = yield* corpusGrep({ pattern: "rate limit", ignore_case: true, context: 1 })
      expect(result.count).toBe(2)
      expect(result.documents_matched).toBe(2)
      expect(result.matches[0]).toMatchObject({ document_id: 1, line: 2, before: ["alpha"], after: ["omega"] })
    }).pipe(Effect.provide(stubCorpus(docs).layer)),
  )

  it.effect("grep treats patterns literally unless regex=true", () =>
    Effect.gen(function* () {
      const literal = yield* corpusGrep({ pattern: "1.0" })
      expect(literal.count).toBe(0)
      const regex = yield* corpusGrep({ pattern: "\\d+ rpm", regex: true })
      expect(regex.count).toBe(1)
    }).pipe(Effect.provide(stubCorpus(docs).layer)),
  )

  it.effect("grep caps matches and flags truncation", () =>
    Effect.gen(function* () {
      const result = yield* corpusGrep({ pattern: "a", max_matches: 1 })
      expect(result.count).toBe(1)
      expect(result.truncated).toBe(true)
    }).pipe(Effect.provide(stubCorpus(docs).layer)),
  )

  it.effect("read slices by line range", () =>
    Effect.gen(function* () {
      const result = yield* corpusRead({ id: 1, lines: "2-3" })
      expect(result.content).toBe("Rate limit: 100 rpm\nomega")
      expect(result.total_lines).toBe(3)
      expect(result.truncated).toBe(true)
    }).pipe(Effect.provide(stubCorpus(docs).layer)),
  )

  it.effect("read resolves by canonical url and char range", () =>
    Effect.gen(function* () {
      const result = yield* corpusRead({ url: "https://www.a.com/x/", offset: 0, length: 5 })
      expect(result.content).toBe("alpha")
    }).pipe(Effect.provide(stubCorpus(docs).layer)),
  )

  it.effect("read fails cleanly for unknown documents", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(corpusRead({ id: 99 }))
      expect(error._tag).toBe("CommandInputError")
    }).pipe(Effect.provide(stubCorpus(docs).layer)),
  )

  it.effect("search quotes terms by default and passes raw fts on request", () => {
    const stub = stubCorpus(docs)
    return Effect.gen(function* () {
      yield* corpusSearch({ query: "rate-limit" })
      yield* corpusSearch({ query: "rate*", syntax: "fts" })
      expect(stub.searched).toEqual(['"rate-limit"', "rate*"])
    }).pipe(Effect.provide(stub.layer))
  })

  it.effect("diff compares previous version to latest by default", () =>
    Effect.gen(function* () {
      const result = yield* corpusDiff({ id: 3 })
      expect(result.from).toBe(1)
      expect(result.to).toBe(2)
      expect(result.diff.hunks[0]?.lines).toContain("+v2")
    }).pipe(
      Effect.provide(stubCorpus([doc(3, "note://w", "v2", 2)], { "3:1": "v1" }).layer),
    ),
  )

  it.effect("search hits carry best-matching line numbers", () =>
    Effect.gen(function* () {
      const result = yield* corpusSearch({ query: "rate limits" })
      expect(result.hits[0]).toMatchObject({ id: 1, lines: [{ line: 2, text: "Rate limit: 100 rpm" }] })
      const none = yield* corpusSearch({ query: "rate", max_lines: 0 })
      expect("lines" in none.hits[0]!).toBe(false)
    }).pipe(Effect.provide(stubCorpus(docs).layer)),
  )
})

describe("locateLines", () => {
  it("ranks lines by matched terms and returns them in document order", () => {
    const content = "intro\nfusion only\nreciprocal rank fusion here\nrank again\nend"
    expect(locateLines(content, queryTerms("Reciprocal Rank Fusion"), 2)).toEqual([
      { line: 2, text: "fusion only" },
      { line: 3, text: "reciprocal rank fusion here" },
    ])
    expect(queryTerms('"deep research" OR NEAR(agents)')).toEqual(["deep", "research", "agents"])
  })
})
