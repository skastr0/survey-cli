import { registerContracts } from "../../core/discovery"
import {
  AgentEventsInputSchema,
  AgentListInputSchema,
  AgentStartInputSchema,
  BatchStartInputSchema,
  CrawlStartInputSchema,
  ExtractStartInputSchema,
  InteractExecuteInputSchema,
  JobCheckInputSchema,
  JobIdInputSchema,
  MapCommandInputSchema,
  ParseCommandInputSchema,
  ResearchInspectPaperCommandInputSchema,
  ResearchReadPaperCommandInputSchema,
  ResearchRelatedPapersCommandInputSchema,
  ResearchSearchPapersCommandInputSchema,
  ScrapeCommandInputSchema,
  SearchCommandInputSchema,
  WaitInputSchema,
} from "./schemas"

const JOB_ORBIT = ["check", "inspect", "wait", "errors", "cancel", "events"] as const
const AGENT_ORBIT = ["check", "inspect", "wait", "cancel", "events", "list"] as const
const EXTRACT_ORBIT = ["check", "inspect", "wait"] as const

// Placeholder job ids for orbit examples; Firecrawl job ids are UUIDs.
const BATCH_ID = "11111111-1111-1111-1111-111111111111"
const CRAWL_ID = "22222222-2222-2222-2222-222222222222"
const AGENT_ID = "33333333-3333-3333-3333-333333333333"
const EXTRACT_ID = "44444444-4444-4444-4444-444444444444"
const SCRAPE_ID = "55555555-5555-5555-5555-555555555555"

registerContracts([
  {
    command: "firecrawl scrape",
    description:
      "Scrape one URL or an ordered local batch of URL scrape objects. Formats: markdown, summary, html, rawHtml, rawBase64, links, images, branding, product, menu, audio, video plus json/screenshot/changeTracking/question/highlights options. Works without FIRECRAWL_API_KEY on the rate-limited keyless free tier; responses carry auth_mode keyed|public.",
    inputSchema: ScrapeCommandInputSchema,
    batch: true,
    examples: [
      {
        name: "markdown scrape",
        input: { url: "https://example.com", formats: ["markdown"] },
      },
      {
        name: "json extraction with screenshot",
        input: {
          url: "https://example.com",
          json_schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
          json_prompt: "Extract the page title.",
          screenshot: { fullPage: true, quality: 80 },
        },
      },
      {
        name: "ordered local batch",
        input: [
          { url: "https://example.com/a", formats: ["markdown"] },
          { url: "https://example.com/b", formats: ["summary"] },
        ],
      },
      {
        name: "product format with a question",
        input: {
          url: "https://example.com/product",
          formats: ["markdown", "product"],
          question: "What is the price?",
          only_clean_content: true,
        },
      },
    ],
  },
  {
    command: "firecrawl map",
    description: "Map a website to discovered URLs, or an ordered local batch of map objects.",
    inputSchema: MapCommandInputSchema,
    batch: true,
    examples: [
      {
        name: "map a site",
        input: { url: "https://example.com", sitemap: "include", limit: 100 },
      },
      {
        name: "map with search ranking",
        input: {
          url: "https://example.com",
          search: "blog",
          include_subdomains: true,
          ignore_query_parameters: true,
        },
      },
    ],
  },
  {
    command: "firecrawl search",
    description:
      "Search the web with Firecrawl v2, optionally scraping result pages. Accepts one object or an ordered local array. Works without FIRECRAWL_API_KEY on the rate-limited keyless free tier; responses carry auth_mode keyed|public.",
    inputSchema: SearchCommandInputSchema,
    batch: true,
    examples: [
      {
        name: "web search",
        input: { query: "firecrawl scrape api", limit: 5, sources: ["web"] },
      },
      {
        name: "search and scrape markdown",
        input: {
          query: "firecrawl changelog",
          limit: 3,
          scrape_options: { formats: ["markdown"], only_main_content: true },
        },
      },
    ],
  },
  {
    command: "firecrawl parse",
    description:
      "Parse a local file (PDF, Office, HTML, and more) through Firecrawl /v2/parse multipart upload. Accepts one object or an ordered local array. Works without FIRECRAWL_API_KEY on the rate-limited keyless free tier; responses carry auth_mode keyed|public.",
    inputSchema: ParseCommandInputSchema,
    batch: true,
    examples: [
      {
        name: "parse a PDF to markdown",
        input: { path: "./report.pdf", formats: ["markdown"], pdf_pages: true },
      },
      {
        name: "parse with JSON extraction",
        input: {
          path: "./invoice.pdf",
          json_schema: {
            type: "object",
            properties: { vendor: { type: "string" }, total: { type: "number" } },
            required: ["vendor", "total"],
          },
        },
      },
    ],
  },
  {
    command: "firecrawl batch start",
    description: "Start a Firecrawl provider-owned batch scrape job.",
    inputSchema: BatchStartInputSchema,
    orbit: JOB_ORBIT,
    examples: [
      {
        name: "provider batch scrape",
        input: {
          urls: ["https://example.com/a", "https://example.com/b"],
          formats: ["markdown"],
          max_concurrency: 2,
          ignore_invalid_urls: true,
        },
      },
    ],
  },
  {
    command: "firecrawl batch run",
    description: "Alias for firecrawl batch start.",
    inputSchema: BatchStartInputSchema,
    examples: [
      {
        name: "provider batch scrape",
        input: { urls: ["https://example.com/a", "https://example.com/b"], formats: ["markdown"] },
      },
    ],
  },
  {
    command: "firecrawl batch check",
    description: "Inspect a Firecrawl batch scrape job or next page URL.",
    inputSchema: JobCheckInputSchema,
    examples: [
      { name: "check batch", input: { id: BATCH_ID } },
      {
        name: "next results page",
        input: { id: BATCH_ID, next_url: `https://api.firecrawl.dev/v2/batch/scrape/${BATCH_ID}?skip=10` },
      },
    ],
  },
  {
    command: "firecrawl batch inspect",
    description: "Alias for firecrawl batch check with the same input contract.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "inspect batch", input: { id: BATCH_ID } }],
  },
  {
    command: "firecrawl batch wait",
    description: "Poll a Firecrawl batch scrape job until it reaches a terminal state.",
    inputSchema: WaitInputSchema,
    examples: [
      {
        name: "wait for batch",
        input: { id: "batch_123", poll_interval_ms: 2000, timeout_ms: 120000 },
      },
    ],
  },
  {
    command: "firecrawl batch errors",
    description: "Fetch Firecrawl batch scrape job errors.",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "batch errors", input: { id: BATCH_ID } }],
  },
  {
    command: "firecrawl batch cancel",
    description: "Cancel a Firecrawl batch scrape job.",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "cancel batch", input: { id: BATCH_ID } }],
  },
  {
    command: "firecrawl batch events",
    description:
      "Report Firecrawl batch event stream support. No provider event stream exists; returns supported:false with polling alternatives.",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "batch event support", input: { id: BATCH_ID } }],
  },
  {
    command: "firecrawl crawl start",
    description: "Start a Firecrawl provider-owned crawl job.",
    inputSchema: CrawlStartInputSchema,
    orbit: JOB_ORBIT,
    examples: [
      {
        name: "crawl with scrape options",
        input: {
          url: "https://example.com/docs",
          limit: 25,
          sitemap: "include",
          scrape_options: { formats: ["markdown"], only_main_content: true },
        },
      },
    ],
  },
  {
    command: "firecrawl crawl run",
    description: "Alias for firecrawl crawl start.",
    inputSchema: CrawlStartInputSchema,
    examples: [
      { name: "crawl docs", input: { url: "https://example.com/docs", limit: 25, sitemap: "include" } },
    ],
  },
  {
    command: "firecrawl crawl check",
    description: "Inspect a Firecrawl crawl job or next page URL.",
    inputSchema: JobCheckInputSchema,
    examples: [
      { name: "check crawl", input: { id: CRAWL_ID } },
      {
        name: "next results page",
        input: { id: CRAWL_ID, next_url: `https://api.firecrawl.dev/v2/crawl/${CRAWL_ID}?skip=10` },
      },
    ],
  },
  {
    command: "firecrawl crawl inspect",
    description: "Alias for firecrawl crawl check with the same input contract.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "inspect crawl", input: { id: CRAWL_ID } }],
  },
  {
    command: "firecrawl crawl wait",
    description: "Poll a Firecrawl crawl job until it reaches a terminal state.",
    inputSchema: WaitInputSchema,
    examples: [
      { name: "wait for crawl", input: { id: CRAWL_ID, poll_interval_ms: 5000, timeout_ms: 600000 } },
    ],
  },
  {
    command: "firecrawl crawl errors",
    description: "Fetch Firecrawl crawl job errors.",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "crawl errors", input: { id: CRAWL_ID } }],
  },
  {
    command: "firecrawl crawl cancel",
    description: "Cancel a Firecrawl crawl job.",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "cancel crawl", input: { id: CRAWL_ID } }],
  },
  {
    command: "firecrawl crawl events",
    description:
      "Report Firecrawl crawl event stream support. Realtime updates exist only via SDK/WebSocket watchers; returns supported:false with polling alternatives.",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "crawl event support", input: { id: CRAWL_ID } }],
  },
  {
    command: "firecrawl agent start",
    description:
      "Start a Firecrawl agent job. Successor to /extract for web-wide structured extraction.",
    inputSchema: AgentStartInputSchema,
    orbit: AGENT_ORBIT,
    examples: [
      {
        name: "prompt-only agent",
        input: { prompt: "Find the founders of Firecrawl", max_credits: 100 },
      },
      {
        name: "agent constrained to URLs",
        input: {
          prompt: "Extract product names and prices",
          urls: ["https://example.com"],
          schema: {
            type: "object",
            properties: {
              products: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, price: { type: "string" } },
                },
              },
            },
          },
          strict_constrain_to_urls: true,
        },
      },
    ],
  },
  {
    command: "firecrawl agent run",
    description: "Alias for firecrawl agent start.",
    inputSchema: AgentStartInputSchema,
    examples: [{ name: "prompt-only agent", input: { prompt: "Find the founders of Firecrawl", max_credits: 100 } }],
  },
  {
    command: "firecrawl agent check",
    description: "Inspect a Firecrawl agent job.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "check agent", input: { id: AGENT_ID } }],
  },
  {
    command: "firecrawl agent inspect",
    description: "Alias for firecrawl agent check.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "inspect agent", input: { id: AGENT_ID } }],
  },
  {
    command: "firecrawl agent wait",
    description: "Poll a Firecrawl agent job until it reaches a terminal state.",
    inputSchema: WaitInputSchema,
    examples: [
      {
        name: "wait for agent",
        input: {
          id: "11111111-1111-1111-1111-111111111111",
          poll_interval_ms: 2000,
          timeout_ms: 120000,
        },
      },
    ],
  },
  {
    command: "firecrawl agent cancel",
    description: "Cancel a Firecrawl agent job.",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "cancel agent", input: { id: AGENT_ID } }],
  },
  {
    command: "firecrawl agent events",
    description:
      "Fetch the agent execution trace snapshot (GET /agent/{id}/trace REST snapshot, not an SSE stream).",
    inputSchema: AgentEventsInputSchema,
    examples: [
      { name: "agent trace", input: { id: AGENT_ID } },
      { name: "agent trace with live view", input: { id: AGENT_ID, live_view: true } },
    ],
  },
  {
    command: "firecrawl agent list",
    description: "List recent agent runs. Pages are fixed at 20; pass before from the previous next URL.",
    inputSchema: AgentListInputSchema,
    examples: [{ name: "latest agent runs", input: {} }],
  },
  {
    command: "firecrawl extract start",
    description:
      "Start a Firecrawl /v2/extract job. Firecrawl recommends /agent for new extraction work.",
    inputSchema: ExtractStartInputSchema,
    orbit: EXTRACT_ORBIT,
    examples: [
      {
        name: "extract from known URLs",
        input: {
          urls: ["https://docs.firecrawl.dev"],
          prompt: "Extract the page title",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
    ],
  },
  {
    command: "firecrawl extract run",
    description: "Alias for firecrawl extract start.",
    inputSchema: ExtractStartInputSchema,
    examples: [
      {
        name: "extract from known URLs",
        input: {
          urls: ["https://docs.firecrawl.dev"],
          prompt: "Extract the page title",
          schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        },
      },
    ],
  },
  {
    command: "firecrawl extract check",
    description: "Inspect a Firecrawl extract job.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "check extract", input: { id: EXTRACT_ID } }],
  },
  {
    command: "firecrawl extract inspect",
    description: "Alias for firecrawl extract check.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "inspect extract", input: { id: EXTRACT_ID } }],
  },
  {
    command: "firecrawl extract wait",
    description:
      "Poll a Firecrawl extract job until it reaches a terminal state. No cancel or events endpoint exists for extract.",
    inputSchema: WaitInputSchema,
    examples: [
      { name: "wait for extract", input: { id: EXTRACT_ID, poll_interval_ms: 2000, timeout_ms: 300000 } },
    ],
  },
  {
    command: "firecrawl interact execute",
    description:
      "Execute a prompt or code in the browser session bound to a scrape job. id is data.metadata.scrapeId from a prior scrape; provide prompt or code, not both. Works without FIRECRAWL_API_KEY on the rate-limited keyless free tier; responses carry auth_mode keyed|public.",
    inputSchema: InteractExecuteInputSchema,
    orbit: ["stop"],
    examples: [
      {
        name: "prompt interaction",
        input: {
          id: "11111111-1111-1111-1111-111111111111",
          prompt: "Click the first result and extract the price",
        },
      },
      {
        name: "playwright code",
        input: {
          id: "11111111-1111-1111-1111-111111111111",
          code: "await page.title()",
          language: "node",
          timeout: 30,
        },
      },
    ],
  },
  {
    command: "firecrawl interact stop",
    description: "Stop the interactive browser session bound to a scrape job.",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "stop browser session", input: { id: SCRAPE_ID } }],
  },
  {
    command: "firecrawl research search-papers",
    description:
      "GET /search/research/papers: ranked papers (paperId, primaryId such as arxiv:<id>/pmid:<id>/pmcid:<id>/doi:<id>, ids, title, abstract, score, signals) from ~43M arXiv/PubMed/bioRxiv/medRxiv abstracts. Keyless; a key only raises rate limits. Sources are recorded under primaryId. Accepts one object or an ordered local array.",
    inputSchema: ResearchSearchPapersCommandInputSchema,
    batch: true,
    orbit: ["inspect-paper", "read-paper", "related-papers"],
    examples: [
      { name: "paper search", input: { query: "diffusion models image synthesis", k: 10 } },
      {
        name: "filtered paper search",
        input: {
          query: "protein structure prediction",
          categories: ["q-bio.BM"],
          from: "2021-01-01",
          k: 20,
        },
      },
    ],
  },
  {
    command: "firecrawl research inspect-paper",
    description:
      "GET /search/research/papers/{id}: metadata for a paperId or primaryId (title, abstract, authors, categories, createdDate, updateDate, ids). Keyless.",
    inputSchema: ResearchInspectPaperCommandInputSchema,
    batch: true,
    orbit: ["read-paper", "related-papers"],
    examples: [
      { name: "inspect by arxiv id", input: { id: "arxiv:1706.03762" } },
      { name: "inspect several", input: [{ id: "arxiv:1706.03762" }, { id: "arxiv:2105.05233" }] },
    ],
  },
  {
    command: "firecrawl research read-paper",
    description:
      "GET /search/research/papers/{id}?query=...: top full-text passages (text, score; k 1-50, default 4) answering a question. Keyless.",
    inputSchema: ResearchReadPaperCommandInputSchema,
    batch: true,
    orbit: ["inspect-paper", "related-papers"],
    examples: [
      {
        name: "read passages",
        input: { id: "arxiv:1706.03762", query: "what is the attention mechanism", k: 4 },
      },
    ],
  },
  {
    command: "firecrawl research related-papers",
    description:
      "GET /search/research/papers/{id}/similar: expand a seed paper by mode similar (co-citation and bibliographic coupling), citers, or references, ranked by intent; returns results, poolSize, truncated. Keyless.",
    inputSchema: ResearchRelatedPapersCommandInputSchema,
    batch: true,
    orbit: ["inspect-paper", "read-paper"],
    examples: [
      {
        name: "similar papers",
        input: { id: "arxiv:1706.03762", intent: "efficient transformers", mode: "similar", k: 20 },
      },
      {
        name: "citers with extra anchors",
        input: {
          id: "arxiv:2006.11239",
          intent: "faster diffusion sampling",
          mode: "citers",
          anchor: ["arxiv:2105.05233"],
          rerank: true,
        },
      },
    ],
  },
])
