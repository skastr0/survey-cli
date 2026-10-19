import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema, Stdio, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { vi } from "vitest"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// ---------------------------------------------------------------------------
// Stub the impure native/CLI edge: no native library is needed in vitest.

interface StubProbe {
  ok: boolean
  found?: boolean
  detail?: string
  binding?: unknown
  version?: string | null
  dir?: string
}

const native = vi.hoisted(() => ({
  modules: new Map<string, StubProbe>(),
  onPath: new Map<string, string>(),
  cliCalls: [] as Array<{ command: string; args: ReadonlyArray<string>; stdin?: Uint8Array }>,
  cliReply: (_command: string, _args: ReadonlyArray<string>): {
    stdout: string
    stderr: string
    exitCode: number
  } => ({ stdout: "", stderr: "", exitCode: 1 }),
}))

vi.mock("../src/local/native", () => ({
  requireModule: async (_root: string, name: string) =>
    native.modules.get(name) ?? { ok: false, found: false, detail: `${name} is not installed` },
  requireModuleOwning: async () => ({ ok: false, found: false, detail: "n/a" }),
  findOnPath: async (binary: string) => native.onPath.get(binary) ?? null,
  realPathOf: async (path: string) => path,
  runCli: async (
    command: string,
    args: ReadonlyArray<string>,
    options: { stdin?: Uint8Array } = {},
  ) => {
    native.cliCalls.push({
      command,
      args,
      ...(options.stdin ? { stdin: options.stdin } : {}),
    })
    const reply = native.cliReply(command, args)
    return {
      stdout: Buffer.from(reply.stdout),
      stderr: reply.stderr,
      exitCode: reply.exitCode,
    }
  },
}))

import { convertCommand } from "../src/capabilities/convert"
import { extractCommand } from "../src/capabilities/extract"
import { corpusCommand } from "../src/capabilities/corpus"
import { authCommand } from "../src/commands/auth"
import { capabilitiesCommand, doctorCommand } from "../src/commands/discovery"
import { listContracts } from "../src/core/discovery"
import { LOCAL_PROVIDERS, localProviderNames } from "../src/core/registry"
import { globToRegExp } from "../src/capabilities/ingest"
import { clearLocalToolCache } from "../src/local/tools"
import { anydocCommand } from "../src/providers/anydoc"
import { pdfInspectorCommand } from "../src/providers/pdf-inspector"

// vitest runs under Node; survey core reads Bun.env at call time.
const globalRef = globalThis as Record<string, unknown>
if (globalRef.Bun === undefined) {
  globalRef.Bun = { env: process.env, version: "test" }
}

// ---------------------------------------------------------------------------
// Stub napi bindings. Documents are tiny byte strings carrying markers.

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const anydocBinding = {
  toMarkdownBytes: async (bytes: Uint8Array, format?: string | null) => {
    if (text(bytes).includes("SCAN")) {
      throw Object.assign(new Error("all 2 pages need OCR"), {
        code: "needsOcr",
        pages: [1, 2],
        pageCount: 2,
      })
    }
    if (text(bytes).includes("BOOM")) {
      throw Object.assign(new Error("structurally unusable"), { code: "malformed" })
    }
    return `anydoc[${format ?? "auto"}]: ${text(bytes).replace(/^%PDF-\S*/, "").trim()}`
  },
  toDocument: async () => ({
    blocks: [{ kind: "paragraph" }],
    notes: [],
    assets: [{ id: 0, mediaType: "image/png", originPart: "word/media/a.png", data: Buffer.from([1, 2, 3]) }],
  }),
  formatFromBytes: (bytes: Uint8Array) =>
    text(bytes).startsWith("%PDF") ? "pdf" : text(bytes).startsWith("PK") ? "docx" : null,
  formatFromExtension: (extension: string) =>
    ({ csv: "csv", xls: "xlsx", xlsx: "xlsx", docx: "docx", pdf: "pdf" })[
      extension.replace(/^\./, "").toLowerCase()
    ] ?? null,
}

const classifyByMarker = (buffer: Buffer) => {
  const body = buffer.toString("utf8")
  if (body.includes("MIX")) {
    return { pdfType: "Mixed", pageCount: 2, pagesNeedingOcr: [1], confidence: 0.7 }
  }
  if (body.includes("SCAN")) {
    return { pdfType: "Scanned", pageCount: 2, pagesNeedingOcr: [0, 1], confidence: 0.95 }
  }
  return { pdfType: "TextBased", pageCount: 1, pagesNeedingOcr: [], confidence: 1 }
}

const calls = { extract: 0, ocrOptions: undefined as unknown, regions: undefined as unknown }

const pdfBinding = {
  classifyPdfAsync: async (buffer: Buffer) => classifyByMarker(buffer),
  detectPdf: (buffer: Buffer) => ({ ...classifyByMarker(buffer), title: "Stub", isComplexLayout: false }),
  processPdfAsync: async (buffer: Buffer, pages?: ReadonlyArray<number> | null) => {
    calls.extract += 1
    const cls = classifyByMarker(buffer)
    return {
      ...cls,
      pagesNeedingOcr: cls.pagesNeedingOcr.map((page) => page + 1),
      markdown: pages ? `# pages ${pages.join(",")}` : "# extracted",
      isComplexLayout: false,
      hasEncodingIssues: buffer.toString("utf8").includes("GARBLED"),
      pagesWithTables: [],
      pagesWithColumns: [],
    }
  },
  extractPagesMarkdownAsync: async () => ({ pages: [{ page: 0, markdown: "p1", needsOcr: false }] }),
  extractText: () => "plain text",
  extractTextWithPositionsAndRotations: () => ({ items: [{ page: 1, text: "hi" }], pageRotations: [] }),
  extractTextInRegions: (_buffer: Buffer, pageRegions: unknown) => {
    calls.regions = pageRegions
    return [{ page: 0, regions: [{ text: "region", needsOcr: false }] }]
  },
  extractTablesInRegions: () => [{ page: 0, regions: [{ text: "| a |", needsOcr: false }] }],
  processPdfWithOcr: async (_buffer: Buffer, options: unknown) => {
    calls.ocrOptions = options
    return { markdown: "ocr", pages: [], pageCount: 1 }
  },
}

const installModules = () => {
  native.modules.set("@firecrawl/anydoc", {
    ok: true,
    binding: anydocBinding,
    version: "0.2.4",
    dir: "/tools/node_modules/@firecrawl/anydoc",
  })
  native.modules.set("@firecrawl/pdf-inspector", {
    ok: true,
    binding: pdfBinding,
    version: "1.25.2",
    dir: "/tools/node_modules/@firecrawl/pdf-inspector",
  })
}

// ---------------------------------------------------------------------------
// HTTP stub server (node:http — Bun.serve is not available under vitest)

const servers: Array<Server> = []

const startServer = (
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
        const request = new Request(new URL(req.url ?? "/", "http://127.0.0.1").toString(), {
          method,
          headers,
          ...(method !== "GET" && method !== "HEAD" && body.length > 0 ? { body } : {}),
        })
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
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
    servers.push(server)
  })

// ---------------------------------------------------------------------------
// CLI environment (Node-backed FileSystem; fake terminal/spawner)

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
  exists: (path: string) => Effect.promise(() => access(path).then(() => true, () => false)),
  readFile: (path: string) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await readFile(path)),
      catch: () => fsError("readFile", path),
    }),
  readFileString: (path: string) =>
    Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: () => fsError("readFileString", path) }),
  makeDirectory: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path, { recursive: true })
      },
      catch: () => fsError("makeDirectory", path),
    }),
  writeFile: (path: string, data: Uint8Array) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, data)
      },
      catch: () => fsError("writeFile", path),
    }),
  writeFileString: (path: string, data: string) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, data)
      },
      catch: () => fsError("writeFileString", path),
    }),
  makeTempFile: (options?: { readonly suffix?: string | undefined }) =>
    Effect.promise(async () => {
      const dir = mkdtempSync(join(tmpdir(), "survey-local-temp-"))
      const path = join(dir, `upload${options?.suffix ?? ""}`)
      await writeFile(path, "")
      return path
    }),
  remove: (path: string) => Effect.promise(() => rm(path, { force: true, recursive: true })),
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

import { Corpus, type PutDocument } from "../src/core/corpus"
import { Store } from "../src/core/store"

// None of the local routes touch the run/source ledger.
const UnusedStore = Layer.succeed(Store, {} as never)

// In-memory corpus: records puts and versions content by url like the real one.
const stored: Array<PutDocument> = []
const InMemoryCorpus = Layer.succeed(Corpus, {
  get: (ref: { url?: string }) =>
    Effect.sync(() => {
      const matches = stored.filter((d) => d.url === ref.url)
      const latest = matches.at(-1)
      return latest === undefined
        ? undefined
        : { id: stored.indexOf(matches[0]!) + 1, version: matches.length, metadata: latest.metadata ?? null }
    }),
  put: (doc: PutDocument) =>
    Effect.sync(() => {
      const previous = stored.filter((d) => d.url === doc.url).at(-1)
      stored.push(doc)
      return {
        id: stored.length,
        canonical_url: doc.url,
        version: stored.filter((d) => d.url === doc.url).length,
        content_hash: "h",
        created: previous === undefined,
        changed: previous?.content !== doc.content,
        previous_hash: null,
      }
    }),
} as never)

const testLayer = Layer.mergeAll(
  UnusedStore,
  InMemoryCorpus,
  NodeFileSystem,
  Path.layer,
  Stdio.layerTest({}),
  TestTerminal,
  TestSpawner,
  FetchHttpClient.layer,
)

const root = Command.make("survey").pipe(
  Command.withSubcommands([
    anydocCommand,
    pdfInspectorCommand,
    convertCommand,
    extractCommand,
    corpusCommand,
    doctorCommand,
    capabilitiesCommand,
    authCommand,
  ]),
)

interface CliResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    const previousExitCode = process.exitCode
    ;(process.stdout as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      out.push(String(chunk))
      return true
    }
    ;(process.stderr as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      err.push(String(chunk))
      return true
    }
    process.exitCode = 0
    yield* Command.runWith(root, { version: "0.0.0-test", renderErrors: false })(args).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.stdout.write = originalStdoutWrite
          process.stderr.write = originalStderrWrite
        }),
      ),
    )
    const exitCode = process.exitCode ?? 0
    process.exitCode = previousExitCode
    return { stdout: out.join(""), stderr: err.join(""), exitCode } satisfies CliResult
  }).pipe(Effect.provide(testLayer))

// A successful call prints its envelope to stdout; a failure prints to stderr.
const envelope = <T = any>(result: CliResult): { ok: boolean; command: string; data: T; error: any } =>
  JSON.parse(result.stdout.trim().length > 0 ? result.stdout : result.stderr)

const json = (value: unknown) => JSON.stringify(value)

// ---------------------------------------------------------------------------
// fixtures + env

let docsDir = ""
const writeDoc = (name: string, contents: string) => {
  const path = join(docsDir, name)
  writeFileSync(path, contents)
  return path
}

const ENV_KEYS = [
  "SURVEY_HOME",
  "SURVEY_LOCAL_TOOLS_DIR",
  "LLAMA_CLOUD_API_KEY",
  "LLAMA_CLOUD_API_BASE_URL",
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.SURVEY_HOME = mkdtempSync(join(tmpdir(), "survey-home-"))
  process.env.SURVEY_LOCAL_TOOLS_DIR = "/tools"
  delete process.env.LLAMA_CLOUD_API_KEY
  delete process.env.LLAMA_CLOUD_API_BASE_URL
  docsDir = mkdtempSync(join(tmpdir(), "survey-docs-"))
  native.modules.clear()
  native.onPath.clear()
  native.cliCalls.length = 0
  native.cliReply = () => ({ stdout: "", stderr: "", exitCode: 1 })
  calls.extract = 0
  stored.length = 0
  calls.ocrOptions = undefined
  calls.regions = undefined
  clearLocalToolCache()
  installModules()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  for (const server of servers.splice(0)) server.close()
})

// ---------------------------------------------------------------------------

describe("tool resolution and honest status", () => {
  it.live("doctor reports node_module mode with versions and operations", () =>
    Effect.gen(function* () {
      const result = yield* run(["doctor"])
      const tools = envelope(result).data.local_tools as Array<any>
      expect(tools.map((t) => [t.tool, t.mode, t.version, t.available])).toEqual([
        ["anydoc", "node_module", "0.2.4", true],
        ["pdf-inspector", "node_module", "1.25.2", true],
      ])
      expect(tools[1].operations).toContain("regions")
      expect(tools.every((t) => t.requires_key === false && t.network === false)).toBe(true)
    }),
  )

  it.live("falls back to a PATH cli and lists only the operations it serves", () =>
    Effect.gen(function* () {
      native.modules.clear()
      native.onPath.set("anydoc", "/usr/local/bin/anydoc")
      native.onPath.set("pdf-inspector", "/usr/local/bin/pdf-inspector")
      native.cliReply = () => ({ stdout: "1.2.3\n", stderr: "", exitCode: 0 })

      const tools = envelope(yield* run(["doctor"])).data.local_tools as Array<any>
      expect(tools.map((t) => [t.tool, t.mode, t.version])).toEqual([
        ["anydoc", "path_cli", "1.2.3"],
        ["pdf-inspector", "path_cli", "1.2.3"],
      ])
      expect(tools[0].operations).toEqual(["convert"])
      expect(tools[1].operations).toEqual(["classify", "extract"])
    }),
  )

  it.live("reports unavailable with attempts and an install hint, and fails commands typed", () =>
    Effect.gen(function* () {
      native.modules.clear()
      const doctor = envelope(yield* run(["doctor"])).data.local_tools as Array<any>
      expect(doctor[0].mode).toBe("unavailable")
      expect(doctor[0].available).toBe(false)
      expect(doctor[0].install_hint).toContain("@firecrawl/anydoc")
      expect(doctor[0].attempts.map((a: any) => a.mode)).toEqual(["node_module", "path_cli"])

      const path = writeDoc("a.docx", "PK docx")
      const failed = yield* run(["anydoc", "convert", json({ path })])
      expect(failed.exitCode).toBe(1)
      const body = envelope(failed)
      expect(body.error.type).toBe("LocalToolUnavailableError")
      expect(body.error.details.install_hint).toContain("bun add")
      expect(body.error.details.retryable).toBe(false)
    }),
  )

  it.live("a module that is found but fails to load is reported with the load error", () =>
    Effect.gen(function* () {
      native.modules.set("@firecrawl/pdf-inspector", {
        ok: false,
        found: true,
        detail: "@firecrawl/pdf-inspector found at /tools but its native binding failed to load: no darwin-x64 build",
      })
      const tools = envelope(yield* run(["doctor"])).data.local_tools as Array<any>
      expect(tools[1].mode).toBe("unavailable")
      expect(tools[1].attempts[0].detail).toContain("failed to load")
    }),
  )

  it.live("capabilities and auth status model local providers without keys", () =>
    Effect.gen(function* () {
      const caps = envelope(yield* run(["capabilities"])).data
      expect(caps.local_providers.map((p: any) => p.provider)).toEqual(["anydoc", "pdf-inspector"])
      expect(caps.local_providers[0]).toMatchObject({
        kind: "local",
        requires_key: false,
        network: false,
        mode: "node_module",
      })
      expect(caps.providers.map((p: any) => p.provider)).not.toContain("anydoc")

      const auth = envelope(yield* run(["auth", "status"])).data
      expect(auth.local_providers).toEqual([
        { provider: "anydoc", kind: "local", credential_required: false, network: false },
        { provider: "pdf-inspector", kind: "local", credential_required: false, network: false },
      ])
      expect(auth.providers.map((p: any) => p.provider)).not.toContain("anydoc")
    }),
  )

  it("registry marks local providers as keyless and offline", () => {
    for (const name of localProviderNames) {
      expect(LOCAL_PROVIDERS[name]).toMatchObject({ kind: "local", requiresKey: false, network: false })
    }
  })
})

describe("anydoc", () => {
  it.live("converts a path and reports the mode that served it", () =>
    Effect.gen(function* () {
      const path = writeDoc("notes.docx", "PK hello")
      const body = envelope(yield* run(["anydoc", "convert", json({ path })]))
      expect(body.ok).toBe(true)
      expect(body.data.format).toBe("docx")
      expect(body.data.markdown).toBe("anydoc[auto]: PK hello")
      expect(body.data.tool).toEqual({ name: "anydoc", mode: "node_module", version: "0.2.4" })
      expect(body.data.source).toMatchObject({ kind: "path", path, bytes: 8 })
    }),
  )

  it.live("signature-less formats take the extension hint; explicit format wins and aliases resolve", () =>
    Effect.gen(function* () {
      const csv = writeDoc("data.csv", "a,b\n1,2")
      const hinted = envelope(yield* run(["anydoc", "convert", json({ path: csv })]))
      expect(hinted.data.markdown).toBe("anydoc[csv]: a,b\n1,2")

      const alias = envelope(
        yield* run(["anydoc", "convert", json({ base64: Buffer.from("x").toString("base64"), format: "xls" })]),
      )
      expect(alias.data.format).toBe("xlsx")
      expect(alias.data.markdown).toBe("anydoc[xlsx]: x")

      const bad = yield* run(["anydoc", "convert", json({ base64: Buffer.from("x").toString("base64"), format: "nope" })])
      expect(envelope(bad).error.type).toBe("LocalToolError")
      expect(envelope(bad).error.details.code).toBe("unsupported")
    }),
  )

  it.live("downloads a url then converts locally, using the content type as a format hint", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startServer(
          () => new Response("a,b\n3,4", { headers: { "content-type": "text/csv; charset=utf-8" } }),
        ),
      )
      const body = envelope(
        yield* run(["anydoc", "convert", json({ url: `http://127.0.0.1:${port}/export` })]),
      )
      expect(body.data.markdown).toBe("anydoc[csv]: a,b\n3,4")
      expect(body.data.source).toMatchObject({ kind: "url", content_type: "text/csv; charset=utf-8" })
    }),
  )

  it.live("rejects a bad source set, bad base64, http errors and oversize documents", () =>
    Effect.gen(function* () {
      const none = envelope(yield* run(["anydoc", "convert", json({})]))
      expect(none.error.type).toBe("CommandInputError")
      expect(none.error.message).toContain("exactly one of path, url, or base64")

      const two = envelope(yield* run(["anydoc", "convert", json({ path: "/a", base64: "eA==" })]))
      expect(two.error.message).toContain("got path, base64")

      const badB64 = envelope(yield* run(["anydoc", "convert", json({ base64: "***" })]))
      expect(badB64.error.details.field).toBe("base64")

      const port = yield* Effect.promise(() => startServer(() => new Response("nope", { status: 404 })))
      const missing = envelope(yield* run(["anydoc", "convert", json({ url: `http://127.0.0.1:${port}/x.docx` })]))
      expect(missing.error.type).toBe("ApiResponseError")
      expect(missing.error.details.status).toBe(404)

      const big = envelope(
        yield* run(["anydoc", "convert", json({ base64: Buffer.from("0123456789").toString("base64"), max_bytes: 4 })]),
      )
      expect(big.error.message).toContain("over max_bytes 4")

      const ftp = envelope(yield* run(["anydoc", "convert", json({ url: "ftp://example.com/a.docx" })]))
      expect(ftp.error.message).toContain("http:// or https://")
    }),
  )

  it.live("array input is an ordered batch with per-item errors and a failing exit code", () =>
    Effect.gen(function* () {
      const good = writeDoc("ok.docx", "PK ok")
      const scanned = writeDoc("scan.pdf", "%PDF-1.4 SCAN")
      const result = yield* run([
        "anydoc",
        "convert",
        json([{ path: good }, { path: join(docsDir, "missing.docx") }, { path: scanned }]),
      ])
      expect(result.exitCode).toBe(1)
      const data = envelope(result).data
      expect(data).toMatchObject({ outcome: "partial_failure", total: 3, success_count: 1, error_count: 2 })
      expect(data.results.map((r: any) => [r.index, r.ok, r.error?.type ?? null])).toEqual([
        [0, true, null],
        [1, false, "CommandInputError"],
        [2, false, "LocalToolError"],
      ])
      expect(data.results[2].error.details).toMatchObject({ code: "needsOcr", pages: [1, 2], page_count: 2 })
    }),
  )

  it.live("detect and document need the node module; document keeps asset bytes opt-in", () =>
    Effect.gen(function* () {
      const path = writeDoc("a.docx", "PK x")
      const detect = envelope(yield* run(["anydoc", "detect", json({ path })]))
      expect(detect.data).toMatchObject({ format: "docx", from_content: "docx", from_extension: "docx" })

      const model = envelope(yield* run(["anydoc", "document", json({ path })]))
      expect(model.data.document.assets).toEqual([
        { id: 0, mediaType: "image/png", originPart: "word/media/a.png", bytes: 3 },
      ])
      const withBytes = envelope(yield* run(["anydoc", "document", json({ path, include_assets: true })]))
      expect(withBytes.data.document.assets[0].data_base64).toBe(Buffer.from([1, 2, 3]).toString("base64"))

      native.modules.clear()
      clearLocalToolCache()
      native.onPath.set("anydoc", "/usr/local/bin/anydoc")
      native.cliReply = () => ({ stdout: "0.2.4\n", stderr: "", exitCode: 0 })
      const viaCli = envelope(yield* run(["anydoc", "detect", json({ path })]))
      expect(viaCli.error.type).toBe("LocalToolUnavailableError")
      expect(viaCli.error.message).toContain("not available in path_cli mode")
    }),
  )

  it.live("path_cli mode shells out to `anydoc` (path directly, bytes over stdin) and maps exit 3 to needsOcr", () =>
    Effect.gen(function* () {
      native.modules.clear()
      native.onPath.set("anydoc", "/bin/anydoc")
      native.cliReply = (_command, args) =>
        args[0] === "--version"
          ? { stdout: "0.2.4\n", stderr: "", exitCode: 0 }
          : args.includes("pages-need-ocr")
            ? { stdout: "", stderr: "all 2 pages need OCR\n", exitCode: 3 }
            : { stdout: "# from cli\n", stderr: "", exitCode: 0 }

      const path = writeDoc("a.docx", "PK x")
      const direct = envelope(yield* run(["anydoc", "convert", json({ path })]))
      expect(direct.data.markdown).toBe("# from cli\n")
      expect(direct.data.tool.mode).toBe("path_cli")
      expect(native.cliCalls.at(-1)).toMatchObject({ command: "/bin/anydoc", args: [path] })

      const csv = envelope(
        yield* run(["anydoc", "convert", json({ base64: Buffer.from("a,b").toString("base64"), format: "csv" })]),
      )
      expect(csv.data.format).toBe("csv")
      expect(native.cliCalls.at(-1)?.args).toEqual(["-", "--format", "csv"])
      expect(text(native.cliCalls.at(-1)!.stdin!)).toBe("a,b")

      native.cliReply = (_c, args) =>
        args[0] === "--version"
          ? { stdout: "0.2.4\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "all 2 pages need OCR\n", exitCode: 3 }
      const ocr = envelope(yield* run(["anydoc", "convert", json({ path })]))
      expect(ocr.error.details).toMatchObject({ code: "needsOcr", mode: "path_cli" })
    }),
  )
})

describe("pdf-inspector", () => {
  it.live("classify returns the library's native fields under result", () =>
    Effect.gen(function* () {
      const path = writeDoc("a.pdf", "%PDF-1.4 SCAN")
      const body = envelope(yield* run(["pdf-inspector", "classify", json({ path })]))
      expect(body.data.result).toEqual({
        pdfType: "Scanned",
        pageCount: 2,
        pagesNeedingOcr: [0, 1],
        confidence: 0.95,
      })
      expect(body.data.tool.mode).toBe("node_module")
    }),
  )

  it.live("extract, pages, text, positions, tables and inspect call through with their options", () =>
    Effect.gen(function* () {
      const path = writeDoc("a.pdf", "%PDF-1.4 hello")
      const extract = envelope(yield* run(["pdf-inspector", "extract", json({ path, pages: [1, 3] })]))
      expect(extract.data.result.markdown).toBe("# pages 1,3")
      const all = envelope(yield* run(["pdf-inspector", "extract", json({ path })]))
      expect(all.data.result.markdown).toBe("# extracted")

      expect(envelope(yield* run(["pdf-inspector", "text", json({ path })])).data.result).toBe("plain text")
      expect(envelope(yield* run(["pdf-inspector", "pages", json({ path })])).data.result.pages[0].markdown).toBe("p1")
      expect(
        envelope(yield* run(["pdf-inspector", "positions", json({ path, frame: "display" })])).data.result.items,
      ).toHaveLength(1)
      expect(envelope(yield* run(["pdf-inspector", "tables", json({ path, pageRegions: [{ page: 0, regions: [[0, 0, 1, 1]] }] })])).data.result[0].regions[0].text).toBe("| a |")
      expect(envelope(yield* run(["pdf-inspector", "inspect", json({ path })])).data.result.title).toBe("Stub")
    }),
  )

  it.live("regions forwards pageRegions untouched and validates their shape", () =>
    Effect.gen(function* () {
      const path = writeDoc("a.pdf", "%PDF-1.4 hello")
      const pageRegions = [{ page: 0, regions: [[0, 0, 300, 400], [300, 0, 612, 400]] }]
      const ok = envelope(yield* run(["pdf-inspector", "regions", json({ path, pageRegions })]))
      expect(ok.data.result[0].regions[0]).toEqual({ text: "region", needsOcr: false })
      expect(calls.regions).toEqual(pageRegions)

      const bad = yield* run(["pdf-inspector", "regions", json({ path, pageRegions: [{ page: "0" }] })])
      expect(envelope(bad).error.type).toBe("JsonInputError")
    }),
  )

  it.live("ocr defaults to offline so no model is downloaded unless asked", () =>
    Effect.gen(function* () {
      const path = writeDoc("a.pdf", "%PDF-1.4 hello")
      yield* run(["pdf-inspector", "ocr", json({ path })])
      expect(calls.ocrOptions).toEqual({ mode: "Auto", offline: true })
      yield* run(["pdf-inspector", "ocr", json({ path, offline: false, mode: "Force", dpi: 200 })])
      expect(calls.ocrOptions).toEqual({ mode: "Force", offline: false, dpi: 200 })
    }),
  )

  it.live("path_cli mode serves classify/extract through the pdf-inspector CLI json output", () =>
    Effect.gen(function* () {
      native.modules.clear()
      native.onPath.set("pdf-inspector", "/bin/pdf-inspector")
      native.cliReply = (_command, args) => {
        if (args[0] === "--version") return { stdout: "1.25.2\n", stderr: "", exitCode: 0 }
        if (args[0] === "detect") {
          return {
            stdout: json({ pdfType: "TextBased", pageCount: 1, pagesNeedingOcr: [], confidence: 1 }),
            stderr: "",
            exitCode: 0,
          }
        }
        return { stdout: json({ pdfType: "TextBased", markdown: "# cli", pageCount: 1 }), stderr: "", exitCode: 0 }
      }
      const path = writeDoc("a.pdf", "%PDF-1.4 x")
      const classify = envelope(yield* run(["pdf-inspector", "classify", json({ path })]))
      expect(classify.data.tool.mode).toBe("path_cli")
      expect(classify.data.result.pdfType).toBe("TextBased")
      expect(native.cliCalls.at(-1)?.args).toEqual(["detect", "--json", path])

      const extract = envelope(yield* run(["pdf-inspector", "extract", json({ path, pages: [2, 4] })]))
      expect(extract.data.result.markdown).toBe("# cli")
      expect(native.cliCalls.at(-1)?.args).toEqual(["--json", "--pages", "2,4", path])

      const unsupported = envelope(yield* run(["pdf-inspector", "regions", json({ path, pageRegions: [] })]))
      expect(unsupported.error.type).toBe("LocalToolUnavailableError")
      expect(unsupported.error.message).toContain("not available in path_cli mode")
    }),
  )
})

describe("unified convert routing", () => {
  it.live("text-based PDF extracts locally and says why", () =>
    Effect.gen(function* () {
      const path = writeDoc("report.pdf", "%PDF-1.4 TEXT")
      const body = envelope(yield* run(["convert", json({ path })]))
      expect(body.data).toMatchObject({
        status: "converted",
        needs_ocr: false,
        complete: true,
        markdown: "# extracted",
        route: { selected: "local:pdf-inspector", kind: "local", mode: "node_module" },
      })
      expect(body.data.route.reason).toContain("text-based PDF extracts locally")
      expect(body.data.route.trace.map((s: any) => s.step)).toEqual(["classify", "extract"])
    }),
  )

  it.live("scanned PDF without a LlamaCloud key returns the classification and needs_ocr", () =>
    Effect.gen(function* () {
      const path = writeDoc("scan.pdf", "%PDF-1.4 SCAN")
      const result = yield* run(["convert", json({ path })])
      expect(result.exitCode).toBe(0)
      const data = envelope(result).data
      expect(data).toMatchObject({
        status: "needs_ocr",
        needs_ocr: true,
        complete: false,
        pages_needing_ocr: [1, 2],
        classification: { pdfType: "Scanned", pagesNeedingOcr: [0, 1] },
        route: { selected: "local:pdf-inspector" },
      })
      expect(data.markdown).toBeUndefined()
      expect(data.route.reason).toContain("no LLAMA_CLOUD_API_KEY configured")
      expect(data.next_step).toContain("LLAMA_CLOUD_API_KEY")
      expect(calls.extract).toBe(0)
    }),
  )

  it.live("mixed PDF keeps the locally extracted text but is flagged incomplete", () =>
    Effect.gen(function* () {
      const path = writeDoc("mixed.pdf", "%PDF-1.4 MIX")
      const data = envelope(yield* run(["convert", json({ path })])).data
      expect(data).toMatchObject({ status: "needs_ocr", needs_ocr: true, complete: false, markdown: "# extracted" })
      expect(data.pages_needing_ocr).toEqual([2])
    }),
  )

  it.live("a text PDF whose fonts decode to garbage is treated as needing OCR", () =>
    Effect.gen(function* () {
      const path = writeDoc("garbled.pdf", "%PDF-1.4 TEXT GARBLED")
      const data = envelope(yield* run(["convert", json({ path })])).data
      expect(data.needs_ocr).toBe(true)
      expect(data.route.reason).toContain("fonts decode to garbage")
    }),
  )

  it.live("scanned PDF with a key routes to LlamaCloud parse and reports it", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const port = yield* Effect.promise(() =>
        startServer(async (request) => {
          const url = new URL(request.url)
          seen.push(`${request.method} ${url.pathname}`)
          expect(request.headers.get("authorization")).toBe("Bearer llx-test")
          if (request.method === "POST" && url.pathname === "/api/v2/parse/upload") {
            const form = await request.formData()
            expect(form.get("file") instanceof File).toBe(true)
            return Response.json({ id: "pjb-1", status: "PENDING" })
          }
          expect(url.pathname).toBe("/api/v2/parse/pjb-1")
          return Response.json({
            job: { id: "pjb-1", status: "COMPLETED" },
            markdown: { pages: [{ markdown: "# OCR page 1" }, { markdown: "page 2" }] },
          })
        }),
      )
      process.env.LLAMA_CLOUD_API_KEY = "llx-test"
      process.env.LLAMA_CLOUD_API_BASE_URL = `http://127.0.0.1:${port}`

      const path = writeDoc("scan.pdf", "%PDF-1.4 SCAN")
      const data = envelope(yield* run(["convert", json({ path })])).data
      expect(data).toMatchObject({
        status: "converted",
        needs_ocr: true,
        complete: true,
        markdown: "# OCR page 1\n\npage 2",
        job_id: "pjb-1",
        route: { selected: "hosted:llama", kind: "hosted" },
      })
      expect(data.route.reason).toContain("LLAMA_CLOUD_API_KEY present")
      expect(seen[0]).toBe("POST /api/v2/parse/upload")

      // bytes without a path are written to a temp file for the upload
      const fromBase64 = envelope(
        yield* run(["convert", json({ base64: Buffer.from("%PDF-1.4 SCAN").toString("base64") })]),
      ).data
      expect(fromBase64.route.selected).toBe("hosted:llama")
    }),
  )

  it.live("route=local never calls LlamaCloud even with a key", () =>
    Effect.gen(function* () {
      process.env.LLAMA_CLOUD_API_KEY = "llx-test"
      process.env.LLAMA_CLOUD_API_BASE_URL = "http://127.0.0.1:1"
      const path = writeDoc("scan.pdf", "%PDF-1.4 SCAN")
      const data = envelope(yield* run(["convert", json({ path, route: "local" })])).data
      expect(data.status).toBe("needs_ocr")
      expect(data.route.reason).toContain("route=local forbids hosted OCR")
      expect(data.next_step).toBeUndefined()
    }),
  )

  it.live("office documents use anydoc, including downloaded URLs (keyless)", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() =>
        startServer(() => new Response("PK docx body", { headers: { "content-type": "application/octet-stream" } })),
      )
      const url = `http://127.0.0.1:${port}/files/report.docx`
      const data = envelope(yield* run(["convert", json({ url })])).data
      expect(data).toMatchObject({
        status: "converted",
        format: "docx",
        route: { selected: "local:anydoc", engine: "anydoc" },
        source: { kind: "url", url },
      })
      expect(data.route.reason).toContain("non-PDF document (docx)")
    }),
  )

  it.live("anydoc missing: hosted fallback only when keyed and allowed, otherwise the typed error", () =>
    Effect.gen(function* () {
      native.modules.delete("@firecrawl/anydoc")
      clearLocalToolCache()
      const path = writeDoc("a.docx", "PK x")

      const noKey = envelope(yield* run(["convert", json({ path })]))
      expect(noKey.error.type).toBe("LocalToolUnavailableError")

      const port = yield* Effect.promise(() =>
        startServer((request) =>
          new URL(request.url).pathname.endsWith("/upload")
            ? Response.json({ id: "pjb-2", status: "PENDING" })
            : Response.json({ job: { id: "pjb-2", status: "COMPLETED" }, markdown: { pages: [{ markdown: "hosted docx" }] } }),
        ),
      )
      process.env.LLAMA_CLOUD_API_KEY = "llx-test"
      process.env.LLAMA_CLOUD_API_BASE_URL = `http://127.0.0.1:${port}`
      const keyed = envelope(yield* run(["convert", json({ path })])).data
      expect(keyed.route.selected).toBe("hosted:llama")
      expect(keyed.route.trace.map((s: any) => s.engine)).toEqual(["anydoc", "llama"])

      const forbidden = envelope(yield* run(["convert", json({ path, route: "local" })]))
      expect(forbidden.error.type).toBe("LocalToolUnavailableError")
    }),
  )

  it.live("pdf-inspector missing: anydoc's built-in PDF engine converts text PDFs and flags scanned ones", () =>
    Effect.gen(function* () {
      native.modules.delete("@firecrawl/pdf-inspector")
      clearLocalToolCache()

      const textPdf = writeDoc("t.pdf", "%PDF-1.4 TEXT")
      const converted = envelope(yield* run(["convert", json({ path: textPdf })])).data
      expect(converted.route.selected).toBe("local:anydoc")
      expect(converted.route.reason).toContain("pdf-inspector unavailable")
      expect(converted.markdown).toContain("anydoc[pdf]")

      const scanned = writeDoc("s.pdf", "%PDF-1.4 SCAN")
      const needs = envelope(yield* run(["convert", json({ path: scanned })])).data
      expect(needs).toMatchObject({ status: "needs_ocr", pages_needing_ocr: [1, 2] })
      expect(needs.route.selected).toBe("local:anydoc")
    }),
  )

  it.live("both tools missing on a PDF surfaces the pdf-inspector unavailable error", () =>
    Effect.gen(function* () {
      native.modules.clear()
      const path = writeDoc("t.pdf", "%PDF-1.4 TEXT")
      const result = yield* run(["convert", json({ path })])
      expect(result.exitCode).toBe(1)
      expect(envelope(result).error).toMatchObject({
        type: "LocalToolUnavailableError",
        details: { tool: "pdf-inspector" },
      })
    }),
  )

  it.live("array input is an ordered batch across routes", () =>
    Effect.gen(function* () {
      const a = writeDoc("a.pdf", "%PDF-1.4 TEXT")
      const b = writeDoc("b.docx", "PK b")
      const data = envelope(yield* run(["convert", json([{ path: a }, { path: b }])])).data
      expect(data.outcome).toBe("succeeded")
      expect(data.results.map((r: any) => r.data.route.selected)).toEqual([
        "local:pdf-inspector",
        "local:anydoc",
      ])
    }),
  )
})

describe("extract keeps schema work on providers and sends plain documents local", () => {
  it.live("file_path without schema/prompt routes through local convert", () =>
    Effect.gen(function* () {
      const path = writeDoc("report.pdf", "%PDF-1.4 TEXT")
      const data = envelope(yield* run(["extract", json({ file_path: path })])).data
      expect(data.routed_to).toBe("pdf-inspector")
      expect(data.route_reason).toContain("text-based PDF")
      expect(data.result.markdown).toBe("# extracted")
    }),
  )

  it.live("a document URL without schema routes local; a schema keeps the provider route", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => startServer(() => new Response("PK docx")))
      const local = envelope(yield* run(["extract", json({ url: `http://127.0.0.1:${port}/a.docx` })])).data
      expect(local.routed_to).toBe("anydoc")

      // with a schema the provider route is untouched: it fails on the missing
      // LlamaCloud key instead of converting locally
      const schema = yield* run(["extract", json({ file_path: "/x.pdf", schema: { type: "object" } })])
      expect(schema.exitCode).toBe(1)
      expect(schema.stdout).toBe("")
    }),
  )
})

describe("convert remembers documents in the corpus", () => {
  it.live("a complete conversion is stored as kind document and reports corpus like fetch", () =>
    Effect.gen(function* () {
      const path = writeDoc("report.pdf", "%PDF-1.4 TEXT")
      const first = envelope(yield* run(["convert", json({ path, tags: ["papers"] })])).data
      expect(first.corpus).toEqual({ id: 1, version: 1, changed: true, created: true })
      expect(stored[0]).toMatchObject({
        url: `file://${path}`,
        content: "# extracted",
        title: "report.pdf",
        provider: "pdf-inspector",
        kind: "document",
        tags: ["papers"],
      })
      expect(stored[0]!.metadata).toMatchObject({
        route: "local:pdf-inspector",
        format: "pdf",
        classification: { pdfType: "TextBased" },
        pdf: { pageCount: 1 },
      })

      const again = envelope(yield* run(["convert", json({ path })])).data
      expect(again.corpus).toEqual({ id: 2, version: 2, changed: false, created: false })
    }),
  )

  it.live("url sources keep their url; base64 sources are keyed by content hash", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => startServer(() => new Response("PK docx")))
      const url = `http://127.0.0.1:${port}/a.docx`
      yield* run(["convert", json({ url })])
      expect(stored[0]).toMatchObject({ url, provider: "anydoc", kind: "document", title: "a.docx" })

      yield* run(["convert", json({ base64: Buffer.from("PK x").toString("base64"), format: "docx" })])
      expect(stored[1]!.url).toMatch(/^sha256:[0-9a-f]{64}$/)
    }),
  )

  it.live("store:false opts out; incomplete conversions are never stored", () =>
    Effect.gen(function* () {
      const ok = writeDoc("a.pdf", "%PDF-1.4 TEXT")
      const optOut = envelope(yield* run(["convert", json({ path: ok, store: false })])).data
      expect(optOut.corpus).toBeUndefined()

      const mixed = writeDoc("m.pdf", "%PDF-1.4 MIX")
      const scan = writeDoc("s.pdf", "%PDF-1.4 SCAN")
      const incomplete = envelope(yield* run(["convert", json([{ path: mixed }, { path: scan }])])).data
      expect(incomplete.results.map((r: any) => r.data.corpus)).toEqual([undefined, undefined])
      expect(stored).toHaveLength(0)
    }),
  )

  it.live("the local branch of extract stores too", () =>
    Effect.gen(function* () {
      const path = writeDoc("r.pdf", "%PDF-1.4 TEXT")
      const data = envelope(yield* run(["extract", json({ file_path: path })])).data
      expect(data.result.corpus).toMatchObject({ created: true })
      expect(stored[0]!.kind).toBe("document")
    }),
  )

  it.live("corpus add converts binary documents and keeps the plain-text fast path", () =>
    Effect.gen(function* () {
      const pdf = writeDoc("paper.pdf", "%PDF-1.4 TEXT")
      const added = envelope(yield* run(["corpus", "add", json({ path: pdf, tags: ["t"], metadata: { note: 1 } })])).data.results[0].data
      expect(added).toMatchObject({ source: "convert", created: true, route: { selected: "local:pdf-inspector" } })
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ url: `file://${pdf}`, kind: "document", provider: "pdf-inspector", tags: ["t"] })
      expect(stored[0]!.metadata).toMatchObject({ note: 1, route: "local:pdf-inspector" })

      const md = writeDoc("notes.md", "# plain")
      const plain = envelope(yield* run(["corpus", "add", json({ path: md })])).data.results[0].data
      expect(plain.source).toBe("path")
      expect(stored[1]).toMatchObject({ content: "# plain", kind: "file", provider: "local" })

      const csv = writeDoc("t.csv", "a,b\n1,2")
      yield* run(["corpus", "add", json({ path: csv })])
      expect(stored[2]).toMatchObject({ content: "a,b\n1,2", kind: "file" })
      expect(native.cliCalls).toHaveLength(0)

      const scan = writeDoc("scan.pdf", "%PDF-1.4 SCAN")
      const rejected = yield* run(["corpus", "add", json({ path: scan })])
      const error = envelope(rejected).data.results[0].error
      expect(error.type).toBe("CommandInputError")
      expect(error.message).toContain("did not convert completely")
      expect(stored).toHaveLength(3)
    }),
  )
})

const writeTree = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "survey-tree-"))
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  return dir
}

describe("directory ingest", () => {
  it("globToRegExp supports *, **, ?, {a,b} and matches case-insensitively", () => {
    const ok = (glob: string, path: string) => globToRegExp(glob).test(path)
    expect(ok("*.pdf", "a.PDF")).toBe(true)
    expect(ok("*.pdf", "sub/a.pdf")).toBe(false)
    expect(ok("**/*.pdf", "a.pdf")).toBe(true)
    expect(ok("**/*.pdf", "x/y/a.pdf")).toBe(true)
    expect(ok("*.{pdf,docx}", "a.docx")).toBe(true)
    expect(ok("*.{pdf,docx}", "a.txt")).toBe(false)
    expect(ok("report-?.md", "report-1.md")).toBe(true)
    expect(ok("a.b", "aXb")).toBe(false)
  })

  it.live("convert {dir} converts, stores, then skips unchanged files by hash without converting", () =>
    Effect.gen(function* () {
      const dir = writeTree({
        "a.pdf": "%PDF-1.4 TEXT",
        "b.docx": "PK b",
        "notes.txt": "not a document",
        "sub/d.pdf": "%PDF-1.4 SCAN",
        ".hidden/e.pdf": "%PDF-1.4 TEXT",
        "node_modules/x.pdf": "%PDF-1.4 TEXT",
      })
      const first = yield* run(["convert", json({ dir, concurrency: 2, tags: ["inbox"] })])
      expect(first.exitCode).toBe(0)
      const data = envelope(first).data
      expect(data).toMatchObject({ matched: 3, processed: 3, stored: 2, needs_ocr: 1, failed: 0, skipped_unchanged: 0 })
      expect(data.results.map((r: any) => [r.relative, r.status])).toEqual([
        ["a.pdf", "stored"],
        ["b.docx", "stored"],
        ["sub/d.pdf", "needs_ocr"],
      ])
      expect(stored.map((d) => d.tags)).toEqual([["inbox"], ["inbox"]])
      expect(stored[0]!.metadata).toMatchObject({ source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })

      const extractsBefore = calls.extract
      const second = envelope(yield* run(["convert", json({ dir })])).data
      expect(second).toMatchObject({ skipped_unchanged: 2, needs_ocr: 1, stored: 0 })
      expect(calls.extract).toBe(extractsBefore) // unchanged files were not even classified
      expect(stored).toHaveLength(2)

      writeFileSync(join(dir, "a.pdf"), "%PDF-1.4 TEXT edited")
      const third = envelope(yield* run(["convert", json({ dir })])).data
      expect(third.results.map((r: any) => [r.relative, r.status])).toEqual([
        ["a.pdf", "unchanged"], // stub extraction ignores the edit, so the stored text is identical
        ["b.docx", "skipped_unchanged"],
        ["sub/d.pdf", "needs_ocr"],
      ])

      const forced = envelope(yield* run(["convert", json({ dir, force: true })])).data
      expect(forced.skipped_unchanged).toBe(0)
    }),
  )

  it.live("recursive:false, glob, max_files and dry_run", () =>
    Effect.gen(function* () {
      const dir = writeTree({ "a.pdf": "%PDF-1.4 TEXT", "b.docx": "PK b", "sub/c.docx": "PK c" })

      const flat = envelope(yield* run(["convert", json({ dir, recursive: false, dry_run: true })])).data
      expect(flat.results.map((r: any) => [r.relative, r.status])).toEqual([
        ["a.pdf", "would_process"],
        ["b.docx", "would_process"],
      ])
      expect(stored).toHaveLength(0)

      const onlyDocx = envelope(yield* run(["convert", json({ dir, glob: "**/*.docx" })])).data
      expect(onlyDocx.results.map((r: any) => r.relative)).toEqual(["b.docx", "sub/c.docx"])

      const capped = envelope(yield* run(["convert", json({ dir, max_files: 1, glob: "**/*.docx" })])).data
      expect(capped).toMatchObject({ matched: 2, processed: 1, truncated: true })

      const preview = envelope(yield* run(["convert", json({ dir, glob: "**/*.docx", dry_run: true })])).data
      expect(preview.results.map((r: any) => r.status)).toEqual(["would_skip_unchanged", "would_skip_unchanged"])
    }),
  )

  it.live("per-file failures do not stop the run and set a failing exit code", () =>
    Effect.gen(function* () {
      const dir = writeTree({ "good.docx": "PK ok", "bad.docx": "PK BOOM" })
      const result = yield* run(["convert", json({ dir })])
      expect(result.exitCode).toBe(1)
      const data = envelope(result).data
      expect(data).toMatchObject({ stored: 1, failed: 1 })
      const bad = data.results.find((r: any) => r.relative === "bad.docx")
      expect(bad.status).toBe("failed")
      expect(bad.error).toMatchObject({ type: "LocalToolError", details: { code: "malformed" } })
    }),
  )

  it.live("rejects a missing directory and non-positive limits", () =>
    Effect.gen(function* () {
      const missing = envelope(yield* run(["convert", json({ dir: join(docsDir, "nope") })]))
      expect(missing.error.type).toBe("CommandInputError")
      expect(missing.error.message).toContain("is not a directory")
      const dir = writeTree({ "a.docx": "PK" })
      const bad = envelope(yield* run(["convert", json({ dir, concurrency: 0 })]))
      expect(bad.error.details.field).toBe("concurrency")
    }),
  )

  it.live("corpus add {dir} converts documents, stores text, and skips unchanged on re-run", () =>
    Effect.gen(function* () {
      const dir = writeTree({
        "paper.pdf": "%PDF-1.4 TEXT",
        "scan.pdf": "%PDF-1.4 SCAN",
        "notes.md": "# notes",
        "ignore.json": "{}",
      })
      const first = envelope(yield* run(["corpus", "add", json({ dir, tags: ["lib"], metadata: { batch: 1 } })])).data.results[0].data
      expect(first).toMatchObject({ matched: 3, stored: 2, needs_ocr: 1, failed: 0 })
      const byUrl = Object.fromEntries(stored.map((d) => [d.url.split("/").pop(), d]))
      expect(byUrl["paper.pdf"]).toMatchObject({ kind: "document", provider: "pdf-inspector", tags: ["lib"] })
      expect(byUrl["notes.md"]).toMatchObject({ kind: "file", provider: "local", content: "# notes", tags: ["lib"] })
      expect(byUrl["notes.md"]!.metadata).toMatchObject({ batch: 1, source_sha256: expect.any(String) })

      const again = envelope(yield* run(["corpus", "add", json({ dir })])).data.results[0].data
      expect(again).toMatchObject({ skipped_unchanged: 2, needs_ocr: 1, stored: 0 })
      expect(stored).toHaveLength(2)
    }),
  )
})

describe("contracts", () => {
  const localContracts = () =>
    listContracts().filter(
      (c) => c.command.startsWith("anydoc ") || c.command.startsWith("pdf-inspector ") || c.command === "convert",
    )

  it("registers every local command with a schema, batch flag and examples", () => {
    expect(localContracts().map((c) => c.command)).toEqual([
      "anydoc convert",
      "anydoc detect",
      "anydoc document",
      "convert",
      "pdf-inspector classify",
      "pdf-inspector extract",
      "pdf-inspector inspect",
      "pdf-inspector ocr",
      "pdf-inspector pages",
      "pdf-inspector positions",
      "pdf-inspector regions",
      "pdf-inspector tables",
      "pdf-inspector text",
    ])
    for (const contract of localContracts()) {
      expect(contract.inputSchema, contract.command).toBeDefined()
      expect(contract.batch, contract.command).toBe(true)
      expect(contract.examples?.length ?? 0, contract.command).toBeGreaterThan(0)
    }
  })

  it("every example decodes against its own input schema (single objects and batch arrays)", () => {
    for (const contract of localContracts()) {
      for (const example of contract.examples ?? []) {
        const items = Array.isArray(example.input) ? example.input : [example.input]
        for (const item of items) {
          expect(
            () => Schema.decodeUnknownSync(contract.inputSchema as Schema.Decoder<unknown>)(item),
            `${contract.command} / ${example.name}`,
          ).not.toThrow()
        }
      }
    }
  })
})
