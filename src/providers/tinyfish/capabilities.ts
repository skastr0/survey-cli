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
      "Live Google-index web search (GET api.search.tinyfish.ai; free 12,000/day, 30/min). Input: {query, location?, language?, include_domains?, domain_type?, recency_minutes?, page?}; object or array. Returns ranked results.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results: [{ index, ok, data | error }] }; each data is the raw provider response { query, results: [{ position?, site_name?, title, url, snippet? }], total_results?, page? }.",
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
      "Fetch 1-10 URLs (POST api.fetch.tinyfish.ai; free 1,000/day) as markdown, html, or json tree. Input: {urls, format?, links?, page_metadata?, store?, tags?}; object or array. Returns per-URL results/errors; text kept in corpus.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results: [{ index, ok, data | error }] }; each data is { results: [{ url, final_url?, title?, format?, text? }], errors?: [{ url, error }], corpus?: [{ url, id, version, changed, created }] } (corpus omitted when store:false).",
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
    description:
      "Paged usage history for one product (GET <product host>/usage). Input: {product: search|fetch|browser, status?, start_after?, end_before?, limit?, page?, session_id? (browser only)}. Returns the raw usage page.",
    output:
      "Raw provider usage page (JSON object passed through, fields not modeled); entries under items[].",
    inputSchema: UsageInputSchema,
    examples: [
      { name: "recent searches", input: { product: "search", limit: 20 } },
      { name: "failed fetches", input: { product: "fetch", status: "failed" } },
    ],
  },
  {
    command: "tinyfish wallet",
    description:
      "Wallet balance, auto-reload state, and metered rates (GET /v1/wallet). Input optional: {}. Returns the raw wallet object.",
    output:
      "Raw provider wallet object { ...provider fields } from GET /v1/wallet (passed through, not modeled).",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "balance", input: {} }],
  },
  {
    command: "tinyfish browser create",
    description:
      "Create a remote CDP browser session (POST api.browser.tinyfish.ai; billed per browser-minute). Input optional: {url?, timeout_seconds?, proxy_config?}. Returns session_id, cdp_url (wss, for connectOverCDP), base_url.",
    output:
      "{ session_id, cdp_url, base_url, ...provider fields, next_actions: { inspect, close } }",
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
    description:
      "Inspect one browser session by session_id via the usage log (TinyFish has no get-session endpoint). Input: {session_id}. Returns the matching usage entry or null.",
    output:
      "{ session_id, session: first usage item for that session | null, source: \"GET /usage?session_id\" }",
    inputSchema: BrowserSessionIdInputSchema,
    examples: [{ name: "inspect", input: { session_id: "sess_abc123" } }],
  },
  {
    command: "tinyfish browser list",
    description:
      "List browser sessions (GET api.browser.tinyfish.ai/usage). Input optional: {status?: running|ended, start_after?, end_before?, limit?, page?}. Returns the raw usage page.",
    output:
      "Raw provider usage page (JSON object passed through, fields not modeled); sessions under items[].",
    inputSchema: BrowserListInputSchema,
    examples: [{ name: "running sessions", input: { status: "running" } }],
  },
  {
    command: "tinyfish browser close",
    description:
      "Close a browser session by session_id (DELETE /{session_id}, idempotent 204). Input: {session_id}. Returns a close confirmation.",
    output:
      "{ session_id, closed: true }",
    inputSchema: BrowserSessionIdInputSchema,
    examples: [{ name: "close", input: { session_id: "sess_abc123" } }],
  },
  {
    command: "tinyfish agent start",
    description:
      "Start async goal-based browser-agent runs (POST /v1/automation/run-async; billed per step). Input: {url, goal, browser_profile?, output_schema?}; object or array. Returns a run_id per run, recorded in the run registry.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results: [{ index, ok, data | error }] }; each data is { run_id, status: \"PENDING\", lifecycle: { provider_async, supported_actions, unsupported_actions }, next_actions }.",
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
    description:
      "Start an async browser-agent run and poll GET /v1/runs/{id} until terminal or max_wait_seconds (default 300). Input: {url, goal, max_wait_seconds?, store?}. Returns the run with status and result.",
    output:
      "{ completed, terminal, run_id, status, result, error, run, timed_out, corpus?, next_action?, next_actions? }; run is the raw GET /v1/runs/{id} payload, next_action* only while not terminal.",
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
      "Run via POST /v1/automation/run-sse and collect STARTED/STREAMING_URL/PROGRESS/COMPLETE events until COMPLETE or max_wait_seconds. Input: {url, goal, max_wait_seconds?}. Returns status, result, and events.",
    output:
      "{ run_id | null, status, completed, result, error, timed_out, event_count, events: [raw SSE data], next_action? (no COMPLETE seen), corpus? }",
    inputSchema: AgentStreamInputSchema,
    examples: [
      { name: "stream a run", input: { url: "https://example.com", goal: "Find the contact email", max_wait_seconds: 120 } },
    ],
  },
  {
    command: "tinyfish agent check",
    description:
      "Get a run's status and result by run_id. Terminal runs update the run registry; COMPLETED results are stored in the corpus as tinyfish://agent/runs/<run_id> (store:false opts out). Input: {run_id, tags?}.",
    output:
      "{ completed, terminal, run_id, status, result, error, run, corpus?: { id, version, changed, created }, next_action?, next_actions? }; run is the raw GET /v1/runs/{id} payload, next_action* only while not terminal.",
    inputSchema: AgentCheckInputSchema,
    examples: [
      { name: "check", input: { run_id: RUN_ID } },
      { name: "check, tag the stored result", input: { run_id: RUN_ID, tags: ["pricing"] } },
    ],
  },
  {
    command: "tinyfish agent inspect",
    description:
      "Raw run detail by run_id (GET /v1/runs/{id}) including steps, screenshots, and video_url. Input: {run_id, screenshots?: base64|url|none, html?: url|none}. Returns the provider run object.",
    output:
      "Raw provider run { run_id, status, ...passthrough provider fields such as result and error }.",
    inputSchema: AgentRunIdInputSchema,
    examples: [{ name: "inspect without screenshots", input: { run_id: RUN_ID, screenshots: "none", html: "none" } }],
  },
  {
    command: "tinyfish agent wait",
    description:
      "Poll an existing run by run_id until COMPLETED/FAILED/CANCELLED or max_wait_seconds (default 300). Input: {run_id, max_wait_seconds?, poll_interval_seconds?}. Returns the run snapshot; timed_out:true if not terminal.",
    output:
      "{ completed, terminal, run_id, status, result, error, run, timed_out, corpus?, next_action?, next_actions? }; run is the raw GET /v1/runs/{id} payload, next_action* only while not terminal.",
    inputSchema: AgentWaitInputSchema,
    examples: [{ name: "wait", input: { run_id: RUN_ID, max_wait_seconds: 300, poll_interval_seconds: 5 } }],
  },
  {
    command: "tinyfish agent cancel",
    description:
      "Cancel an async or SSE run by run_id (POST /v1/runs/{id}/cancel); sync runs cannot be cancelled. Input: {run_id}. Returns the run's new status.",
    output:
      "Raw provider response { run_id, status, ...provider fields }.",
    inputSchema: AgentRunRefInputSchema,
    examples: [{ name: "cancel", input: { run_id: RUN_ID } }],
  },
  {
    command: "tinyfish agent list",
    description:
      "List runs (GET /v1/runs) with status/goal/date filters and cursor pagination. Input optional: {status?, goal?, created_after?, created_before?, sort_direction?, cursor?, limit?}. Returns runs and pagination.",
    output:
      "Raw provider list { data: [{ run_id, status, ...provider fields }], pagination? }.",
    inputSchema: AgentListInputSchema,
    examples: [
      { name: "recent", input: { limit: 10 } },
      { name: "failed runs", input: { status: "FAILED", sort_direction: "desc" } },
    ],
  },
  {
    command: "tinyfish agent events",
    description:
      "Report run-events support for a run_id. TinyFish has no run-events endpoint; returns supported:false pointing at agent stream and webhooks. Input: {run_id}.",
    output:
      "{ provider, run_id, capability: \"agent.events\", supported: false, reason, alternatives: [string] } (static, no API call).",
    inputSchema: AgentRunRefInputSchema,
    examples: [{ name: "events", input: { run_id: RUN_ID } }],
  },
  {
    command: "tinyfish profiles list",
    description:
      "List Browser Context Profiles (GET /v1/profiles). Input optional: {}. Returns the raw profile list.",
    output:
      "Raw provider JSON object { ...provider fields } from GET /v1/profiles (passed through, not modeled).",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "list", input: {} }],
  },
  {
    command: "tinyfish profiles create",
    description:
      "Create a Browser Context Profile (POST /v1/profiles); pass profile_id + use_profile:true to agent runs to reuse sign-ins. Input: {name, set_as_default?, proxy_country_code?}. Returns the created profile.",
    output:
      "Raw provider JSON object { ...provider fields } for the created profile (passed through, not modeled).",
    inputSchema: ProfileCreateInputSchema,
    examples: [{ name: "default profile", input: { name: "research", set_as_default: true, proxy_country_code: "US" } }],
  },
  {
    command: "tinyfish profiles inspect",
    description:
      "Get a profile by profile_id with its stored domains (GET /v1/profiles/{id}). Input: {profile_id}. Returns the raw profile.",
    output:
      "Raw provider profile object { ...provider fields } (passed through, not modeled).",
    inputSchema: ProfileIdInputSchema,
    examples: [{ name: "inspect", input: { profile_id: "prof_abc123" } }],
  },
  {
    command: "tinyfish profiles update",
    description:
      "Update a profile by profile_id: rename, set as default, or change proxy country (PATCH /v1/profiles/{id}). Input: {profile_id, name?, set_as_default?, proxy_country_code?}. Returns the updated profile.",
    output:
      "Raw provider profile object { ...provider fields } (passed through, not modeled).",
    inputSchema: ProfileUpdateInputSchema,
    examples: [{ name: "rename", input: { profile_id: "prof_abc123", name: "work" } }],
  },
  {
    command: "tinyfish profiles delete",
    description:
      "Delete a profile by profile_id (DELETE /v1/profiles/{id}). Input: {profile_id}. Returns the provider's delete response.",
    output:
      "Raw provider JSON object { ...provider fields } (passed through, not modeled).",
    inputSchema: ProfileIdInputSchema,
    examples: [{ name: "delete", input: { profile_id: "prof_abc123" } }],
  },
  {
    command: "tinyfish vault connections",
    description:
      "List connected password-manager vaults such as 1Password and Bitwarden (GET /v1/vault/connections). Input optional: {}. Returns the raw connection list.",
    output:
      "Raw provider JSON object { ...provider fields } from GET /v1/vault/connections (passed through, not modeled).",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "list", input: {} }],
  },
  {
    command: "tinyfish vault items",
    description:
      "List vault credential items, metadata only (GET /v1/vault/items); use itemId in agent credential_item_ids. Input optional: {}. Returns the raw item list.",
    output:
      "Raw provider JSON object { ...provider fields } from GET /v1/vault/items (passed through, not modeled).",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "list", input: {} }],
  },
  {
    command: "tinyfish vault sync",
    description:
      "Re-sync vault items from connected providers (POST /v1/vault/items/sync). Input optional: {}. Returns the provider's sync response.",
    output:
      "Raw provider JSON object { ...provider fields } (passed through, not modeled).",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "sync", input: {} }],
  },
  {
    command: "tinyfish research start",
    description:
      "Start a beta research run (POST /v1/automation/run-research-async) for a cited report: deep 5-20 min, max 5-45 min. Cap 5 concurrent, 5 per Pacific day; not idempotent. Input: {query, mode?}. Returns research_run_id.",
    output:
      "{ research_run_id, status: \"QUEUED\", lifecycle: { provider_async, supported_actions, unsupported_actions }, next_actions }",
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
    description:
      "Start a research run and poll until terminal or max_wait_seconds (default 1800). Input: {query, mode?, domain_filter?, max_wait_seconds?, poll_interval_seconds?}. Returns status, report, and citations.",
    output:
      "{ completed, terminal, research_run_id, status, report, citations: [url], run, timed_out, next_action?, next_actions? }; report is deep_result.result or null, run is the raw research run.",
    inputSchema: ResearchRunInputSchema,
    examples: [{ name: "run and wait", input: { query: "Compare TinyFish and Firecrawl fetch APIs", max_wait_seconds: 1800 } }],
  },
  {
    command: "tinyfish research check",
    description:
      "Get a research run's status by research_run_id; when COMPLETED returns the report (deep_result.result) and citations (URL strings). Input: {research_run_id}.",
    output:
      "{ completed, terminal, research_run_id, status, report, citations: [url], run, next_action?, next_actions? }; report is deep_result.result or null, run is the raw research run, next_action* only while not terminal.",
    inputSchema: ResearchIdInputSchema,
    examples: [{ name: "check", input: { research_run_id: RESEARCH_ID } }],
  },
  {
    command: "tinyfish research inspect",
    description:
      "Raw research run by research_run_id (GET /v1/research-run/{id}): research_plan, evidence with claims, iterations. Input: {research_run_id}. Returns the provider run object.",
    output:
      "Raw provider run { research_run_id, status, deep_result?: { result?, citations? }, ...passthrough fields such as evidence }.",
    inputSchema: ResearchIdInputSchema,
    examples: [{ name: "inspect", input: { research_run_id: RESEARCH_ID } }],
  },
  {
    command: "tinyfish research wait",
    description:
      "Poll an existing research run by research_run_id until terminal or max_wait_seconds (default 1800). Input: {research_run_id, max_wait_seconds?, poll_interval_seconds?}. Returns report and citations; timed_out:true if not done.",
    output:
      "{ completed, terminal, research_run_id, status, report, citations: [url], run, timed_out, next_action?, next_actions? }; report is deep_result.result or null, run is the raw research run.",
    inputSchema: ResearchWaitInputSchema,
    examples: [{ name: "wait", input: { research_run_id: RESEARCH_ID, max_wait_seconds: 1200, poll_interval_seconds: 15 } }],
  },
  {
    command: "tinyfish research events",
    description:
      "Read a research run's SSE stream (GET /v1/research-run/{id}/events) for up to max_wait_seconds (default 30). Input: {research_run_id, last_event_id?}. Disconnecting never cancels the run; resume with last_event_id.",
    output:
      "{ research_run_id, event_count, done, timed_out, last_event_id | null, events: [{ event?, id?, data }], next_action?, resume_with?: { last_event_id } } (next_action/resume_with only when not done).",
    inputSchema: ResearchEventsInputSchema,
    examples: [
      { name: "tail events", input: { research_run_id: RESEARCH_ID, max_wait_seconds: 20 } },
      { name: "resume", input: { research_run_id: RESEARCH_ID, last_event_id: "42" } },
    ],
  },
  {
    command: "tinyfish research cancel",
    description:
      "Cancel a research run by research_run_id (POST /v1/research-run/{id}/cancel, idempotent). Input: {research_run_id}. Returns the provider's cancel response.",
    output:
      "Raw provider JSON object { ...provider fields } (passed through, not modeled); its status, when present, updates the run registry.",
    inputSchema: ResearchIdInputSchema,
    examples: [{ name: "cancel", input: { research_run_id: RESEARCH_ID } }],
  },
  {
    command: "tinyfish research list",
    description:
      "List research runs (GET /v1/research-run) with cursor pagination. Input optional: {status?, query?, created_after?, created_before?, sort_direction?, cursor?, limit?}. Returns runs and pagination.",
    output:
      "Raw provider list { data: [{ research_run_id, status, deep_result?, ...provider fields }], pagination? }.",
    inputSchema: ResearchListInputSchema,
    examples: [{ name: "completed", input: { status: "COMPLETED", limit: 10 } }],
  },
  {
    command: "tinyfish monitor create",
    description:
      "Create a Page (type=fetch, config.url) or Topic (type=search, config.query) monitor on a 5-field cron (UTC unless CRON_TZ=<IANA> prefix); a baseline runs now. Max 50; topic runs >=30 min apart. Input: {type, config, schedule_cron, name?}.",
    output:
      "Raw provider JSON object { ...provider fields } (passed through, not modeled); the monitor id is read from id or monitor.id, the baseline run from run.",
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
    description:
      "List monitors (GET /v1/monitors). Input optional: {}. Returns the raw monitor list.",
    output:
      "Raw provider JSON object { ...provider fields } from GET /v1/monitors (passed through, not modeled).",
    inputSchema: EmptyInputSchema,
    examples: [{ name: "list", input: {} }],
  },
  {
    command: "tinyfish monitor inspect",
    description:
      "Get one monitor by id (GET /v1/monitors/{id}). Input: {id}. Returns the raw monitor object.",
    output:
      "Raw provider monitor object { ...provider fields } (passed through, not modeled).",
    inputSchema: MonitorIdInputSchema,
    examples: [{ name: "inspect", input: { id: "mon_abc123" } }],
  },
  {
    command: "tinyfish monitor update",
    description:
      "Update a monitor by id (PATCH /v1/monitors/{id}): status-only {id, status: active|paused} or edits {id, schedule_cron?, name?, purpose?, webhook_url?} (null clears); type/config immutable. Returns the updated monitor.",
    output:
      "Raw provider monitor object { ...provider fields } (passed through, not modeled).",
    inputSchema: MonitorUpdateInputSchema,
    examples: [
      { name: "pause", input: { id: "mon_abc123", status: "paused" } },
      { name: "reschedule", input: { id: "mon_abc123", schedule_cron: "0 */2 * * *" } },
    ],
  },
  {
    command: "tinyfish monitor delete",
    description:
      "Delete a monitor by id (DELETE /v1/monitors/{id}). Input: {id}. Returns the provider's delete response.",
    output:
      "Raw provider JSON object { ...provider fields } (passed through, not modeled).",
    inputSchema: MonitorIdInputSchema,
    examples: [{ name: "delete", input: { id: "mon_abc123" } }],
  },
  {
    command: "tinyfish monitor trigger",
    description:
      "Run a monitor now by id (POST /v1/monitors/{id}/runs); topic monitors may return 409 RETRY_REQUIRED. Input: {id}. Returns the provider's trigger response.",
    output:
      "Raw provider JSON object { ...provider fields } (passed through, not modeled); run output, when present, is under run.",
    inputSchema: MonitorIdInputSchema,
    examples: [{ name: "run now", input: { id: "mon_abc123" } }],
  },
  {
    command: "tinyfish monitor events",
    description:
      "Report run-history support for a monitor id. TinyFish has no REST run-history endpoint; returns supported:false pointing at webhooks and trigger. Input: {id}.",
    output:
      "{ provider, id, capability: \"monitor.events\", supported: false, reason, alternatives: [string] } (static, no API call).",
    inputSchema: MonitorIdInputSchema,
    examples: [{ name: "events", input: { id: "mon_abc123" } }],
  },
])
