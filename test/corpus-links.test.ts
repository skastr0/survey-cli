import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { access, mkdir, readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { corpusCommand, parseCutoff } from "../src/capabilities/corpus"
import { researchCommand } from "../src/capabilities/research"
import { searchCommand } from "../src/capabilities/search"
import { verifyCommand } from "../src/capabilities/verify"
import { Corpus, type PutDocument } from "../src/core/corpus"
import { Store } from "../src/core/store"

const globalRef = globalThis as Record<string, unknown>
if (globalRef.Bun === undefined) {
  globalRef.Bun = { env: process.env, version: "test" }
}

// ---------------------------------------------------------------------------
// In-memory corpus with the subset of behavior these features rely on.

interface Doc extends PutDocument {
  id: number
  version: number
  updated_at: string
  domain: string
}

const docs: Array<Doc> = []
let nextId = 1

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

const InMemoryCorpus = Layer.succeed(Corpus, {
  put: (doc: PutDocument) =>
    Effect.sync(() => {
      const existing = docs.find((d) => d.url === doc.url)
      const changed = existing?.content !== doc.content
      if (existing) {
        Object.assign(existing, doc, {
          version: changed ? existing.version + 1 : existing.version,
          updated_at: new Date().toISOString(),
        })
      } else {
        docs.push({ ...doc, id: nextId++, version: 1, updated_at: new Date().toISOString(), domain: domainOf(doc.url) })
      }
      const row = docs.find((d) => d.url === doc.url)!
      return {
        id: row.id,
        canonical_url: row.url,
        version: row.version,
        content_hash: "h",
        created: existing === undefined,
        changed,
        previous_hash: null,
      }
    }),
  get: (ref: { id?: number; url?: string }) =>
    Effect.sync(() => docs.find((d) => (ref.id !== undefined ? d.id === ref.id : d.url === ref.url))),
  list: (options: {
    limit: number
    offset?: number
    filter?: { kind?: string; tag?: string; provider?: string; domain?: string }
  }) =>
    Effect.sync(() => {
      const f = options.filter ?? {}
      return docs
        .filter(
          (d) =>
            (f.kind === undefined || d.kind === f.kind) &&
            (f.provider === undefined || d.provider === f.provider) &&
            (f.domain === undefined || d.domain === f.domain) &&
            (f.tag === undefined || (d.tags ?? []).includes(f.tag)),
        )
        .slice(options.offset ?? 0, (options.offset ?? 0) + options.limit)
    }),
  remove: (ref: { id?: number }) =>
    Effect.sync(() => {
      const index = docs.findIndex((d) => d.id === ref.id)
      if (index < 0) return 0
      docs.splice(index, 1)
      return 1
    }),
} as never)

const UnusedStore = Layer.succeed(
  Store,
  {
    upsertRun: (input: { id: string }) => Effect.succeed({ id: input.id }),
    updateRun: () => Effect.void,
    findRunByRemote: () => Effect.succeed(undefined),
    insertSources: () => Effect.succeed(0),
  } as never,
)

// ---------------------------------------------------------------------------
// Stub HTTP server: handler gets method + path + query and may delay.

const servers: Array<Server> = []
const seen: Array<string> = []
let inFlight = 0
let maxInFlight = 0

const startServer = (
  handler: (method: string, pathname: string, url: URL) => { status?: number; body: unknown; delayMs?: number },
) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x")
      const method = req.method ?? "GET"
      req.resume()
      req.on("end", () => {
        seen.push(`${method} ${url.pathname}`)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        const reply = handler(method, url.pathname, url)
        setTimeout(() => {
          inFlight -= 1
          res.writeHead(reply.status ?? 200, { "content-type": "application/json" })
          res.end(JSON.stringify(reply.body))
        }, reply.delayMs ?? 0)
      })
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
    servers.push(server)
  })

// ---------------------------------------------------------------------------
// CLI harness

const NodeFileSystem = FileSystem.layerNoop({
  exists: (path: string) => Effect.promise(() => access(path).then(() => true, () => false)),
  readFileString: (path: string) =>
    Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: () => ({ _tag: "SystemError" }) as never }),
  makeDirectory: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path, { recursive: true })
      },
      catch: () => ({ _tag: "SystemError" }) as never,
    }),
})

const testLayer = Layer.mergeAll(
  UnusedStore,
  InMemoryCorpus,
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
  FetchHttpClient.layer,
)

const root = Command.make("survey").pipe(
  Command.withSubcommands([searchCommand, researchCommand, verifyCommand, corpusCommand]),
)

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

const ENV_KEYS = [
  "SURVEY_HOME",
  "KEENABLE_API_KEY", "KEENABLE_API_BASE_URL",
  "EXA_API_KEY", "EXA_API_BASE_URL",
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.SURVEY_HOME = mkdtempSync(join(tmpdir(), "survey-links-"))
  delete process.env.KEENABLE_API_KEY
  docs.length = 0
  nextId = 1
  seen.length = 0
  inFlight = 0
  maxInFlight = 0
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const server of servers.splice(0)) server.close()
})

const json = (value: unknown) => JSON.stringify(value)

// ---------------------------------------------------------------------------

const searchResults = [1, 2, 3, 4].map((n) => ({
  url: `https://site${n}.example/page`,
  title: `Page ${n}`,
  snippet: `snippet ${n}`,
}))

const keenableStub = (options: { failUrl?: string; delayMs?: number } = {}) =>
  startServer((method, pathname, url) => {
    if (method === "POST" && pathname === "/v1/search/public") {
      return { body: { query: "q", results: searchResults } }
    }
    if (method === "GET" && pathname === "/v1/fetch/public") {
      const target = url.searchParams.get("url")!
      if (options.failUrl && target === options.failUrl) return { status: 500, body: { error: "upstream exploded" } }
      return {
        body: { url: target, content: `# Body of ${target}`, title: `Title of ${target}` },
        ...(options.delayMs ? { delayMs: options.delayMs } : {}),
      }
    }
    return { status: 404, body: { error: pathname } }
  })

describe("search read_top", () => {
  it.live("reads the top n fused results into the corpus and attaches corpus refs", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => keenableStub())
      process.env.KEENABLE_API_BASE_URL = `http://127.0.0.1:${port}`

      const { body } = yield* run([
        "search",
        json({ query: "q", providers: ["keenable"], tier: "free", read_top: 2, tags: ["rt"] }),
      ])
      expect(body.ok).toBe(true)
      const results = body.data.results as Array<any>
      expect(results).toHaveLength(4)
      // ids follow completion order under concurrency, so match them by url
      for (const result of results.slice(0, 2)) {
        const stored = docs.find((d) => d.url === result.url)!
        expect(result.corpus).toEqual({ id: stored.id, version: 1, changed: true })
      }
      expect(results[0].read).toMatchObject({ provider: "keenable", cached: false })
      expect(results[2].corpus).toBeUndefined()
      expect(results[2].read).toBeUndefined()
      expect(docs.map((d) => [d.url, d.kind, d.tags]).sort()).toEqual([
        ["https://site1.example/page", "web", ["rt"]],
        ["https://site2.example/page", "web", ["rt"]],
      ])
      expect(seen.filter((s) => s === "GET /v1/fetch/public")).toHaveLength(2)
    }),
  )

  it.live("without read_top it only searches", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => keenableStub())
      process.env.KEENABLE_API_BASE_URL = `http://127.0.0.1:${port}`
      const { body } = yield* run(["search", json({ query: "q", providers: ["keenable"], tier: "free" })])
      expect(body.data.results.every((r: any) => r.corpus === undefined)).toBe(true)
      expect(seen.filter((s) => s.includes("fetch"))).toHaveLength(0)
    }),
  )

  it.live("a failed read becomes read_error on that result only", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => keenableStub({ failUrl: searchResults[1]!.url }))
      process.env.KEENABLE_API_BASE_URL = `http://127.0.0.1:${port}`
      const { body } = yield* run([
        "search",
        json({ query: "q", providers: ["keenable"], tier: "free", read_top: 3, read_providers: ["keenable"] }),
      ])
      const results = body.data.results as Array<any>
      expect(results.map((r) => (r.corpus ? "read" : r.read_error ? "error" : "none"))).toEqual([
        "read",
        "error",
        "read",
        "none",
      ])
      expect(results[1].read_error.type).toBeDefined()
    }),
  )

  it.live("read_concurrency bounds parallel fetches", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => keenableStub({ delayMs: 40 }))
      process.env.KEENABLE_API_BASE_URL = `http://127.0.0.1:${port}`
      yield* run(["search", json({ query: "q", providers: ["keenable"], tier: "free", read_top: 4, read_concurrency: 1 })])
      expect(maxInFlight).toBe(1)
      docs.length = 0
      seen.length = 0
      maxInFlight = 0
      yield* run(["search", json({ query: "q", providers: ["keenable"], tier: "free", read_top: 4, read_concurrency: 2 })])
      expect(maxInFlight).toBe(2)
    }),
  )

  it.live("max_age_ms reuses the corpus copy instead of fetching again", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => keenableStub())
      process.env.KEENABLE_API_BASE_URL = `http://127.0.0.1:${port}`
      const input = { query: "q", providers: ["keenable"], tier: "free", read_top: 2, max_age_ms: 3_600_000 }
      yield* run(["search", json(input)])
      seen.length = 0
      const second = yield* run(["search", json(input)])
      expect(seen.filter((s) => s === "GET /v1/fetch/public")).toHaveLength(0)
      expect(second.body.data.results[0].read.cached).toBe(true)
    }),
  )
})

describe("research and verify store reports", () => {
  const exaStub = () =>
    startServer((method, pathname) => {
      if (method === "POST" && pathname === "/agent/runs") return { body: { id: "run_1", status: "queued" } }
      if (method === "GET" && pathname === "/agent/runs/run_1") {
        return {
          body: {
            id: "run_1",
            status: "completed",
            output: { content: "Bun is maintained by Oven." },
            citations: [{ url: "https://bun.sh/about", title: "About Bun" }],
          },
        }
      }
      if (method === "POST" && pathname === "/answer") {
        return { body: { answer: "Yes, it did.", citations: [{ url: "https://bun.sh/blog/x" }] } }
      }
      return { status: 404, body: { error: pathname } }
    })

  const useExa = (port: number) => {
    process.env.EXA_API_KEY = "exa-test"
    process.env.EXA_API_BASE_URL = `http://127.0.0.1:${port}`
  }

  it.live("research stores a kind=report document at a stable survey://research/<run> key", () =>
    Effect.gen(function* () {
      useExa(yield* Effect.promise(() => exaStub()))
      const { body } = yield* run([
        "research",
        json({ query: "Who maintains Bun?", providers: ["exa"], depth: "quick", domain: "web", tags: ["oss"] }),
      ])
      expect(body.ok).toBe(true)
      expect(body.data.corpus).toMatchObject({ id: 1, version: 1, created: true })
      expect(body.data.corpus.url).toMatch(/^survey:\/\/research\//)
      expect(docs).toHaveLength(1)
      expect(docs[0]).toMatchObject({
        kind: "report",
        provider: "survey",
        title: "Research: Who maintains Bun?",
        url: body.data.corpus.url,
        tags: ["oss"],
      })
      expect(docs[0]!.content).toContain("# Research: Who maintains Bun?")
      expect(docs[0]!.content).toContain("Bun is maintained by Oven.")
      expect(docs[0]!.content).toContain("https://bun.sh/about")
      expect(docs[0]!.metadata).toMatchObject({
        query: "Who maintains Bun?",
        providers_succeeded: ["exa"],
        source_count: 1,
      })
    }),
  )

  it.live("research store:false opts out", () =>
    Effect.gen(function* () {
      useExa(yield* Effect.promise(() => exaStub()))
      const { body } = yield* run([
        "research",
        json({ query: "Who maintains Bun?", providers: ["exa"], depth: "quick", domain: "web", store: false }),
      ])
      expect(body.ok).toBe(true)
      expect(body.data.corpus).toBeUndefined()
      expect(docs).toHaveLength(0)
    }),
  )

  it.live("verify stores its report at survey://verify/<claim hash>, versioned on re-run", () =>
    Effect.gen(function* () {
      useExa(yield* Effect.promise(() => exaStub()))
      const input = { claim: "Bun can compile to a single binary", providers: ["exa"], domain: "web", tags: ["fc"] }
      const first = (yield* run(["verify", json(input)])).body.data
      expect(first.corpus).toMatchObject({ id: 1, created: true })
      expect(first.corpus.url).toMatch(/^survey:\/\/verify\/[0-9a-f]{16}$/)
      expect(docs[0]).toMatchObject({ kind: "report", provider: "survey", tags: ["fc"] })
      expect(docs[0]!.content).toContain("Confidence: **low**")
      expect(docs[0]!.content).toContain("Yes, it did.")
      expect(docs[0]!.metadata).toMatchObject({ providers_succeeded: ["exa"], confidence: "low" })

      const again = (yield* run(["verify", json(input)])).body.data
      expect(again.corpus).toMatchObject({ id: 1, created: false, changed: false, url: first.corpus.url })
      expect(docs).toHaveLength(1)

      const optOut = (yield* run(["verify", json({ ...input, claim: "Another claim", store: false })])).body.data
      expect(optOut.corpus).toBeUndefined()
      expect(docs).toHaveLength(1)
    }),
  )

  it.live("nothing is stored when every provider failed", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => startServer(() => ({ status: 500, body: { error: "down" } })))
      useExa(port)
      const { body } = yield* run(["verify", json({ claim: "x", providers: ["exa"], domain: "web" })])
      expect(body.data.confidence).toBe("none")
      expect(body.data.corpus).toBeUndefined()
      expect(docs).toHaveLength(0)
    }),
  )
})

describe("corpus prune", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

  const seed = () => {
    const dir = mkdtempSync(join(tmpdir(), "survey-prune-"))
    const present = join(dir, "present.md")
    writeFileSync(present, "x")
    const gone = join(dir, "gone.md")
    const rows: Array<[string, string, number]> = [
      [pathToFileURL(present).toString(), "file", 1],
      [pathToFileURL(gone).toString(), "file", 1],
      ["https://old.example/a", "web", 120],
      ["https://new.example/b", "web", 2],
      ["survey://research/old", "report", 60],
    ]
    for (const [url, kind, age] of rows) {
      docs.push({
        url,
        kind,
        content: "c",
        id: nextId++,
        version: 1,
        updated_at: daysAgo(age),
        domain: domainOf(url),
        provider: "t",
        tags: kind === "report" ? ["q3"] : [],
      })
    }
    return { present, gone }
  }

  it("parseCutoff reads durations and ISO dates", () => {
    const now = Date.parse("2026-01-31T00:00:00Z")
    expect(parseCutoff("30d", now)).toBe(Date.parse("2026-01-01T00:00:00Z"))
    expect(parseCutoff("12h", now)).toBe(now - 12 * 3_600_000)
    expect(parseCutoff("2w", now)).toBe(now - 14 * 86_400_000)
    expect(parseCutoff("2026-01-15", now)).toBe(Date.parse("2026-01-15"))
    expect(parseCutoff("soon", now)).toBeUndefined()
  })

  it.live("defaults to a dry run that lists documents whose file source is gone", () =>
    Effect.gen(function* () {
      seed()
      const { body } = yield* run(["corpus", "prune", json({})])
      expect(body.data).toMatchObject({ dry_run: true, scanned: 5, matched: 1, would_remove: 1, removed: 0 })
      expect(body.data.documents[0]).toMatchObject({ status: "would_remove", reasons: ["missing_file"] })
      expect(body.data.documents[0].url).toMatch(/gone\.md$/)
      expect(docs).toHaveLength(5)
    }),
  )

  it.live("dry_run:false removes them, and only them", () =>
    Effect.gen(function* () {
      seed()
      const { body } = yield* run(["corpus", "prune", json({ dry_run: false })])
      expect(body.data).toMatchObject({ dry_run: false, removed: 1, would_remove: 0, failed: 0 })
      expect(docs.map((d) => d.url).some((u) => u.endsWith("gone.md"))).toBe(false)
      expect(docs).toHaveLength(4)
    }),
  )

  it.live("older_than with kind/tag filters scopes the cut", () =>
    Effect.gen(function* () {
      seed()
      const web = (yield* run(["corpus", "prune", json({ older_than: "90d", kind: "web", missing_files: false })])).body.data
      expect(web.documents.map((d: any) => d.url)).toEqual(["https://old.example/a"])
      expect(web.documents[0].reasons).toEqual(["older_than"])

      const reports = (yield* run(["corpus", "prune", json({ older_than: "30d", kind: "report", tag: "q3", dry_run: false })])).body.data
      expect(reports).toMatchObject({ removed: 1, matched: 1 })
      expect(docs.some((d) => d.kind === "report")).toBe(false)

      const both = (yield* run(["corpus", "prune", json({ older_than: "90d" })])).body.data
      const byReason = Object.fromEntries(both.documents.map((d: any) => [d.url.split("/").pop(), d.reasons]))
      expect(byReason).toMatchObject({ "gone.md": ["missing_file"], a: ["older_than"] })
    }),
  )

  it.live("max_remove caps a call and reports truncation; bad criteria are rejected", () =>
    Effect.gen(function* () {
      seed()
      const capped = (yield* run(["corpus", "prune", json({ older_than: "1d", missing_files: false, max_remove: 2, dry_run: false })])).body.data
      expect(capped).toMatchObject({ matched: 5, removed: 2, truncated: true })
      expect(docs).toHaveLength(3)

      const bad = (yield* run(["corpus", "prune", json({ older_than: "soon" })])).body
      expect(bad.error.details.field).toBe("older_than")
      const none = (yield* run(["corpus", "prune", json({ missing_files: false })])).body
      expect(none.error.message).toContain("Nothing to prune by")
    }),
  )
})
