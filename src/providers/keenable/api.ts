import { Effect } from "effect"

import { CommandInputError } from "../../core/errors"
import { requestJsonOptionalAuth } from "../../core/http"
import { loadProviderConfig } from "../../core/registry"
import { extractUrls, recordSources } from "../../core/runs"
import {
  DEFAULT_SELECT_TIMEOUT_SECONDS,
  FETCH_PATH,
  publicPath,
  resolveTitle,
  SEARCH_PATH,
  SELECT_MCP_TOOL,
  SELECT_REPORT_TOOL,
  SELECT_REVOKE_TOOL,
} from "./config"
import { callSelectMcpTool, type McpToolCallResult } from "./mcp"
import {
  FetchResponseSchema,
  SearchResponseSchema,
  type AuthMode,
  type CommandResult,
  type FetchInput,
  type FetchResponse,
  type SearchInput,
  type SearchResponse,
  type SelectInput,
  type SelectReportInput,
  type SelectRevokeInput,
} from "./schemas"

const validateOptionalNonEmpty = (field: string, value: string | undefined) =>
  value !== undefined && value.trim().length === 0
    ? Effect.fail(
        new CommandInputError({
          field,
          message: `${field} must not be empty when provided`,
        }),
      )
    : Effect.void

const validateHttpUrl = (field: string, value: string) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(value),
      catch: () =>
        new CommandInputError({
          field,
          message: `${field} must be a valid URL`,
        }),
    })

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* Effect.fail(
        new CommandInputError({
          field,
          message: `${field} must be an http or https URL`,
        }),
      )
    }
  })

export const search = Effect.fn("keenable.search")(function* (input: SearchInput) {
  yield* validateOptionalNonEmpty("site", input.site)
  yield* validateOptionalNonEmpty("acquired_after", input.acquired_after)
  yield* validateOptionalNonEmpty("acquired_before", input.acquired_before)
  yield* validateOptionalNonEmpty("published_after", input.published_after)
  yield* validateOptionalNonEmpty("published_before", input.published_before)
  yield* validateOptionalNonEmpty("query_time", input.query_time)

  const config = yield* loadProviderConfig("keenable")
  const keyed = config.credential !== undefined
  const authMode: AuthMode = keyed ? "keyed" : "public"
  const endpoint = keyed ? SEARCH_PATH : publicPath(SEARCH_PATH)
  const title = resolveTitle(input)
  const mode = input.mode === "standard" ? "realtime" : input.mode
  const body = {
    query: input.query,
    ...(input.acquired_after ? { acquired_after: input.acquired_after } : {}),
    ...(input.acquired_before ? { acquired_before: input.acquired_before } : {}),
    ...(input.published_after ? { published_after: input.published_after } : {}),
    ...(input.published_before ? { published_before: input.published_before } : {}),
    ...(input.site ? { site: input.site } : {}),
    ...(input.query_time ? { query_time: input.query_time } : {}),
    ...(input.snippet_max_length !== undefined
      ? { snippet_max_length: input.snippet_max_length }
      : {}),
    ...(input.max_results !== undefined ? { max_results: input.max_results } : {}),
    ...(mode ? { mode } : {}),
  }

  const data = yield* requestJsonOptionalAuth({
    provider: "keenable",
    method: "POST",
    path: endpoint,
    body,
    headers: { "x-keenable-title": title },
    responseSchema: SearchResponseSchema,
  })

  yield* recordSources("keenable", extractUrls(data))

  return {
    auth_mode: authMode,
    endpoint,
    title,
    data,
  } satisfies CommandResult<SearchResponse>
})

export const fetchPage = Effect.fn("keenable.fetch")(function* (input: FetchInput) {
  yield* validateHttpUrl("url", input.url)

  const config = yield* loadProviderConfig("keenable")
  const keyed = config.credential !== undefined
  const authMode: AuthMode = keyed ? "keyed" : "public"
  const endpoint = keyed ? FETCH_PATH : publicPath(FETCH_PATH)
  const title = resolveTitle(input)

  const data = yield* requestJsonOptionalAuth({
    provider: "keenable",
    method: "GET",
    path: endpoint,
    urlParams: {
      url: input.url,
      live: input.live,
      max_chars: input.max_chars,
      prompt: input.prompt,
    },
    headers: { "x-keenable-title": title },
    responseSchema: FetchResponseSchema,
  })

  yield* recordSources("keenable", extractUrls(data))

  return {
    auth_mode: authMode,
    endpoint,
    title,
    data,
  } satisfies CommandResult<FetchResponse>
})

const validateTimeout = (timeout: number) =>
  Number.isInteger(timeout) && timeout > 0
    ? Effect.void
    : Effect.fail(
        new CommandInputError({
          field: "timeout",
          message: "timeout must be a positive integer number of seconds",
        }),
      )

const validateSelectQuery = (input: SelectInput) =>
  Effect.gen(function* () {
    if (!/^\s*select\b/i.test(input.query)) {
      return yield* Effect.fail(
        new CommandInputError({
          field: "query",
          message: "query must be a read-only DuckDB SELECT statement",
        }),
      )
    }
  })

export const selectQuery = Effect.fn("keenable.select")(function* (
  input: SelectInput,
  timeoutSeconds = DEFAULT_SELECT_TIMEOUT_SECONDS,
) {
  yield* validateSelectQuery(input)
  yield* validateTimeout(timeoutSeconds)

  return yield* callSelectMcpTool({
    tool: SELECT_MCP_TOOL,
    timeoutSeconds,
    arguments: {
      query: input.query,
      ...(input.show_preview !== undefined ? { show_preview: input.show_preview } : {}),
    },
  })
})

export const selectReport = Effect.fn("keenable.selectReport")(function* (
  input: SelectReportInput,
  timeoutSeconds = DEFAULT_SELECT_TIMEOUT_SECONDS,
) {
  yield* validateTimeout(timeoutSeconds)

  return yield* callSelectMcpTool({
    tool: SELECT_REPORT_TOOL,
    timeoutSeconds,
    arguments: {
      brief: input.brief,
      result_set_ids: [...input.result_set_ids],
    },
  })
})

export const selectRevoke = Effect.fn("keenable.selectRevoke")(function* (
  input: SelectRevokeInput,
  timeoutSeconds = DEFAULT_SELECT_TIMEOUT_SECONDS,
) {
  yield* validateTimeout(timeoutSeconds)
  const url = input.url?.trim() || input.report_url?.trim()
  if (!url) {
    return yield* Effect.fail(
      new CommandInputError({
        field: "url",
        message: "Provide url or report_url of the HTML report to revoke",
      }),
    )
  }

  return yield* callSelectMcpTool({
    tool: SELECT_REVOKE_TOOL,
    timeoutSeconds,
    arguments: { url },
  })
})

export type { McpToolCallResult }
