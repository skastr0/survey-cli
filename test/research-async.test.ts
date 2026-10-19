import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { mkdtempSync } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { finalizeResearch, researchCommand } from "../src/capabilities/research"
import { verifyCommand } from "../src/capabilities/verify"
import { Corpus, type PutDocument } from "../src/core/corpus"
import { groupSources, registrableDomain, similarTitles, titleTokens } from "../src/core/independence"
import { Store, type RunRecord } from "../src/core/store"

const globalRef = globalThis as Record<string, unknown>
if (globalRef.Bun === undefined) {
  globalRef.Bun = { env: process.env, version: "test" }
}

/* ------------------------------------------------------------------------ */
/* Source independence                                                       */
/* ------------------------------------------------------------------------ */

describe("registrableDomain", () => {
  it("takes eTLD+1 with generic ccTLD second levels and listed suffixes", () => {
    expect(registrableDomain("https://news.bbc.co.uk/story")).toBe("bbc.co.uk")
    expect(registrableDomain("https://www.abc.net.au/news")).toBe("abc.net.au")
    expect(registrableDomain("https://docs.example.com/a")).toBe("example.com")
    expect(registrableDomain("https://www.nhs.uk/conditions")).toBe("nhs.uk")
    expect(registrableDomain("https://digital.nhs.uk/x")).toBe("digital.nhs.uk")
    expect(registrableDomain("https://alice.github.io/post")).toBe("alice.github.io")
    expect(registrableDomain("https://bob.github.io/post")).toBe("bob.github.io")
    expect(registrableDomain("https://example.de")).toBe("example.de")
    expect(registrableDomain("http://127.0.0.1:8080/x")).toBe("127.0.0.1")
    expect(registrableDomain("localhost")).toBe("localhost")
  })
})

describe("groupSources", () => {
  it("merges same page, same publisher and syndicated titles; keeps repositories per work", () => {
    const result = groupSources([
      { provider: "exa", url: "https://www.reuters.com/tech/chip-ban-2026?utm_source=x", title: "US widens chip export ban to more countries" },
      { provider: "parallel", url: "https://reuters.com/tech/chip-ban-2026", title: "US widens chip export ban" },
      { provider: "firecrawl", url: "https://www.reuters.com/markets/other-story", title: "Markets today" },
      // Syndicated copy on another domain, same headline plus site suffix.
      { provider: "parallel", url: "https://news.yahoo.com/us-widens-chip-export-ban-123.html", title: "US widens chip export ban to more countries - Yahoo News" },
      { provider: "exa", url: "https://www.bbc.co.uk/news/technology-1", title: "Why the chip war matters" },
      { provider: "exa", url: "https://arxiv.org/abs/1706.03762v5", title: "Attention Is All You Need" },
      { provider: "papers", url: "https://arxiv.org/pdf/1706.03762", title: "Attention Is All You Need" },
      { provider: "papers", url: "https://arxiv.org/abs/2005.14165", title: "Language Models are Few-Shot Learners" },
    ])
    expect(result.citations).toBe(8)
    expect(result.unique_urls).toBe(7)
    // reuters+yahoo syndication, bbc, arxiv 1706.03762, arxiv 2005.14165
    expect(result.independent_sources).toBe(4)
    const reuters = result.groups.find((g) => g.domains.includes("reuters.com"))!
    expect(reuters.domains).toEqual(["reuters.com", "yahoo.com"])
    expect(reuters.providers.sort()).toEqual(["exa", "firecrawl", "parallel"])
    expect(reuters.merged_by).toEqual(["same_domain", "same_page", "similar_title"])
    const attention = result.groups.find((g) => g.key === "arxiv:1706.03762")!
    expect(attention.urls).toHaveLength(2)
    expect(attention.merged_by).toEqual(["same_work"])
    expect(result.group_of.get("https://arxiv.org/abs/2005.14165")).toBe("arxiv:2005.14165")
  })

  it("short or different titles never merge", () => {
    expect(similarTitles(titleTokens("Home"), titleTokens("Home"))).toBe(false)
    expect(similarTitles(titleTokens("Bun 1.3 release notes and changes"), titleTokens("Deno 2 release notes and changes"))).toBe(false)
    expect(groupSources([
      { provider: "a", url: "https://a.example/x", title: "Home" },
      { provider: "b", url: "https://b.example/y", title: "Home" },
    ]).independent_sources).toBe(2)
  })
})

/* ------------------------------------------------------------------------ */
/* CLI harness: in-memory Store + Corpus, real temp dir for artifacts        */
/* ------------------------------------------------------------------------ */

const runs = new Map<string, RunRecord>()
const docs: Array<PutDocument & { id: number }> = []

const MemoryStore = Layer.succeed(Store, {
  upsertRun: (input: { id: string; provider: string; kind: string; remoteId?: string; status: RunRecord["status"]; payload?: unknown }) =>
    Effect.sync(() => {
      const ts = new Date().toISOString()
      const record: RunRecord = {
        id: input.id,
        provider: input.provider,
        kind: input.kind,
        remote_id: input.remoteId ?? null,
        status: input.status,
        payload: input.payload === undefined ? null : JSON.stringify(input.payload),
        result_ref: null,
        created_at: ts,
        updated_at: ts,
      }
      runs.set(input.id, record)
      return record
    }),
  getRun: (id: string) => Effect.sync(() => runs.get(id)),
  updateRun: (id: string, patch: { status?: RunRecord["status"]; resultRef?: string }) =>
    Effect.sync(() => {
      const run = runs.get(id)
      if (!run) return
      runs.set(id, {
        ...run,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.resultRef ? { result_ref: patch.resultRef } : {}),
        updated_at: new Date().toISOString(),
      })
    }),
  findRunByRemote: () => Effect.succeed(undefined),
  insertSources: () => Effect.succeed(0),
} as never)

const MemoryCorpus = Layer.succeed(Corpus, {
  put: (doc: PutDocument) =>
    Effect.sync(() => {
      const existing = docs.find((d) => d.url === doc.url)
      if (existing) Object.assign(existing, doc)
      else docs.push({ ...doc, id: docs.length + 1 })
      const row = docs.find((d) => d.url === doc.url)!
      return { id: row.id, canonical_url: row.url, version: 1, content_hash: "h", created: !existing, changed: !existing, previous_hash: null }
    }),
} as never)

const NodeFileSystem = FileSystem.layerNoop({
  exists: (path: string) => Effect.promise(() => access(path).then(() => true, () => false)),
  readFileString: (path: string) =>
    Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: () => ({ _tag: "SystemError" }) as never }),
  writeFileString: (path: string, data: string) =>
    Effect.tryPromise({ try: () => writeFile(path, data), catch: () => ({ _tag: "SystemError" }) as never }),
  makeDirectory: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path, { recursive: true })
      },
      catch: () => ({ _tag: "SystemError" }) as never,
    }),
})

const testLayer = Layer.mergeAll(
  MemoryStore,
  MemoryCorpus,
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

const root = Command.make("survey").pipe(Command.withSubcommands([researchCommand, verifyCommand]))

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
    process.exitCode = previousExit
    return JSON.parse(out.join("") || err.join("")) as any
  }).pipe(Effect.provide(testLayer))

const servers: Array<Server> = []
const seen: Array<string> = []

/** Exa agent stub: run_1 completes after `pollsUntilDone` checks; /answer cites `answerCitations`. */
const exaStub = (options: { pollsUntilDone: number; answerCitations?: ReadonlyArray<{ url: string }> }) => {
  let polls = 0
  return new Promise<number>((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x")
      req.resume()
      req.on("end", () => {
        seen.push(`${req.method} ${url.pathname}`)
        let body: unknown = { error: url.pathname }
        let status = 200
        if (req.method === "POST" && url.pathname === "/agent/runs") body = { id: "run_1", status: "queued" }
        else if (req.method === "GET" && url.pathname === "/agent/runs/run_1") {
          polls += 1
          body =
            polls >= options.pollsUntilDone
              ? {
                  id: "run_1",
                  status: "completed",
                  output: { content: "Bun is maintained by Oven." },
                  citations: [
                    { url: "https://bun.sh/about", title: "About Bun" },
                    { url: "https://www.bun.sh/blog/bun-v1.3", title: "Bun v1.3" },
                    { url: "https://github.com/oven-sh/bun", title: "oven-sh/bun" },
                  ],
                }
              : { id: "run_1", status: "running" }
        } else if (req.method === "POST" && url.pathname === "/answer") {
          body = { answer: "Yes.", citations: options.answerCitations ?? [] }
        } else status = 404
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      })
    })
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
    servers.push(server)
  })
}

const ENV_KEYS = ["SURVEY_HOME", "EXA_API_KEY", "EXA_API_BASE_URL"] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.SURVEY_HOME = mkdtempSync(join(tmpdir(), "survey-research-"))
  process.env.EXA_API_KEY = "exa-test"
  runs.clear()
  docs.length = 0
  seen.length = 0
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const server of servers.splice(0)) server.close()
})

const useExa = (port: number) => {
  process.env.EXA_API_BASE_URL = `http://127.0.0.1:${port}`
}

const json = (value: unknown) => JSON.stringify(value)
const query = { query: "Who maintains Bun?", providers: ["exa"], domain: "web" }

describe("research start | check | wait | inspect", () => {
  it.live("start returns at once; check reports pending, then finalizes once, then serves the stored result", () =>
    Effect.gen(function* () {
      useExa(yield* Effect.promise(() => exaStub({ pollsUntilDone: 2 })))

      const started = yield* run(["research", "start", json(query)])
      expect(started).toMatchObject({ ok: true, command: "research start" })
      const id = started.data.research_id as string
      expect(started.data.members).toEqual([{ provider: "exa", run_id: expect.any(String), remote_id: "run_1", status: "running" }])
      expect(seen).toEqual(["POST /agent/runs"])
      expect(runs.get(started.data.members[0].run_id)).toMatchObject({ kind: "exa.agent", remote_id: "run_1" })

      const pending = yield* run(["research", "check", json({ id })])
      expect(pending.data).toMatchObject({ complete: false, status: "running", pending: ["exa"] })
      expect(docs).toHaveLength(0)

      const done = yield* run(["research", "check", json({ id })])
      expect(done.data).toMatchObject({ complete: true, status: "succeeded", mode: "async" })
      expect(done.data.result).toMatchObject({
        run_id: id,
        reports: { exa: { status: "completed" } },
        corpus: { url: `survey://research/${id}` },
        citation_intersection: { total_sources: 3, citations: 3, independent_sources: 2 },
      })
      expect(done.data.result.sources.find((s: any) => s.canonical_url === "https://bun.sh/about").independent_group).toBe("domain:bun.sh")
      expect(docs).toHaveLength(1)
      expect(docs[0]!.content).toContain("Bun is maintained by Oven.")
      expect(runs.get(id)).toMatchObject({ status: "succeeded", result_ref: expect.stringMatching(/research-.*\.json$/) })

      const pollsBefore = seen.length
      const again = yield* run(["research", "check", json({ id })])
      expect(again.data).toMatchObject({ complete: true, result: { run_id: id } })
      expect(seen.length).toBe(pollsBefore)

      const inspected = yield* run(["research", "inspect", json({ id })])
      expect(inspected.data).toMatchObject({
        mode: "async",
        status: "succeeded",
        query: "Who maintains Bun?",
        members: [{ provider: "exa", kind: "exa.agent", status: "succeeded" }],
        result: { run_id: id },
      })
      expect(seen.length).toBe(pollsBefore)
    }),
  )

  it.live("wait polls until complete; a short timeout fails with JobWaitTimeoutError", () =>
    Effect.gen(function* () {
      useExa(yield* Effect.promise(() => exaStub({ pollsUntilDone: 3 })))
      const id = (yield* run(["research", "start", json(query)])).data.research_id as string

      const timedOut = yield* run(["research", "wait", json({ id, interval_ms: 50, timeout_ms: 60 })])
      expect(timedOut).toMatchObject({ ok: false, error: { type: "JobWaitTimeoutError", details: { retryable: true } } })

      const waited = yield* run(["research", "wait", json({ id, interval_ms: 50, timeout_ms: 5000 })])
      expect(waited.data).toMatchObject({ complete: true, status: "succeeded", waited_ms: expect.any(Number) })
    }),
  )

  it.live("finalizeResearch fuses what finished and reports unfinished members as Incomplete", () =>
    Effect.gen(function* () {
      useExa(yield* Effect.promise(() => exaStub({ pollsUntilDone: 99 })))
      const id = (yield* run(["research", "start", json(query)])).data.research_id as string
      const result = yield* finalizeResearch(id).pipe(Effect.provide(testLayer))
      expect(result.providers).toEqual([
        expect.objectContaining({ provider: "exa", ok: false, error: expect.objectContaining({ type: "Incomplete" }) }),
      ])
      expect(runs.get(id)?.status).toBe("failed")
      expect(docs).toHaveLength(0)
    }),
  )

  it.live("members past timeout_ms are reported timed_out and the research finalizes", () =>
    Effect.gen(function* () {
      useExa(yield* Effect.promise(() => exaStub({ pollsUntilDone: 99 })))
      const id = (yield* run(["research", "start", json({ ...query, timeout_ms: 1 })])).data.research_id as string
      yield* Effect.sleep(5)
      const checked = yield* run(["research", "check", json({ id })])
      expect(checked.data).toMatchObject({ complete: true, status: "failed", members: [{ provider: "exa", status: "timed_out" }] })
    }),
  )

  it.live("unknown ids and blocking runs answer with typed results", () =>
    Effect.gen(function* () {
      const missing = yield* run(["research", "check", json({ id: "srv_nope" })])
      expect(missing).toMatchObject({ ok: false, error: { type: "CommandInputError", details: { field: "id" } } })

      useExa(yield* Effect.promise(() => exaStub({ pollsUntilDone: 1 })))
      const blocking = yield* run(["research", json({ ...query, store: false })])
      expect(blocking).toMatchObject({ ok: true, command: "research", data: { citation_intersection: { independent_sources: 2 } } })
      const checked = yield* run(["research", "check", json({ id: blocking.data.run_id })])
      expect(checked.data).toMatchObject({ mode: "blocking", status: "succeeded", complete: true })
    }),
  )
})

describe("verify confidence counts independent sources", () => {
  const verifyWith = (citations: ReadonlyArray<{ url: string }>) =>
    Effect.gen(function* () {
      useExa(yield* Effect.promise(() => exaStub({ pollsUntilDone: 1, answerCitations: citations })))
      return (yield* run(["verify", json({ claim: "Bun is maintained by Oven", providers: ["exa"], domain: "web", store: false })])).data
    })

  it.live("three pages of one site are one independent source", () =>
    Effect.gen(function* () {
      const data = yield* verifyWith([
        { url: "https://bun.sh/a" },
        { url: "https://www.bun.sh/b" },
        { url: "https://docs.bun.sh/c" },
      ])
      expect(data).toMatchObject({ citations: 3, independent_sources: 1, confidence: "low" })
      expect(data.source_groups[0]).toMatchObject({ key: "domain:bun.sh", citations: 3, merged_by: ["same_domain"] })
    }),
  )

  it.live("three independent publishers lift a single provider to medium", () =>
    Effect.gen(function* () {
      const data = yield* verifyWith([
        { url: "https://bun.sh/a" },
        { url: "https://github.com/oven-sh/bun" },
        { url: "https://news.bbc.co.uk/x" },
      ])
      expect(data).toMatchObject({ citations: 3, independent_sources: 3, confidence: "medium" })
      expect(data.confidence_basis).toMatchObject({ providers_succeeded: 1, independent_sources: 3 })
    }),
  )
})
