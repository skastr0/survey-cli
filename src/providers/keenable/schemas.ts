import { Schema } from "effect"

const ExtraFields = Schema.Record(Schema.String, Schema.Unknown)
const OptionalString = Schema.optional(Schema.NullishOr(Schema.String))

export const SearchModeSchema = Schema.Literals(["realtime", "pro", "standard"])
export type SearchMode = typeof SearchModeSchema.Type

export const SearchInputSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)),
  acquired_after: Schema.optional(Schema.String),
  acquired_before: Schema.optional(Schema.String),
  published_after: Schema.optional(Schema.String),
  published_before: Schema.optional(Schema.String),
  site: Schema.optional(Schema.String),
  query_time: Schema.optional(Schema.String),
  snippet_max_length: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 180, maximum: 10000 })),
  ),
  max_results: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  ),
  mode: Schema.optional(SearchModeSchema),
  keenable_title: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
})

export type SearchInput = typeof SearchInputSchema.Type

export const SearchResultSchema = Schema.StructWithRest(
  Schema.Struct({
    title: Schema.String,
    url: Schema.String,
    description: OptionalString,
    snippet: OptionalString,
    published_at: OptionalString,
    acquired_at: OptionalString,
  }),
  [ExtraFields],
)

export const SearchResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    query: Schema.String,
    results: Schema.Array(SearchResultSchema),
    // Present on the wire (official CLI e2e); omitted from OpenAPI SearchResponse.
    mode: Schema.optional(Schema.String),
  }),
  [ExtraFields],
)

export type SearchResponse = typeof SearchResponseSchema.Type

export const FetchInputSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)),
  live: Schema.optional(Schema.Boolean),
  max_chars: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  keenable_title: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
})

export type FetchInput = typeof FetchInputSchema.Type

export const FetchResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    url: Schema.String,
    content: Schema.String,
    title: OptionalString,
    description: OptionalString,
    author: OptionalString,
    published_at: Schema.optional(
      Schema.NullishOr(Schema.Union([Schema.String, Schema.Number])),
    ),
  }),
  [ExtraFields],
)

export type FetchResponse = typeof FetchResponseSchema.Type

export const SelectInputSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)),
  show_preview: Schema.optional(Schema.Boolean),
  timeout_seconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type SelectInput = typeof SelectInputSchema.Type

export const SelectReportInputSchema = Schema.Struct({
  brief: Schema.String.check(Schema.isMinLength(1)),
  result_set_ids: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
    Schema.isMinLength(1),
  ),
  timeout_seconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type SelectReportInput = typeof SelectReportInputSchema.Type

export const SelectRevokeInputSchema = Schema.Struct({
  url: Schema.optional(Schema.String),
  report_url: Schema.optional(Schema.String),
  timeout_seconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type SelectRevokeInput = typeof SelectRevokeInputSchema.Type

export type AuthMode = "keyed" | "public"

export interface CommandResult<A> {
  readonly auth_mode: AuthMode
  readonly endpoint: string
  readonly title: string
  readonly data: A
}
