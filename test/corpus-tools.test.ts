import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { mkdtempSync } from "node:fs"
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { corpusCommand } from "../src/capabilities/corpus"
import { extractLinks, resolveLink } from "../src/capabilities/corpus-tools"
import { Corpus, hashContent, type DocumentRecord, type PutDocument } from "../src/core/corpus"
import { Store } from "../src/core/store"

const globalRef = globalThis as Record<string, unknown>
if (globalRef.Bun === undefined) {
  globalRef.Bun = { env: process.env, version: "test" }
}

// ---------------------------------------------------------------------------
// In-memory corpus mirroring the real put semantics (tag union, versions on change).

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface Row extends Mutable<DocumentRecord> {
  history: Array<{ version: number; content: string; hash: string }>
}

let rows: Array<Row> = []
let nextId = 1
let clock = 0

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

const matches = (row: Row, f: { kind?: string; tag?: string; provider?: string; domain?: string; since?: string } = {}) =>
  (f.kind === undefined || row.kind === f.kind) &&
  (f.provider === undefined || row.provider === f.provider) &&
  (f.domain === undefined || row.domain === f.domain) &&
  (f.tag === undefined || row.tags.includes(f.tag)) &&
  (f.since === undefined || row.updated_at >= f.since)

const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString()

const InMemoryCorpus = Layer.succeed(Corpus, {
  put: (doc: PutDocument) =>
    Effect.sync(() => {
      const hash = hashContent(doc.content)
      const existing = rows.find((r) => r.url === doc.url)
      if (existing === undefined) {
        const ts = stamp()
        rows.push({
          id: nextId++,
          url: doc.url,
          canonical_url: doc.url,
          domain: domainOf(doc.url),
          title: doc.title ?? null,
          provider: doc.provider ?? null,
          kind: doc.kind ?? "web",
          content: doc.content,
          content_hash: hash,
          bytes: doc.content.length,
          version: 1,
          tags: [...new Set(doc.tags ?? [])],
          metadata: doc.metadata ?? null,
          created_at: ts,
          updated_at: ts,
          changed_at: ts,
          history: [{ version: 1, content: doc.content, hash }],
        })
        const row = rows.at(-1)!
        return { id: row.id, canonical_url: row.url, version: 1, content_hash: hash, created: true, changed: true, previous_hash: null }
      }
      const changed = existing.content_hash !== hash
      const previous = existing.content_hash
      if (changed) {
        existing.version += 1
        existing.content = doc.content
        existing.content_hash = hash
        existing.history.push({ version: existing.version, content: doc.content, hash })
        existing.changed_at = stamp()
      }
      existing.tags = [...new Set([...existing.tags, ...(doc.tags ?? [])])]
      existing.title = doc.title ?? existing.title
      existing.kind = doc.kind ?? existing.kind
      existing.provider = doc.provider ?? existing.provider
      existing.metadata = doc.metadata ?? existing.metadata
      existing.updated_at = stamp()
      return {
        id: existing.id,
        canonical_url: existing.url,
        version: existing.version,
        content_hash: hash,
        created: false,
        changed,
        previous_hash: changed ? previous : null,
      }
    }),
  get: (ref: { id?: number; url?: string }) =>
    Effect.sync(() => rows.find((r) => (ref.id !== undefined ? r.id === ref.id : r.url === ref.url))),
  versions: (id: number) =>
    Effect.sync(
      () =>
        rows
          .find((r) => r.id === id)
          ?.history.map((h) => ({ version: h.version, content_hash: h.hash, bytes: h.content.length, fetched_at: "t" })) ?? [],
    ),
  versionContent: (id: number, version: number) =>
    Effect.sync(() => rows.find((r) => r.id === id)?.history.find((h) => h.version === version)?.content),
  scan: (options: { ids?: ReadonlyArray<number>; filter?: Parameters<typeof matches>[1]; limit: number }) =>
    Effect.sync(() =>
      rows
        .filter((r) => (options.ids === undefined || options.ids.includes(r.id)) && matches(r, options.filter))
        .slice(0, options.limit),
    ),
  list: () => Effect.sync(() => rows),
  setTags: (id: number, tags: ReadonlyArray<string>) =>
    Effect.sync(() => {
      const row = rows.find((r) => r.id === id)
      if (row === undefined) return false
      row.tags = [...new Set(tags)].sort()
      return true
    }),
  remove: () => Effect.succeed(0),
} as never)

// ---------------------------------------------------------------------------

const NodeFileSystem = FileSystem.layerNoop({
  exists: (path: string) => Effect.promise(() => access(path).then(() => true, () => false)),
  readFileString: (path: string) =>
    Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: () => ({ _tag: "SystemError", message: `cannot read ${path}` }) as never }),
  writeFileString: (path: string, data: string) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, data)
      },
      catch: () => ({ _tag: "SystemError", message: `cannot write ${path}` }) as never,
    }),
  makeDirectory: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path, { recursive: true })
      },
      catch: () => ({ _tag: "SystemError" }) as never,
    }),
})

const testLayer = Layer.mergeAll(
  InMemoryCorpus,
  Layer.succeed(Store, {} as never),
  FetchHttpClient.layer,
  NodeFileSystem,
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.die("unused"))),
)

const root = Command.make("survey").pipe(Command.withSubcommands([corpusCommand]))

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const originalOut = process.stdout.write
    const originalErr = process.stderr.write
    const previousExit = process.exitCode
    ;(process.stdout as { write: (c: unknown) => boolean }).write = (c) => (out.push(String(c)), true)
    ;(process.stderr as { write: (c: unknown) => boolean }).write = (c) => (err.push(String(c)), true)
    process.exitCode = 0
    yield* Command.runWith(root, { version: "0.0.0-test", renderErrors: false })(args).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.stdout.write = originalOut
          process.stderr.write = originalErr
        }),
      ),
    )
    const exitCode = process.exitCode ?? 0
    process.exitCode = previousExit
    return { exitCode, body: JSON.parse(out.join("") || err.join("")) as any }
  }).pipe(Effect.provide(testLayer))

const ENV_KEYS = ["SURVEY_HOME", "SURVEY_ARTIFACT_DIR"] as const
const saved: Record<string, string | undefined> = {}
let artifacts = ""

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.SURVEY_HOME = mkdtempSync(join(tmpdir(), "survey-tools-"))
  artifacts = mkdtempSync(join(tmpdir(), "survey-artifacts-"))
  process.env.SURVEY_ARTIFACT_DIR = artifacts
  rows = []
  nextId = 1
  clock = 0
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const json = (value: unknown) => JSON.stringify(value)

const seed = () => {
  const put = (doc: PutDocument) => rows.length >= 0 && Effect.runSync(Effect.provide(Effect.gen(function* () {
    const corpus = yield* Corpus
    return yield* corpus.put(doc)
  }), InMemoryCorpus))
  put({ url: "https://a.example/one", title: "One", content: "# One\n\nSee [two](https://b.example/two).", kind: "web", provider: "keenable", tags: ["inbox"] })
  put({ url: "https://a.example/one", content: "# One v2\n\nSee [two](https://b.example/two) and [rel](/docs/x#frag).", tags: [] })
  put({ url: "https://b.example/two", title: "Two", content: "second doc", kind: "document", provider: "anydoc", tags: ["relevant"], metadata: { route: "local:anydoc" } })
  put({ url: "survey://research/r1", title: "Report", content: "report body", kind: "report", provider: "survey", tags: ["inbox", "q3"] })
}

// ---------------------------------------------------------------------------

describe("corpus export", () => {
  it.live("jsonl: one record per line with the schema marker, in the artifact dir by default", () =>
    Effect.gen(function* () {
      seed()
      const { body } = yield* run(["corpus", "export", json({})])
      expect(body.data).toMatchObject({ format: "jsonl", documents: 3, include_versions: false })
      expect(body.data.path.startsWith(artifacts)).toBe(true)
      expect(body.data.path.endsWith(".jsonl")).toBe(true)
      const lines = (yield* Effect.promise(() => readFile(body.data.path, "utf8"))).trim().split("\n").map((l) => JSON.parse(l))
      expect(lines.map((l) => l.url)).toEqual(["https://a.example/one", "https://b.example/two", "survey://research/r1"])
      expect(lines[0]).toMatchObject({ schema: "survey.corpus.document/v1", version: 2, title: "One", tags: ["inbox"] })
      expect(lines[0].versions).toBeUndefined()
    }),
  )

  it.live("filters (kind, tag, ids) and include_versions", () =>
    Effect.gen(function* () {
      seed()
      const path = join(artifacts, "filtered.jsonl")
      const byKind = (yield* run(["corpus", "export", json({ kind: "document", path })])).body.data
      expect(byKind).toMatchObject({ documents: 1, path })
      const byTag = (yield* run(["corpus", "export", json({ tag: "inbox", path })])).body.data
      expect(byTag.documents).toBe(2)
      const byIds = (yield* run(["corpus", "export", json({ ids: [2], path })])).body.data
      expect(byIds.documents).toBe(1)

      const withVersions = (yield* run(["corpus", "export", json({ ids: [1], include_versions: true, path })])).body.data
      expect(withVersions.include_versions).toBe(true)
      const record = JSON.parse((yield* Effect.promise(() => readFile(path, "utf8"))).trim())
      expect(record.versions.map((v: any) => [v.version, v.content.slice(0, 5)])).toEqual([[1, "# One"], [2, "# One"]])
      expect(record.versions[0].content).not.toBe(record.versions[1].content)
    }),
  )

  it.live("bundle: index.md plus one markdown file per document with front matter", () =>
    Effect.gen(function* () {
      seed()
      const dir = join(artifacts, "bundle")
      const { body } = yield* run(["corpus", "export", json({ format: "bundle", path: dir })])
      expect(body.data).toMatchObject({ format: "bundle", path: dir, documents: 3 })
      expect(body.data.files).toEqual([
        "docs/0001-one.md",
        "docs/0002-two.md",
        "docs/0003-report.md",
      ])
      expect((yield* Effect.promise(() => readdir(join(dir, "docs")))).length).toBe(3)
      const index = yield* Effect.promise(() => readFile(join(dir, "index.md"), "utf8"))
      expect(index).toContain("- [One](docs/0001-one.md) — https://a.example/one (web, keenable, v2) — tags: inbox")
      expect(index).toContain("3 documents")
      const doc = yield* Effect.promise(() => readFile(join(dir, "docs/0002-two.md"), "utf8"))
      expect(doc.startsWith("---\nurl: \"https://b.example/two\"")).toBe(true)
      expect(doc).toContain('tags: ["relevant"]')
      expect(doc.trimEnd().endsWith("second doc")).toBe(true)
    }),
  )

  it.live("markdown: a single file with an index and anchors", () =>
    Effect.gen(function* () {
      seed()
      const { body } = yield* run(["corpus", "export", json({ format: "markdown", tag: "relevant" })])
      expect(body.data).toMatchObject({ format: "markdown", documents: 1 })
      expect(body.data.path.endsWith(".md")).toBe(true)
      const text = yield* Effect.promise(() => readFile(body.data.path, "utf8"))
      expect(text).toContain("# Corpus export")
      expect(text).toContain('<a id="doc-2"></a>')
      expect(text).toContain("second doc")
    }),
  )

  it.live("an empty selection writes nothing", () =>
    Effect.gen(function* () {
      seed()
      const { body } = yield* run(["corpus", "export", json({ tag: "nope" })])
      expect(body.data).toMatchObject({ documents: 0, path: null })
      expect(yield* Effect.promise(() => readdir(artifacts))).toEqual([])
    }),
  )
})

describe("corpus import", () => {
  const exportAll = (extra: object = {}) =>
    Effect.gen(function* () {
      const path = join(artifacts, `roundtrip-${Math.random().toString(36).slice(2)}.jsonl`)
      yield* run(["corpus", "export", json({ path, ...extra })])
      return path
    })

  it.live("round-trips into an empty corpus and is idempotent on re-import", () =>
    Effect.gen(function* () {
      seed()
      const path = yield* exportAll()
      const original = rows.map((r) => ({ url: r.url, title: r.title, kind: r.kind, provider: r.provider, tags: r.tags, content: r.content, metadata: r.metadata }))
      rows = []
      nextId = 1

      const first = (yield* run(["corpus", "import", json({ path })])).body.data
      expect(first).toMatchObject({ lines: 3, created: 3, updated: 0, unchanged: 0, failed: 0 })
      expect(rows.map((r) => ({ url: r.url, title: r.title, kind: r.kind, provider: r.provider, tags: r.tags, content: r.content, metadata: r.metadata }))).toEqual(original)

      const second = (yield* run(["corpus", "import", json({ path })])).body.data
      expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 3 })
      expect(rows).toHaveLength(3)
      expect(rows.map((r) => r.version)).toEqual([1, 1, 1]) // current content only; no history was exported
    }),
  )

  it.live("replays exported version history oldest-first, once", () =>
    Effect.gen(function* () {
      seed()
      const path = yield* exportAll({ include_versions: true })
      rows = []
      nextId = 1
      const first = (yield* run(["corpus", "import", json({ path })])).body.data
      expect(first).toMatchObject({ created: 3, updated: 0, failed: 0 })
      const one = rows.find((r) => r.url === "https://a.example/one")!
      expect(one.version).toBe(2)
      expect(one.history.map((h) => h.content.slice(0, 8))).toEqual(["# One\n\nS", "# One v2"])

      const again = (yield* run(["corpus", "import", json({ path })])).body.data
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3 })
      expect(one.version).toBe(2)
      expect(one.history).toHaveLength(2)
    }),
  )

  it.live("updates when content differs, adds tags, supports dry_run and inline content", () =>
    Effect.gen(function* () {
      const line = (content: string) => json({ url: "https://x.example/p", content, tags: ["a"] })
      const created = (yield* run(["corpus", "import", json({ content: line("v1"), tags: ["extra"] })])).body.data
      expect(created.created).toBe(1)
      expect(rows[0]!.tags).toEqual(["a", "extra"])

      const preview = (yield* run(["corpus", "import", json({ content: line("v2"), dry_run: true })])).body.data
      expect(preview).toMatchObject({ dry_run: true, updated: 1 })
      expect(rows[0]!.version).toBe(1)

      const updated = (yield* run(["corpus", "import", json({ content: line("v2") })])).body.data
      expect(updated).toMatchObject({ updated: 1 })
      expect(rows[0]!.version).toBe(2)
    }),
  )

  it.live("bad lines fail individually; path xor content is enforced", () =>
    Effect.gen(function* () {
      const content = [json({ url: "https://ok.example/", content: "fine" }), "{not json", json({ nope: true })].join("\n")
      const result = yield* run(["corpus", "import", json({ content })])
      expect(result.exitCode).toBe(1)
      expect(result.body.data).toMatchObject({ lines: 3, created: 1, failed: 2 })
      expect(result.body.data.results.filter((r: any) => r.status === "failed").map((r: any) => r.line)).toEqual([2, 3])

      const both = (yield* run(["corpus", "import", json({ content: "x", path: "/y" })])).body
      expect(both.error.message).toContain("exactly one of path or content")
    }),
  )
})

describe("corpus tag", () => {
  it.live("adds and removes tags by id, url and filter without touching content or timestamps", () =>
    Effect.gen(function* () {
      seed()
      const before = rows.map((r) => ({ v: r.version, u: r.updated_at, h: r.content_hash }))
      const added = (yield* run(["corpus", "tag", json({ ids: [1, 2], add: ["relevant", "watch"] })])).body.data
      expect(added).toMatchObject({ matched: 2, changed: 2 })
      expect(rows[0]!.tags).toEqual(["inbox", "relevant", "watch"])
      expect(added.documents[1]).toMatchObject({ id: 2, before: ["relevant"], after: ["relevant", "watch"] })

      const byUrl = (yield* run(["corpus", "tag", json({ urls: ["survey://research/r1"], remove: ["inbox"] })])).body.data
      expect(byUrl.documents[0].after).toEqual(["q3"])

      const byFilter = (yield* run(["corpus", "tag", json({ tag: "relevant", remove: ["relevant"], add: ["done"] })])).body.data
      expect(byFilter.matched).toBe(2)
      expect(rows.map((r) => r.tags.includes("done"))).toEqual([true, true, false])

      expect(rows.map((r) => ({ v: r.version, u: r.updated_at, h: r.content_hash }))).toEqual(before)
    }),
  )

  it.live("set replaces all tags; unchanged documents are not rewritten; dry_run previews", () =>
    Effect.gen(function* () {
      seed()
      const preview = (yield* run(["corpus", "tag", json({ kind: "web", set: ["archived"], dry_run: true })])).body.data
      expect(preview).toMatchObject({ dry_run: true, matched: 1, changed: 1 })
      expect(rows[0]!.tags).toEqual(["inbox"])

      yield* run(["corpus", "tag", json({ kind: "web", set: ["archived"] })])
      expect(rows[0]!.tags).toEqual(["archived"])
      const noop = (yield* run(["corpus", "tag", json({ kind: "web", add: ["archived"] })])).body.data
      expect(noop).toMatchObject({ matched: 1, changed: 0 })
    }),
  )

  it.live("ids and a filter select the union; unknown ids/urls are reported; bad input is rejected", () =>
    Effect.gen(function* () {
      seed()
      const union = (yield* run(["corpus", "tag", json({ ids: [3], kind: "document", add: ["x"], urls: ["https://nope.example"] })])).body.data
      expect(union.documents.map((d: any) => d.id)).toEqual([2, 3])
      expect(union.not_found).toEqual([{ url: "https://nope.example" }])
      const missingId = (yield* run(["corpus", "tag", json({ ids: [99], add: ["x"] })])).body.data
      expect(missingId).toMatchObject({ matched: 0, not_found: [{ id: 99 }] })

      expect((yield* run(["corpus", "tag", json({ add: ["x"] })])).body.error.message).toContain("Select documents")
      expect((yield* run(["corpus", "tag", json({ ids: [1] })])).body.error.message).toContain("Provide add, remove, or set")
      expect((yield* run(["corpus", "tag", json({ ids: [1], set: ["a"], add: ["b"] })])).body.error.message).toContain("do not combine")
    }),
  )
})

describe("corpus links", () => {
  it("extractLinks handles inline, reference, autolink, html and bare URLs, resolves relatives and skips code", () => {
    const md = [
      "Intro [a](https://a.example/x#top) and [again](https://a.example/x \"title\") plus ![img](/img/p.png).",
      "[rel](../up) [mail](mailto:me@x.io) [anchor](#sec) [js](javascript:alert(1)).",
      "<https://auto.example/p> and <a href=\"https://html.example/h\">h</a> and bare https://bare.example/path?q=1, done.",
      "A wiki [link](https://en.wikipedia.org/wiki/Foo_(bar)).",
      "[ref]: https://ref.example/r \"R\"",
      "```",
      "[code](https://code.example/skip) https://code.example/also",
      "```",
      "inline `https://tick.example/skip` span",
    ].join("\n")
    const links = extractLinks(md, "https://base.example/docs/page")
    expect(links.map((l) => [l.url, l.kind, l.occurrences])).toEqual([
      ["https://a.example/x", "link", 2],
      ["https://base.example/img/p.png", "image", 1],
      ["https://base.example/up", "link", 1],
      ["https://auto.example/p", "autolink", 1],
      ["https://html.example/h", "html", 1],
      ["https://bare.example/path?q=1", "bare", 1],
      ["https://en.wikipedia.org/wiki/Foo_(bar)", "link", 1],
      ["https://ref.example/r", "reference", 1],
    ])
    expect(links.map((l) => l.url)).not.toContain("https://code.example/skip")
    expect(links.map((l) => l.url)).not.toContain("https://tick.example/skip")
    expect(links.find((l) => l.url === "https://a.example/x")!.text).toBe("a")
  })

  it("resolveLink only yields http(s) URLs without fragments", () => {
    expect(resolveLink("/p#x", "https://h.example/a/b")).toBe("https://h.example/p")
    expect(resolveLink("mailto:a@b.c", "https://h.example")).toBeUndefined()
    expect(resolveLink("#top", "https://h.example")).toBeUndefined()
    expect(resolveLink("rel/path", "note://x")).toBeUndefined()
    expect(resolveLink("<https://ok.example/>", undefined)).toBe("https://ok.example/")
  })

  it.live("lists a document's links with internal / in_corpus marks, scope, new_only and version", () =>
    Effect.gen(function* () {
      seed()
      const all = (yield* run(["corpus", "links", json({ id: 1 })])).body.data
      expect(all.urls).toEqual(["https://b.example/two", "https://a.example/docs/x"])
      expect(all.links[0]).toMatchObject({ internal: false, in_corpus: true, corpus_id: 2, kind: "link", text: "two" })
      expect(all.links[1]).toMatchObject({ internal: true, in_corpus: false })
      expect(all).toMatchObject({ count: 2, known: 1, version: 2 })

      expect((yield* run(["corpus", "links", json({ id: 1, scope: "internal" })])).body.data.urls).toEqual(["https://a.example/docs/x"])
      expect((yield* run(["corpus", "links", json({ id: 1, scope: "external" })])).body.data.urls).toEqual(["https://b.example/two"])
      expect((yield* run(["corpus", "links", json({ id: 1, new_only: true })])).body.data.urls).toEqual(["https://a.example/docs/x"])
      expect((yield* run(["corpus", "links", json({ url: "https://a.example/one", version: 1 })])).body.data.urls).toEqual(["https://b.example/two"])
      expect((yield* run(["corpus", "links", json({ id: 1, limit: 1 })])).body.data).toMatchObject({ count: 1, truncated: true })
    }),
  )

  it.live("reports missing documents and versions", () =>
    Effect.gen(function* () {
      seed()
      expect((yield* run(["corpus", "links", json({ id: 99 })])).body.error.message).toContain("No corpus document")
      expect((yield* run(["corpus", "links", json({ id: 1, version: 9 })])).body.error.message).toContain("no version 9")
      expect((yield* run(["corpus", "links", json({})])).body.error.message).toContain("Provide id or url")
    }),
  )
})
