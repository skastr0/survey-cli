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
      "Scrape one URL (or an ordered local batch) via POST /scrape. Input: {url, formats?, only_main_content?, json_schema?, screenshot?, question?}. Returns page content plus metadata. Keyless free tier works.",
    output:
      "Raw provider payload { success, data{ markdown?, html?, json?, links?, screenshot?, metadata{ sourceURL, statusCode, scrapeId } }, auth_mode: keyed|public }. Array input returns { outcome, total, success_count, error_count, concurrency, results[{ index, ok, target, data|error }] }.",
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
    description:
      "Map a website to discovered URLs via POST /map, or an ordered local batch. Input: {url, search?, sitemap?, include_subdomains?, limit?}. Returns the discovered links.",
    output:
      "Raw provider payload { success, links[{ url, title? }] }. Array input returns { outcome, total, success_count, error_count, concurrency, results[{ index, ok, target, data|error }] }.",
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
      "Search the web via POST /search, optionally scraping result pages. Input: {query, limit?, sources?, scrape_options?}. Returns results grouped by source. Keyless free tier works.",
    output:
      "Raw provider payload { success, data{ web?[{ url, title, ... }], news?, images? }, auth_mode: keyed|public }. Array input returns { outcome, total, success_count, error_count, concurrency, results[{ index, ok, target, data|error }] }.",
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
      "Parse a local file (PDF, Office, HTML, ...) via /v2/parse multipart upload. Input: {path, formats?, json_schema?, pdf_*?}. Returns parsed document content. Keyless free tier works.",
    output:
      "Raw provider payload { success, data{ markdown?, json?, ... }, auth_mode: keyed|public }. Array input returns { outcome, total, success_count, error_count, concurrency, results[{ index, ok, target, data|error }] }.",
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
    description:
      "Start a provider-owned batch scrape job (POST /batch/scrape). Input: {urls, formats?, max_concurrency?, webhook?}. Returns a submitted job snapshot whose id feeds batch check/wait.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } with kind batch_scrape, status submitted; provider_response is { success, id }.",
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
    description:
      "Alias for firecrawl batch start: start a provider-owned batch scrape job. Input: {urls, formats?, max_concurrency?}. Returns a submitted job snapshot with id.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } with kind batch_scrape, status submitted.",
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
    description:
      "Check a batch scrape job by id (GET /batch/scrape/{id}), or fetch a results page via next_url. Input: {id, next_url?}. Returns a normalized status snapshot with scraped pages.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response }; provider_response is { status, completed, total, creditsUsed, expiresAt, next?, data[{ markdown?, metadata? }] }.",
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
    description:
      "Alias for firecrawl batch check: snapshot a batch scrape job by id. Input: {id, next_url?}. Returns normalized status, progress and the provider response.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response }.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "inspect batch", input: { id: BATCH_ID } }],
  },
  {
    command: "firecrawl batch wait",
    description:
      "Poll a batch scrape job by id until terminal. Input: {id, poll_interval_ms?, timeout_ms?}. Returns the final job snapshot plus waited_ms; fails with a timeout error otherwise.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } plus waited_ms, poll_interval_ms.",
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
    description:
      "Fetch per-URL errors of a batch scrape job (GET /batch/scrape/{id}/errors). Input: {id}. Returns error and robots-blocked counts plus the provider response.",
    output:
      "{ provider, kind: batch_scrape, id, errors_count?, robots_blocked_count?, provider_response{ errors[], robotsBlocked[] } }",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "batch errors", input: { id: BATCH_ID } }],
  },
  {
    command: "firecrawl batch cancel",
    description:
      "Cancel a batch scrape job (DELETE /batch/scrape/{id}). Input: {id}. Returns a canceled terminal snapshot.",
    output:
      "{ provider, kind: batch_scrape, id, status: canceled, terminal: true, provider_response }",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "cancel batch", input: { id: BATCH_ID } }],
  },
  {
    command: "firecrawl batch events",
    description:
      "Report batch event stream support for a job id. Input: {id}. No provider event stream exists (polling only); returns supported:false with polling alternatives.",
    output:
      "{ provider, kind: batch_scrape, id, capability, supported: false, reason, alternatives[] }",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "batch event support", input: { id: BATCH_ID } }],
  },
  {
    command: "firecrawl crawl start",
    description:
      "Start a provider-owned crawl job (POST /crawl). Input: {url, limit?, include_paths?, exclude_paths?, sitemap?, scrape_options?}. Returns a submitted job snapshot whose id feeds crawl check/wait.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } with kind crawl, status submitted; provider_response is { success, id }.",
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
    description:
      "Alias for firecrawl crawl start: start a provider-owned crawl job. Input: {url, limit?, sitemap?, scrape_options?}. Returns a submitted job snapshot with id.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } with kind crawl, status submitted.",
    inputSchema: CrawlStartInputSchema,
    examples: [
      { name: "crawl docs", input: { url: "https://example.com/docs", limit: 25, sitemap: "include" } },
    ],
  },
  {
    command: "firecrawl crawl check",
    description:
      "Check a crawl job by id (GET /crawl/{id}), or fetch a results page via next_url. Input: {id, next_url?}. Returns a normalized status snapshot with crawled pages.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response }; provider_response is { status, completed, total, creditsUsed, expiresAt, next?, data[{ markdown?, metadata? }] }.",
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
    description:
      "Alias for firecrawl crawl check: snapshot a crawl job by id. Input: {id, next_url?}. Returns normalized status, progress and the provider response.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response }.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "inspect crawl", input: { id: CRAWL_ID } }],
  },
  {
    command: "firecrawl crawl wait",
    description:
      "Poll a crawl job by id until terminal. Input: {id, poll_interval_ms?, timeout_ms?}. Returns the final job snapshot plus waited_ms; fails with a timeout error otherwise.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } plus waited_ms, poll_interval_ms.",
    inputSchema: WaitInputSchema,
    examples: [
      { name: "wait for crawl", input: { id: CRAWL_ID, poll_interval_ms: 5000, timeout_ms: 600000 } },
    ],
  },
  {
    command: "firecrawl crawl errors",
    description:
      "Fetch per-URL errors of a crawl job (GET /crawl/{id}/errors). Input: {id}. Returns error and robots-blocked counts plus the provider response.",
    output:
      "{ provider, kind: crawl, id, errors_count?, robots_blocked_count?, provider_response{ errors[], robotsBlocked[] } }",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "crawl errors", input: { id: CRAWL_ID } }],
  },
  {
    command: "firecrawl crawl cancel",
    description:
      "Cancel a crawl job (DELETE /crawl/{id}). Input: {id}. Returns a canceled terminal snapshot.",
    output:
      "{ provider, kind: crawl, id, status: canceled, terminal: true, provider_response }",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "cancel crawl", input: { id: CRAWL_ID } }],
  },
  {
    command: "firecrawl crawl events",
    description:
      "Report crawl event stream support for a job id. Input: {id}. Realtime updates exist only via SDK/WebSocket watchers (polling only here); returns supported:false with alternatives.",
    output:
      "{ provider, kind: crawl, id, capability, supported: false, reason, alternatives[] }",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "crawl event support", input: { id: CRAWL_ID } }],
  },
  {
    command: "firecrawl agent start",
    description:
      "Start an agent job (POST /agent), successor to /extract for web-wide structured extraction. Input: {prompt, urls?, schema?, max_credits?, model?}. Returns a submitted job snapshot with id.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } with kind agent, status submitted; provider_response is { success, id }.",
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
    description:
      "Alias for firecrawl agent start: start an agent extraction job. Input: {prompt, urls?, schema?, max_credits?}. Returns a submitted job snapshot with id.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } with kind agent, status submitted.",
    inputSchema: AgentStartInputSchema,
    examples: [{ name: "prompt-only agent", input: { prompt: "Find the founders of Firecrawl", max_credits: 100 } }],
  },
  {
    command: "firecrawl agent check",
    description:
      "Check an agent job by id (GET /agent/{id}). Input: {id}. Returns a normalized status snapshot; provider_response holds the extracted data once completed.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response }; provider_response is { success, status, data?, creditsUsed?, expiresAt? }.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "check agent", input: { id: AGENT_ID } }],
  },
  {
    command: "firecrawl agent inspect",
    description:
      "Alias for firecrawl agent check: snapshot an agent job by id. Input: {id}. Returns normalized status, credits used and the provider response.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response }.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "inspect agent", input: { id: AGENT_ID } }],
  },
  {
    command: "firecrawl agent wait",
    description:
      "Poll an agent job by id until terminal. Input: {id, poll_interval_ms?, timeout_ms?}. Returns the final job snapshot plus waited_ms; fails with a timeout error otherwise.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } plus waited_ms, poll_interval_ms.",
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
    description:
      "Cancel an agent job (DELETE /agent/{id}). Input: {id}. Returns a canceled terminal snapshot.",
    output:
      "{ provider, kind: agent, id, status: canceled, terminal: true, provider_response }",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "cancel agent", input: { id: AGENT_ID } }],
  },
  {
    command: "firecrawl agent events",
    description:
      "Fetch an agent job's execution trace by id (GET /agent/{id}/trace REST snapshot, not an SSE stream). Input: {id, live_view?}. Returns the trace in provider_response.",
    output:
      "{ provider, kind: agent, id, capability, supported: true, transport: rest-trace, notes[], provider_response{ events[] } }",
    inputSchema: AgentEventsInputSchema,
    examples: [
      { name: "agent trace", input: { id: AGENT_ID } },
      { name: "agent trace with live view", input: { id: AGENT_ID, live_view: true } },
    ],
  },
  {
    command: "firecrawl agent list",
    description:
      "List recent agent runs (GET /agent). Input: {before?}; pages are fixed at 20, pass before from the previous next URL. Returns the raw provider listing.",
    output:
      "Raw provider payload { success, runs[], next }.",
    inputSchema: AgentListInputSchema,
    examples: [{ name: "latest agent runs", input: {} }],
  },
  {
    command: "firecrawl extract start",
    description:
      "Start a /v2/extract job (Firecrawl recommends agent for new work). Input: {urls?, prompt?, schema?, enable_web_search?}. Returns a submitted job snapshot whose id feeds extract check/wait.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } with kind extract, status submitted; provider_response is { success, id }.",
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
    description:
      "Alias for firecrawl extract start: start a /v2/extract job. Input: {urls?, prompt?, schema?}. Returns a submitted job snapshot with id.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } with kind extract, status submitted.",
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
    description:
      "Check an extract job by id (GET /extract/{id}). Input: {id}. Returns a normalized status snapshot; provider_response.data holds the extracted object once completed.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response }; provider_response is { success, status, data?, expiresAt? }.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "check extract", input: { id: EXTRACT_ID } }],
  },
  {
    command: "firecrawl extract inspect",
    description:
      "Alias for firecrawl extract check: snapshot an extract job by id. Input: {id}. Returns normalized status and the provider response with extracted data.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response }.",
    inputSchema: JobCheckInputSchema,
    examples: [{ name: "inspect extract", input: { id: EXTRACT_ID } }],
  },
  {
    command: "firecrawl extract wait",
    description:
      "Poll an extract job by id until terminal. Input: {id, poll_interval_ms?, timeout_ms?}. Returns the final snapshot plus waited_ms. No cancel or events endpoint exists for extract.",
    output:
      "Job snapshot { provider, kind, id, status, provider_status?, terminal, progress?{ completed, total, credits_used }, next_url?, expires_at?, data_count?, provider_response } plus waited_ms, poll_interval_ms.",
    inputSchema: WaitInputSchema,
    examples: [
      { name: "wait for extract", input: { id: EXTRACT_ID, poll_interval_ms: 2000, timeout_ms: 300000 } },
    ],
  },
  {
    command: "firecrawl interact execute",
    description:
      "Run a prompt or code in the browser session of a scrape job. Input: {id (data.metadata.scrapeId), prompt xor code, language?, timeout?}. Returns the provider result. Keyless free tier works.",
    output:
      "Raw provider payload { success, output?, ... } plus auth_mode: keyed|public.",
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
    description:
      "Stop the interactive browser session bound to a scrape job (DELETE /scrape/{id}/interact). Input: {id} (data.metadata.scrapeId). Returns a stopped marker.",
    output:
      "{ provider, kind: interact, id, stopped: true, provider_response }",
    inputSchema: JobIdInputSchema,
    examples: [{ name: "stop browser session", input: { id: SCRAPE_ID } }],
  },
  {
    command: "firecrawl research search-papers",
    description:
      "Search ~43M arXiv/PubMed/bioRxiv/medRxiv abstracts (GET /search/research/papers). Input: {query, k?, authors?, categories?, from?, to?}. Returns ranked papers. Keyless; batch-capable.",
    output:
      "Raw provider payload { results[{ paperId, primaryId?, ids?, title, abstract, score, signals? }], auth_mode }; primaryId (arxiv:/pmid:/pmcid:/doi:) is recorded as the source. Array input returns { outcome, total, success_count, error_count, concurrency, results[{ index, ok, target, data|error }] }.",
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
      "Get paper metadata by paperId or primaryId (GET /search/research/papers/{id}). Input: {id} e.g. arxiv:1706.03762. Returns title, abstract, authors, categories, dates, ids. Keyless.",
    output:
      "Raw provider payload with paper metadata (paperId, title, abstract, authors, categories, createdDate, updateDate, ids) plus auth_mode. Array input returns { outcome, total, success_count, error_count, concurrency, results[{ index, ok, target, data|error }] }.",
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
      "Read the top full-text passages of a paper answering a question (GET /search/research/papers/{id}?query=). Input: {id, query, k? 1-50, default 4}. Keyless.",
    output:
      "Raw provider payload { paperId, query, paper{ paperId, title, abstract }, passages[{ text, score }], auth_mode }. Array input returns { outcome, total, success_count, error_count, concurrency, results[{ index, ok, target, data|error }] }.",
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
      "Expand a seed paper (GET /search/research/papers/{id}/similar). Input: {id, intent, mode? similar|citers|references, k?, anchor?, rerank?}. Returns papers ranked by intent. Keyless.",
    output:
      "Raw provider payload { results[{ paperId, primaryId?, title, abstract, score }], poolSize, truncated, auth_mode }. Array input returns { outcome, total, success_count, error_count, concurrency, results[{ index, ok, target, data|error }] }.",
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
