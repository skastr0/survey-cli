import { Effect, Schema } from "effect"

import { ApiDecodeError, ApiResponseError } from "../../core/errors"
import { callMcpTool } from "../../core/mcp"
import { ExtractResponse, SearchResponse, type ExtractInput } from "./schemas"

/**
 * Keyless Parallel: the free Search MCP (https://docs.parallel.ai/integrations/mcp/search-mcp:
 * "The Search MCP is free to use — no API key required"). `web_search` and
 * `web_fetch` return structuredContent in the REST /v1/search and /v1/extract
 * shapes. Task, FindAll, and Monitor still need PARALLEL_API_KEY.
 */

export const PARALLEL_SEARCH_MCP_URL_ENV = "PARALLEL_SEARCH_MCP_URL"
export const DEFAULT_PARALLEL_SEARCH_MCP_URL = "https://search.parallel.ai/mcp"

const mcpUrl = () => Bun.env[PARALLEL_SEARCH_MCP_URL_ENV]?.trim() || DEFAULT_PARALLEL_SEARCH_MCP_URL

/** Stable per-process id; the free tier rate-limits by session_id. */
const PROCESS_SESSION_ID = crypto.randomUUID()

const ignoredFields = (input: object, supported: ReadonlyArray<string>) =>
  Object.entries(input)
    .filter(([key, value]) => value !== undefined && !supported.includes(key))
    .map(([key]) => key)

const callTool = <S extends Schema.Constraint>(
  tool: string,
  args: Record<string, unknown>,
  schema: S,
) =>
  Effect.gen(function* () {
    const url = mcpUrl()
    const result = yield* callMcpTool({ provider: "parallel", url, tool, arguments: args })
    if (result.is_error) {
      return yield* new ApiResponseError({
        provider: "parallel",
        method: "POST",
        path: url,
        status: 200,
        message: result.text ?? `parallel MCP ${tool} returned an error`,
        body: result,
      })
    }
    const structured =
      result.structured ??
      (result.text !== undefined ? yield* Effect.try(() => JSON.parse(result.text ?? "") as unknown).pipe(
        Effect.orElseSucceed(() => undefined),
      ) : undefined)
    const decoded = yield* Schema.decodeUnknownEffect(schema)(structured).pipe(
      Effect.mapError(
        (error) =>
          new ApiDecodeError({
            provider: "parallel",
            method: "POST",
            path: url,
            message: String(error.message ?? error),
          }),
      ),
    )
    return { url, decoded }
  })

export const keylessSearch = (input: {
  readonly objective?: string | undefined
  readonly session_id?: string | undefined
  readonly client_model?: string | undefined
}, searchQueries: ReadonlyArray<string>) =>
  callTool(
    "web_search",
    {
      objective: input.objective ?? searchQueries.join("; "),
      search_queries: searchQueries,
      session_id: input.session_id ?? PROCESS_SESSION_ID,
      ...(input.client_model ? { model_name: input.client_model } : {}),
    },
    SearchResponse,
  ).pipe(
    Effect.map(({ url, decoded }) => ({
      ...decoded,
      auth_mode: "public" as const,
      endpoint: url,
      ignored_options: ignoredFields(input, ["objective", "search_queries", "session_id", "client_model"]),
    })),
  )

export const keylessExtract = (input: ExtractInput) =>
  callTool(
    "web_fetch",
    {
      urls: input.urls,
      ...(input.objective ? { objective: input.objective } : {}),
      ...(input.search_queries ? { search_queries: input.search_queries } : {}),
      session_id: input.session_id ?? PROCESS_SESSION_ID,
      ...(input.client_model ? { model_name: input.client_model } : {}),
    },
    ExtractResponse,
  ).pipe(
    Effect.map(({ url, decoded }) => ({
      ...decoded,
      auth_mode: "public" as const,
      endpoint: url,
      ignored_options: ignoredFields(input, [
        "urls",
        "objective",
        "search_queries",
        "session_id",
        "client_model",
      ]),
    })),
  )
