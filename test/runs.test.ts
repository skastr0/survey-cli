import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { mkdtempSync } from "node:fs"
import { access, mkdir, readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { normalizeStatus, runsCommand } from "../src/capabilities/runs"
import type { RunRecord } from "../src/core/store"
import { Store } from "../src/core/store"

const globalRef = globalThis as Record<string, unknown>
if (globalRef.Bun === undefined) {
  globalRef.Bun = { env: process.env, version: "test" }
}

// ---------------------------------------------------------------------------
// node:http stub server: records every request, answers by "METHOD /path".

const servers: Array<Server> = []
const seen: Array<string> = []

const startServer = (routes: Record<string, unknown>) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer((req, res) => {
      const key = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`
      seen.push(key)
      const body = routes[key]
      if (body === undefined) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `no route ${key}` }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(typeof body === "string" ? body : JSON.stringify(body))
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
    servers.push(server)
  })

// ---------------------------------------------------------------------------
// In-memory run store

const makeStore = (initial: ReadonlyArray<Pick<RunRecord, "id" | "provider" | "kind" | "remote_id" | "status">>) => {
  const ts = "2026-01-01T00:00:00.000Z"
  const runs = new Map<string, RunRecord>(
    initial.map((run) => [
      run.id,
      { ...run, payload: null, result_ref: null, created_at: ts, updated_at: ts },
    ]),
  )
  const service = Store.of({
    getRun: (id: string) => Effect.succeed(runs.get(id)),
    findRunByRemote: (provider: string, remoteId: string) =>
      Effect.succeed([...runs.values()].find((r) => r.provider === provider && r.remote_id === remoteId)),
    listRuns: () => Effect.succeed([...runs.values()]),
    updateRun: (id: string, patch: { status?: RunRecord["status"] }) =>
      Effect.sync(() => {
        const existing = runs.get(id)
        if (existing) runs.set(id, { ...existing, status: patch.status ?? existing.status })
      }),
  } as never)
  return { service, runs }
}

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

const layerFor = (store: ReturnType<typeof makeStore>) =>
  Layer.mergeAll(
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
    Layer.succeed(Store, store.service),
  )

const run = (args: ReadonlyArray<string>, store: ReturnType<typeof makeStore>) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const originalOut = process.stdout.write
    const originalErr = process.stderr.write
    const previousExit = process.exitCode
    ;(process.stdout as { write: (c: unknown) => boolean }).write = (c) => (out.push(String(c)), true)
    ;(process.stderr as { write: (c: unknown) => boolean }).write = (c) => (err.push(String(c)), true)
    process.exitCode = 0
    yield* Command.runWith(runsCommand, { version: "0.0.0-test", renderErrors: false })(args).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.stdout.write = originalOut
          process.stderr.write = originalErr
        }),
      ),
    )
    const exitCode = process.exitCode ?? 0
    process.exitCode = previousExit
    const text = out.join("") || err.join("")
    return { exitCode, body: JSON.parse(text) as any }
  }).pipe(Effect.provide(layerFor(store)))

const ENV_KEYS = [
  "SURVEY_HOME",
  "LLAMA_CLOUD_API_KEY", "LLAMA_CLOUD_API_BASE_URL",
  "PARALLEL_API_KEY", "PARALLEL_API_BASE_URL",
  "FIRECRAWL_API_KEY", "FIRECRAWL_API_BASE_URL",
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.SURVEY_HOME = mkdtempSync(join(tmpdir(), "survey-runs-"))
  seen.length = 0
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const server of servers.splice(0)) server.close()
})

const useProvider = (name: "LLAMA_CLOUD" | "PARALLEL" | "FIRECRAWL", port: number) => {
  process.env[`${name}_API_KEY`] = "test-key"
  process.env[`${name}_API_BASE_URL`] = `http://127.0.0.1:${port}`
}

// ---------------------------------------------------------------------------

describe("normalizeStatus", () => {
  it("reads flat, nested findall, and llama job statuses", () => {
    expect(normalizeStatus({ status: "COMPLETED" })).toBe("succeeded")
    expect(normalizeStatus({ job: { id: "pjb-1", status: "COMPLETED" } })).toBe("succeeded")
    expect(normalizeStatus({ job: { status: "FAILED" } })).toBe("failed")
    expect(normalizeStatus({ job: { status: "PENDING" } })).toBe("queued")
    expect(normalizeStatus({ status: { status: "completed", is_active: false } })).toBe("succeeded")
    expect(normalizeStatus({})).toBe("running")
  })
})

describe("run adapters hit the right provider endpoints", () => {
  it.live("llama parse: status is read from job.status and written back to the run", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startServer({ "GET /api/v2/parse/pjb-1": { job: { id: "pjb-1", status: "COMPLETED" } } }),
      )
      useProvider("LLAMA_CLOUD", port)
      const store = makeStore([{ id: "srv_1", provider: "llama", kind: "llama.parse", remote_id: "pjb-1", status: "running" }])

      const inspected = yield* run(["inspect", JSON.stringify({ id: "srv_1" })], store)
      expect(inspected.body.data.live.job.status).toBe("COMPLETED")
      expect(store.runs.get("srv_1")?.status).toBe("succeeded")

      store.runs.set("srv_1", { ...store.runs.get("srv_1")!, status: "running" })
      const waited = yield* run(["wait", JSON.stringify({ id: "srv_1", interval_ms: 10, timeout_ms: 1000 })], store)
      expect(waited.body.data.run.status).toBe("succeeded")
    }),
  )

  it.live("llama extract: checks /api/v2/extract/{id}", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startServer({ "GET /api/v2/extract/ext-1": { id: "ext-1", status: "COMPLETED" } }),
      )
      useProvider("LLAMA_CLOUD", port)
      const store = makeStore([{ id: "srv_2", provider: "llama", kind: "llama.extract", remote_id: "ext-1", status: "running" }])
      const inspected = yield* run(["inspect", JSON.stringify({ id: "srv_2" })], store)
      expect(inspected.body.data.live.status).toBe("COMPLETED")
      expect(store.runs.get("srv_2")?.status).toBe("succeeded")
    }),
  )

  it.live("parallel findall: check, events and cancel use findall_id paths", () =>
    Effect.gen(function* () {
      const running = {
        findall_id: "fa_1",
        status: { status: "running", is_active: true, metrics: { generated_candidates_count: 1, matched_candidates_count: 0 } },
        generator: "base",
      }
      const port = yield* Effect.promise(() =>
        startServer({
          "GET /v1beta/findall/runs/fa_1": running,
          "GET /v1beta/findall/runs/fa_1/events": "event: ping\ndata: {}\n\n",
          "POST /v1beta/findall/runs/fa_1/cancel": {},
        }),
      )
      useProvider("PARALLEL", port)
      const store = makeStore([{ id: "srv_3", provider: "parallel", kind: "parallel.findall", remote_id: "fa_1", status: "running" }])

      const inspected = yield* run(["inspect", JSON.stringify({ id: "srv_3" })], store)
      expect(inspected.body.ok).toBe(true)
      expect(inspected.body.data.live.error).toBeUndefined()
      const events = yield* run(["events", JSON.stringify({ id: "srv_3" })], store)
      expect(events.body.ok).toBe(true)
      const cancelled = yield* run(["cancel", JSON.stringify({ id: "srv_3" })], store)
      expect(cancelled.body.ok).toBe(true)
      expect(seen).toEqual([
        "GET /v1beta/findall/runs/fa_1",
        "GET /v1beta/findall/runs/fa_1/events",
        "POST /v1beta/findall/runs/fa_1/cancel",
      ])
      expect(store.runs.get("srv_3")?.status).toBe("canceled")
    }),
  )

  it.live("firecrawl batch runs use /batch/scrape, crawl runs use /crawl", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startServer({
          "GET /batch/scrape/b1": { status: "completed", total: 1, completed: 1, data: [] },
          "DELETE /batch/scrape/b1": { status: "cancelled" },
          "GET /crawl/c1": { status: "completed", total: 1, completed: 1, data: [] },
        }),
      )
      useProvider("FIRECRAWL", port)
      const store = makeStore([
        { id: "srv_4", provider: "firecrawl", kind: "firecrawl.batch", remote_id: "b1", status: "running" },
        { id: "srv_5", provider: "firecrawl", kind: "firecrawl.crawl", remote_id: "c1", status: "running" },
      ])
      expect((yield* run(["inspect", JSON.stringify({ id: "srv_4" })], store)).body.data.live.error).toBeUndefined()
      expect((yield* run(["cancel", JSON.stringify({ id: "srv_4" })], store)).body.ok).toBe(true)
      expect((yield* run(["inspect", JSON.stringify({ id: "srv_5" })], store)).body.data.live.error).toBeUndefined()
      expect(seen).toEqual(["GET /batch/scrape/b1", "DELETE /batch/scrape/b1", "GET /crawl/c1"])
    }),
  )

  it.live("wait timeout fails with a real JobWaitTimeoutError envelope (retryable, hint)", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startServer({ "GET /api/v2/parse/pjb-9": { job: { id: "pjb-9", status: "RUNNING" } } }),
      )
      useProvider("LLAMA_CLOUD", port)
      const store = makeStore([{ id: "srv_6", provider: "llama", kind: "llama.parse", remote_id: "pjb-9", status: "running" }])
      const result = yield* run(["wait", JSON.stringify({ id: "srv_6", interval_ms: 10, timeout_ms: 60 })], store)
      expect(result.exitCode).toBe(1)
      expect(result.body.error.type).toBe("JobWaitTimeoutError")
      expect(result.body.error.details).toMatchObject({
        provider: "llama",
        job_id: "pjb-9",
        timeout_ms: 60,
        retryable: true,
      })
      expect(result.body.error.details.hint).toContain("timeout_ms")
    }),
  )
})
