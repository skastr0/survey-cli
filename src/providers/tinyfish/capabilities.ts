import { registerContracts } from "../../core/discovery"
import {
  AgentListInputSchema,
  AgentCheckInputSchema,
  AgentRunIdInputSchema,
  AgentRunInputSchema,
  AgentRunRefInputSchema,
  AgentStartInputSchema,
  AgentStreamInputSchema,
  AgentWaitInputSchema,
  BrowserCreateInputSchema,
  BrowserListInputSchema,
  BrowserSessionIdInputSchema,
  EmptyInputSchema,
  FetchCommandInputSchema,
  MonitorCreateInputSchema,
  MonitorIdInputSchema,
  MonitorUpdateInputSchema,
  ProfileCreateInputSchema,
  ProfileIdInputSchema,
  ProfileUpdateInputSchema,
  ResearchEventsInputSchema,
  ResearchIdInputSchema,
  ResearchListInputSchema,
  ResearchRunInputSchema,
  ResearchStartInputSchema,
  ResearchWaitInputSchema,
  SearchInputSchema,
  UsageInputSchema,
} from "./schemas"

const AGENT_ORBIT = ["check", "inspect", "wait", "cancel", "list", "events"] as const
const RESEARCH_ORBIT = ["check", "inspect", "wait", "events", "cancel", "list"] as const
const MONITOR_ORBIT = ["inspect", "update", "trigger", "delete", "events"] as const
const BROWSER_ORBIT = ["inspect", "close"] as const

const RUN_ID = "tf_run_abc123"
const RESEARCH_ID = "11111111-1111-1111-1111-111111111111"

registerContracts([
  {
    command: "tinyfish search",
    description:
      "Live Google-index web search (GET https://api.search.tinyfish.ai). Free 12,000 requests/day on a keyed account, 30/min. include_domains/exclude_domains accept a comma-separated string or an array. Accepts one object or an ordered local array.",
    inputSchema: SearchInputSchema,
    batch: true,
    examples: [
      { name: "web search", input: { query: "effect typescript schema", location: "US", language: "en" } },
      {
        name: "news in the last day",
        input: { query: "browser automation funding", domain_type: "news", recency_minutes: 1440 },
      },
      {
        name: "research papers by year",
        input: { query: "web agents benchmark", domain_type: "research_paper", pub_year_min: 2024 },
      },
      { name: "domain filter", input: { query: "release notes", include_domains: ["github.com", "bun.sh"] } },
    ],
  },
  {
    command: "tinyfish fetch",
    description:
      "Fetch 1-10 URLs in parallel (POST https://api.fetch.tinyfish.ai) as markdown (default), html, or a json document tree. Per-URL failures land in errors[]. Free 1,000 URLs/day on a keyed account. markdown/html results are kept in the local corpus (kind web; store:false opts out, tags labels them).",
    inputSchema: FetchCommandInputSchema,
    batch: true,
    examples: [
      { name: "markdown", input: { urls: ["https://example.com"] } },
      { name: "no corpus write", input: { urls: ["https://example.com"], store: false } },
      {
        name: "links and metadata",
        input: { urls: ["https://example.com", "https://example.org"], links: true, page_metadata: true },
      },
      {
        name: "selector scoped",
        input: { urls: ["https://example.com/docs"], include_selectors: ["main"], exclude_selectors: ["nav"], ttl: 0 },
      },
    ],
  },
  {
    command: "tinyfish usage",
    description: "Paged usage history for one product: search, fetch, or browser (GET <product host>/usage).",
    inputSchema: UsageInputSchema,
    examples: [
      { name: "recent searches", input: { product: "search", limit: 20 } },
      { name: "failed fetches", input: { product: "fetch", status: "failed" } },
    ],
  },
  {
    command: "tinyfish wallet",
    description: "Wallet balance, auto-reload state, and metered rates (GET /v1/wallet). Input optional.",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "balance", input: {} }],
  },
  {
    command: "tinyfish browser create",
    description:
      "Create a remote browser session (POST https://api.browser.tinyfish.ai). Returns session_id, cdp_url (wss, for Playwright/Puppeteer connectOverCDP), base_url. Billed per browser-minute. Input optional.",
    inputSchema: BrowserCreateInputSchema,
    orbit: BROWSER_ORBIT,
    examples: [
      { name: "blank session", input: {} },
      {
        name: "start url with proxy",
        input: { url: "https://example.com", timeout_seconds: 600, proxy_config: { enabled: true, country_code: "GB" } },
      },
    ],
  },
  {
    command: "tinyfish browser inspect",
    description: "Inspect one session from the usage log (TinyFish has no get-session endpoint).",
    inputSchema: BrowserSessionIdInputSchema,
    examples: [{ name: "inspect", input: { session_id: "sess_abc123" } }],
  },
  {
    command: "tinyfish browser list",
    description: "List browser sessions (GET /usage). Input optional.",
    inputSchema: BrowserListInputSchema,
    examples: [{ name: "running sessions", input: { status: "running" } }],
  },
  {
    command: "tinyfish browser close",
    description: "Close a browser session (DELETE /{session_id}, idempotent 204).",
    inputSchema: BrowserSessionIdInputSchema,
    examples: [{ name: "close", input: { session_id: "sess_abc123" } }],
  },
  {
    command: "tinyfish agent start",
    description:
      "Start async goal-based web automation runs (POST /v1/automation/run-async). Billed per step. Accepts one object or an ordered local array; each run is recorded in the run registry.",
    inputSchema: AgentStartInputSchema,
    batch: true,
    orbit: AGENT_ORBIT,
    examples: [
      { name: "extract with goal", input: { url: "https://news.ycombinator.com", goal: "Return the top 5 story titles as JSON" } },
      {
        name: "structured output, stealth",
        input: {
          url: "https://example.com/pricing",
          goal: "Extract every plan name and monthly price",
          browser_profile: "stealth",
          agent_config: { max_steps: 40 },
          output_schema: {
            type: "object",
            properties: {
              plans: {
                type: "array",
                items: { type: "object", properties: { name: { type: "string" }, price: { type: "string" } } },
              },
            },
          },
        },
      },
    ],
  },
  {
    command: "tinyfish agent run",
    description: "Start an async run and poll GET /v1/runs/{id} until terminal or max_wait_seconds (default 300).",
    inputSchema: AgentRunInputSchema,
    examples: [
      {
        name: "run and wait",
        input: { url: "https://example.com", goal: "What is the page heading?", max_wait_seconds: 180, poll_interval_seconds: 5 },
      },
    ],
  },
  {
    command: "tinyfish agent stream",
    description:
      "Run via POST /v1/automation/run-sse and collect STARTED/STREAMING_URL/PROGRESS/COMPLETE events until COMPLETE or max_wait_seconds.",
    inputSchema: AgentStreamInputSchema,
    examples: [
      { name: "stream a run", input: { url: "https://example.com", goal: "Find the contact email", max_wait_seconds: 120 } },
    ],
  },
  {
    command: "tinyfish agent check",
    description:
      "Get a run's status and result; terminal runs update the local run registry. COMPLETED results are kept in the local corpus as tinyfish://agent/runs/<run_id> (kind agent; store:false opts out). Same for agent run/wait/stream.",
    inputSchema: AgentCheckInputSchema,
    examples: [
      { name: "check", input: { run_id: RUN_ID } },
      { name: "check, tag the stored result", input: { run_id: RUN_ID, tags: ["pricing"] } },
    ],
  },
  {
    command: "tinyfish agent inspect",
    description: "Raw run detail (GET /v1/runs/{id}) including steps, screenshots, and video_url.",
    inputSchema: AgentRunIdInputSchema,
    examples: [{ name: "inspect without screenshots", input: { run_id: RUN_ID, screenshots: "none", html: "none" } }],
  },
  {
    command: "tinyfish agent wait",
    description: "Poll an existing run until COMPLETED/FAILED/CANCELLED or max_wait_seconds; returns timed_out:true otherwise.",
    inputSchema: AgentWaitInputSchema,
    examples: [{ name: "wait", input: { run_id: RUN_ID, max_wait_seconds: 300, poll_interval_seconds: 5 } }],
  },
  {
    command: "tinyfish agent cancel",
    description: "Cancel an async or SSE run (POST /v1/runs/{id}/cancel). Sync runs cannot be cancelled.",
    inputSchema: AgentRunRefInputSchema,
    examples: [{ name: "cancel", input: { run_id: RUN_ID } }],
  },
  {
    command: "tinyfish agent list",
    description: "List runs (GET /v1/runs) with status/goal/date filters and cursor pagination. Input optional.",
    inputSchema: AgentListInputSchema,
    examples: [
      { name: "recent", input: { limit: 10 } },
      { name: "failed runs", input: { status: "FAILED", sort_direction: "desc" } },
    ],
  },
  {
    command: "tinyfish agent events",
    description:
      "Report run-events support. TinyFish has no run-events endpoint; returns supported:false pointing at agent stream and webhooks.",
    inputSchema: AgentRunRefInputSchema,
    examples: [{ name: "events", input: { run_id: RUN_ID } }],
  },
  {
    command: "tinyfish profiles list",
    description: "List Browser Context Profiles (GET /v1/profiles). Input optional.",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "list", input: {} }],
  },
  {
    command: "tinyfish profiles create",
    description: "Create a Browser Context Profile; pass profile_id + use_profile:true to agent runs to reuse sign-ins.",
    inputSchema: ProfileCreateInputSchema,
    examples: [{ name: "default profile", input: { name: "research", set_as_default: true, proxy_country_code: "US" } }],
  },
  {
    command: "tinyfish profiles inspect",
    description: "Get a profile with its stored domains.",
    inputSchema: ProfileIdInputSchema,
    examples: [{ name: "inspect", input: { profile_id: "prof_abc123" } }],
  },
  {
    command: "tinyfish profiles update",
    description: "Rename a profile, set it as default, or change its proxy country (PATCH /v1/profiles/{id}).",
    inputSchema: ProfileUpdateInputSchema,
    examples: [{ name: "rename", input: { profile_id: "prof_abc123", name: "work" } }],
  },
  {
    command: "tinyfish profiles delete",
    description: "Delete a profile (DELETE /v1/profiles/{id}).",
    inputSchema: ProfileIdInputSchema,
    examples: [{ name: "delete", input: { profile_id: "prof_abc123" } }],
  },
  {
    command: "tinyfish vault connections",
    description: "List connected password-manager vaults (1Password, Bitwarden). Input optional.",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "list", input: {} }],
  },
  {
    command: "tinyfish vault items",
    description: "List vault credential items (metadata only; use itemId in agent credential_item_ids). Input optional.",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "list", input: {} }],
  },
  {
    command: "tinyfish vault sync",
    description: "Re-sync vault items from connected providers (POST /v1/vault/items/sync). Input optional.",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "sync", input: {} }],
  },
  {
    command: "tinyfish research start",
    description:
      "Start a Research API (beta) run (POST /v1/automation/run-research-async): plan, search, fetch, evaluate, cited report. deep = 5-20 min, max = 5-45 min. Beta cap: 5 concurrent and 5 per Pacific day. Not idempotent.",
    inputSchema: ResearchStartInputSchema,
    orbit: RESEARCH_ORBIT,
    examples: [
      { name: "deep research", input: { query: "State of open-source browser agents in 2026", mode: "deep" } },
      {
        name: "restricted domains, recent",
        input: {
          query: "Bun runtime production adoption",
          recency_minutes: 43200,
          domain_filter: { mode: "exclusive", domains: ["bun.sh", "github.com"] },
        },
      },
    ],
  },
  {
    command: "tinyfish research run",
    description: "Start a research run and poll until terminal or max_wait_seconds (default 1800).",
    inputSchema: ResearchRunInputSchema,
    examples: [{ name: "run and wait", input: { query: "Compare TinyFish and Firecrawl fetch APIs", max_wait_seconds: 1800 } }],
  },
  {
    command: "tinyfish research check",
    description: "Get status; when COMPLETED returns report (deep_result.result) and citations (URL strings).",
    inputSchema: ResearchIdInputSchema,
    examples: [{ name: "check", input: { research_run_id: RESEARCH_ID } }],
  },
  {
    command: "tinyfish research inspect",
    description: "Raw research run (research_plan, evidence with claims, iterations).",
    inputSchema: ResearchIdInputSchema,
    examples: [{ name: "inspect", input: { research_run_id: RESEARCH_ID } }],
  },
  {
    command: "tinyfish research wait",
    description: "Poll an existing research run until terminal or max_wait_seconds; returns timed_out:true otherwise.",
    inputSchema: ResearchWaitInputSchema,
    examples: [{ name: "wait", input: { research_run_id: RESEARCH_ID, max_wait_seconds: 1200, poll_interval_seconds: 15 } }],
  },
  {
    command: "tinyfish research events",
    description:
      "Read the run's SSE stream (GET /v1/research-run/{id}/events) for up to max_wait_seconds (default 30). Disconnecting never cancels the run; resume with last_event_id.",
    inputSchema: ResearchEventsInputSchema,
    examples: [
      { name: "tail events", input: { research_run_id: RESEARCH_ID, max_wait_seconds: 20 } },
      { name: "resume", input: { research_run_id: RESEARCH_ID, last_event_id: "42" } },
    ],
  },
  {
    command: "tinyfish research cancel",
    description: "Cancel a research run (idempotent).",
    inputSchema: ResearchIdInputSchema,
    examples: [{ name: "cancel", input: { research_run_id: RESEARCH_ID } }],
  },
  {
    command: "tinyfish research list",
    description: "List research runs with cursor pagination. Input optional.",
    inputSchema: ResearchListInputSchema,
    examples: [{ name: "completed", input: { status: "COMPLETED", limit: 10 } }],
  },
  {
    command: "tinyfish monitor create",
    description:
      "Create a Page (type=fetch, config.url) or Topic (type=search, config.query) monitor on a 5-field cron (UTC unless CRON_TZ=<IANA> prefix). A baseline run executes immediately. Max 50 per account; topic runs at least 30 min apart.",
    inputSchema: MonitorCreateInputSchema,
    orbit: MONITOR_ORBIT,
    examples: [
      {
        name: "page monitor",
        input: {
          type: "fetch",
          config: { url: "https://example.com/pricing", format: "markdown" },
          schedule_cron: "0 9 * * *",
          name: "pricing page",
          purpose: "Alert when plan prices change",
        },
      },
      {
        name: "topic monitor",
        input: {
          type: "search",
          config: { query: "tinyfish api launch", recency_minutes: 1440, result_limit: 10 },
          schedule_cron: "CRON_TZ=America/New_York 0 */6 * * *",
          webhook_url: "https://example.com/hooks/tinyfish",
        },
      },
    ],
  },
  {
    command: "tinyfish monitor list",
    description: "List monitors. Input optional.",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "list", input: {} }],
  },
  {
    command: "tinyfish monitor inspect",
    description: "Get one monitor.",
    inputSchema: MonitorIdInputSchema,
    examples: [{ name: "inspect", input: { id: "mon_abc123" } }],
  },
  {
    command: "tinyfish monitor update",
    description:
      "Either status-only {id, status: active|paused} or edits {id, schedule_cron?, name?, purpose?, webhook_url?} (null clears). type/config are immutable.",
    inputSchema: MonitorUpdateInputSchema,
    examples: [
      { name: "pause", input: { id: "mon_abc123", status: "paused" } },
      { name: "reschedule", input: { id: "mon_abc123", schedule_cron: "0 */2 * * *" } },
    ],
  },
  {
    command: "tinyfish monitor delete",
    description: "Delete a monitor.",
    inputSchema: MonitorIdInputSchema,
    examples: [{ name: "delete", input: { id: "mon_abc123" } }],
  },
  {
    command: "tinyfish monitor trigger",
    description: "Run a monitor now (POST /v1/monitors/{id}/runs). Topic monitors may return 409 RETRY_REQUIRED.",
    inputSchema: MonitorIdInputSchema,
    examples: [{ name: "run now", input: { id: "mon_abc123" } }],
  },
  {
    command: "tinyfish monitor events",
    description:
      "Report run-history support. TinyFish has no REST run-history endpoint; returns supported:false pointing at webhooks and trigger.",
    inputSchema: MonitorIdInputSchema,
    examples: [{ name: "events", input: { id: "mon_abc123" } }],
  },
])
