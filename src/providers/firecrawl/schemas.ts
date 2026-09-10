import { Schema } from "effect"

/**
 * Firecrawl v2 input codecs. Field names mirror the CLI's snake_case JSON
 * payloads; api.ts maps them onto the provider's camelCase wire format.
 */

export const SIMPLE_FORMATS = [
  "markdown",
  "summary",
  "html",
  "rawHtml",
  "rawBase64",
  "links",
  "images",
  "branding",
  "product",
  "menu",
  "audio",
  "video",
] as const

export const PII_MODES = ["accurate", "aggressive", "fast"] as const
export const PII_ENTITIES = ["PERSON", "EMAIL", "PHONE", "LOCATION", "FINANCIAL", "SECRET"] as const
export const PII_REPLACE_STYLES = ["tag", "mask", "remove"] as const
export const PDF_PAGE_FORMATS = [
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "Letter",
  "Legal",
  "Tabloid",
  "Ledger",
] as const

export const PROXY_TYPES = ["basic", "enhanced", "auto"] as const
export const PDF_PARSER_MODES = ["fast", "auto", "ocr"] as const
export const CHANGE_TRACKING_MODES = ["git-diff", "json"] as const
export const SITEMAP_MODES = ["skip", "include", "only"] as const

export type SimpleFormat = (typeof SIMPLE_FORMATS)[number]
export type ProxyType = (typeof PROXY_TYPES)[number]
export type PdfParserMode = (typeof PDF_PARSER_MODES)[number]
export type ChangeTrackingMode = (typeof CHANGE_TRACKING_MODES)[number]
export type SitemapMode = (typeof SITEMAP_MODES)[number]
export type JsonSchema = Record<string, unknown>
export type JsonRecord = Record<string, unknown>

export const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown).annotate({
  title: "JSON object",
  description: "Arbitrary JSON object",
})

const NonNegativeIntegerSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const PositiveIntegerSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const TimeoutMsSchema = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1000, maximum: 300000 }))
const QualitySchema = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
const CountryCodeSchema = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}$/, {
    message: "must be an ISO alpha-2 country code",
  }),
)

const SimpleFormatSchema = Schema.Literals(SIMPLE_FORMATS)
const ProxySchema = Schema.Literals(PROXY_TYPES)
const PdfParserModeSchema = Schema.Literals(PDF_PARSER_MODES)
const ChangeTrackingModeSchema = Schema.Literals(CHANGE_TRACKING_MODES)
const SitemapModeSchema = Schema.Literals(SITEMAP_MODES)
const JsonSchemaInputSchema = Schema.Union([Schema.String, JsonObjectSchema])

const ScreenshotInputSchema = Schema.Struct({
  fullPage: Schema.optional(Schema.Boolean),
  quality: Schema.optional(QualitySchema),
  viewport: Schema.optional(
    Schema.Struct({
      width: PositiveIntegerSchema,
      height: PositiveIntegerSchema,
    }),
  ),
}).annotate({
  title: "Screenshot options",
})

const ChangeTrackingInputSchema = Schema.Struct({
  modes: Schema.optional(Schema.Array(ChangeTrackingModeSchema)),
  schema: Schema.optional(JsonSchemaInputSchema),
  prompt: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
}).annotate({
  title: "Change tracking options",
})

const RedactPiiObjectSchema = Schema.Struct({
  mode: Schema.optional(Schema.Literals(PII_MODES)),
  entities: Schema.optional(Schema.Array(Schema.Literals(PII_ENTITIES))),
  replace_style: Schema.optional(Schema.Literals(PII_REPLACE_STYLES)),
})

const ProfileInputSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  save_changes: Schema.optional(Schema.Boolean),
})

const StringRecordSchema = Schema.Record(Schema.String, Schema.String)

const WaitDurationActionSchema = Schema.Struct({
  type: Schema.Literals(["wait"]),
  milliseconds: PositiveIntegerSchema,
})

const WaitSelectorActionSchema = Schema.Struct({
  type: Schema.Literals(["wait"]),
  selector: Schema.String,
})

const ActionSchema = Schema.Union([
  WaitDurationActionSchema,
  WaitSelectorActionSchema,
  Schema.Struct({
    type: Schema.Literals(["screenshot"]),
    fullPage: Schema.optional(Schema.Boolean),
    quality: Schema.optional(QualitySchema),
    viewport: Schema.optional(
      Schema.Struct({
        width: PositiveIntegerSchema,
        height: PositiveIntegerSchema,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literals(["click"]),
    selector: Schema.String,
    all: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literals(["write"]),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["press"]),
    key: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["scroll"]),
    direction: Schema.optional(Schema.Literals(["up", "down"])),
    selector: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literals(["scrape"]),
  }),
  Schema.Struct({
    type: Schema.Literals(["executeJavascript"]),
    script: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["pdf"]),
    format: Schema.optional(Schema.Literals(PDF_PAGE_FORMATS)),
    landscape: Schema.optional(Schema.Boolean),
    scale: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  }),
])
export type ScrapeAction = typeof ActionSchema.Type

const LocationInputSchema = Schema.Struct({
  country: Schema.optional(CountryCodeSchema),
  languages: Schema.optional(Schema.Array(Schema.String)),
}).annotate({
  title: "Location options",
})

export const CommonScrapeInputSchema = Schema.Struct({
  formats: Schema.optional(Schema.Array(SimpleFormatSchema)),
  json_schema: Schema.optional(JsonSchemaInputSchema),
  json_prompt: Schema.optional(Schema.String),
  json_check_prompt_injection: Schema.optional(Schema.Boolean),
  question: Schema.optional(Schema.String.check(Schema.isMaxLength(10000))),
  highlights_query: Schema.optional(Schema.String.check(Schema.isMaxLength(10000))),
  screenshot: Schema.optional(ScreenshotInputSchema),
  change_tracking: Schema.optional(ChangeTrackingInputSchema),
  only_main_content: Schema.optional(Schema.Boolean),
  only_clean_content: Schema.optional(Schema.Boolean),
  include_tags: Schema.optional(Schema.Array(Schema.String)),
  exclude_tags: Schema.optional(Schema.Array(Schema.String)),
  headers: Schema.optional(StringRecordSchema),
  wait_for: Schema.optional(NonNegativeIntegerSchema),
  max_age: Schema.optional(NonNegativeIntegerSchema),
  min_age: Schema.optional(PositiveIntegerSchema),
  timeout: Schema.optional(TimeoutMsSchema),
  mobile: Schema.optional(Schema.Boolean),
  skip_tls_verification: Schema.optional(Schema.Boolean),
  location: Schema.optional(LocationInputSchema),
  proxy: Schema.optional(ProxySchema),
  pdf_parser_mode: Schema.optional(PdfParserModeSchema),
  pdf_max_pages: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10000 })),
  ),
  pdf_pages: Schema.optional(Schema.Boolean),
  pdf_blocks: Schema.optional(Schema.Boolean),
  pdf_page_markers: Schema.optional(Schema.Boolean),
  actions: Schema.optional(Schema.Array(ActionSchema)),
  store_in_cache: Schema.optional(Schema.Boolean),
  remove_base64_images: Schema.optional(Schema.Boolean),
  block_ads: Schema.optional(Schema.Boolean),
  lockdown: Schema.optional(Schema.Boolean),
  redact_pii: Schema.optional(Schema.Union([Schema.Boolean, RedactPiiObjectSchema])),
  profile: Schema.optional(ProfileInputSchema),
  zero_data_retention: Schema.optional(Schema.Boolean),
}).annotate({
  title: "Common scrape input",
  description:
    "Shared Firecrawl scrape options accepted by scrape, batch start, crawl scrape_options, and search scrape_options.",
})
export type CommonScrapeInput = typeof CommonScrapeInputSchema.Type

export const ScrapeInputSchema = Schema.Struct({
  ...CommonScrapeInputSchema.fields,
  url: Schema.String,
}).annotate({
  title: "Scrape input",
  description: "Scrape one URL with optional output formats and extraction options.",
})
export type ScrapeInput = typeof ScrapeInputSchema.Type

export const ScrapeCommandInputSchema = Schema.Union([
  ScrapeInputSchema,
  Schema.Array(ScrapeInputSchema),
]).annotate({
  title: "Scrape command input",
  description: "A single scrape object or an ordered array for local batch scraping.",
})
export type ScrapeCommandInput = typeof ScrapeCommandInputSchema.Type

export const BatchStartInputSchema = Schema.Struct({
  ...CommonScrapeInputSchema.fields,
  urls: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  max_concurrency: Schema.optional(PositiveIntegerSchema),
  ignore_invalid_urls: Schema.optional(Schema.Boolean),
  webhook: Schema.optional(JsonObjectSchema),
}).annotate({
  title: "Batch start input",
  description: "Start a provider-owned Firecrawl batch scrape job.",
})
export type BatchStartInput = typeof BatchStartInputSchema.Type

export const JobIdInputSchema = Schema.Struct({
  id: Schema.String,
}).annotate({
  title: "Job id input",
})
export type JobIdInput = typeof JobIdInputSchema.Type

export const JobCheckInputSchema = Schema.Struct({
  ...JobIdInputSchema.fields,
  next_url: Schema.optional(Schema.String),
}).annotate({
  title: "Job check input",
})
export type JobCheckInput = typeof JobCheckInputSchema.Type

export const WaitInputSchema = Schema.Struct({
  ...JobCheckInputSchema.fields,
  poll_interval_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 50, maximum: 60000 })),
  ),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 50, maximum: 86_400_000 })),
  ),
}).annotate({
  title: "Wait input",
})
export type WaitInput = typeof WaitInputSchema.Type

export const CrawlStartInputSchema = Schema.Struct({
  url: Schema.String,
  prompt: Schema.optional(Schema.String),
  exclude_paths: Schema.optional(Schema.Array(Schema.String)),
  include_paths: Schema.optional(Schema.Array(Schema.String)),
  max_discovery_depth: Schema.optional(NonNegativeIntegerSchema),
  sitemap: Schema.optional(SitemapModeSchema),
  ignore_query_parameters: Schema.optional(Schema.Boolean),
  regex_on_full_url: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveIntegerSchema),
  crawl_entire_domain: Schema.optional(Schema.Boolean),
  allow_external_links: Schema.optional(Schema.Boolean),
  allow_subdomains: Schema.optional(Schema.Boolean),
  ignore_robots_txt: Schema.optional(Schema.Boolean),
  robots_user_agent: Schema.optional(Schema.String),
  delay: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  max_concurrency: Schema.optional(PositiveIntegerSchema),
  webhook: Schema.optional(JsonObjectSchema),
  scrape_options: Schema.optional(CommonScrapeInputSchema),
  zero_data_retention: Schema.optional(Schema.Boolean),
}).annotate({
  title: "Crawl start input",
  description: "Start a provider-owned Firecrawl crawl job.",
})
export type CrawlStartInput = typeof CrawlStartInputSchema.Type

export const MapInputSchema = Schema.Struct({
  url: Schema.String,
  search: Schema.optional(Schema.String),
  sitemap: Schema.optional(SitemapModeSchema),
  include_subdomains: Schema.optional(Schema.Boolean),
  ignore_query_parameters: Schema.optional(Schema.Boolean),
  ignore_cache: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100000 })),
  ),
  timeout: Schema.optional(PositiveIntegerSchema),
  location: Schema.optional(LocationInputSchema),
}).annotate({
  title: "Map input",
  description: "Map a website to discovered URLs.",
})
export type MapInput = typeof MapInputSchema.Type

export const MapCommandInputSchema = Schema.Union([
  MapInputSchema,
  Schema.Array(MapInputSchema),
]).annotate({
  title: "Map command input",
  description: "A single map object or an ordered array for local batch mapping.",
})
export type MapCommandInput = typeof MapCommandInputSchema.Type

const SEARCH_SOURCES = ["web", "images", "news"] as const
const SEARCH_CATEGORIES = ["developer", "research", "pdf"] as const
const SEARCH_ENTERPRISE = ["anon", "zdr"] as const

export type SearchSource = (typeof SEARCH_SOURCES)[number]
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number]

const SearchLimitSchema = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))

const SearchSourceObjectSchema = Schema.Struct({
  type: Schema.Literals(SEARCH_SOURCES),
  tbs: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
})

const SearchCategoryObjectSchema = Schema.Struct({
  type: Schema.Literals(SEARCH_CATEGORIES),
})

const SearchSourceInputSchema = Schema.Union([
  Schema.Literals(SEARCH_SOURCES),
  SearchSourceObjectSchema,
])

const SearchCategoryInputSchema = Schema.Union([
  Schema.Literals(SEARCH_CATEGORIES),
  SearchCategoryObjectSchema,
])

export const SearchInputSchema = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(SearchLimitSchema),
  sources: Schema.optional(Schema.Array(SearchSourceInputSchema)),
  categories: Schema.optional(Schema.Array(SearchCategoryInputSchema)),
  include_domains: Schema.optional(Schema.Array(Schema.String)),
  exclude_domains: Schema.optional(Schema.Array(Schema.String)),
  tbs: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  country: Schema.optional(CountryCodeSchema),
  safe: Schema.optional(Schema.Boolean),
  timeout: Schema.optional(TimeoutMsSchema),
  ignore_invalid_urls: Schema.optional(Schema.Boolean),
  highlights: Schema.optional(Schema.Boolean),
  enterprise: Schema.optional(Schema.Array(Schema.Literals(SEARCH_ENTERPRISE))),
  scrape_options: Schema.optional(CommonScrapeInputSchema),
}).annotate({
  title: "Search input",
  description: "Search the web with Firecrawl v2 and optionally scrape result pages.",
})
export type SearchInput = typeof SearchInputSchema.Type

export const SearchCommandInputSchema = Schema.Union([
  SearchInputSchema,
  Schema.Array(SearchInputSchema),
]).annotate({
  title: "Search command input",
  description: "A single search object or an ordered array for local batch search.",
})
export type SearchCommandInput = typeof SearchCommandInputSchema.Type

const PARSE_EXTENSIONS = [
  ".html",
  ".htm",
  ".xhtml",
  ".pdf",
  ".docx",
  ".doc",
  ".docm",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
  ".xlsx",
  ".xls",
  ".xlsm",
  ".xlsb",
  ".pptx",
  ".ppt",
  ".pptm",
  ".epub",
  ".csv",
] as const
export { PARSE_EXTENSIONS }

export const PARSE_MIME: Record<(typeof PARSE_EXTENSIONS)[number], string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".xhtml": "application/xhtml+xml",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".docm": "application/vnd.ms-word.document.macroEnabled.12",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  ".epub": "application/epub+zip",
  ".csv": "text/csv",
}

export const PARSE_FORMATS = ["markdown", "summary", "html", "rawHtml", "links", "images"] as const
const PARSE_PROXY_TYPES = ["basic", "auto"] as const
export const MAX_PARSE_BYTES = 50 * 1024 * 1024

const ParseTimeoutMsSchema = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 300000 }))

export const ParseInputSchema = Schema.Struct({
  path: Schema.String,
  formats: Schema.optional(Schema.Array(Schema.Literals(PARSE_FORMATS))),
  json_schema: Schema.optional(JsonSchemaInputSchema),
  json_prompt: Schema.optional(Schema.String),
  only_main_content: Schema.optional(Schema.Boolean),
  include_tags: Schema.optional(Schema.Array(Schema.String)),
  exclude_tags: Schema.optional(Schema.Array(Schema.String)),
  headers: Schema.optional(StringRecordSchema),
  timeout: Schema.optional(ParseTimeoutMsSchema),
  pdf_parser_mode: Schema.optional(Schema.Literals(PDF_PARSER_MODES)),
  pdf_max_pages: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10000 })),
  ),
  pdf_pages: Schema.optional(Schema.Boolean),
  pdf_blocks: Schema.optional(Schema.Boolean),
  pdf_page_markers: Schema.optional(Schema.Boolean),
  skip_tls_verification: Schema.optional(Schema.Boolean),
  remove_base64_images: Schema.optional(Schema.Boolean),
  block_ads: Schema.optional(Schema.Boolean),
  redact_pii: Schema.optional(Schema.Union([Schema.Boolean, RedactPiiObjectSchema])),
  proxy: Schema.optional(Schema.Literals(PARSE_PROXY_TYPES)),
  zero_data_retention: Schema.optional(Schema.Boolean),
}).annotate({
  title: "Parse input",
  description: "Upload a local document and parse it with Firecrawl /v2/parse.",
})
export type ParseInput = typeof ParseInputSchema.Type

export const ParseCommandInputSchema = Schema.Union([
  ParseInputSchema,
  Schema.Array(ParseInputSchema),
]).annotate({
  title: "Parse command input",
  description: "A single parse object or an ordered array for local batch parsing.",
})
export type ParseCommandInput = typeof ParseCommandInputSchema.Type

export const ExtractStartInputSchema = Schema.Struct({
  urls: Schema.optional(Schema.Array(Schema.String)),
  prompt: Schema.optional(Schema.String),
  schema: Schema.optional(JsonSchemaInputSchema),
  enable_web_search: Schema.optional(Schema.Boolean),
  ignore_sitemap: Schema.optional(Schema.Boolean),
  include_subdomains: Schema.optional(Schema.Boolean),
  show_sources: Schema.optional(Schema.Boolean),
  scrape_options: Schema.optional(CommonScrapeInputSchema),
  ignore_invalid_urls: Schema.optional(Schema.Boolean),
}).annotate({
  title: "Extract start input",
  description:
    "Start a Firecrawl /v2/extract job. Prefer agent for new work; extract remains available for known-URL multi-page extraction.",
})
export type ExtractStartInput = typeof ExtractStartInputSchema.Type

const AGENT_MODELS = ["spark-2", "spark-1-mini", "spark-1-pro"] as const
const AGENT_EFFORTS = ["low", "medium", "high"] as const
const AGENT_WEBHOOK_EVENTS = ["started", "action", "completed", "failed", "cancelled"] as const

const AgentWebhookSchema = Schema.Struct({
  url: Schema.String,
  headers: Schema.optional(StringRecordSchema),
  metadata: Schema.optional(StringRecordSchema),
  events: Schema.optional(Schema.Array(Schema.Literals(AGENT_WEBHOOK_EVENTS))),
})

export const AgentStartInputSchema = Schema.Struct({
  prompt: Schema.String,
  urls: Schema.optional(Schema.Array(Schema.String)),
  schema: Schema.optional(JsonSchemaInputSchema),
  max_credits: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  strict_constrain_to_urls: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.Literals(AGENT_MODELS)),
  effort: Schema.optional(Schema.Literals(AGENT_EFFORTS)),
  webhook: Schema.optional(AgentWebhookSchema),
}).annotate({
  title: "Agent start input",
  description: "Start a Firecrawl /v2/agent job. Prompt is required; URLs are optional.",
})
export type AgentStartInput = typeof AgentStartInputSchema.Type

export const AgentListInputSchema = Schema.Struct({
  before: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
}).annotate({
  title: "Agent list input",
  description: "List recent agent runs. Pages are fixed at 20; pass before from the previous next URL.",
})
export type AgentListInput = typeof AgentListInputSchema.Type

export const AgentEventsInputSchema = Schema.Struct({
  ...JobIdInputSchema.fields,
  live_view: Schema.optional(Schema.Boolean),
}).annotate({
  title: "Agent events input",
  description: "Fetch the REST execution trace for an agent job.",
})
export type AgentEventsInput = typeof AgentEventsInputSchema.Type

const INTERACT_LANGUAGES = ["python", "node", "bash"] as const

export const InteractExecuteInputSchema = Schema.Struct({
  id: Schema.String,
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(10000))),
  code: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
  language: Schema.optional(Schema.Literals(INTERACT_LANGUAGES)),
  timeout: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 300 }))),
  origin: Schema.optional(Schema.String),
}).annotate({
  title: "Interact execute input",
  description:
    "Continue a scrape-bound browser session. id is data.metadata.scrapeId from a prior scrape. Provide prompt or code, not both.",
})
export type InteractExecuteInput = typeof InteractExecuteInputSchema.Type

export type ProviderJobKind = "batch_scrape" | "crawl" | "agent" | "extract"

export type NormalizedJobStatus =
  | "submitted"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "unknown"

export interface ProviderJobSnapshot {
  readonly provider: "firecrawl"
  readonly kind: ProviderJobKind
  readonly id?: string | undefined
  readonly status: NormalizedJobStatus
  readonly provider_status?: string | undefined
  readonly terminal: boolean
  readonly progress?: {
    readonly completed?: number | undefined
    readonly total?: number | undefined
    readonly credits_used?: number | undefined
  } | undefined
  readonly next_url?: string | null | undefined
  readonly expires_at?: string | undefined
  readonly data_count?: number | undefined
  readonly provider_response: unknown
}
