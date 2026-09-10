import { Schema } from "effect"

export const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)
const StringRecord = Schema.Record(Schema.String, Schema.String)
const OptionalStringArray = Schema.optional(Schema.Array(Schema.String))

export const Warning = Schema.Struct({
  type: Schema.optional(Schema.String),
  message: Schema.String,
  detail: Schema.optional(Schema.NullishOr(JsonRecord)),
})

export const UsageItem = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
})

export const FetchPolicy = Schema.Struct({
  max_age_seconds: Schema.optional(Schema.Number),
  timeout_seconds: Schema.optional(Schema.Number),
  disable_cache_fallback: Schema.optional(Schema.Boolean),
})

export const ExcerptSettings = Schema.Struct({
  max_chars_per_result: Schema.optional(Schema.Number),
})

export const SourcePolicy = Schema.Struct({
  include_domains: OptionalStringArray,
  exclude_domains: OptionalStringArray,
  after_date: Schema.optional(Schema.String),
})
export type SourcePolicy = typeof SourcePolicy.Type

export const AdvancedSearchSettings = Schema.Struct({
  source_policy: Schema.optional(SourcePolicy),
  fetch_policy: Schema.optional(FetchPolicy),
  excerpt_settings: Schema.optional(ExcerptSettings),
  location: Schema.optional(Schema.String),
  max_results: Schema.optional(Schema.Number),
})

export const AdvancedExtractSettings = Schema.Struct({
  fetch_policy: Schema.optional(FetchPolicy),
  excerpt_settings: Schema.optional(ExcerptSettings),
  full_content: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Struct({
        max_chars_per_result: Schema.optional(Schema.Number),
      }),
    ]),
  ),
})

export const SearchMode = Schema.Literals([
  "turbo",
  "fast",
  "basic",
  "advanced",
  "one-shot",
  "agentic",
])
export type SearchMode = typeof SearchMode.Type

export const SearchInput = Schema.Struct({
  objective: Schema.optional(Schema.String),
  search_queries: OptionalStringArray,
  mode: Schema.optional(SearchMode),
  max_results: Schema.optional(Schema.Number),
  max_chars_total: Schema.optional(Schema.Number),
  session_id: Schema.optional(Schema.String),
  client_model: Schema.optional(Schema.String),
  allowed_domains: OptionalStringArray,
  disallowed_domains: OptionalStringArray,
  include_domains: OptionalStringArray,
  exclude_domains: OptionalStringArray,
  after_date: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  fetch_policy: Schema.optional(FetchPolicy),
  excerpt_settings: Schema.optional(ExcerptSettings),
  source_policy: Schema.optional(SourcePolicy),
  advanced_settings: Schema.optional(AdvancedSearchSettings),
})
export type SearchInput = typeof SearchInput.Type

export const ExtractInput = Schema.Struct({
  urls: Schema.Array(Schema.String),
  objective: Schema.optional(Schema.String),
  search_queries: OptionalStringArray,
  max_chars_total: Schema.optional(Schema.Number),
  session_id: Schema.optional(Schema.String),
  client_model: Schema.optional(Schema.String),
  excerpts: Schema.optional(Schema.Union([Schema.Boolean, ExcerptSettings])),
  full_content: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Struct({
        max_chars_per_result: Schema.optional(Schema.Number),
      }),
    ]),
  ),
  fetch_policy: Schema.optional(FetchPolicy),
  excerpt_settings: Schema.optional(ExcerptSettings),
  advanced_settings: Schema.optional(AdvancedExtractSettings),
})
export type ExtractInput = typeof ExtractInput.Type

export const TaskSchemaSpec = Schema.Union([
  Schema.String,
  Schema.Struct({
    type: Schema.Literal("auto"),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    description: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("json"),
    json_schema: Schema.optional(JsonRecord),
  }),
])

export const TaskInputSchemaSpec = Schema.Union([
  Schema.String,
  Schema.Struct({
    type: Schema.Literal("text"),
    description: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("json"),
    json_schema: JsonRecord,
  }),
])

export const DeepResearchInput = Schema.Struct({
  input: Schema.Union([Schema.String, JsonRecord]),
  processor: Schema.optional(Schema.String),
  output_schema: Schema.optional(TaskSchemaSpec),
  input_schema: Schema.optional(TaskInputSchemaSpec),
  metadata: Schema.optional(JsonRecord),
  allowed_domains: OptionalStringArray,
  disallowed_domains: OptionalStringArray,
  location: Schema.optional(Schema.String),
  memory_scope_key: Schema.optional(Schema.String),
  previous_interaction_id: Schema.optional(Schema.String),
  enable_events: Schema.optional(Schema.Boolean),
  webhook_url: Schema.optional(Schema.String),
  max_wait_seconds: Schema.optional(Schema.Number),
  poll_interval_seconds: Schema.optional(Schema.Number),
})
export type DeepResearchInput = typeof DeepResearchInput.Type

export const DeepResearchCheckInput = Schema.Struct({
  run_id: Schema.String,
  timeout_seconds: Schema.optional(Schema.Number),
})
export type DeepResearchCheckInput = typeof DeepResearchCheckInput.Type

export const DeepResearchWaitInput = Schema.Struct({
  run_id: Schema.String,
  max_wait_seconds: Schema.optional(Schema.Number),
  poll_interval_seconds: Schema.optional(Schema.Number),
  timeout_seconds: Schema.optional(Schema.Number),
})
export type DeepResearchWaitInput = typeof DeepResearchWaitInput.Type

export const DeepResearchEventsInput = Schema.Struct({
  run_id: Schema.String,
  timeout_seconds: Schema.optional(Schema.Number),
  last_event_id: Schema.optional(Schema.String),
})
export type DeepResearchEventsInput = typeof DeepResearchEventsInput.Type

export const MatchCondition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})

export const ExcludeCandidate = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
})

// `type` defaults to "json" at the payload boundary (see api.ts).
export const JsonOutputSchema = Schema.Struct({
  type: Schema.optional(Schema.Literal("json")),
  json_schema: JsonRecord,
})
export type JsonOutputSchema = typeof JsonOutputSchema.Type

export const FindAllEnrichmentV1 = Schema.Struct({
  processor: Schema.optional(Schema.String),
  output_schema: JsonOutputSchema,
})

export const FindAllEnrichmentLegacy = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  processor: Schema.optional(Schema.String),
})

export const FindAllEnrichment = Schema.Union([
  FindAllEnrichmentV1,
  FindAllEnrichmentLegacy,
])
export type FindAllEnrichment = typeof FindAllEnrichment.Type

export const FindAllStartInput = Schema.Struct({
  objective: Schema.String,
  entity_type: Schema.optional(Schema.String),
  match_conditions: Schema.optional(Schema.Array(MatchCondition)),
  generator: Schema.optional(Schema.Literals(["preview", "base", "core", "pro"])),
  match_limit: Schema.optional(Schema.Number),
  exclude_list: Schema.optional(Schema.Array(ExcludeCandidate)),
  enrichments: Schema.optional(Schema.Array(FindAllEnrichment)),
  metadata: Schema.optional(JsonRecord),
  webhook_url: Schema.optional(Schema.String),
  memory_scope_key: Schema.optional(Schema.String),
})
export type FindAllStartInput = typeof FindAllStartInput.Type

export const FindAllEntitySearchInput = Schema.Struct({
  entity_type: Schema.Literals(["people", "companies"]),
  objective: Schema.String,
  match_limit: Schema.optional(Schema.Number),
})
export type FindAllEntitySearchInput = typeof FindAllEntitySearchInput.Type

export const FindAllCheckInput = Schema.Struct({
  findall_id: Schema.String,
})
export type FindAllCheckInput = typeof FindAllCheckInput.Type

export const FindAllWaitInput = Schema.Struct({
  findall_id: Schema.String,
  max_wait_seconds: Schema.optional(Schema.Number),
  poll_interval_seconds: Schema.optional(Schema.Number),
})
export type FindAllWaitInput = typeof FindAllWaitInput.Type

export const FindAllEventsInput = Schema.Struct({
  findall_id: Schema.String,
  timeout_seconds: Schema.optional(Schema.Number),
  last_event_id: Schema.optional(Schema.String),
})
export type FindAllEventsInput = typeof FindAllEventsInput.Type

export const FindAllCancelInput = Schema.Struct({
  findall_id: Schema.String,
})
export type FindAllCancelInput = typeof FindAllCancelInput.Type

export const FindAllEnrichInput = Schema.Struct({
  findall_id: Schema.String,
  processor: Schema.optional(Schema.String),
  output_schema: JsonOutputSchema,
})
export type FindAllEnrichInput = typeof FindAllEnrichInput.Type

export const FindAllExtendInput = Schema.Struct({
  findall_id: Schema.String,
  additional_match_limit: Schema.Number,
})
export type FindAllExtendInput = typeof FindAllExtendInput.Type

export const MonitorCreateInput = Schema.Struct({
  type: Schema.optional(Schema.Literals(["event_stream", "snapshot"])),
  query: Schema.optional(Schema.String),
  cadence: Schema.optional(
    Schema.Literals(["hourly", "daily", "weekly", "every_two_weeks"]),
  ),
  frequency: Schema.optional(Schema.String),
  processor: Schema.optional(Schema.Literals(["lite", "base"])),
  webhook_url: Schema.optional(Schema.String),
  metadata: Schema.optional(StringRecord),
  task_run_id: Schema.optional(Schema.String),
  output_schema: Schema.optional(JsonOutputSchema),
  include_backfill: Schema.optional(Schema.Boolean),
  location: Schema.optional(Schema.String),
  include_domains: OptionalStringArray,
  exclude_domains: OptionalStringArray,
  after_date: Schema.optional(Schema.String),
  memory_scope_key: Schema.optional(Schema.String),
})
export type MonitorCreateInput = typeof MonitorCreateInput.Type

export const MonitorEventsInput = Schema.Struct({
  monitor_id: Schema.String,
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  include_completions: Schema.optional(Schema.Boolean),
  event_group_id: Schema.optional(Schema.String),
  lookback: Schema.optional(Schema.String),
  lookback_period: Schema.optional(Schema.String),
})
export type MonitorEventsInput = typeof MonitorEventsInput.Type

export const MonitorIdInput = Schema.Struct({
  monitor_id: Schema.String,
})
export type MonitorIdInput = typeof MonitorIdInput.Type

// ---- Response schemas ----

export const SearchResponse = Schema.Struct({
  search_id: Schema.String,
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
      publish_date: Schema.optional(Schema.NullOr(Schema.String)),
      excerpts: Schema.Array(Schema.String),
    }),
  ),
  warnings: Schema.optional(Schema.NullOr(Schema.Array(Warning))),
  usage: Schema.optional(Schema.NullOr(Schema.Array(UsageItem))),
  session_id: Schema.String,
})
export type SearchResponse = typeof SearchResponse.Type

export const ExtractResponse = Schema.Struct({
  extract_id: Schema.String,
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
      publish_date: Schema.optional(Schema.NullOr(Schema.String)),
      excerpts: Schema.Array(Schema.String),
      full_content: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  errors: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      error_type: Schema.optional(Schema.String),
      http_status_code: Schema.optional(Schema.NullOr(Schema.Number)),
      content: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  warnings: Schema.optional(Schema.NullOr(Schema.Array(Warning))),
  usage: Schema.optional(Schema.NullOr(Schema.Array(UsageItem))),
  session_id: Schema.String,
})
export type ExtractResponse = typeof ExtractResponse.Type

export const TaskRunStatus = Schema.Literals([
  "queued",
  "action_required",
  "running",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
])
export type TaskRunStatus = typeof TaskRunStatus.Type

export const TaskRun = Schema.Struct({
  run_id: Schema.String,
  status: TaskRunStatus,
  is_active: Schema.Boolean,
  processor: Schema.String,
  interaction_id: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.NullOr(JsonRecord)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  modified_at: Schema.optional(Schema.NullOr(Schema.String)),
  warnings: Schema.optional(Schema.NullOr(Schema.Array(Warning))),
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ref_id: Schema.optional(Schema.String),
        code: Schema.optional(Schema.String),
        message: Schema.String,
        detail: Schema.optional(Schema.NullOr(JsonRecord)),
      }),
    ),
  ),
})
export type TaskRun = typeof TaskRun.Type

export const BasisItem = Schema.Struct({
  field: Schema.String,
  reasoning: Schema.String,
  confidence: Schema.optional(Schema.NullOr(Schema.String)),
  citations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        title: Schema.optional(Schema.NullOr(Schema.String)),
        excerpts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
})

export const TaskRunResult = Schema.Struct({
  run: TaskRun,
  output: Schema.Struct({
    content: Schema.Unknown,
    type: Schema.Literals(["text", "json"]),
    output_schema: Schema.optional(Schema.NullishOr(Schema.Unknown)),
    basis: Schema.optional(Schema.Array(BasisItem)),
  }),
})
export type TaskRunResult = typeof TaskRunResult.Type

export const FindAllIngestResponse = Schema.Struct({
  objective: Schema.String,
  entity_type: Schema.String,
  match_conditions: Schema.Array(MatchCondition),
  enrichments: Schema.optional(Schema.NullOr(Schema.Array(FindAllEnrichmentV1))),
  generator: Schema.optional(
    Schema.Literals(["preview", "base", "core", "pro"]),
  ),
  match_limit: Schema.optional(Schema.NullOr(Schema.Number)),
})
export type FindAllIngestResponse = typeof FindAllIngestResponse.Type

export const FindAllRun = Schema.Struct({
  findall_id: Schema.String,
  status: Schema.Struct({
    status: TaskRunStatus,
    is_active: Schema.Boolean,
    metrics: Schema.Struct({
      generated_candidates_count: Schema.Number,
      matched_candidates_count: Schema.Number,
    }),
    termination_reason: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  generator: Schema.String,
  metadata: Schema.optional(Schema.NullOr(JsonRecord)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  modified_at: Schema.optional(Schema.NullOr(Schema.String)),
})
export type FindAllRun = typeof FindAllRun.Type

export const FindAllRunResult = Schema.Struct({
  findall_id: Schema.String,
  status: FindAllRun.fields.status,
  candidates: Schema.Array(
    Schema.Struct({
      candidate_id: Schema.String,
      name: Schema.String,
      url: Schema.String,
      description: Schema.String,
      match_status: Schema.Literals(["matched", "unmatched", "generated"]),
      output: JsonRecord,
      basis: Schema.Array(BasisItem),
    }),
  ),
})
export type FindAllRunResult = typeof FindAllRunResult.Type

export const FindAllSchemaResponse = Schema.Struct({
  objective: Schema.String,
  entity_type: Schema.String,
  match_conditions: Schema.Array(MatchCondition),
  enrichments: Schema.optional(Schema.NullOr(Schema.Array(FindAllEnrichmentV1))),
  generator: Schema.optional(
    Schema.Literals(["preview", "base", "core", "pro"]),
  ),
  match_limit: Schema.optional(Schema.NullOr(Schema.Number)),
})
export type FindAllSchemaResponse = typeof FindAllSchemaResponse.Type

export const EntitySearchResponse = Schema.Struct({
  entity_set_id: Schema.String,
  entities: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      description: Schema.String,
    }),
  ),
})
export type EntitySearchResponse = typeof EntitySearchResponse.Type

export const MonitorSettings = Schema.Struct({
  query: Schema.optional(Schema.String),
  task_run_id: Schema.optional(Schema.String),
  output_schema: Schema.optional(Schema.NullOr(JsonRecord)),
  include_backfill: Schema.optional(Schema.NullOr(Schema.Boolean)),
  advanced_settings: Schema.optional(Schema.NullOr(JsonRecord)),
})

export const Monitor = Schema.Struct({
  monitor_id: Schema.String,
  type: Schema.optional(Schema.Literals(["event_stream", "snapshot"])),
  query: Schema.optional(Schema.String),
  status: Schema.String,
  frequency: Schema.optional(Schema.String),
  cadence: Schema.optional(Schema.String),
  processor: Schema.optional(Schema.Literals(["lite", "base"])),
  metadata: Schema.optional(Schema.NullOr(StringRecord)),
  webhook: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        url: Schema.String,
        event_types: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  created_at: Schema.String,
  last_run_at: Schema.optional(Schema.NullOr(Schema.String)),
  settings: Schema.optional(MonitorSettings),
  output: Schema.optional(Schema.NullOr(JsonRecord)),
})
export type Monitor = typeof Monitor.Type

export const MonitorEvent = JsonRecord

export const MonitorEventsResponse = Schema.Struct({
  events: Schema.Array(MonitorEvent),
  has_more: Schema.optional(Schema.Boolean),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
  warnings: Schema.optional(Schema.NullOr(Schema.Array(Warning))),
})
export type MonitorEventsResponse = typeof MonitorEventsResponse.Type

export const MonitorsResponse = Schema.Struct({
  monitors: Schema.Array(Monitor),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
})
export type MonitorsResponse = typeof MonitorsResponse.Type
