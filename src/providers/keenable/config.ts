import { Effect } from "effect"

import { ConfigurationError } from "../../core/errors"

export const API_KEY_ENV = "KEENABLE_API_KEY"
export const SELECT_MCP_URL_ENV = "KEENABLE_SELECT_MCP_URL"
export const DEFAULT_SELECT_MCP_URL = "https://select.keenable.ai/mcp"
export const TITLE_ENV = "KEENABLE_TITLE"
export const TITLE_ENV_ALIAS = "KEENABLE_APP_TITLE"
export const DEFAULT_TITLE = "survey"
export const TITLE_MAX_LENGTH = 256
export const MCP_PROTOCOL_VERSION = "2025-03-26"
export const SELECT_MCP_TOOL = "select"
export const SELECT_REPORT_TOOL = "generate_html_report"
export const SELECT_REVOKE_TOOL = "revoke_html_report"
export const DEFAULT_SELECT_CONCURRENCY = 1
export const DEFAULT_SELECT_TIMEOUT_SECONDS = 300
export const SEARCH_PATH = "/v1/search"
export const FETCH_PATH = "/v1/fetch"

export const truncateTitle = (value: string) =>
  value.length <= TITLE_MAX_LENGTH ? value : value.slice(0, TITLE_MAX_LENGTH)

export const payloadTitle = (input: {
  readonly keenable_title?: string | undefined
  readonly title?: string | undefined
}) => {
  const fromKeenableTitle = input.keenable_title?.trim()
  if (fromKeenableTitle && fromKeenableTitle.length > 0) {
    return fromKeenableTitle
  }

  const fromTitle = input.title?.trim()
  if (fromTitle && fromTitle.length > 0) {
    return fromTitle
  }

  return undefined
}

export const resolveTitle = (input?: {
  readonly keenable_title?: string | undefined
  readonly title?: string | undefined
}) => {
  const override = input ? payloadTitle(input) : undefined
  if (override) {
    return truncateTitle(override)
  }

  const envTitle = Bun.env[TITLE_ENV]?.trim()
  if (envTitle && envTitle.length > 0) {
    return truncateTitle(envTitle)
  }

  const aliasTitle = Bun.env[TITLE_ENV_ALIAS]?.trim()
  if (aliasTitle && aliasTitle.length > 0) {
    return truncateTitle(aliasTitle)
  }

  return DEFAULT_TITLE
}

export const publicPath = (path: string) =>
  path.endsWith("/public") ? path : `${path}/public`

export const selectMcpUrl = Effect.gen(function* () {
  const rawValue = (Bun.env[SELECT_MCP_URL_ENV] ?? DEFAULT_SELECT_MCP_URL).trim()

  if (rawValue.length === 0) {
    return yield* new ConfigurationError({
      field: SELECT_MCP_URL_ENV,
      message: "SELECT MCP URL cannot be empty",
    })
  }

  const url = yield* Effect.try({
    try: () => new URL(rawValue),
    catch: () =>
      new ConfigurationError({
        field: SELECT_MCP_URL_ENV,
        message: "Invalid SELECT MCP URL",
      }),
  })

  if (url.username || url.password) {
    return yield* new ConfigurationError({
      field: SELECT_MCP_URL_ENV,
      message: "SELECT MCP URL must not include credentials",
    })
  }

  return url.toString().replace(/\/+$/, "")
})
