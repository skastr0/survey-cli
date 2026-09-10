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
    description: "Run a synchronous Parallel Search request (POST /v1/search)",
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
    description: "Run a synchronous Parallel Extract request (POST /v1/extract)",
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
    description: "Submit a Parallel Task Run and return the run id",
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
    output:
      "Run handle with lifecycle.next_actions. Task Run cancel is not documented; no cancel subcommand exists.",
  },
  {
    command: "parallel deep-research run",
    description:
      "Submit a Parallel Task Run and poll until complete or timed out",
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
    description: "Inspect a Parallel Task API run without fetching results",
    inputSchema: DeepResearchCheckInput,
    orbit: deepResearchOrbit,
    examples: [{ name: "inspect run", input: { run_id: "trun_..." } }],
  },
  {
    command: "parallel deep-research check",
    description: "Inspect a Task Run and fetch results when complete",
    inputSchema: DeepResearchCheckInput,
    orbit: deepResearchOrbit,
    examples: [{ name: "check run", input: { run_id: "trun_..." } }],
  },
  {
    command: "parallel deep-research wait",
    description: "Poll an existing Task Run until complete or timed out",
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
    description: "Read Task Run SSE events (parallel-beta events-sse-2025-07-24)",
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
    description: "Submit a Parallel FindAll run (/v1beta/findall/*)",
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
      "Run a synchronous ranked people or company search without per-candidate verification",
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
    description: "Inspect a Parallel FindAll run",
    inputSchema: FindAllCheckInput,
    orbit: findAllOrbit,
    examples: [{ name: "inspect findall", input: { findall_id: "findall_..." } }],
  },
  {
    command: "parallel findall check",
    description: "Inspect a FindAll run and fetch candidates when complete",
    inputSchema: FindAllCheckInput,
    orbit: findAllOrbit,
    examples: [{ name: "check findall", input: { findall_id: "findall_..." } }],
  },
  {
    command: "parallel findall wait",
    description: "Poll an existing FindAll run until complete or timed out",
    inputSchema: FindAllWaitInput,
    orbit: findAllOrbit,
    examples: [{ name: "wait findall", input: { findall_id: "findall_..." } }],
  },
  {
    command: "parallel findall events",
    description: "Read FindAll SSE events",
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
    description: "Add a Task-powered enrichment to an existing FindAll run",
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
    description: "Increase the match limit of an existing FindAll run",
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
    description: "Cancel a FindAll run (POST /v1beta/findall/runs/{id}/cancel)",
    inputSchema: FindAllCancelInput,
    orbit: findAllOrbit,
    examples: [{ name: "cancel", input: { findall_id: "findall_..." } }],
  },
  {
    command: "parallel monitors create",
    description: "Create a scheduled web monitor (POST /v1/monitors)",
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
    description: "List Parallel monitors (GET /v1/monitors)",
    orbit: monitorOrbit,
  },
  {
    command: "parallel monitors inspect",
    description: "Retrieve a monitor by id",
    inputSchema: MonitorIdInput,
    orbit: monitorOrbit,
    examples: [{ name: "inspect monitor", input: { monitor_id: "mon_..." } }],
  },
  {
    command: "parallel monitors events",
    description:
      "List monitor events or retrieve an event group. Monitor V1 removed lookback_period.",
    inputSchema: MonitorEventsInput,
    orbit: monitorOrbit,
    examples: [
      { name: "recent events", input: { monitor_id: "mon_...", limit: 20 } },
    ],
  },
  {
    command: "parallel monitors trigger",
    description:
      "Enqueue a real off-schedule monitor run (POST /v1/monitors/{id}/trigger)",
    inputSchema: MonitorIdInput,
    orbit: monitorOrbit,
    examples: [{ name: "trigger monitor", input: { monitor_id: "mon_..." } }],
  },
  {
    command: "parallel monitors cancel",
    description:
      "Cancel a monitor to stop future executions (POST /v1/monitors/{id}/cancel)",
    inputSchema: MonitorIdInput,
    orbit: monitorOrbit,
    examples: [{ name: "cancel monitor", input: { monitor_id: "mon_..." } }],
  },
])
