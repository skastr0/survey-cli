import { Schema } from "effect"

export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

const PublicSearchType = Schema.Literals([
  "auto",
  "fast",
  "instant",
  "deep-lite",
  "deep",
  "deep-reasoning",
])
const SearchType = Schema.Union([PublicSearchType, Schema.Literal("neural")])
const LivecrawlMode = Schema.Literals(["never", "always", "fallback", "preferred"])
const SearchCategory = Schema.Literals([
  "company",
  "publication",
  "news",
  "personal site",
  "financial report",
  "people",
  "research paper",
  "pdf",
  "github",
  "tweet",
])
const PageSection = Schema.Literals([
  "header",
  "navigation",
  "banner",
  "body",
  "sidebar",
  "footer",
  "metadata",
])
const SearchTextFilter = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const AgentEffort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "auto", "max"])
const AgentDataSourceProvider = Schema.Literals([
  "fiber",
  "financial_datasets",
  "similarweb",
  "baselayer",
  "affiliate",
  "particle",
  "jinko",
  "polymarket",
])
const AnswerModel = Schema.Literals(["exa", "exa-pro", "exa-research", "exa-fast"])

const TextContentsOptions = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    maxCharacters: Schema.optional(Schema.Number),
    includeHtmlTags: Schema.optional(Schema.Boolean),
    verbosity: Schema.optional(Schema.Literals(["compact", "standard", "full"])),
    includeSections: Schema.optional(Schema.Array(PageSection)),
    excludeSections: Schema.optional(Schema.Array(PageSection)),
  }),
])

const HighlightsContentsOptions = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    query: Schema.optional(Schema.String),
    verbosity: Schema.optional(Schema.Literals(["low", "medium", "high"])),
    dynamic: Schema.optional(Schema.Boolean),
    maxCharacters: Schema.optional(Schema.Number),
  }),
])

const SummaryContentsOptions = Schema.Struct({
  query: Schema.optional(Schema.String),
  schema: Schema.optional(UnknownRecord),
})

const ExtrasContentsOptions = Schema.Struct({
  links: Schema.optional(Schema.Number),
  imageLinks: Schema.optional(Schema.Number),
  richImageLinks: Schema.optional(Schema.Number),
  richLinks: Schema.optional(Schema.Number),
  codeBlocks: Schema.optional(Schema.Number),
})

const ContextContentsOptions = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    maxCharacters: Schema.optional(Schema.Number),
  }),
])

export const ContentsOptionsSchema = Schema.Struct({
  text: Schema.optional(TextContentsOptions),
  highlights: Schema.optional(HighlightsContentsOptions),
  summary: Schema.optional(SummaryContentsOptions),
  extras: Schema.optional(ExtrasContentsOptions),
  context: Schema.optional(ContextContentsOptions),
  livecrawl: Schema.optional(LivecrawlMode),
  livecrawlTimeout: Schema.optional(Schema.Number),
  maxAgeHours: Schema.optional(Schema.Number),
  subpages: Schema.optional(Schema.Number),
  subpageTarget: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})

export const WebSearchInputSchema = Schema.Struct({
  query: Schema.String,
  numResults: Schema.optional(Schema.Number),
  livecrawl: Schema.optional(LivecrawlMode),
  type: Schema.optional(SearchType),
  contextMaxCharacters: Schema.optional(Schema.Number),
  category: Schema.optional(SearchCategory),
  includeDomains: Schema.optional(Schema.Array(Schema.String)),
  excludeDomains: Schema.optional(Schema.Array(Schema.String)),
  startPublishedDate: Schema.optional(Schema.String),
  endPublishedDate: Schema.optional(Schema.String),
  includeText: Schema.optional(SearchTextFilter),
  excludeText: Schema.optional(SearchTextFilter),
  userLocation: Schema.optional(Schema.String),
  moderation: Schema.optional(Schema.Boolean),
  additionalQueries: Schema.optional(Schema.Array(Schema.String)),
  outputSchema: Schema.optional(UnknownRecord),
  systemPrompt: Schema.optional(Schema.String),
  stream: Schema.optional(Schema.Boolean),
  contents: Schema.optional(ContentsOptionsSchema),
})

export const CodeContextInputSchema = Schema.Struct({
  query: Schema.String,
  tokensNum: Schema.optional(Schema.Union([Schema.Literal("dynamic"), Schema.Number])),
  flags: Schema.optional(Schema.Array(Schema.String)),
})

export const CrawlInputSchema = Schema.Struct({
  url: Schema.String,
  maxCharacters: Schema.optional(Schema.Number),
})

export const ContentsInputSchema = Schema.Struct({
  ids: Schema.optional(Schema.Array(Schema.String)),
  urls: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  text: Schema.optional(TextContentsOptions),
  highlights: Schema.optional(HighlightsContentsOptions),
  summary: Schema.optional(SummaryContentsOptions),
  extras: Schema.optional(ExtrasContentsOptions),
  context: Schema.optional(ContextContentsOptions),
  livecrawl: Schema.optional(LivecrawlMode),
  livecrawlTimeout: Schema.optional(Schema.Number),
  maxAgeHours: Schema.optional(Schema.Number),
  subpages: Schema.optional(Schema.Number),
  subpageTarget: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  maxCharacters: Schema.optional(Schema.Number),
})

export const AnswerInputSchema = Schema.Struct({
  query: Schema.String,
  text: Schema.optional(Schema.Boolean),
  model: Schema.optional(AnswerModel),
  systemPrompt: Schema.optional(Schema.String),
  userLocation: Schema.optional(Schema.String),
  outputSchema: Schema.optional(UnknownRecord),
  stream: Schema.optional(Schema.Boolean),
})

export const CompanyResearchInputSchema = Schema.Struct({
  companyName: Schema.String,
  numResults: Schema.optional(Schema.Number),
})

export const LinkedinSearchInputSchema = Schema.Struct({
  query: Schema.String,
  searchType: Schema.optional(Schema.Literals(["profiles", "companies", "all"])),
  numResults: Schema.optional(Schema.Number),
})

const AgentInputRows = Schema.Struct({
  data: Schema.optional(Schema.Array(UnknownRecord)),
  exclusion: Schema.optional(Schema.Array(UnknownRecord)),
})

const AgentBudget = Schema.Struct({
  maxCostDollars: Schema.optional(Schema.Number),
})

const AgentDataSource = Schema.Struct({
  provider: AgentDataSourceProvider,
})

export const AgentStartInputSchema = Schema.Struct({
  query: Schema.String,
  systemPrompt: Schema.optional(Schema.String),
  input: Schema.optional(AgentInputRows),
  outputSchema: Schema.optional(UnknownRecord),
  effort: Schema.optional(AgentEffort),
  previousRunId: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dataSources: Schema.optional(Schema.Array(AgentDataSource)),
  budget: Schema.optional(AgentBudget),
})

export const AgentIdInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
})

export const AgentListInputSchema = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const AgentWaitInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  intervalMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
})

export const AgentEventsInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const AgentStreamInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  lastEventId: Schema.optional(Schema.String),
})

export const DeepResearchStartInputSchema = Schema.Struct({
  instructions: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  model: Schema.optional(Schema.Literals(["exa-research-fast", "exa-research", "exa-research-pro"])),
  outputSchema: Schema.optional(UnknownRecord),
  systemPrompt: Schema.optional(Schema.String),
  effort: Schema.optional(AgentEffort),
  input: Schema.optional(AgentInputRows),
  previousRunId: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dataSources: Schema.optional(Schema.Array(AgentDataSource)),
  budget: Schema.optional(AgentBudget),
})

export const DeepResearchCheckInputSchema = Schema.Struct({
  researchId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
})

export const DeepResearchListInputSchema = AgentListInputSchema

export const DeepResearchWaitInputSchema = Schema.Struct({
  researchId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  intervalMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
})

export const DeepResearchEventsInputSchema = Schema.Struct({
  researchId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const DeepResearchStreamInputSchema = Schema.Struct({
  researchId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  lastEventId: Schema.optional(Schema.String),
})

export const FindSimilarInputSchema = Schema.Struct({
  url: Schema.String,
  numResults: Schema.optional(Schema.Number),
  includeDomains: Schema.optional(Schema.Array(Schema.String)),
  excludeDomains: Schema.optional(Schema.Array(Schema.String)),
  startPublishedDate: Schema.optional(Schema.String),
  endPublishedDate: Schema.optional(Schema.String),
  category: Schema.optional(SearchCategory),
  excludeSourceDomain: Schema.optional(Schema.Boolean),
  contents: Schema.optional(ContentsOptionsSchema),
})

export type WebSearchInput = typeof WebSearchInputSchema.Type
export type CodeContextInput = typeof CodeContextInputSchema.Type
export type CrawlInput = typeof CrawlInputSchema.Type
export type ContentsInput = typeof ContentsInputSchema.Type
export type AnswerInput = typeof AnswerInputSchema.Type
export type CompanyResearchInput = typeof CompanyResearchInputSchema.Type
export type LinkedinSearchInput = typeof LinkedinSearchInputSchema.Type
export type AgentStartInput = typeof AgentStartInputSchema.Type
export type AgentIdInput = typeof AgentIdInputSchema.Type
export type AgentListInput = typeof AgentListInputSchema.Type
export type AgentWaitInput = typeof AgentWaitInputSchema.Type
export type AgentEventsInput = typeof AgentEventsInputSchema.Type
export type AgentStreamInput = typeof AgentStreamInputSchema.Type
export type DeepResearchStartInput = typeof DeepResearchStartInputSchema.Type
export type DeepResearchIdInput = typeof DeepResearchCheckInputSchema.Type
export type DeepResearchListInput = typeof DeepResearchListInputSchema.Type
export type DeepResearchWaitInput = typeof DeepResearchWaitInputSchema.Type
export type DeepResearchEventsInput = typeof DeepResearchEventsInputSchema.Type
export type DeepResearchStreamInput = typeof DeepResearchStreamInputSchema.Type
export type FindSimilarInput = typeof FindSimilarInputSchema.Type
export type ContentsOptions = typeof ContentsOptionsSchema.Type
