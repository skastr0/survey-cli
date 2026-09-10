import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { RunRecord, SourceRecord } from "../src/core/store"
import { canonicalizeUrl, Store } from "../src/core/store"
import { llamaCommand } from "../src/providers/llama"

// ---------------------------------------------------------------------------
// Bun shim — vitest workers run under Node, but survey core reads Bun.env at
// call time. Point Bun.env at process.env so env var control works in tests.

let stdinText = ""

const globalRef = globalThis as Record<string, unknown>
if (globalRef.Bun === undefined) {
  globalRef.Bun = {
    env: process.env,
    version: "test",
    stdin: {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (stdinText.length > 0) {
              controller.enqueue(new TextEncoder().encode(stdinText))
            }
            controller.close()
          },
        }),
    },
  }
}

// ---------------------------------------------------------------------------
// Mock HTTP server (node:http — Bun.serve is not available under vitest)

const servers: Array<Server> = []

const startMockServer = (
  handler: (request: Request) => Response | Promise<Response>,
) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Array<Buffer> = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue
          headers.set(key, Array.isArray(value) ? value.join(",") : value)
        }
        const method = req.method ?? "GET"
        const request = new Request(
          new URL(req.url ?? "/", "http://127.0.0.1").toString(),
          {
            method,
            headers,
            ...(method !== "GET" && method !== "HEAD" && body.length > 0
              ? { body }
              : {}),
          },
        )
        const response = await handler(request)
        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value
        })
        res.writeHead(response.status, responseHeaders)
        res.end(Buffer.from(await response.arrayBuffer()))
      })().catch((error) => {
        res.writeHead(500)
        res.end(String(error))
      })
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    )
    servers.push(server)
  })

// ---------------------------------------------------------------------------
// In-memory Store (bun:sqlite is not loadable under Node)

const makeStore = () => {
  const runs = new Map<string, RunRecord>()
  const sources: Array<SourceRecord> = []
  let nextId = 1
  const ts = "2026-01-01T00:00:00.000Z"
  const service = Store.of({
    upsertRun: (input) =>
      Effect.sync(() => {
        const record: RunRecord = {
          id: input.id,
          provider: input.provider,
          kind: input.kind,
          remote_id: input.remoteId ?? null,
          status: input.status,
          payload:
            input.payload === undefined ? null : JSON.stringify(input.payload),
          result_ref: input.resultRef ?? null,
          created_at: ts,
          updated_at: ts,
        }
        runs.set(input.id, record)
        return record
      }),
    getRun: (id) => Effect.succeed(runs.get(id)),
    findRunByRemote: (provider, remoteId) =>
      Effect.succeed(
        [...runs.values()].find(
          (run) => run.provider === provider && run.remote_id === remoteId,
        ),
      ),
    listRuns: (options) =>
      Effect.succeed(
        [...runs.values()].filter(
          (run) =>
            (options?.provider === undefined ||
              run.provider === options.provider) &&
            (options?.status === undefined || run.status === options.status),
        ),
      ),
    updateRun: (id, patch) =>
      Effect.sync(() => {
        const existing = runs.get(id)
        if (existing) {
          runs.set(id, {
            ...existing,
            status: patch.status ?? existing.status,
            remote_id: patch.remoteId ?? existing.remote_id,
            result_ref: patch.resultRef ?? existing.result_ref,
          })
        }
      }),
    insertSources: (items) =>
      Effect.sync(() => {
        for (const item of items) {
          sources.push({
            id: nextId++,
            run_id: item.runId ?? null,
            provider: item.provider,
            url: item.url,
            canonical_url: canonicalizeUrl(item.url),
            title: item.title ?? null,
            snippet: item.snippet ?? null,
            content_hash: item.contentHash ?? null,
            fetched_at: ts,
          })
        }
        return items.length
      }),
    sourcesForRun: (runId) =>
      Effect.succeed(sources.filter((source) => source.run_id === runId)),
    listSources: (options) =>
      Effect.succeed(
        sources.filter(
          (source) =>
            (options?.provider === undefined ||
              source.provider === options.provider) &&
            (options?.canonicalUrl === undefined ||
              source.canonical_url === options.canonicalUrl),
        ),
      ),
    citationOverlap: (urls) =>
      Effect.succeed(
        [...new Set(urls.map(canonicalizeUrl))]
          .map((canonical_url) => ({
            canonical_url,
            providers: [
              ...new Set(
                sources
                  .filter((source) => source.canonical_url === canonical_url)
                  .map((source) => source.provider),
              ),
            ].join(","),
          }))
          .filter((row) => row.providers.length > 0),
      ),
  })
  return { service, runs, sources }
}

// ---------------------------------------------------------------------------
// CLI environment layer (Node-backed FileSystem, fake terminal/spawner)

const fsError = (method: string, path: string) =>
  ({
    _tag: "SystemError",
    reason: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    message: `${method} failed for ${path}`,
  }) as never

const NodeFileSystem = FileSystem.layerNoop({
  exists: (path: string) =>
    Effect.promise(() => access(path).then(() => true, () => false)),
  readFileString: (path: string) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () => fsError("readFileString", path),
    }),
  makeDirectory: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path, { recursive: true })
      },
      catch: () => fsError("makeDirectory", path),
    }),
  writeFileString: (path: string, data: string) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, data)
      },
      catch: () => fsError("writeFileString", path),
    }),
  chmod: () => Effect.void,
})

const TestTerminal = Layer.succeed(
  Terminal.Terminal,
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.die("unused"),
    readLine: Effect.die("unused"),
    display: () => Effect.void,
  }),
)

const TestSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unused")),
)

const testLayer = (store: ReturnType<typeof makeStore>) =>
  Layer.mergeAll(
    NodeFileSystem,
    Path.layer,
    Stdio.layerTest({}),
    TestTerminal,
    TestSpawner,
    FetchHttpClient.layer,
    Layer.succeed(Store, store.service),
  )

// ---------------------------------------------------------------------------
// runLlama — invoke `survey llama <args>` in-process and capture the envelopes

interface CliResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const runLlama = (
  args: ReadonlyArray<string>,
  store: ReturnType<typeof makeStore>,
) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    const previousExitCode = process.exitCode

    ;(process.stdout as { write: (chunk: unknown) => boolean }).write = (
      chunk: unknown,
    ) => {
      out.push(String(chunk))
      return true
    }
    ;(process.stderr as { write: (chunk: unknown) => boolean }).write = (
      chunk: unknown,
    ) => {
      err.push(String(chunk))
      return true
    }
    process.exitCode = 0

    yield* Command.runWith(llamaCommand, {
      version: "0.0.0-test",
      renderErrors: false,
    })(args).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.stdout.write = originalStdoutWrite
          process.stderr.write = originalStderrWrite
        }),
      ),
    )

    const exitCode = process.exitCode ?? 0
    process.exitCode = previousExitCode
    return {
      stdout: out.join(""),
      stderr: err.join(""),
      exitCode,
    } satisfies CliResult
  }).pipe(Effect.provide(testLayer(store)))

const expectJson = <T>(text: string): T => {
  expect(text.trim().length > 0).toBe(true)
  return JSON.parse(text) as T
}

const writePdf = (name = "invoice.pdf") => {
  const dir = mkdtempSync(join(tmpdir(), "survey-llama-"))
  const path = join(dir, name)
  writeFileSync(path, "%PDF-1.4 test")
  return path
}

// ---------------------------------------------------------------------------
// env management

const ENV_KEYS = [
  "LLAMA_CLOUD_API_KEY",
  "LLAMA_CLOUD_API_BASE_URL",
  "SURVEY_HOME",
  "SURVEY_ARTIFACT_DIR",
] as const

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.SURVEY_HOME = mkdtempSync(join(tmpdir(), "survey-home-"))
  stdinText = ""
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  for (const server of servers.splice(0)) server.close()
})

const useServer = (port: number) => {
  process.env.LLAMA_CLOUD_API_KEY = "llx-test"
  process.env.LLAMA_CLOUD_API_BASE_URL = `http://127.0.0.1:${port}`
}

// ---------------------------------------------------------------------------

describe("llama files", () => {
  it.live("uploads a local file as multipart with purpose", () =>
    Effect.gen(function* () {
      const filePath = writePdf()
      const port = yield* Effect.promise(() =>
        startMockServer(async (request) => {
          expect(request.method).toBe("POST")
          expect(new URL(request.url).pathname).toBe("/api/v1/beta/files")
          expect(request.headers.get("authorization")).toBe("Bearer llx-test")
          const form = await request.formData()
          expect(form.get("purpose")).toBe("parse")
          expect(form.get("file") instanceof File).toBe(true)
          return Response.json({
            id: "dfl-1",
            name: "invoice.pdf",
            project_id: "prj-1",
            purpose: "parse",
            file_type: "pdf",
          })
        }),
      )
      useServer(port)
      const store = makeStore()

      const result = yield* runLlama(
        [
          "files",
          "upload",
          JSON.stringify({ file_path: filePath, purpose: "parse" }),
        ],
        store,
      )

      const payload = expectJson<{
        ok: boolean
        data: { id: string; purpose: string }
      }>(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(payload.data.id).toBe("dfl-1")
      expect(payload.data.purpose).toBe("parse")
    }),
  )

  it.live("lists files and sends file_ids as repeated query params", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer((request) => {
          const url = new URL(request.url)
          expect(url.pathname).toBe("/api/v1/beta/files")
          expect(url.searchParams.getAll("file_ids")).toEqual(["dfl-1", "dfl-2"])
          return Response.json({
            items: [{ id: "dfl-1", name: "invoice.pdf", project_id: "prj-1" }],
            next_page_token: null,
            total_size: 1,
          })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        [
          "files",
          "list",
          JSON.stringify({ page_size: 10, file_ids: ["dfl-1", "dfl-2"] }),
        ],
        makeStore(),
      )

      const payload = expectJson<{ data: { items: Array<{ id: string }> } }>(
        result.stdout,
      )
      expect(result.exitCode).toBe(0)
      expect(payload.data.items[0]?.id).toBe("dfl-1")
    }),
  )

  it.live("deletes a file", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer((request) => {
          expect(request.method).toBe("DELETE")
          expect(new URL(request.url).pathname).toBe(
            "/api/v1/beta/files/dfl-1",
          )
          return new Response(null, { status: 204 })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        ["files", "delete", JSON.stringify({ file_id: "dfl-1" })],
        makeStore(),
      )

      const payload = expectJson<{
        data: { deleted: boolean; file_id: string }
      }>(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(payload.data).toEqual({ deleted: true, file_id: "dfl-1" })
    }),
  )

  it.live("returns a typed API error envelope", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer(() =>
          Response.json(
            {
              detail: [
                {
                  type: "value_error",
                  loc: ["purpose"],
                  msg: "Invalid purpose",
                },
              ],
            },
            { status: 422 },
          ),
        ),
      )
      useServer(port)
      const filePath = writePdf()

      const result = yield* runLlama(
        [
          "files",
          "upload",
          JSON.stringify({ file_path: filePath, purpose: "parse" }),
        ],
        makeStore(),
      )

      const payload = expectJson<{
        error: {
          type: string
          details: { status: number; body: { detail: unknown[] } }
        }
      }>(result.stderr)
      expect(result.exitCode).toBe(1)
      expect(payload.error.type).toBe("ApiResponseError")
      expect(payload.error.details.status).toBe(422)
      expect(payload.error.details.body.detail[0]).toMatchObject({
        msg: "Invalid purpose",
      })
      expect(result.stderr).not.toContain("llx-test")
    }),
  )
})

describe("llama parse", () => {
  it.live("creates a parse job from file_id and records a run", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer(async (request) => {
          expect(request.method).toBe("POST")
          const body = (await request.json()) as {
            file_id: string
            tier: string
          }
          expect(body.file_id).toBe("dfl-1")
          expect(body.tier).toBe("agentic")
          return Response.json({
            id: "pjb-1",
            project_id: "prj-1",
            status: "PENDING",
            tier: "agentic",
          })
        }),
      )
      useServer(port)
      const store = makeStore()

      const result = yield* runLlama(
        [
          "parse",
          "create",
          JSON.stringify({ file_id: "dfl-1", tier: "agentic", version: "latest" }),
        ],
        store,
      )

      const payload = expectJson<{ data: { id: string; status: string } }>(
        result.stdout,
      )
      expect(result.exitCode).toBe(0)
      expect(payload.data.id).toBe("pjb-1")
      expect(payload.data.status).toBe("PENDING")

      const runs = [...store.runs.values()]
      expect(runs).toHaveLength(1)
      expect(runs[0]?.kind).toBe("llama.parse")
      expect(runs[0]?.remote_id).toBe("pjb-1")
      expect(runs[0]?.status).toBe("running")
    }),
  )

  it.live("does not inject tier/version defaults when configuration_id is set", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer(async (request) => {
          const body = (await request.json()) as Record<string, unknown>
          expect(body.file_id).toBe("dfl-1")
          expect(body.configuration_id).toBe("cfg-9")
          expect("tier" in body).toBe(false)
          expect("version" in body).toBe(false)
          return Response.json({
            id: "pjb-cfg",
            project_id: "prj-1",
            status: "PENDING",
          })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        [
          "parse",
          "create",
          JSON.stringify({ file_id: "dfl-1", configuration_id: "cfg-9" }),
        ],
        makeStore(),
      )

      expect(result.exitCode).toBe(0)
      expect(expectJson<{ data: { id: string } }>(result.stdout).data.id).toBe(
        "pjb-cfg",
      )
    }),
  )

  it.live("rejects create payloads with both file_id and source_url", () =>
    Effect.gen(function* () {
      useServer(65535)
      const result = yield* runLlama(
        [
          "parse",
          "create",
          JSON.stringify({
            file_id: "dfl-1",
            source_url: "https://example.com/a.pdf",
          }),
        ],
        makeStore(),
      )
      const payload = expectJson<{ error: { type: string } }>(result.stderr)
      expect(result.exitCode).toBe(1)
      expect(payload.error.type).toBe("CommandInputError")
    }),
  )

  it.live("create --wait uses text expand for the fast tier", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer(async (request) => {
          const url = new URL(request.url)
          if (request.method === "POST") {
            expect(url.pathname).toBe("/api/v2/parse")
            const body = (await request.json()) as { tier: string }
            expect(body.tier).toBe("fast")
            return Response.json({
              id: "pjb-fast",
              project_id: "prj-1",
              status: "PENDING",
              tier: "fast",
            })
          }

          expect(url.pathname).toBe("/api/v2/parse/pjb-fast")
          expect(url.searchParams.get("expand")).toBe("text")
          return Response.json({
            job: {
              id: "pjb-fast",
              project_id: "prj-1",
              status: "COMPLETED",
              tier: "fast",
            },
            text: { pages: [{ text: "plain" }] },
          })
        }),
      )
      useServer(port)
      const store = makeStore()

      const result = yield* runLlama(
        [
          "parse",
          "create",
          JSON.stringify({ file_id: "dfl-1", tier: "fast", version: "latest" }),
          "--wait",
        ],
        store,
      )

      const payload = expectJson<{
        data: { job: { status: string }; text: { pages: Array<{ text: string }> } }
      }>(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(payload.data.job.status).toBe("COMPLETED")
      expect(payload.data.text.pages[0]?.text).toBe("plain")
      expect([...store.runs.values()][0]?.status).toBe("succeeded")
    }),
  )

  it.live("wait defaults expand to a comma-separated markdown query", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer((request) => {
          const url = new URL(request.url)
          expect(url.pathname).toBe("/api/v2/parse/pjb-1")
          expect(url.searchParams.get("expand")).toBe("markdown")
          expect(url.searchParams.getAll("expand")).toEqual(["markdown"])
          return Response.json({
            job: { id: "pjb-1", project_id: "prj-1", status: "COMPLETED" },
            markdown: { pages: [{ markdown: "ok" }] },
          })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        [
          "parse",
          "wait",
          JSON.stringify({
            job_id: "pjb-1",
            poll_interval_ms: 10,
            timeout_seconds: 5,
          }),
        ],
        makeStore(),
      )

      expect(result.exitCode).toBe(0)
      expect(
        expectJson<{
          data: { markdown: { pages: Array<{ markdown: string }> } }
        }>(result.stdout).data.markdown.pages[0]?.markdown,
      ).toBe("ok")
    }),
  )

  it.live("waits until parse completes and returns markdown", () =>
    Effect.gen(function* () {
      let polls = 0
      const port = yield* Effect.promise(() =>
        startMockServer((request) => {
          const url = new URL(request.url)
          expect(url.pathname).toBe("/api/v2/parse/pjb-1")
          expect(url.searchParams.get("expand")).toBe("markdown,items")
          polls += 1
          if (polls === 1) {
            return Response.json({
              job: { id: "pjb-1", project_id: "prj-1", status: "RUNNING" },
            })
          }

          return Response.json({
            job: { id: "pjb-1", project_id: "prj-1", status: "COMPLETED" },
            markdown: { pages: [{ markdown: "# Hello" }] },
            items: { pages: [] },
          })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        [
          "parse",
          "wait",
          JSON.stringify({
            job_id: "pjb-1",
            expand: ["markdown", "items"],
            poll_interval_ms: 10,
            timeout_seconds: 5,
          }),
        ],
        makeStore(),
      )

      const payload = expectJson<{
        data: {
          job: { status: string }
          markdown: { pages: Array<{ markdown: string }> }
        }
      }>(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(payload.data.job.status).toBe("COMPLETED")
      expect(payload.data.markdown.pages[0]?.markdown).toBe("# Hello")
    }),
  )

  it.live("run uploads a local file then waits", () =>
    Effect.gen(function* () {
      const filePath = writePdf("report.pdf")
      let uploaded = false
      const port = yield* Effect.promise(() =>
        startMockServer(async (request) => {
          const url = new URL(request.url)
          if (request.method === "POST" && url.pathname === "/api/v2/parse/upload") {
            uploaded = true
            const form = await request.formData()
            expect(form.get("file") instanceof File).toBe(true)
            const configuration = JSON.parse(
              String(form.get("configuration")),
            ) as { tier: string }
            expect(configuration.tier).toBe("agentic")
            return Response.json({
              id: "pjb-9",
              project_id: "prj-1",
              status: "PENDING",
            })
          }

          expect(url.pathname).toBe("/api/v2/parse/pjb-9")
          return Response.json({
            job: { id: "pjb-9", project_id: "prj-1", status: "COMPLETED" },
            markdown: { pages: [{ markdown: "parsed" }] },
          })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        [
          "parse",
          "run",
          JSON.stringify({
            file_path: filePath,
            tier: "agentic",
            expand: ["markdown"],
            poll_interval_ms: 10,
            timeout_seconds: 5,
          }),
        ],
        makeStore(),
      )

      const payload = expectJson<{
        data: { job: { id: string; status: string } }
      }>(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(uploaded).toBe(true)
      expect(payload.data.job.id).toBe("pjb-9")
      expect(payload.data.job.status).toBe("COMPLETED")
    }),
  )

  it.live("wait fails with JobFailedError when the job fails", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer(() =>
          Response.json({
            job: {
              id: "pjb-fail",
              project_id: "prj-1",
              status: "FAILED",
              error_message: "unsupported file",
            },
          }),
        ),
      )
      useServer(port)

      const result = yield* runLlama(
        ["parse", "wait", JSON.stringify({ job_id: "pjb-fail" })],
        makeStore(),
      )

      const payload = expectJson<{ error: { type: string; message: string } }>(
        result.stderr,
      )
      expect(result.exitCode).toBe(1)
      expect(payload.error.type).toBe("JobFailedError")
      expect(payload.error.message).toContain("unsupported file")
      expect(result.stderr).not.toContain("llx-test")
    }),
  )

  it.live("accepts JSON from @file", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "survey-llama-payload-"))
      const payloadPath = join(dir, "create.json")
      writeFileSync(
        payloadPath,
        JSON.stringify({ file_id: "dfl-file", tier: "fast", version: "latest" }),
      )

      const port = yield* Effect.promise(() =>
        startMockServer(async (request) => {
          const body = (await request.json()) as {
            file_id: string
            tier: string
          }
          expect(body.file_id).toBe("dfl-file")
          expect(body.tier).toBe("fast")
          return Response.json({
            id: "pjb-file",
            project_id: "prj-1",
            status: "PENDING",
          })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        ["parse", "create", `@${payloadPath}`],
        makeStore(),
      )

      expect(result.exitCode).toBe(0)
      expect(expectJson<{ data: { id: string } }>(result.stdout).data.id).toBe(
        "pjb-file",
      )
    }),
  )
})

describe("llama extract", () => {
  it.live("get sends expand as repeated query parameters", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer((request) => {
          const url = new URL(request.url)
          expect(request.method).toBe("GET")
          expect(url.pathname).toBe("/api/v2/extract/ext-1")
          expect(url.searchParams.getAll("expand")).toEqual([
            "extract_metadata",
            "usage",
          ])
          return Response.json({
            id: "ext-1",
            status: "COMPLETED",
            extract_result: { title: "A" },
          })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        [
          "extract",
          "get",
          JSON.stringify({
            job_id: "ext-1",
            expand: ["extract_metadata", "usage"],
          }),
        ],
        makeStore(),
      )

      expect(result.exitCode).toBe(0)
      expect(
        expectJson<{ data: { extract_result: { title: string } } }>(
          result.stdout,
        ).data.extract_result.title,
      ).toBe("A")
    }),
  )

  it.live("creates an extract job with an inline schema", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/v2/extract")
          const body = (await request.json()) as {
            file_input: string
            configuration: { data_schema: unknown }
          }
          expect(body.file_input).toBe("dfl-1")
          expect(body.configuration.data_schema).toEqual({
            type: "object",
            properties: { title: { type: "string" } },
          })
          return Response.json({
            id: "ext-1",
            status: "PENDING",
            file_input: "dfl-1",
            project_id: "prj-1",
          })
        }),
      )
      useServer(port)
      const store = makeStore()

      const result = yield* runLlama(
        [
          "extract",
          "create",
          JSON.stringify({
            file_input: "dfl-1",
            configuration: {
              tier: "agentic",
              data_schema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
          }),
        ],
        store,
      )

      const payload = expectJson<{ data: { id: string; status: string } }>(
        result.stdout,
      )
      expect(result.exitCode).toBe(0)
      expect(payload.data.id).toBe("ext-1")
      expect([...store.runs.values()][0]?.kind).toBe("llama.extract")
    }),
  )

  it.live("run uploads a file then waits for extract_result", () =>
    Effect.gen(function* () {
      const filePath = writePdf("resume.pdf")
      const port = yield* Effect.promise(() =>
        startMockServer(async (request) => {
          const url = new URL(request.url)
          if (request.method === "POST" && url.pathname === "/api/v1/beta/files") {
            const form = await request.formData()
            expect(form.get("purpose")).toBe("extract")
            return Response.json({
              id: "dfl-resume",
              name: "resume.pdf",
              project_id: "prj-1",
              purpose: "extract",
            })
          }

          if (request.method === "POST" && url.pathname === "/api/v2/extract") {
            const body = (await request.json()) as { file_input: string }
            expect(body.file_input).toBe("dfl-resume")
            return Response.json({
              id: "ext-9",
              status: "RUNNING",
              file_input: "dfl-resume",
            })
          }

          expect(url.pathname).toBe("/api/v2/extract/ext-9")
          return Response.json({
            id: "ext-9",
            status: "COMPLETED",
            file_input: "dfl-resume",
            extract_result: { name: "Ada" },
          })
        }),
      )
      useServer(port)

      const result = yield* runLlama(
        [
          "extract",
          "run",
          JSON.stringify({
            file_path: filePath,
            configuration: {
              tier: "agentic",
              data_schema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
            poll_interval_ms: 10,
            timeout_seconds: 5,
          }),
        ],
        makeStore(),
      )

      const payload = expectJson<{
        data: { status: string; extract_result: { name: string } }
      }>(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(payload.data.status).toBe("COMPLETED")
      expect(payload.data.extract_result.name).toBe("Ada")
    }),
  )

  it.live("accepts extract input from stdin", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startMockServer(() =>
          Response.json({
            id: "ext-stdin",
            status: "PENDING",
            file_input: "dfl-1",
          }),
        ),
      )
      useServer(port)
      stdinText = JSON.stringify({
        file_input: "dfl-1",
        configuration: {
          data_schema: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      })

      const result = yield* runLlama(["extract", "create", "-"], makeStore())

      expect(result.exitCode).toBe(0)
      expect(expectJson<{ data: { id: string } }>(result.stdout).data.id).toBe(
        "ext-stdin",
      )
    }),
  )

  it.live("writes large extract results to an artifact", () =>
    Effect.gen(function* () {
      const artifactDir = mkdtempSync(join(tmpdir(), "survey-artifacts-"))
      process.env.SURVEY_ARTIFACT_DIR = artifactDir
      const port = yield* Effect.promise(() =>
        startMockServer(() =>
          Response.json({
            id: "ext-big",
            status: "COMPLETED",
            extract_result: { blob: "x".repeat(70_000) },
          }),
        ),
      )
      useServer(port)

      const result = yield* runLlama(
        ["extract", "get", JSON.stringify({ job_id: "ext-big" }), "--output", "auto"],
        makeStore(),
      )

      const payload = expectJson<{
        data: {
          kind: string
          artifact: { absolute_path: string; size_bytes: number }
        }
      }>(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(payload.data.kind).toBe("summary+artifact")
      expect(payload.data.artifact.absolute_path.startsWith(artifactDir)).toBe(
        true,
      )
      expect(payload.data.artifact.size_bytes).toBeGreaterThan(64 * 1024)
    }),
  )
})
