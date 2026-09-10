/**
 * Firecrawl provider tests. Two layers of coverage:
 *
 * - In-process API tests: real `requestJson` HTTP against a local `node:http`
 *   stub (FIRECRAWL_API_BASE_URL), no live API. Bun globals are polyfilled so
 *   the provider registry reads process.env.
 * - Subprocess CLI tests: spawn `bun -e` harness that runs `firecrawlCommand`
 *   through `Command.runWith` with the real runtime layer (BunServices, fetch
 *   client, Store). Exercises envelopes, exit codes, and run recording.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import { FetchHttpClient } from "effect/unstable/http"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// registry.ts reads Bun.env at call time; under node-vitest polyfill it onto
// process.env so provider config resolution works without Bun.
if (typeof (globalThis as Record<string, unknown>).Bun === "undefined") {
  ;(globalThis as Record<string, unknown>).Bun = { env: process.env }
}

import {
  agentCancel,
  agentCheck,
  agentEvents,
  agentList,
  agentStart,
  batchScrapeCancel,
  batchScrapeCheck,
  batchScrapeErrors,
  batchScrapeStart,
  crawlCancel,
  crawlCheck,
  crawlErrors,
  crawlStart,
  extractCheck,
  extractStart,
  interactExecute,
  interactStop,
  normalizeJobSnapshot,
  runMapCommand,
  runParseCommand,
  runScrapeCommand,
  runSearchCommand,
  unsupportedEventStream,
  validateAgentStartInput,
  validateBatchStartInput,
  validateCrawlStartInput,
  validateExtractStartInput,
  validateInteractExecuteInput,
  validateMapCommandInput,
  validateParseCommandInput,
  validateScrapeCommandInput,
  validateSearchCommandInput,
  waitForJob,
} from "../src/providers/firecrawl/api"

const TestLayer = Layer.mergeAll(FetchHttpClient.layer, NodeFileSystem.layer, NodePath.layer)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestLayer))

interface SeenRequest {
  readonly method: string
  readonly path: string
  readonly query: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly rawBody: string
  readonly json?: unknown
}

type StubHandler = (
  request: SeenRequest,
) => { readonly status?: number; readonly body?: unknown }

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolveBody, reject) => {
    const chunks: Array<Buffer> = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

const withServer = async <A>(
  handler: StubHandler,
  run_: (baseUrl: string, seen: Array<SeenRequest>) => Promise<A>,
): Promise<A> => {
  const seen: Array<SeenRequest> = []
  let handlerError: unknown
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://stub.local")
      const rawBody = await readBody(req)
      const contentType = req.headers["content-type"] ?? ""
      const seenRequest: SeenRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        rawBody,
        ...(contentType.includes("application/json") && rawBody.length > 0
          ? { json: JSON.parse(rawBody) }
          : {}),
      }
      seen.push(seenRequest)
      const reply = handler(seenRequest)
      res
        .writeHead(reply.status ?? 200, { "content-type": "application/json" })
        .end(JSON.stringify(reply.body ?? { success: true }))
    })().catch((error) => {
      handlerError ??= error
      res.writeHead(500).end(String(error))
    })
  })

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`

  const previousKey = process.env.FIRECRAWL_API_KEY
  const previousBase = process.env.FIRECRAWL_API_BASE_URL
  process.env.FIRECRAWL_API_KEY = "test-key"
  process.env.FIRECRAWL_API_BASE_URL = baseUrl
  try {
    const result = await run_(baseUrl, seen)
    if (handlerError !== undefined) {
      throw handlerError
    }
    return result
  } finally {
    if (previousKey === undefined) delete process.env.FIRECRAWL_API_KEY
    else process.env.FIRECRAWL_API_KEY = previousKey
    if (previousBase === undefined) delete process.env.FIRECRAWL_API_BASE_URL
    else process.env.FIRECRAWL_API_BASE_URL = previousBase
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

describe("firecrawl api", () => {
  it.effect("scrape posts JSON body and returns the provider response", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          expect(request.method).toBe("POST")
          expect(request.path).toBe("/scrape")
          expect(request.headers.authorization).toBe("Bearer test-key")
          expect(request.json).toMatchObject({
            url: "https://example.com",
            formats: [
              {
                type: "json",
                schema: { type: "object" },
                prompt: "extract title",
              },
            ],
            onlyMainContent: true,
            waitFor: 1000,
            proxy: "auto",
          })
          return {
            body: { success: true, data: { markdown: "# Example", json: { title: "Example" } } },
          }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateScrapeCommandInput({
              url: "https://example.com",
              json_schema: { type: "object" },
              json_prompt: "extract title",
              only_main_content: true,
              wait_for: 1000,
              proxy: "auto",
            }),
          )
          const result = await Effect.runPromise(
            run(runScrapeCommand(validated, 1)),
          )
          expect(result).toEqual({
            success: true,
            data: { markdown: "# Example", json: { title: "Example" } },
          })
        },
      ),
    ),
  )

  it.effect("scrape maps extended formats and options onto the wire payload", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          expect(request.json).toMatchObject({
            url: "https://example.com",
            formats: [
              "markdown",
              "product",
              { type: "question", question: "What is the price?" },
              { type: "highlights", query: "pricing" },
            ],
            onlyCleanContent: true,
            parsers: [{ type: "pdf", mode: "ocr", pages: true, blocks: true, pageMarkers: true }],
            profile: { name: "shopper", saveChanges: false },
            lockdown: true,
            redactPII: { mode: "fast", entities: ["EMAIL"], replaceStyle: "mask" },
          })
          return { body: { success: true, data: { answer: "$1" } } }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateScrapeCommandInput({
              url: "https://example.com",
              formats: ["markdown", "product"],
              question: "What is the price?",
              highlights_query: "pricing",
              only_clean_content: true,
              pdf_parser_mode: "ocr",
              pdf_pages: true,
              pdf_blocks: true,
              pdf_page_markers: true,
              profile: { name: "shopper", save_changes: false },
              lockdown: true,
              redact_pii: { mode: "fast", entities: ["EMAIL"], replace_style: "mask" },
            }),
          )
          const result = await Effect.runPromise(
            run(runScrapeCommand(validated, 1)),
          )
          expect(result).toEqual({ success: true, data: { answer: "$1" } })
        },
      ),
    ),
  )

  it.effect("scrape defaults formats to markdown and requires json schema for json change tracking", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          expect(request.json).toMatchObject({
            url: "https://example.com",
            formats: ["markdown"],
          })
          return { body: { success: true, data: {} } }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateScrapeCommandInput({ url: "https://example.com" }),
          )
          await Effect.runPromise(run(runScrapeCommand(validated, 1)))

          const invalid = await Effect.runPromise(
            validateScrapeCommandInput({
              url: "https://example.com",
              change_tracking: { modes: ["json"] },
            }).pipe(Effect.flip),
          )
          expect(invalid._tag).toBe("CommandInputError")
          expect((invalid as { field: string }).field).toBe("change_tracking.schema")

          const badUrl = await Effect.runPromise(
            validateScrapeCommandInput({ url: "not-a-url" }).pipe(Effect.flip),
          )
          expect(badUrl._tag).toBe("CommandInputError")
          expect((badUrl as { field: string }).field).toBe("url")
        },
      ),
    ),
  )

  it.effect("local scrape batch preserves order and reports partial failure", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          const url = (request.json as { url: string }).url
          if (url === "https://example.com/bad") {
            return { status: 500, body: { error: "blocked" } }
          }
          return { body: { success: true, data: { markdown: `# ${url}` } } }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateScrapeCommandInput([
              { url: "https://example.com/good" },
              { url: "https://example.com/bad" },
              { url: "https://example.com/also-good" },
            ]),
          )
          const summary = await Effect.runPromise(
            run(runScrapeCommand(validated, 2)),
          )
          expect(summary).toMatchObject({
            outcome: "partial_failure",
            total: 3,
            success_count: 2,
            error_count: 1,
            concurrency: 2,
          })
          const results = (summary as { results: Array<{ index: number; ok: boolean; target: { url: string } }> })
            .results
          expect(results.map((item) => item.index)).toEqual([0, 1, 2])
          expect(results[1]?.ok).toBe(false)
          expect(results[1]?.target).toEqual({ url: "https://example.com/bad" })
        },
      ),
    ),
  )

  it.effect("map posts camelCase body and supports ordered local batches", () =>
    Effect.promise(() =>
      withServer(
        () => ({
          body: { success: true, links: [{ url: "https://example.com/", title: "Example" }] },
        }),
        async (_base, seen) => {
          const single = await Effect.runPromise(
            validateMapCommandInput({
              url: "https://example.com",
              search: "blog",
              sitemap: "include",
              include_subdomains: true,
              ignore_query_parameters: true,
              ignore_cache: false,
              limit: 50,
            }),
          )
          const singleResult = await Effect.runPromise(run(runMapCommand(single, 5)))
          expect(singleResult).toEqual({
            success: true,
            links: [{ url: "https://example.com/", title: "Example" }],
          })

          const batch = await Effect.runPromise(
            validateMapCommandInput([
              { url: "https://example.com/a", sitemap: "only" },
              { url: "https://example.com/b" },
            ]),
          )
          const batchResult = await Effect.runPromise(
            run(runMapCommand(batch, 5)),
          )
          expect(batchResult).toMatchObject({ outcome: "succeeded", total: 2, success_count: 2 })

          expect(seen[0]?.json).toEqual({
            url: "https://example.com",
            search: "blog",
            sitemap: "include",
            includeSubdomains: true,
            ignoreQueryParameters: true,
            ignoreCache: false,
            limit: 50,
          })
          expect(seen).toContainEqual(
            expect.objectContaining({
              method: "POST",
              path: "/map",
              json: { url: "https://example.com/b" },
            }),
          )
        },
      ),
    ),
  )

  it.effect("batch start|check|wait|cancel|errors|events follow the job orbit", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          if (request.method === "POST" && request.path === "/batch/scrape") {
            expect(request.json).toEqual({
              urls: ["https://example.com/a"],
              formats: ["markdown"],
              maxConcurrency: 2,
              ignoreInvalidURLs: true,
            })
            return { body: { success: true, id: "batch_123" } }
          }
          if (request.method === "GET" && request.path === "/batch/scrape/batch_123") {
            const polls = request.headers["x-poll"] !== undefined
            void polls
            return {
              body: {
                status: "scraping",
                total: 1,
                completed: 0,
                data: [],
                next: "http://example.invalid/batch/scrape/batch_123?skip=10",
              },
            }
          }
          if (request.method === "DELETE" && request.path === "/batch/scrape/batch_123") {
            return { body: { success: true } }
          }
          if (request.path === "/batch/scrape/batch_123/errors") {
            return { body: { success: true, errors: [{ url: "x" }], robotsBlocked: [] } }
          }
          return { status: 404, body: { error: "unexpected route" } }
        },
        async (_base, seen) => {
          const startInput = await Effect.runPromise(
            validateBatchStartInput({
              urls: ["https://example.com/a"],
              formats: ["markdown"],
              max_concurrency: 2,
              ignore_invalid_urls: true,
            }),
          )
          const started = await Effect.runPromise(run(batchScrapeStart(startInput)))
          expect(started).toMatchObject({
            provider: "firecrawl",
            kind: "batch_scrape",
            id: "batch_123",
            status: "submitted",
            terminal: false,
          })

          const checked = await Effect.runPromise(
            run(batchScrapeCheck({ id: "batch_123" })),
          )
          expect(checked).toMatchObject({
            status: "running",
            provider_status: "scraping",
            next_url: "http://example.invalid/batch/scrape/batch_123?skip=10",
            terminal: false,
          })

          // wait must keep polling the status URL — never the `next` page URL
          // (firecrawl-cli 7d21790). Second poll returns completed via closure.
          let pollCount = 0
          const completedCheck = (input: { readonly id: string; readonly next_url?: string | undefined }) =>
            batchScrapeCheck(input).pipe(
              Effect.map((snapshot) => {
                pollCount += 1
                return pollCount < 2
                  ? snapshot
                  : { ...snapshot, status: "succeeded" as const, terminal: true }
              }),
            )
          const waited = await Effect.runPromise(
            run(
              waitForJob(
                { id: "batch_123", poll_interval_ms: 50, timeout_ms: 5000 },
                completedCheck,
              ),
            ),
          )
          expect(waited).toMatchObject({ status: "succeeded", terminal: true })
          const statusPolls = seen.filter(
            (request) => request.method === "GET" && request.path === "/batch/scrape/batch_123",
          )
          expect(statusPolls.length).toBeGreaterThanOrEqual(2)
          expect(seen.every((request) => !request.query.includes("skip"))).toBe(true)

          const canceled = await Effect.runPromise(run(batchScrapeCancel({ id: "batch_123" })))
          expect(canceled).toMatchObject({ kind: "batch_scrape", status: "canceled", terminal: true })

          const errors = await Effect.runPromise(run(batchScrapeErrors({ id: "batch_123" })))
          expect(errors).toMatchObject({ errors_count: 1, robots_blocked_count: 0 })

          expect(unsupportedEventStream("batch_scrape", { id: "batch_123" })).toMatchObject({
            supported: false,
            capability: "batch_scrape.events",
          })
        },
      ),
    ),
  )

  it.effect("check resolves absolute next_url onto the configured base path", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          if (request.path === "/batch/scrape/batch_123") {
            return { body: { status: "completed", total: 1, data: [{ markdown: "x" }] } }
          }
          return { status: 404, body: { error: "unexpected route" } }
        },
        async (baseUrl) => {
          const checked = await Effect.runPromise(
            run(
              batchScrapeCheck({
                id: "batch_123",
                next_url: `${baseUrl}/batch/scrape/batch_123?skip=10`,
              }),
            ),
          )
          expect(checked.status).toBe("succeeded")
          expect(checked.data_count).toBe(1)
        },
      ),
    ),
  )

  it.effect("crawl start|check|cancel|errors map snake_case input to the wire", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          if (request.method === "POST" && request.path === "/crawl") {
            expect(request.json).toEqual({
              url: "https://example.com/docs",
              limit: 25,
              sitemap: "include",
              excludePaths: ["/admin"],
              ignoreQueryParameters: true,
              scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
            })
            return { body: { success: true, id: "crawl_123" } }
          }
          if (request.path === "/crawl/crawl_123") {
            if (request.method === "DELETE") {
              return { body: { success: true } }
            }
            return { body: { status: "active", total: 5, completed: 2, creditsUsed: 4 } }
          }
          if (request.path === "/crawl/crawl_123/errors") {
            return { body: { success: true, errors: [], robotsBlocked: ["https://x"] } }
          }
          return { status: 404, body: { error: "unexpected route" } }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateCrawlStartInput({
              url: "https://example.com/docs",
              limit: 25,
              sitemap: "include",
              exclude_paths: ["/admin"],
              ignore_query_parameters: true,
              scrape_options: { formats: ["markdown"], only_main_content: true },
            }),
          )
          const started = await Effect.runPromise(run(crawlStart(validated)))
          expect(started).toMatchObject({ kind: "crawl", id: "crawl_123", status: "submitted" })

          const checked = await Effect.runPromise(run(crawlCheck({ id: "crawl_123" })))
          expect(checked).toMatchObject({
            status: "running",
            progress: { completed: 2, total: 5, credits_used: 4 },
          })

          const canceled = await Effect.runPromise(run(crawlCancel({ id: "crawl_123" })))
          expect(canceled.status).toBe("canceled")

          const errors = await Effect.runPromise(run(crawlErrors({ id: "crawl_123" })))
          expect(errors).toMatchObject({ errors_count: 0, robots_blocked_count: 1 })
        },
      ),
    ),
  )

  it.effect("search posts normalized sources and rejects mixed domain filters", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          expect(request.json).toMatchObject({
            query: "firecrawl scrape api",
            limit: 5,
            sources: [{ type: "web" }],
            scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
          })
          return {
            body: { success: true, data: { web: [{ title: "Firecrawl", url: "https://docs.firecrawl.dev" }] } },
          }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateSearchCommandInput({
              query: "firecrawl scrape api",
              limit: 5,
              sources: ["web"],
              scrape_options: { formats: ["markdown"], only_main_content: true },
            }),
          )
          const result = await Effect.runPromise(run(runSearchCommand(validated, 5)))
          expect(result).toMatchObject({ success: true })

          const mixed = await Effect.runPromise(
            validateSearchCommandInput({
              query: "firecrawl",
              include_domains: ["docs.firecrawl.dev"],
              exclude_domains: ["example.com"],
            }).pipe(Effect.flip),
          )
          expect(mixed._tag).toBe("CommandInputError")
          expect((mixed as { field: string }).field).toBe("include_domains")
        },
      ),
    ),
  )

  it.effect("parse uploads a real multipart/form-data payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "survey-fc-parse-"))
    const filePath = join(dir, "report.pdf")
    writeFileSync(filePath, "%PDF-1.4 test")

    return Effect.promise(() =>
      withServer(
        (request) => {
          expect(request.method).toBe("POST")
          expect(request.path).toBe("/parse")
          expect(String(request.headers["content-type"])).toContain("multipart/form-data")
          const body = request.rawBody
          expect(body).toContain('name="file"; filename="report.pdf"')
          expect(body).toContain("application/pdf")
          expect(body).toContain("%PDF-1.4 test")
          expect(body).toContain('name="options"')
          const optionsJson = body.slice(body.indexOf('name="options"'))
          expect(optionsJson).toContain('"formats":["markdown"]')
          expect(optionsJson).toContain('"parsers":[{"type":"pdf","mode":"auto","pages":true}]')
          return { body: { success: true, data: { markdown: "# Report" } } }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateParseCommandInput({
              path: filePath,
              formats: ["markdown"],
              pdf_parser_mode: "auto",
              pdf_pages: true,
            }),
          )
          const result = await Effect.runPromise(run(runParseCommand(validated, 1)))
          expect(result).toEqual({ success: true, data: { markdown: "# Report" } })
        },
      ),
    )
  })

  it.effect("extract runs the /v2/extract job orbit and validates inputs", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          if (request.method === "POST" && request.path === "/extract") {
            expect(request.json).toEqual({
              urls: ["https://docs.firecrawl.dev"],
              prompt: "Extract the page title",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            })
            return { body: { success: true, id: "extract_123" } }
          }
          if (request.method === "GET" && request.path === "/extract/extract_123") {
            return { body: { success: true, status: "completed", data: { title: "Docs" } } }
          }
          return { status: 404, body: { error: "unexpected route" } }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateExtractStartInput({
              urls: ["https://docs.firecrawl.dev"],
              prompt: "Extract the page title",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            }),
          )
          const started = await Effect.runPromise(run(extractStart(validated)))
          expect(started).toMatchObject({ kind: "extract", id: "extract_123", status: "submitted" })

          const checked = await Effect.runPromise(run(extractCheck({ id: "extract_123" })))
          expect(checked).toMatchObject({ status: "succeeded", terminal: true })

          const empty = await Effect.runPromise(
            validateExtractStartInput({}).pipe(Effect.flip),
          )
          expect(empty._tag).toBe("CommandInputError")
        },
      ),
    ),
  )

  it.effect("agent runs start|check|cancel|events|list", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          if (request.method === "POST" && request.path === "/agent") {
            expect(request.json).toEqual({
              prompt: "Find the founders of Firecrawl",
              maxCredits: 100,
              strictConstrainToURLs: true,
              model: "spark-1-mini",
            })
            return { body: { success: true, id: "agent_123" } }
          }
          if (request.method === "GET" && request.path === "/agent/agent_123") {
            return { body: { success: true, status: "completed", creditsUsed: 12 } }
          }
          if (request.method === "GET" && request.path === "/agent/agent_123/trace") {
            expect(request.query).toContain("liveView=true")
            return { body: { success: true, events: [{ type: "action" }] } }
          }
          if (request.method === "DELETE" && request.path === "/agent/agent_123") {
            return { body: { success: true } }
          }
          if (request.method === "GET" && request.path === "/agent") {
            expect(request.query).toContain("before=42")
            return { body: { success: true, runs: [], next: null } }
          }
          return { status: 404, body: { error: `unexpected route ${request.method} ${request.path}` } }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateAgentStartInput({
              prompt: "Find the founders of Firecrawl",
              max_credits: 100,
              strict_constrain_to_urls: true,
              model: "spark-1-mini",
            }),
          )
          const started = await Effect.runPromise(run(agentStart(validated)))
          expect(started).toMatchObject({ kind: "agent", id: "agent_123", status: "submitted" })

          const checked = await Effect.runPromise(run(agentCheck({ id: "agent_123" })))
          expect(checked).toMatchObject({ status: "succeeded", progress: { credits_used: 12 } })

          const events = await Effect.runPromise(
            run(agentEvents({ id: "agent_123", live_view: true })),
          )
          expect(events).toMatchObject({
            capability: "agent.events",
            supported: true,
            transport: "rest-trace",
          })

          const canceled = await Effect.runPromise(run(agentCancel({ id: "agent_123" })))
          expect(canceled).toMatchObject({ status: "canceled", terminal: true })

          const list = await Effect.runPromise(run(agentList({ before: 42 })))
          expect(list).toEqual({ success: true, runs: [], next: null })
        },
      ),
    ),
  )

  it.effect("interact execute requires prompt xor code; stop deletes the session", () =>
    Effect.promise(() =>
      withServer(
        (request) => {
          if (request.method === "POST" && request.path === "/scrape/scrape_123/interact") {
            expect(request.json).toEqual({ code: "await page.title()", language: "node", timeout: 30 })
            return { body: { success: true, output: "Example" } }
          }
          if (request.method === "DELETE" && request.path === "/scrape/scrape_123/interact") {
            return { body: { success: true } }
          }
          return { status: 404, body: { error: "unexpected route" } }
        },
        async () => {
          const validated = await Effect.runPromise(
            validateInteractExecuteInput({
              id: "scrape_123",
              code: "await page.title()",
              language: "node",
              timeout: 30,
            }),
          )
          const executed = await Effect.runPromise(run(interactExecute(validated)))
          expect(executed).toEqual({ success: true, output: "Example" })

          const both = await Effect.runPromise(
            validateInteractExecuteInput({
              id: "scrape_123",
              prompt: "click",
              code: "await page.title()",
            }).pipe(Effect.flip),
          )
          expect(both._tag).toBe("CommandInputError")
          expect((both as { field: string }).field).toBe("prompt")

          const neither = await Effect.runPromise(
            validateInteractExecuteInput({ id: "scrape_123" }).pipe(Effect.flip),
          )
          expect(neither._tag).toBe("CommandInputError")

          const langOnly = await Effect.runPromise(
            validateInteractExecuteInput({
              id: "scrape_123",
              prompt: "click",
              language: "node",
            }).pipe(Effect.flip),
          )
          expect((langOnly as { field: string }).field).toBe("language")

          const stopped = await Effect.runPromise(run(interactStop({ id: "scrape_123" })))
          expect(stopped).toMatchObject({ kind: "interact", stopped: true })
        },
      ),
    ),
  )

  it.effect("provider errors surface as ApiResponseError", () =>
    Effect.promise(() =>
      withServer(
        () => ({ status: 429, body: { success: false, error: "rate limited", code: "RATE_LIMIT" } }),
        async () => {
          const validated = await Effect.runPromise(
            validateScrapeCommandInput({ url: "https://example.com" }),
          )
          const failure = await Effect.runPromise(
            run(runScrapeCommand(validated, 1)).pipe(Effect.flip),
          )
          expect(failure).toMatchObject({
            _tag: "ApiResponseError",
            status: 429,
            message: "rate limited",
          })
        },
      ),
    ),
  )

  // it.live: waitForJob uses real Effect.sleep + Date.now timeouts
  it.live("waitForJob times out with JobWaitTimeoutError", () =>
    Effect.gen(function* () {
      const failing = yield* waitForJob(
        { id: "job_x", poll_interval_ms: 50, timeout_ms: 80 },
        () => Effect.succeed(normalizeJobSnapshot("agent", { status: "processing" }, "job_x")),
      ).pipe(Effect.flip)
      expect(failing).toMatchObject({
        _tag: "JobWaitTimeoutError",
        jobId: "job_x",
        timeoutMs: 80,
        lastStatus: "running",
      })
    }),
  )
})

/* ------------------------------------------------------------------------ */
/* CLI-level subprocess tests (real bun runtime, stubbed HTTP over localhost) */
/* ------------------------------------------------------------------------ */

const PROJECT_ROOT = join(import.meta.dirname, "..")

const CLI_HARNESS = `
const root = ${JSON.stringify(PROJECT_ROOT)}
const { Command } = await import("effect/unstable/cli")
const { Effect, Layer } = await import("effect")
const { BunServices, BunRuntime } = await import("@effect/platform-bun")
const { firecrawlCommand } = await import(root + "/src/providers/firecrawl/index.ts")
const { HttpClientLayer } = await import(root + "/src/core/http.ts")
const { Store } = await import(root + "/src/core/store.ts")
const { setExitCode, writeFailureEnvelope, writeCauseEnvelope } = await import(root + "/src/core/output.ts")
const layer = Layer.mergeAll(
  BunServices.layer,
  HttpClientLayer,
  Store.layer.pipe(Layer.provide(BunServices.layer)),
)
const program = Command.runWith(firecrawlCommand, { version: "0.0.0" })(process.argv.slice(1)).pipe(
  Effect.catch((error) => setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(undefined, error)))),
  Effect.catchCause((cause) => setExitCode(1).pipe(Effect.andThen(writeCauseEnvelope(undefined, cause)))),
  Effect.provide(layer),
)
BunRuntime.runMain(program)
`

interface CliResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const runCli = (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
): Promise<CliResult> =>
  new Promise((resolveSpawn, reject) => {
    const processEnv = { ...process.env }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete processEnv[key]
      } else {
        processEnv[key] = value
      }
    }
    const child = spawn("bun", ["-e", CLI_HARNESS, ...args], {
      cwd: PROJECT_ROOT,
      env: processEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (data) => (stdout += data))
    child.stderr.on("data", (data) => (stderr += data))
    child.on("close", (code) => resolveSpawn({ stdout, stderr, exitCode: code ?? -1 }))
    child.on("error", reject)
  })

const expectJson = <T>(text: string): T => {
  expect(text.trim().length).toBeGreaterThan(0)
  return JSON.parse(text) as T
}

describe("firecrawl cli", () => {
  it("scrape and batch orbit produce success envelopes and record runs", async () => {
    const surveyHome = mkdtempSync(join(tmpdir(), "survey-fc-home-"))
    await withServer(
      (request) => {
        if (request.method === "POST" && request.path === "/scrape") {
          return { body: { success: true, data: { markdown: "# Hi" } } }
        }
        if (request.method === "POST" && request.path === "/batch/scrape") {
          return { body: { success: true, id: "batch_1" } }
        }
        if (request.method === "GET" && request.path === "/batch/scrape/batch_1") {
          return { body: { status: "completed", total: 1, data: [{ markdown: "x" }] } }
        }
        return { status: 404, body: { error: "nf" } }
      },
      async (baseUrl) => {
        const env = {
          FIRECRAWL_API_KEY: "test-key",
          FIRECRAWL_API_BASE_URL: baseUrl,
          SURVEY_HOME: surveyHome,
        }
        const scrape = await runCli(
          ["scrape", JSON.stringify({ url: "https://example.com", formats: ["markdown"] })],
          env,
        )
        expect(scrape.exitCode).toBe(0)
        const scrapePayload = expectJson<{ ok: boolean; command: string; data: { success: boolean } }>(
          scrape.stdout,
        )
        expect(scrapePayload).toEqual({
          ok: true,
          command: "firecrawl scrape",
          data: { success: true, data: { markdown: "# Hi" } },
        })

        const batchStart = await runCli(
          ["batch", "start", JSON.stringify({ urls: ["https://example.com/a"] })],
          env,
        )
        expect(batchStart.exitCode).toBe(0)
        expect(
          expectJson<{ command: string; data: { kind: string; status: string } }>(batchStart.stdout),
        ).toMatchObject({
          command: "firecrawl batch start",
          data: { kind: "batch_scrape", status: "submitted", id: "batch_1" },
        })

        const batchCheck = await runCli(["batch", "check", '{"id":"batch_1"}'], env)
        expect(
          expectJson<{ data: { status: string; terminal: boolean } }>(batchCheck.stdout).data,
        ).toMatchObject({ status: "succeeded", terminal: true })

        // run registry captured the provider-side job
        const runs = await runCli(
          [
            "-e",
            `const { Database } = await import("bun:sqlite");
const db = new Database(${JSON.stringify(join(surveyHome, "store.db"))}, { readonly: true });
console.log(JSON.stringify(db.query("select provider, kind, remote_id, status from runs").all()))`,
          ],
          {},
        )
        expect(
          expectJson<Array<{ provider: string; kind: string; remote_id: string; status: string }>>(
            runs.stdout,
          ),
        ).toEqual([
          {
            provider: "firecrawl",
            kind: "firecrawl.batch",
            remote_id: "batch_1",
            // batch check above synced the stored run to the terminal status
            status: "succeeded",
          },
        ])
      },
    )
  })

  it("interact execute rejects prompt+code together with a failure envelope", async () => {
    const surveyHome = mkdtempSync(join(tmpdir(), "survey-fc-home-"))
    const result = await runCli(
      [
        "interact",
        "execute",
        JSON.stringify({ id: "scrape_1", prompt: "click", code: "await page.title()" }),
      ],
      {
        FIRECRAWL_API_KEY: "test-key",
        FIRECRAWL_API_BASE_URL: "http://127.0.0.1:1",
        SURVEY_HOME: surveyHome,
      },
    )
    expect(result.exitCode).toBe(1)
    const payload = expectJson<{ ok: boolean; command: string; error: { type: string } }>(
      result.stderr,
    )
    expect(payload).toMatchObject({
      ok: false,
      command: "firecrawl interact execute",
      error: { type: "CommandInputError" },
    })
  })

  it("missing API key produces MissingApiKeyError envelope", async () => {
    const surveyHome = mkdtempSync(join(tmpdir(), "survey-fc-home-"))
    const result = await runCli(["scrape", '{"url":"https://example.com"}'], {
      FIRECRAWL_API_KEY: undefined,
      FIRECRAWL_API_BASE_URL: "http://127.0.0.1:1",
      SURVEY_HOME: surveyHome,
    })
    expect(result.exitCode).toBe(1)
    const payload = expectJson<{ error: { type: string; details: { env_var: string } } }>(
      result.stderr,
    )
    expect(payload.error).toMatchObject({
      type: "MissingApiKeyError",
      details: { env_var: "FIRECRAWL_API_KEY" },
    })
  })
})
