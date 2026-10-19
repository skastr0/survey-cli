import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

// vitest runs under Node; survey internals read Bun.env.
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  ;(globalThis as { Bun?: unknown }).Bun = { env: process.env }
}

import { unifiedExtract } from "../src/capabilities/extract"
import { unifiedFetch } from "../src/capabilities/fetch"
import { papers } from "../src/capabilities/papers"
import { unifiedSearch } from "../src/capabilities/search"
import { verify } from "../src/capabilities/verify"
import { getContract } from "../src/core/discovery"
import { JobWaitTimeoutError, ProviderUnsupportedError } from "../src/core/errors"
import { toErrorDetails } from "../src/core/output"
import { Store, type SourceRecord } from "../src/core/store"
import { resolveAccess, routeProviders } from "../src/core/tiers"
import { exaApi } from "../src/providers/exa"
import { parseExaMcpText } from "../src/providers/exa/keyless"
import { firecrawlApi } from "../src/providers/firecrawl"
import { arxivRefFromUrl, paperRef, paperSources, paperUrl } from "../src/providers/firecrawl/papers"
import { parallelApi } from "../src/providers/parallel"

afterEach(() => {
  process.exitCode = undefined
})

/* ------------------------------------------------------------------------ */
/* Harness: one stub server for every provider, env pointed at it            */
/* ------------------------------------------------------------------------ */

interface Seen {
  readonly method: string
  readonly pathname: string
  readonly params: URLSearchParams
  readonly rawPath: string
  readonly headers: IncomingMessage["headers"]
  readonly body: unknown
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string>; sse?: boolean }
type Handler = (seen: Seen) => Reply | undefined

const ENV_KEYS = [
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  "PARALLEL_API_KEY",
  "KEENABLE_API_KEY",
  "LLAMA_CLOUD_API_KEY",
  "EXA_API_BASE_URL",
  "FIRECRAWL_API_BASE_URL",
  "PARALLEL_API_BASE_URL",
  "KEENABLE_API_BASE_URL",
  "EXA_MCP_URL",
  "PARALLEL_SEARCH_MCP_URL",
  "SURVEY_HOME",
] as const
type EnvKey = (typeof ENV_KEYS)[number]

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let text = ""
    req.on("data", (chunk) => (text += chunk))
    req.on("end", () => {
      try {
        resolve(text.length > 0 ? JSON.parse(text) : undefined)
      } catch {
        resolve(text)
      }
    })
  })

const write = (res: ServerResponse, reply: Reply) => {
  const headers = { "content-type": reply.sse ? "text/event-stream" : "application/json", ...reply.headers }
  res.writeHead(reply.status ?? 200, headers)
  const json = JSON.stringify(reply.body)
  res.end(reply.sse ? `event: message\ndata: ${json}\n\n` : json)
}

/** Minimal MCP server: initialize (issues a session), initialized, tools/call. */
const mcpHandler =
  (options: { sessionId?: string; sse?: boolean; call: (name: string, args: Record<string, unknown>, seen: Seen) => unknown }) =>
  (seen: Seen): Reply => {
    const rpc = seen.body as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } }
    if (rpc.method === "initialize") {
      return {
        body: { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "stub" } } },
        ...(options.sessionId ? { headers: { "mcp-session-id": options.sessionId } } : {}),
        ...(options.sse ? { sse: true } : {}),
      }
    }
    if (rpc.method === "notifications/initialized") {
      return { status: 202, body: "" }
    }
    return {
      body: { jsonrpc: "2.0", id: rpc.id, result: options.call(rpc.params!.name, rpc.params!.arguments, seen) },
      ...(options.sse ? { sse: true } : {}),
    }
  }

const withStub = async <A>(
  handlers: Record<string, Handler>,
  env: Partial<Record<EnvKey, string | undefined>>,
  run: (seen: ReadonlyArray<Seen>) => Promise<A>,
) => {
  const seen: Array<Seen> = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub")
    const entry: Seen = {
      method: req.method ?? "",
      pathname: url.pathname,
      params: url.searchParams,
      rawPath: req.url ?? "",
      headers: req.headers,
      body: await readBody(req),
    }
    seen.push(entry)
    const prefix = Object.keys(handlers).find((key) => url.pathname.startsWith(key))
    const reply = prefix ? handlers[prefix]!(entry) : undefined
    write(res, reply ?? { status: 404, body: { error: `no stub for ${url.pathname}` } })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  const baseEnv: Record<EnvKey, string | undefined> = {
    EXA_API_KEY: undefined,
    FIRECRAWL_API_KEY: undefined,
    PARALLEL_API_KEY: undefined,
    KEENABLE_API_KEY: undefined,
    LLAMA_CLOUD_API_KEY: undefined,
    EXA_API_BASE_URL: `${base}/exa`,
    FIRECRAWL_API_BASE_URL: `${base}/fc`,
    PARALLEL_API_BASE_URL: `${base}/parallel`,
    KEENABLE_API_BASE_URL: `${base}/keenable`,
    EXA_MCP_URL: `${base}/exa-mcp`,
    PARALLEL_SEARCH_MCP_URL: `${base}/parallel-mcp`,
    SURVEY_HOME: "/nonexistent-survey-home",
  }
  const previous = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key])
    const value = key in env ? env[key] : baseEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run(seen)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const makeStore = () => {
  const sources: Array<{ provider: string; url: string; title?: string | undefined; snippet?: string | undefined }> = []
  const layer = Layer.succeed(
    Store,
    Store.of({
      upsertRun: (run) =>
        Effect.succeed({
          id: run.id,
          provider: run.provider,
          kind: run.kind,
          remote_id: run.remoteId ?? null,
          status: run.status,
          payload: null,
          result_ref: null,
          created_at: "",
          updated_at: "",
        }),
      getRun: () => Effect.succeed(undefined),
      findRunByRemote: () => Effect.succeed(undefined),
      listRuns: () => Effect.succeed([]),
      updateRun: () => Effect.void,
      insertSources: (items) =>
        Effect.sync(() => {
          sources.push(...items)
          return items.length
        }),
      sourcesForRun: () => Effect.succeed([] as ReadonlyArray<SourceRecord>),
      listSources: () => Effect.succeed([] as ReadonlyArray<SourceRecord>),
      citationOverlap: () => Effect.succeed([]),
    }),
  )
  return { layer, sources }
}

const run = <A, E>(effect: Effect.Effect<A, E, any>, store = makeStore()) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          FileSystem.layerNoop({ exists: () => Effect.succeed(false), makeDirectory: () => Effect.void }),
          Path.layer,
          store.layer,
        ),
      ),
    ) as Effect.Effect<A, E, never>,
  )

const keenableSearchReply = (url: string): Reply => ({
  body: { query: "q", results: [{ title: "Keenable hit", url, description: "", snippet: "k" }] },
})

const exaSearchText = [
  "Title: Attention Is All You Need",
  "URL: https://arxiv.org/abs/1706.03762",
  "Published: 2017-06-12T18:40:01.000Z",
  "Author: Vaswani, Ashish",
  "Highlights:",
  "The dominant sequence transduction models...",
  "",
  "---",
  "",
  "Title: Second",
  "URL: https://example.com/second",
  "Published: N/A",
  "Author: N/A",
  "Highlights:",
  "Body two",
].join("\n")

/* ------------------------------------------------------------------------ */
/* Tier model                                                                */
/* ------------------------------------------------------------------------ */

describe("tier model", () => {
  it("resolves keyed, public, and unavailable access", () => {
    expect(resolveAccess("keenable", "search", false)).toEqual({ available: true, mode: "public", cost: "free" })
    expect(resolveAccess("firecrawl", "papers", false)).toEqual({ available: true, mode: "public", cost: "free" })
    expect(resolveAccess("firecrawl", "map", false)).toEqual({ available: false, mode: "unavailable", cost: null })
    expect(resolveAccess("firecrawl", "map", true)).toEqual({ available: true, mode: "keyed", cost: "paid" })
    expect(resolveAccess("exa", "deep_research", false).available).toBe(false)
    expect(resolveAccess("llama", "parse", false).available).toBe(false)
    expect(resolveAccess("exa", "parse", true).mode).toBe("unavailable")
  })

  it("tier free hides configured keys and skips keyed-only capabilities", async () => {
    await withStub({}, { EXA_API_KEY: "k", PARALLEL_API_KEY: "k" }, async () => {
      const any = await run(
        routeProviders({ requested: ["exa", "parallel"], adapters: ["exa", "parallel"], capability: "search" }),
      )
      expect(any.eligible.map((e) => e.access.mode)).toEqual(["keyed", "keyed"])

      const free = await run(
        routeProviders({ requested: ["exa", "parallel"], adapters: ["exa", "parallel"], capability: "search", tier: "free" }),
      )
      expect(free.eligible.map((e) => [e.provider, e.access.mode])).toEqual([
        ["exa", "public"],
        ["parallel", "public"],
      ])

      const research = await run(
        routeProviders({
          requested: ["exa", "keenable"],
          adapters: ["exa"],
          capability: "deep_research",
          tier: "free",
        }),
      )
      expect(research.eligible).toEqual([])
      expect(research.skipped).toEqual([
        { provider: "exa", reason: "tier free: deep_research needs an API key (paid)" },
        { provider: "keenable", reason: "no deep_research adapter for this command" },
      ])
    })
  })
})

/* ------------------------------------------------------------------------ */
/* Firecrawl keyless + Research Index                                        */
/* ------------------------------------------------------------------------ */

describe("firecrawl keyless", () => {
  it("scrape without a key sends no Authorization header and reports auth_mode public", async () => {
    await withStub(
      { "/fc/scrape": () => ({ body: { success: true, data: { markdown: "# Hi" } } }) },
      {},
      async (seen) => {
        const result = await run(firecrawlApi.scrape({ url: "https://example.com" } as never))
        expect(result).toEqual({ success: true, data: { markdown: "# Hi" }, auth_mode: "public" })
        expect(seen[0]?.headers.authorization).toBeUndefined()
      },
    )
  })

  it("keeps the bearer key when configured", async () => {
    await withStub(
      { "/fc/search": () => ({ body: { success: true, data: { web: [] } } }) },
      { FIRECRAWL_API_KEY: "fc-test" },
      async (seen) => {
        const result = await run(firecrawlApi.search({ query: "x" } as never))
        expect((result as { auth_mode: string }).auth_mode).toBe("keyed")
        expect(seen[0]?.headers.authorization).toBe("Bearer fc-test")
      },
    )
  })

  it("maps research endpoints, params, and paper-ref paths", async () => {
    await withStub(
      {
        "/fc/search/research/papers": (s) =>
          s.pathname === "/fc/search/research/papers"
            ? { body: { success: true, results: [] } }
            : s.pathname.endsWith("/similar")
              ? { body: { success: true, results: [], poolSize: 0, truncated: false } }
              : { body: { success: true, paper: { paperId: "1", title: "T", abstract: "A" } } },
      },
      {},
      async (seen) => {
        await run(
          firecrawlApi.searchPapers({ query: "diffusion", k: 5, authors: ["Ho", "Song"], categories: "cs.LG", from: "2020-01-01" }),
        )
        expect(seen[0]?.pathname).toBe("/fc/search/research/papers")
        expect(seen[0]?.params.get("query")).toBe("diffusion")
        expect(seen[0]?.params.get("k")).toBe("5")
        expect(seen[0]?.params.getAll("authors")).toEqual(["Ho", "Song"])
        expect(seen[0]?.params.get("categories")).toBe("cs.LG")
        expect(seen[0]?.params.get("from")).toBe("2020-01-01")
        expect(seen[0]?.headers.authorization).toBeUndefined()

        await run(firecrawlApi.readPaper({ id: "arxiv:1706.03762", query: "attention", k: 2 }))
        expect(seen[1]?.rawPath.startsWith("/fc/search/research/papers/arxiv:1706.03762?")).toBe(true)
        expect(seen[1]?.params.get("query")).toBe("attention")
        expect(seen[1]?.params.get("k")).toBe("2")

        await run(firecrawlApi.inspectPaper({ id: "doi:10.1000/xyz.1" }))
        expect(seen[2]?.rawPath).toBe("/fc/search/research/papers/doi:10.1000%2Fxyz.1")

        await run(
          firecrawlApi.relatedPapers({
            id: "arxiv:2006.11239",
            intent: "faster sampling",
            mode: "citers",
            rerank: true,
            anchor: ["arxiv:2105.05233", "arxiv:2010.02502"],
          }),
        )
        expect(seen[3]?.pathname).toBe("/fc/search/research/papers/arxiv:2006.11239/similar")
        expect(seen[3]?.params.get("intent")).toBe("faster sampling")
        expect(seen[3]?.params.get("mode")).toBe("citers")
        expect(seen[3]?.params.get("rerank")).toBe("true")
        expect(seen[3]?.params.getAll("anchor")).toEqual(["arxiv:2105.05233", "arxiv:2010.02502"])
      },
    )
  })

  it("paper refs, urls, and ledger rows use canonical ids", () => {
    expect(paperRef({ paperId: "201", primaryId: "arxiv:2105.05233" })).toBe("arxiv:2105.05233")
    expect(paperRef({ paperId: "201", ids: { pmid: ["123"], doi: ["10.1/x"] } })).toBe("doi:10.1/x")
    expect(paperRef({ paperId: "201" })).toBe("firecrawl:201")
    expect(paperRef({ paperId: "web:https://a.org/p" })).toBe("web:https://a.org/p")
    expect(paperUrl("arxiv:1706.03762")).toBe("https://arxiv.org/abs/1706.03762")
    expect(paperUrl("pmid:42")).toBe("https://pubmed.ncbi.nlm.nih.gov/42/")
    expect(paperUrl("pmcid:PMC7")).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC7/")
    expect(paperUrl("doi:10.1/x")).toBe("https://doi.org/10.1/x")
    expect(arxivRefFromUrl("https://arxiv.org/html/1706.03762v7")).toBe("arxiv:1706.03762")
    expect(arxivRefFromUrl("https://arxiv.org/pdf/2105.05233")).toBe("arxiv:2105.05233")
    expect(arxivRefFromUrl("https://example.com/1706.03762")).toBeUndefined()
    expect(
      paperSources({
        success: true,
        results: [{ paperId: "1", primaryId: "arxiv:1706.03762", title: "Attention", abstract: "We propose" }],
      }),
    ).toEqual([{ url: "arxiv:1706.03762", title: "Attention", snippet: "We propose" }])
  })
})

/* ------------------------------------------------------------------------ */
/* Exa / Parallel keyless MCP                                                */
/* ------------------------------------------------------------------------ */

describe("exa keyless MCP", () => {
  it("parses web_search_exa text blocks", () => {
    const results = parseExaMcpText(exaSearchText)
    expect(results).toEqual([
      {
        url: "https://arxiv.org/abs/1706.03762",
        title: "Attention Is All You Need",
        publishedDate: "2017-06-12T18:40:01.000Z",
        author: "Vaswani, Ashish",
        text: "The dominant sequence transduction models...",
      },
      { url: "https://example.com/second", title: "Second", text: "Body two" },
    ])
  })

  it("webSearch without a key calls the MCP tool over SSE and reports ignored options", async () => {
    await withStub(
      {
        "/exa-mcp": mcpHandler({
          sse: true,
          call: (name, args) => {
            expect(name).toBe("web_search_exa")
            expect(args).toMatchObject({ query: "attention", numResults: 2, objective: "attention" })
            return { content: [{ type: "text", text: exaSearchText }] }
          },
        }),
      },
      {},
      async (seen) => {
        const store = makeStore()
        const result = (await run(
          exaApi.webSearch({ query: "attention", numResults: 2, includeDomains: ["arxiv.org"] } as never),
          store,
        )) as unknown as { auth_mode: string; ignored_options: Array<string>; data: { results: Array<{ url: string }> } }
        expect(result.auth_mode).toBe("public")
        expect(result.ignored_options).toEqual(["includeDomains"])
        expect(result.data.results.map((r) => r.url)).toEqual([
          "https://arxiv.org/abs/1706.03762",
          "https://example.com/second",
        ])
        expect(seen.every((s) => s.headers["x-api-key"] === undefined)).toBe(true)
        expect(seen.some((s) => s.pathname.startsWith("/exa/"))).toBe(false)
        expect(store.sources.map((s) => s.url)).toContain("https://arxiv.org/abs/1706.03762")
      },
    )
  })

  it("webSearch with a key still uses REST", async () => {
    await withStub(
      { "/exa/search": () => ({ body: { results: [{ url: "https://a.com", title: "A" }] } }) },
      { EXA_API_KEY: "exa-key" },
      async (seen) => {
        const result = (await run(exaApi.webSearch({ query: "x" } as never))) as unknown as { auth_mode: string }
        expect(result.auth_mode).toBe("keyed")
        expect(seen[0]?.headers["x-api-key"]).toBe("exa-key")
      },
    )
  })
})

describe("parallel keyless MCP", () => {
  it("search carries the issued Mcp-Session-Id and decodes structuredContent", async () => {
    await withStub(
      {
        "/parallel-mcp": mcpHandler({
          sessionId: "sess-1",
          call: (name, args, seen) => {
            expect(name).toBe("web_search")
            expect(seen.headers["mcp-session-id"]).toBe("sess-1")
            expect(args.search_queries).toEqual(["state space models"])
            expect(typeof args.session_id).toBe("string")
            return {
              content: [{ type: "text", text: "{}" }],
              structuredContent: {
                search_id: "search_1",
                session_id: "srv",
                results: [{ url: "https://arxiv.org/abs/2312.00752", title: "Mamba", excerpts: ["SSM"] }],
              },
            }
          },
        }),
      },
      {},
      async () => {
        const result = await run(parallelApi.search({ objective: "SSMs", search_queries: ["state space models"] }))
        expect(result.auth_mode).toBe("public")
        expect(result.search_id).toBe("search_1")
        expect(result.results[0]?.url).toBe("https://arxiv.org/abs/2312.00752")
      },
    )
  })

  it("extract without a key uses web_fetch", async () => {
    await withStub(
      {
        "/parallel-mcp": mcpHandler({
          call: (name, args) => {
            expect(name).toBe("web_fetch")
            expect(args.urls).toEqual(["https://example.com"])
            return {
              content: [],
              structuredContent: {
                extract_id: "extract_1",
                session_id: "srv",
                results: [{ url: "https://example.com", title: "Example", excerpts: ["Example Domain"] }],
                errors: [],
              },
            }
          },
        }),
      },
      {},
      async () => {
        const result = await run(parallelApi.extract({ urls: ["https://example.com"] }))
        expect(result.auth_mode).toBe("public")
        expect(result.results[0]?.excerpts).toEqual(["Example Domain"])
      },
    )
  })
})

/* ------------------------------------------------------------------------ */
/* Unified: search tier, papers, verify                                      */
/* ------------------------------------------------------------------------ */

const allKeylessHandlers: Record<string, Handler> = {
  "/exa-mcp": mcpHandler({
    sse: true,
    call: () => ({ content: [{ type: "text", text: exaSearchText }] }),
  }),
  "/parallel-mcp": mcpHandler({
    call: () => ({
      content: [],
      structuredContent: {
        search_id: "s",
        session_id: "srv",
        results: [{ url: "https://arxiv.org/abs/1706.03762", title: "Attention", excerpts: ["x"] }],
      },
    }),
  }),
  "/keenable/v1/search/public": () => keenableSearchReply("https://arxiv.org/html/1706.03762v7"),
}

describe("unified keyless routing", () => {
  it("search with tier free never sends configured keys", async () => {
    await withStub(
      {
        ...allKeylessHandlers,
        "/fc/search": () => ({ body: { success: true, data: { web: [{ url: "https://fc.dev/a", title: "FC" }] } } }),
      },
      { EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "par-key", KEENABLE_API_KEY: "kee-key", FIRECRAWL_API_KEY: "fc-key" },
      async (seen) => {
        const result = await run(unifiedSearch({ query: "attention", tier: "free" }))
        expect(result.routing.map((r) => r.mode)).toEqual(["public", "public", "public", "public"])
        expect(result.providers_used.sort()).toEqual(["exa", "firecrawl", "keenable", "parallel"])
        expect(result.results.find((r) => r.canonical_url === "https://arxiv.org/abs/1706.03762")?.providers.length).toBe(2)
        for (const request of seen) {
          expect(request.headers.authorization).toBeUndefined()
          expect(request.headers["x-api-key"]).toBeUndefined()
        }
        expect(seen.some((s) => s.pathname === "/keenable/v1/search/public")).toBe(true)
      },
    )
  })

  it("papers searches the index, reads passages for the top papers, and records primary ids", async () => {
    await withStub(
      {
        "/fc/search/research/papers": (s) =>
          s.pathname === "/fc/search/research/papers"
            ? {
                body: {
                  success: true,
                  results: [
                    { paperId: "1", primaryId: "arxiv:1706.03762", title: "Attention", abstract: "We propose", score: 0.9 },
                    { paperId: "2", primaryId: "pmid:42", title: "Second", abstract: "B", score: 0.5 },
                    { paperId: "3", primaryId: "doi:10.1/x", title: "Third", abstract: "C", score: 0.1 },
                  ],
                },
              }
            : {
                body: {
                  success: true,
                  paper: { paperId: "1", title: "Attention", abstract: "We propose" },
                  paperId: "1",
                  query: s.params.get("query"),
                  passages: [{ text: `passage for ${decodeURIComponent(s.pathname.split("/").pop() ?? "")}`, score: 0.8 }],
                },
              },
      },
      {},
      async (seen) => {
        const store = makeStore()
        const result = await run(
          papers({ query: "transformers", question: "what is attention", read_top: 2, k: 3 }),
          store,
        )
        expect(result.source).toBe("research_index")
        expect(result.auth_mode).toBe("public")
        expect(result.papers.map((p) => p.primary_id)).toEqual(["arxiv:1706.03762", "pmid:42", "doi:10.1/x"])
        expect(result.papers[0]?.url).toBe("https://arxiv.org/abs/1706.03762")
        expect(result.papers[0]?.passages?.[0]?.text).toBe("passage for arxiv:1706.03762")
        expect(result.papers[1]?.passages?.[0]?.text).toBe("passage for pmid:42")
        expect(result.papers[2]?.passages).toBeUndefined()
        expect(seen.filter((s) => s.params.get("query") === "what is attention").length).toBe(2)
        expect(store.sources.map((s) => s.url)).toEqual(["arxiv:1706.03762", "pmid:42", "doi:10.1/x"])
      },
    )
  })

  it("papers falls back to arXiv web hits when the index refuses", async () => {
    await withStub(
      {
        ...allKeylessHandlers,
        "/fc/search/research/papers": () => ({
          status: 403,
          body: { success: false, error: "IP looks like a VPN", signup_url: "https://firecrawl.dev/k/x" },
        }),
        "/fc/search": () => ({ status: 403, body: { success: false, error: "IP looks like a VPN" } }),
      },
      {},
      async () => {
        const result = await run(papers({ query: "attention", k: 5 }))
        expect(result.source).toBe("web_fallback")
        expect(result.failures[0]).toMatchObject({ stage: "research_index", error: { type: "ApiResponseError" } })
        expect(result.papers.map((p) => p.primary_id)).toEqual(["arxiv:1706.03762"])
        expect(result.papers[0]?.url).toBe("https://arxiv.org/abs/1706.03762")
      },
    )
  })

  it("papers with fallback false reports the index failure without web calls", async () => {
    await withStub(
      { "/fc/search/research/papers": () => ({ status: 429, body: { success: false, error: "rate limited" } }) },
      {},
      async (seen) => {
        const result = await run(papers({ query: "attention", fallback: false }))
        expect(result.source).toBe("none")
        expect(result.count).toBe(0)
        expect(seen.length).toBe(1)
      },
    )
  })

  it("verify with domain academic and tier free uses only the paper index", async () => {
    await withStub(
      {
        "/fc/search/research/papers": (s) =>
          s.pathname === "/fc/search/research/papers"
            ? { body: { success: true, results: [{ paperId: "1", primaryId: "arxiv:1706.03762", title: "Attention", abstract: "A", score: 1 }] } }
            : { body: { success: true, paperId: "1", query: "q", paper: { paperId: "1", title: "Attention", abstract: "A" }, passages: [{ text: "28.4 BLEU on WMT 2014 English-to-German", score: 0.9 }] } },
      },
      { EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "par-key" },
      async (seen) => {
        const result = await run(
          verify({ claim: "The Transformer reports 28.4 BLEU on WMT 2014 En-De", domain: "academic", tier: "free" }),
        )
        expect(result.skipped.map((s) => s.provider)).toEqual(["exa", "parallel"])
        expect(result.verdicts).toHaveLength(1)
        expect(result.verdicts[0]).toMatchObject({ provider: "papers", ok: true })
        expect(result.verdicts[0]?.answer).toContain("[arxiv:1706.03762] 28.4 BLEU")
        expect(result.verdicts[0]?.sources).toEqual(["https://arxiv.org/abs/1706.03762"])
        expect(seen.every((s) => s.pathname.startsWith("/fc/search/research/papers"))).toBe(true)
      },
    )
  })
})

describe("contracts", () => {
  it("registers examples for every new command", () => {
    for (const command of [
      "papers",
      "firecrawl research search-papers",
      "firecrawl research inspect-paper",
      "firecrawl research read-paper",
      "firecrawl research related-papers",
    ]) {
      const contract = getContract(command)
      expect(contract?.inputSchema, command).toBeDefined()
      expect(contract?.examples?.length ?? 0, command).toBeGreaterThan(0)
    }
  })
})

/* ------------------------------------------------------------------------ */
/* Error envelopes: real TaggedErrors, typed details with retryable          */
/* ------------------------------------------------------------------------ */

describe("unified error envelopes", () => {
  const failureOf = async (effect: Effect.Effect<unknown, unknown, any>) => {
    const exit = await run(Effect.flip(effect))
    return { raw: exit, envelope: toErrorDetails(exit) }
  }

  it("extract without a key fails with MissingApiKeyError naming the PROVIDERS env var", async () => {
    await withStub({}, {}, async (seen) => {
      const firecrawl = await failureOf(
        unifiedExtract({ urls: ["https://example.com"], schema: { type: "object" } }),
      )
      expect(firecrawl.envelope).toMatchObject({
        type: "MissingApiKeyError",
        details: { provider: "firecrawl", env_var: "FIRECRAWL_API_KEY", retryable: false },
      })
      const llama = await failureOf(unifiedExtract({ provider: "llama", file: "./report.pdf" }))
      expect(llama.envelope).toMatchObject({
        type: "MissingApiKeyError",
        details: { provider: "llama", env_var: "LLAMA_CLOUD_API_KEY", retryable: false },
      })
      expect(seen).toHaveLength(0)
    })
  })

  it("fetch reports AllProvidersFailedError, retryable when a provider was rate limited", async () => {
    await withStub(
      { "/keenable/v1/fetch/public": () => ({ status: 429, body: { error: "slow down" } }) },
      {},
      async () => {
        const { raw, envelope } = await failureOf(
          unifiedFetch({ url: "https://example.com", providers: ["keenable", "llama"], store: false }),
        )
        expect((raw as { _tag: string })._tag).toBe("AllProvidersFailedError")
        expect(envelope.type).toBe("AllProvidersFailedError")
        expect(envelope.details).toMatchObject({ capability: "fetch", target: "https://example.com", retryable: true })
        const attempted = (envelope.details as { attempted: Array<{ provider: string; error: unknown }> }).attempted
        expect(attempted.map((a) => a.provider)).toEqual(["llama", "keenable"])
        expect(attempted[1]?.error).toMatchObject({ type: "ApiResponseError", details: { status: 429 } })
      },
    )
  })

  it("fetch failure is not retryable when every provider rejected the request", async () => {
    await withStub(
      { "/keenable/v1/fetch/public": () => ({ status: 400, body: { error: "bad url" } }) },
      {},
      async () => {
        const { envelope } = await failureOf(
          unifiedFetch({ url: "https://example.com", providers: ["keenable"], store: false }),
        )
        expect(envelope).toMatchObject({ type: "AllProvidersFailedError", details: { retryable: false } })
      },
    )
  })

  it("ProviderUnsupportedError and JobWaitTimeoutError render typed envelopes", () => {
    expect(
      toErrorDetails(new ProviderUnsupportedError({ provider: "llama", capability: "fetch", message: "no" })),
    ).toMatchObject({ type: "ProviderUnsupportedError", details: { capability: "fetch", retryable: false } })
    expect(
      toErrorDetails(
        new JobWaitTimeoutError({ provider: "exa", jobId: "r1", timeoutMs: 10, lastStatus: "running", message: "t" }),
      ),
    ).toMatchObject({ type: "JobWaitTimeoutError", details: { job_id: "r1", retryable: true } })
  })
})
