import { registerContracts } from "../../core/discovery"

import {
  DeepResearchCheckInput,
  DeepResearchEventsInput,
  DeepResearchInput,
  DeepResearchWaitInput,
  ExtractInput,
  FindAllCancelInput,
  FindAllCheckInput,
  FindAllEnrichInput,
  FindAllEntitySearchInput,
  FindAllEventsInput,
  FindAllExtendInput,
  FindAllStartInput,
  FindAllWaitInput,
  MonitorCreateInput,
  MonitorEventsInput,
  MonitorIdInput,
  MonitorListInput,
  SearchInput,
} from "./schemas"

const deepResearchOrbit = ["start", "run", "inspect", "check", "wait", "events"]
const findAllOrbit = [
  "start",
  "entity-search",
  "inspect",
  "check",
  "wait",
  "events",
  "enrich",
  "extend",
  "cancel",
]
const monitorOrbit = ["create", "list", "inspect", "events", "trigger", "cancel"]

registerContracts([
  {
    command: "parallel search",
    description:
      "Run Parallel web searches (POST /v1/search; keyless public MCP fallback without a key). Input: {objective?, search_queries?, mode?, max_results?}; array for batch. Returns per item {search_id, results}.",
    output:
      "Batch summary { outcome, total, success_count, error_count, results: [{ index, ok, data | error }] }; each data = { auth_mode: keyed|public, search_id, session_id, results: [{ url, title?, publish_date?, excerpts }], result_count, warnings?, usage? }",
    inputSchema: SearchInput,
    batch: true,
    examples: [
      {
        name: "fast search",
        description: "Objective-driven search with explicit queries",
        input: {
          objective: "Find official Parallel API docs",
          search_queries: ["Parallel API documentation"],
          mode: "fast",
          max_results: 5,
          session_id: "session_example",
        },
      },
    ],
  },
  {
    command: "parallel extract",
    description:
      "Extract content from URLs via Parallel Extract (POST /v1/extract; keyless fallback without a key). Input: {urls, objective?, full_content?}; array for batch. Returns per item {extract_id, results, errors}.",
    output:
      "Batch summary { outcome, total, success_count, error_count, results: [{ index, ok, data | error }] }; each data = { auth_mode: keyed|public, extract_id, session_id, results: [{ url, title?, publish_date?, excerpts, full_content? }], errors: [{ url, error_type?, http_status_code?, content? }], result_count, error_count, warnings?, usage? }",
    inputSchema: ExtractInput,
    batch: true,
    examples: [
      {
        name: "focused extraction",
        input: {
          urls: ["https://parallel.ai"],
          objective: "Extract product names and API categories",
          full_content: true,
          max_chars_total: 50000,
          client_model: "grok-4",
        },
      },
    ],
  },
  {
    command: "parallel deep-research start",
    description:
      "Submit Parallel Task Runs (deep research) without waiting. Input: {input, processor?, output_schema?}; array for batch. Returns per item {run_id, status, next_actions}; poll with deep-research check/wait.",
    output:
      "Batch summary { outcome, total, success_count, error_count, results: [{ index, ok, data | error }] }; each data = { run_id, status, processor, interaction_id?, warnings?, lifecycle: { provider_async, supported_actions, unsupported_actions }, next_actions }; plus idempotency receipt with --idempotency-key. Task Run cancel is not documented; no cancel subcommand exists.",
    inputSchema: DeepResearchInput,
    batch: true,
    orbit: deepResearchOrbit,
    examples: [
      {
        name: "evented deep research",
        input: {
          input: "Research current AI browser agents",
          processor: "base",
          enable_events: true,
        },
      },
    ],
  },
  {
    command: "parallel deep-research run",
    description:
      "Submit a Parallel Task Run and poll until complete or max_wait_seconds (default 120). Input: {input, processor?, output_schema?, max_wait_seconds?}. Returns {completed, run_id, status, output?, basis?}.",
    output:
      "When completed: { completed: true, run_id, status, processor, interaction_id?, output, output_type, output_schema?, basis?, warnings? }; otherwise { completed: false, run_id, status, is_active, processor, provider_error?, next_action, next_actions }; plus idempotency receipt with --idempotency-key",
    inputSchema: DeepResearchInput,
    orbit: deepResearchOrbit,
    examples: [
      {
        name: "bounded wait",
        input: {
          input: "Summarize current web extraction APIs",
          processor: "core",
          max_wait_seconds: 120,
          poll_interval_seconds: 5,
        },
      },
    ],
  },
  {
    command: "parallel deep-research inspect",
    description:
      "Inspect a Task Run without fetching results (GET /v1/tasks/runs/{run_id}). Input: {run_id}. Returns the raw provider run {run_id, status, is_active, processor}.",
    output:
      "Raw provider TaskRun { run_id, status, is_active, processor, interaction_id?, metadata?, created_at?, modified_at?, warnings?, error? }",
    inputSchema: DeepResearchCheckInput,
    orbit: deepResearchOrbit,
    examples: [{ name: "inspect run", input: { run_id: "trun_..." } }],
  },
  {
    command: "parallel deep-research check",
    description:
      "Check a Task Run once and fetch its result if completed. Input: {run_id, timeout_seconds?}. Returns {completed, run_id, status} plus output and basis when done, else next_actions.",
    output:
      "When completed: { completed: true, run_id, status, processor, interaction_id?, output, output_type, output_schema?, basis?, warnings? }; otherwise { completed: false, run_id, status, is_active, processor, provider_error?, next_action, next_actions }",
    inputSchema: DeepResearchCheckInput,
    orbit: deepResearchOrbit,
    examples: [{ name: "check run", input: { run_id: "trun_..." } }],
  },
  {
    command: "parallel deep-research wait",
    description:
      "Poll an existing Task Run until complete or max_wait_seconds (default 120). Input: {run_id, max_wait_seconds?, poll_interval_seconds?}. Returns {completed, run_id, status, output?, basis?}.",
    output:
      "When completed: { completed: true, run_id, status, processor, interaction_id?, output, output_type, output_schema?, basis?, warnings? }; otherwise { completed: false, run_id, status, is_active, processor, provider_error?, next_action, next_actions }",
    inputSchema: DeepResearchWaitInput,
    orbit: deepResearchOrbit,
    examples: [
      {
        name: "wait for run",
        input: { run_id: "trun_...", max_wait_seconds: 600 },
      },
    ],
  },
  {
    command: "parallel deep-research events",
    description:
      "Read Task Run SSE events (parallel-beta events-sse-2025-07-24). Input: {run_id, timeout_seconds?, last_event_id?}. Returns {run_id, event_count, events}.",
    output:
      "{ run_id, event_count, events: [parsed SSE data frames; unparseable frames as { type: \"raw\", data }] }",
    inputSchema: DeepResearchEventsInput,
    orbit: deepResearchOrbit,
    examples: [
      {
        name: "events",
        input: { run_id: "trun_...", timeout_seconds: 30 },
      },
    ],
  },
  {
    command: "parallel findall start",
    description:
      "Submit Parallel FindAll entity discovery runs (/v1beta/findall/*). Input: {objective, entity_type?, match_conditions?, generator?, match_limit?}; array for batch. Returns per item {findall_id, next_actions}.",
    output:
      "Batch summary { outcome, total, success_count, error_count, results: [{ index, ok, data | error }] }; each data = { findall_id, entity_type, match_conditions, generator, match_limit, enrichments?, lifecycle: { provider_async, supported_actions }, next_actions }; plus idempotency receipt with --idempotency-key",
    inputSchema: FindAllStartInput,
    batch: true,
    orbit: findAllOrbit,
    examples: [
      {
        name: "entity discovery",
        input: {
          objective: "Find AI infrastructure startups founded after 2023",
          generator: "core",
          match_limit: 10,
        },
      },
    ],
  },
  {
    command: "parallel findall entity-search",
    description:
      "Run a synchronous ranked people or company search without per-candidate verification. Input: {entity_type: people|companies, objective, match_limit?}; array for batch. Returns {entity_set_id, entities}.",
    output:
      "Batch summary { outcome, total, success_count, error_count, results: [{ index, ok, data | error }] }; each data = { entity_set_id, entities: [{ name, url, description }], entity_count }",
    inputSchema: FindAllEntitySearchInput,
    batch: true,
    orbit: findAllOrbit,
    examples: [
      {
        name: "company search",
        input: {
          entity_type: "companies",
          objective: "AI startups in San Francisco",
          match_limit: 25,
        },
      },
    ],
  },
  {
    command: "parallel findall inspect",
    description:
      "Inspect a FindAll run without fetching candidates. Input: {findall_id}. Returns the raw provider run {findall_id, status: {status, is_active, metrics}, generator}.",
    output:
      "Raw provider FindAllRun { findall_id, status: { status, is_active, metrics: { generated_candidates_count, matched_candidates_count }, termination_reason? }, generator, metadata?, created_at?, modified_at? }",
    inputSchema: FindAllCheckInput,
    orbit: findAllOrbit,
    examples: [{ name: "inspect findall", input: { findall_id: "findall_..." } }],
  },
  {
    command: "parallel findall check",
    description:
      "Check a FindAll run once and fetch candidates when complete. Input: {findall_id}. Returns {completed, findall_id, status} plus candidates when done, else progress and next_actions.",
    output:
      "When completed: { completed: true, findall_id, status, total_matched, candidates: [{ candidate_id, name, url, description, match_status, match_results, basis }] }; otherwise { completed: false, findall_id, status, is_active, progress: { generated_candidates, matched_candidates }, next_action, next_actions }",
    inputSchema: FindAllCheckInput,
    orbit: findAllOrbit,
    examples: [{ name: "check findall", input: { findall_id: "findall_..." } }],
  },
  {
    command: "parallel findall wait",
    description:
      "Poll a FindAll run until complete or max_wait_seconds (default 120). Input: {findall_id, max_wait_seconds?, poll_interval_seconds?}. Returns {completed, findall_id, status, candidates?}.",
    output:
      "When completed: { completed: true, findall_id, status, total_matched, candidates: [{ candidate_id, name, url, description, match_status, match_results, basis }] }; otherwise { completed: false, findall_id, status, is_active, progress: { generated_candidates, matched_candidates }, next_action, next_actions }",
    inputSchema: FindAllWaitInput,
    orbit: findAllOrbit,
    examples: [{ name: "wait findall", input: { findall_id: "findall_..." } }],
  },
  {
    command: "parallel findall events",
    description:
      "Read FindAll SSE events. Input: {findall_id, timeout_seconds?, last_event_id?}. Returns {findall_id, event_count, events}.",
    output:
      "{ findall_id, event_count, events: [parsed SSE data frames; unparseable frames as { type: \"raw\", data }] }",
    inputSchema: FindAllEventsInput,
    orbit: findAllOrbit,
    examples: [
      {
        name: "events",
        input: { findall_id: "findall_...", timeout_seconds: 30 },
      },
    ],
  },
  {
    command: "parallel findall enrich",
    description:
      "Add a Task-powered enrichment to an existing FindAll run. Input: {findall_id, output_schema: {json_schema}, processor?}. Returns {findall_id, schema} with the run's updated schema.",
    output:
      "{ findall_id, schema: { objective, entity_type, match_conditions, enrichments?, generator?, match_limit? } }; plus idempotency receipt with --idempotency-key",
    inputSchema: FindAllEnrichInput,
    orbit: findAllOrbit,
    examples: [
      {
        name: "ceo enrichment",
        input: {
          findall_id: "findall_...",
          processor: "core",
          output_schema: {
            type: "json",
            json_schema: {
              type: "object",
              properties: {
                ceo_name: {
                  type: "string",
                  description: "Name of the current CEO",
                },
              },
              required: ["ceo_name"],
              additionalProperties: false,
            },
          },
        },
      },
    ],
  },
  {
    command: "parallel findall extend",
    description:
      "Increase the match limit of an existing FindAll run. Input: {findall_id, additional_match_limit}. Returns {findall_id, schema} with the updated match_limit.",
    output:
      "{ findall_id, schema: { objective, entity_type, match_conditions, enrichments?, generator?, match_limit? } }; plus idempotency receipt with --idempotency-key",
    inputSchema: FindAllExtendInput,
    orbit: findAllOrbit,
    examples: [
      {
        name: "extend matches",
        input: { findall_id: "findall_...", additional_match_limit: 10 },
      },
    ],
  },
  {
    command: "parallel findall cancel",
    description:
      "Cancel a FindAll run (POST /v1beta/findall/runs/{id}/cancel). Input: {findall_id}. Returns {findall_id, cancelled: true, response}.",
    output:
      "{ findall_id, cancelled: true, response } (response is the provider body, {} when empty); plus idempotency receipt with --idempotency-key",
    inputSchema: FindAllCancelInput,
    orbit: findAllOrbit,
    examples: [{ name: "cancel", input: { findall_id: "findall_..." } }],
  },
  {
    command: "parallel monitors create",
    description:
      "Create scheduled web monitors (POST /v1/monitors). Input: {query, cadence?, type?, processor?, webhook_url?}; array for batch. Returns per item {monitor_id, status, cadence, next_actions}.",
    output:
      "Batch summary { outcome, total, success_count, error_count, results: [{ index, ok, data | error }] }; each data = { monitor_id, type?, query?, frequency?, cadence?, processor?, status, webhook_configured, lifecycle, next_actions }; plus idempotency receipt with --idempotency-key",
    inputSchema: MonitorCreateInput,
    batch: true,
    orbit: monitorOrbit,
    examples: [
      {
        name: "daily monitor",
        input: {
          type: "event_stream",
          query: "Notable news about Parallel Web Systems",
          cadence: "daily",
          processor: "lite",
        },
      },
    ],
  },
  {
    command: "parallel monitors list",
    description:
      "List Parallel monitors (GET /v1/monitors). Input optional; must be {} if given. Returns {monitor_count, monitors, next_cursor?}.",
    output:
      "{ monitor_count, monitors: [{ monitor_id, type?, query?, status, frequency?, cadence?, processor?, webhook?, created_at, last_run_at?, settings? }], next_cursor? }",
    inputSchema: MonitorListInput,
    orbit: monitorOrbit,
    examples: [{ name: "list monitors", input: {} }],
  },
  {
    command: "parallel monitors inspect",
    description:
      "Retrieve a monitor by id (GET /v1/monitors/{id}). Input: {monitor_id}. Returns the raw provider monitor {monitor_id, status, query, cadence, created_at}.",
    output:
      "Raw provider Monitor { monitor_id, type?, query?, status, frequency?, cadence?, processor?, metadata?, webhook?, created_at, last_run_at?, settings?, output? }",
    inputSchema: MonitorIdInput,
    orbit: monitorOrbit,
    examples: [{ name: "inspect monitor", input: { monitor_id: "mon_..." } }],
  },
  {
    command: "parallel monitors events",
    description:
      "List monitor events or fetch one event group. Input: {monitor_id, cursor?, limit?, event_group_id?}; Monitor V1 removed lookback_period. Returns {monitor_id, event_count, events}.",
    output:
      "{ monitor_id, event_group_id?, event_count, events: [provider event objects], has_more?, next_cursor? }",
    inputSchema: MonitorEventsInput,
    orbit: monitorOrbit,
    examples: [
      { name: "recent events", input: { monitor_id: "mon_...", limit: 20 } },
    ],
  },
  {
    command: "parallel monitors trigger",
    description:
      "Enqueue a real off-schedule monitor run (POST /v1/monitors/{id}/trigger). Input: {monitor_id}. Returns {monitor_id, triggered: true}.",
    output:
      "{ monitor_id, triggered: true }; plus idempotency receipt with --idempotency-key",
    inputSchema: MonitorIdInput,
    orbit: monitorOrbit,
    examples: [{ name: "trigger monitor", input: { monitor_id: "mon_..." } }],
  },
  {
    command: "parallel monitors cancel",
    description:
      "Cancel a monitor to stop future executions (POST /v1/monitors/{id}/cancel). Input: {monitor_id}. Returns {monitor_id, cancelled: true, monitor}.",
    output:
      "{ monitor_id, cancelled: true, monitor } (monitor is the provider Monitor record); plus idempotency receipt with --idempotency-key",
    inputSchema: MonitorIdInput,
    orbit: monitorOrbit,
    examples: [{ name: "cancel monitor", input: { monitor_id: "mon_..." } }],
  },
])
