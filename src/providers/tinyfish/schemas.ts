import { Schema } from "effect"

// Field names follow the TinyFish OpenAPI specs at
// https://agent.tinyfish.ai/v1/openapi/{search,fetch,browser,main,research}
// and the prose Monitor reference at https://docs.tinyfish.ai/monitor/api-reference.

export const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)
const ExtraFields = Schema.Record(Schema.String, Schema.Unknown)
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const OptionalNullableString = Schema.optional(Schema.NullishOr(Schema.String))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const DomainList = Schema.Union([Schema.String, Schema.Array(Schema.String)])

const WaitFields = {
  max_wait_seconds: Schema.optional(PositiveInt),
  poll_interval_seconds: Schema.optional(PositiveInt),
}

/* ------------------------------------------------------------------------ */
/* Search — GET https://api.search.tinyfish.ai/                              */
/* ------------------------------------------------------------------------ */

export const DomainType = Schema.Literals(["web", "news", "research_paper"])

export const SearchInputSchema = Schema.Struct({
  query: Schema.String.check(Schema.isLengthBetween(1, 2000)),
  purpose: Schema.optional(Schema.String.check(Schema.isLengthBetween(1, 2000))),
  location: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  /** Comma-separated on the wire; arrays are joined. */
  include_domains: Schema.optional(DomainList),
  exclude_domains: Schema.optional(DomainList),
  domain_type: Schema.optional(DomainType),
  after_date: Schema.optional(Schema.String),
  before_date: Schema.optional(Schema.String),
  recency_minutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5_256_000 }))),
  pub_year_min: Schema.optional(Schema.Int),
  pub_year_max: Schema.optional(Schema.Int),
  page: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
  include_thumbnail: Schema.optional(Schema.Boolean),
  /** JSON-encoded fetch configuration (max 256 chars); inner shape is undocumented. */
  fetch: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
})
export type SearchInput = typeof SearchInputSchema.Type

export const SearchResultSchema = Schema.StructWithRest(
  Schema.Struct({
    position: Schema.optional(Schema.Number),
    site_name: OptionalNullableString,
    title: Schema.String,
    url: Schema.String,
    snippet: OptionalNullableString,
  }),
  [ExtraFields],
)

export const SearchResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    query: Schema.String,
    results: Schema.Array(SearchResultSchema),
    total_results: Schema.optional(Schema.Number),
    page: Schema.optional(Schema.Number),
  }),
  [ExtraFields],
)
export type SearchResponse = typeof SearchResponseSchema.Type

/* ------------------------------------------------------------------------ */
/* Fetch — POST https://api.fetch.tinyfish.ai/                               */
/* ------------------------------------------------------------------------ */

const SelectorList = Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 1000))).check(
  Schema.isLengthBetween(1, 20),
)

export const FetchInputSchema = Schema.Struct({
  urls: Schema.Array(NonEmptyString).check(Schema.isLengthBetween(1, 10)),
  purpose: Schema.optional(Schema.String.check(Schema.isLengthBetween(1, 2000))),
  format: Schema.optional(Schema.Literals(["markdown", "html", "json"])),
  links: Schema.optional(Schema.Boolean),
  image_links: Schema.optional(Schema.Boolean),
  iframe_links: Schema.optional(Schema.Boolean),
  page_metadata: Schema.optional(Schema.Boolean),
  ttl: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  per_url_timeout_ms: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 110_000 }))),
  if_none_match: Schema.optional(Schema.String),
  if_modified_since: Schema.optional(Schema.String),
  include_etag_and_last_modified: Schema.optional(Schema.Boolean),
  include_selectors: Schema.optional(SelectorList),
  exclude_selectors: Schema.optional(SelectorList),
})
export type FetchInput = typeof FetchInputSchema.Type

export const FetchResultSchema = Schema.StructWithRest(
  Schema.Struct({
    url: Schema.String,
    final_url: OptionalNullableString,
    title: OptionalNullableString,
    format: Schema.optional(Schema.String),
    text: Schema.optional(Schema.Unknown),
  }),
  [ExtraFields],
)

export const FetchErrorSchema = Schema.StructWithRest(
  Schema.Struct({ url: Schema.String, error: Schema.String }),
  [ExtraFields],
)

export const FetchResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    results: Schema.Array(FetchResultSchema),
    errors: Schema.optional(Schema.Array(FetchErrorSchema)),
  }),
  [ExtraFields],
)
export type FetchResponse = typeof FetchResponseSchema.Type

/* ------------------------------------------------------------------------ */
/* Usage — GET {search,fetch,browser}/usage                                  */
/* ------------------------------------------------------------------------ */

export const UsageInputSchema = Schema.Struct({
  product: Schema.Literals(["search", "fetch", "browser"]),
  start_after: Schema.optional(Schema.String),
  end_before: Schema.optional(Schema.String),
  /** search/fetch: completed|failed; browser: running|ended. */
  status: Schema.optional(Schema.String),
  /** browser only. */
  session_id: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  page: Schema.optional(PositiveInt),
})
export type UsageInput = typeof UsageInputSchema.Type

/* ------------------------------------------------------------------------ */
/* Browser — https://api.browser.tinyfish.ai                                 */
/* ------------------------------------------------------------------------ */

export const BrowserCreateInputSchema = Schema.Struct({
  url: Schema.optional(Schema.String),
  timeout_seconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 86_400 }))),
  proxy_config: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      type: Schema.optional(Schema.Literals(["tinyfish", "custom"])),
      country_code: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
      username: Schema.optional(Schema.String),
      password: Schema.optional(Schema.String),
    }),
  ),
})
export type BrowserCreateInput = typeof BrowserCreateInputSchema.Type

export const BrowserSessionSchema = Schema.StructWithRest(
  Schema.Struct({
    session_id: Schema.String,
    cdp_url: Schema.String,
    base_url: Schema.String,
  }),
  [ExtraFields],
)

export const BrowserSessionIdInputSchema = Schema.Struct({ session_id: NonEmptyString })
export type BrowserSessionIdInput = typeof BrowserSessionIdInputSchema.Type

export const BrowserListInputSchema = Schema.Struct({
  start_after: Schema.optional(Schema.String),
  end_before: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["running", "ended"])),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  page: Schema.optional(PositiveInt),
})
export type BrowserListInput = typeof BrowserListInputSchema.Type

/* ------------------------------------------------------------------------ */
/* Agent — https://agent.tinyfish.ai/v1/automation, /v1/runs                 */
/* ------------------------------------------------------------------------ */

const AgentRunFields = {
  url: NonEmptyString,
  goal: NonEmptyString,
  browser_profile: Schema.optional(Schema.Literals(["lite", "stealth"])),
  api_integration: Schema.optional(Schema.String),
  agent_config: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(["default", "strict"])),
      cursor_style: Schema.optional(Schema.Literals(["fish", "standard", "green-pointer"])),
      max_steps: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
      max_duration_seconds: Schema.optional(PositiveInt),
    }),
  ),
  capture_config: Schema.optional(
    Schema.Struct({
      elements: Schema.optional(Schema.Boolean),
      snapshots: Schema.optional(Schema.Boolean),
      screenshots: Schema.optional(Schema.Boolean),
      recording: Schema.optional(Schema.Boolean),
      html: Schema.optional(Schema.Boolean),
    }),
  ),
  webhook_url: Schema.optional(Schema.String),
  use_vault: Schema.optional(Schema.Boolean),
  use_profile: Schema.optional(Schema.Boolean),
  profile_id: Schema.optional(Schema.String),
  credential_item_ids: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
  proxy_config: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      country_code: Schema.optional(Schema.String),
    }),
  ),
  output_schema: Schema.optional(JsonRecord),
}

export const AgentStartInputSchema = Schema.Struct(AgentRunFields)
export type AgentStartInput = typeof AgentStartInputSchema.Type

export const AgentRunInputSchema = Schema.Struct({ ...AgentRunFields, ...WaitFields })
export type AgentRunInput = typeof AgentRunInputSchema.Type

export const AgentStreamInputSchema = Schema.Struct({
  ...AgentRunFields,
  max_wait_seconds: Schema.optional(PositiveInt),
})
export type AgentStreamInput = typeof AgentStreamInputSchema.Type

export const AgentRunIdInputSchema = Schema.Struct({
  run_id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  screenshots: Schema.optional(Schema.Literals(["base64", "url", "none"])),
  html: Schema.optional(Schema.Literals(["url", "none"])),
})
export type AgentRunIdInput = typeof AgentRunIdInputSchema.Type

export const AgentRunRefInputSchema = Schema.Struct({
  run_id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
})
export type AgentRunRefInput = typeof AgentRunRefInputSchema.Type

export const AgentWaitInputSchema = Schema.Struct({
  run_id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  ...WaitFields,
})
export type AgentWaitInput = typeof AgentWaitInputSchema.Type

export const AgentRunStatus = Schema.Literals(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"])

export const AgentListInputSchema = Schema.Struct({
  status: Schema.optional(AgentRunStatus),
  goal: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  created_after: Schema.optional(Schema.String),
  created_before: Schema.optional(Schema.String),
  sort_direction: Schema.optional(Schema.Literals(["asc", "desc"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
export type AgentListInput = typeof AgentListInputSchema.Type

export const AgentAsyncResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    run_id: Schema.NullishOr(Schema.String),
    error: Schema.optional(Schema.NullishOr(Schema.Unknown)),
  }),
  [ExtraFields],
)

export const AgentRunSchema = Schema.StructWithRest(
  Schema.Struct({
    run_id: Schema.String,
    status: Schema.String,
  }),
  [ExtraFields],
)
export type AgentRun = typeof AgentRunSchema.Type

export const AgentRunListSchema = Schema.StructWithRest(
  Schema.Struct({
    data: Schema.Array(AgentRunSchema),
    pagination: Schema.optional(JsonRecord),
  }),
  [ExtraFields],
)

export const AgentCancelSchema = Schema.StructWithRest(
  Schema.Struct({ run_id: Schema.String, status: Schema.String }),
  [ExtraFields],
)

/* ------------------------------------------------------------------------ */
/* Browser Context Profiles — /v1/profiles                                   */
/* ------------------------------------------------------------------------ */

export const ProfileCreateInputSchema = Schema.Struct({
  name: Schema.String.check(Schema.isLengthBetween(1, 100)),
  set_as_default: Schema.optional(Schema.Boolean),
  proxy_country_code: OptionalNullableString,
})
export type ProfileCreateInput = typeof ProfileCreateInputSchema.Type

export const ProfileIdInputSchema = Schema.Struct({ profile_id: NonEmptyString })
export type ProfileIdInput = typeof ProfileIdInputSchema.Type

export const ProfileUpdateInputSchema = Schema.Struct({
  profile_id: NonEmptyString,
  name: Schema.optional(Schema.String.check(Schema.isLengthBetween(1, 100))),
  set_as_default: Schema.optional(Schema.Boolean),
  proxy_country_code: OptionalNullableString,
})
export type ProfileUpdateInput = typeof ProfileUpdateInputSchema.Type

export const EmptyInputSchema = Schema.Struct({})

/* ------------------------------------------------------------------------ */
/* Research (beta) — /v1/automation/run-research-async, /v1/research-run     */
/* ------------------------------------------------------------------------ */

const ResearchFields = {
  query: Schema.String.check(Schema.isLengthBetween(1, 2000)),
  mode: Schema.optional(Schema.Literals(["deep", "max"])),
  stream: Schema.optional(Schema.Boolean),
  output_language: Schema.optional(Schema.String),
  weak_sources_enabled: Schema.optional(Schema.Boolean),
  domain_type: Schema.optional(DomainType),
  after_date: Schema.optional(Schema.String),
  before_date: Schema.optional(Schema.String),
  recency_minutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5_256_000 }))),
  domain_filter: Schema.optional(
    Schema.Struct({
      mode: Schema.Literals(["include", "exclusive"]),
      domains: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(150))),
      block: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(150))),
    }),
  ),
  prior_run_id: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
}

export const ResearchStartInputSchema = Schema.Struct(ResearchFields)
export type ResearchStartInput = typeof ResearchStartInputSchema.Type

export const ResearchRunInputSchema = Schema.Struct({ ...ResearchFields, ...WaitFields })
export type ResearchRunInput = typeof ResearchRunInputSchema.Type

export const ResearchIdInputSchema = Schema.Struct({ research_run_id: NonEmptyString })
export type ResearchIdInput = typeof ResearchIdInputSchema.Type

export const ResearchWaitInputSchema = Schema.Struct({ research_run_id: NonEmptyString, ...WaitFields })
export type ResearchWaitInput = typeof ResearchWaitInputSchema.Type

export const ResearchEventsInputSchema = Schema.Struct({
  research_run_id: NonEmptyString,
  last_event_id: Schema.optional(Schema.String),
  /** Stop reading the live stream after this many seconds (default 30). */
  max_wait_seconds: Schema.optional(PositiveInt),
})
export type ResearchEventsInput = typeof ResearchEventsInputSchema.Type

export const ResearchListInputSchema = Schema.Struct({
  status: Schema.optional(
    Schema.Literals(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]),
  ),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  created_after: Schema.optional(Schema.String),
  created_before: Schema.optional(Schema.String),
  sort_direction: Schema.optional(Schema.Literals(["asc", "desc"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
export type ResearchListInput = typeof ResearchListInputSchema.Type

export const ResearchAsyncResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    research_run_id: Schema.NullishOr(Schema.String),
    error: Schema.optional(Schema.NullishOr(Schema.Unknown)),
  }),
  [ExtraFields],
)

export const ResearchRunSchema = Schema.StructWithRest(
  Schema.Struct({
    research_run_id: Schema.String,
    status: Schema.String,
    deep_result: Schema.optional(
      Schema.NullishOr(
        Schema.StructWithRest(
          Schema.Struct({
            result: Schema.optional(Schema.String),
            citations: Schema.optional(Schema.Array(Schema.String)),
          }),
          [ExtraFields],
        ),
      ),
    ),
  }),
  [ExtraFields],
)
export type ResearchRun = typeof ResearchRunSchema.Type

export const ResearchListSchema = Schema.StructWithRest(
  Schema.Struct({
    data: Schema.Array(ResearchRunSchema),
    pagination: Schema.optional(JsonRecord),
  }),
  [ExtraFields],
)

/* ------------------------------------------------------------------------ */
/* Monitors — /v1/monitors (prose docs only; no OpenAPI)                     */
/* ------------------------------------------------------------------------ */

export const MonitorCreateInputSchema = Schema.Struct({
  /** fetch = Page Monitor, search = Topic Monitor. */
  type: Schema.Literals(["fetch", "search"]),
  /** Page: {url, format?, links?, image_links?}. Topic: {query, recency_minutes?, result_limit?}. */
  config: JsonRecord,
  /** 5-field cron, UTC unless prefixed with `CRON_TZ=<IANA> `. */
  schedule_cron: NonEmptyString,
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
  purpose: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  webhook_url: Schema.optional(Schema.String),
})
export type MonitorCreateInput = typeof MonitorCreateInputSchema.Type

export const MonitorIdInputSchema = Schema.Struct({ id: NonEmptyString })
export type MonitorIdInput = typeof MonitorIdInputSchema.Type

export const MonitorUpdateInputSchema = Schema.Struct({
  id: NonEmptyString,
  /** Status-only update; never combined with field edits. */
  status: Schema.optional(Schema.Literals(["active", "paused"])),
  schedule_cron: Schema.optional(Schema.String),
  name: OptionalNullableString,
  purpose: OptionalNullableString,
  webhook_url: OptionalNullableString,
})
export type MonitorUpdateInput = typeof MonitorUpdateInputSchema.Type
