import { Effect, Option } from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http"

import { USER_AGENT, CLI_NAME, CLI_VERSION } from "./constants"
import { ApiDecodeError, ApiRequestError, ApiResponseError } from "./errors"
import { decodeUnknownJsonText } from "./json"

/**
 * Minimal streamable-HTTP MCP client for keyless hosted tool servers
 * (mcp.exa.ai, search.parallel.ai). One call = initialize →
 * notifications/initialized → tools/call, carrying Mcp-Session-Id when the
 * server issues one. Responses may be JSON or SSE `data:` frames.
 */

const PROTOCOL_VERSION = "2025-03-26"

export interface McpToolResult {
  readonly text?: string
  readonly structured?: unknown
  readonly is_error: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseFrames = (text: string): ReadonlyArray<unknown> => {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) {
    try {
      return [JSON.parse(trimmed) as unknown]
    } catch {
      return []
    }
  }
  const values: Array<unknown> = []
  let data: Array<string> = []
  const flush = () => {
    const raw = data.join("\n").trim()
    data = []
    if (raw.length === 0) return
    try {
      values.push(JSON.parse(raw) as unknown)
    } catch {
      // Malformed frame; the id matcher below fails closed.
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
    else if (line.trim().length === 0) flush()
  }
  flush()
  return values
}

/** The JSON-RPC reply for `id`; some servers omit id on single-reply streams. */
const pickReply = (frames: ReadonlyArray<unknown>, id: number) =>
  frames.find((frame) => isRecord(frame) && frame.id === id) ??
  frames.find((frame) => isRecord(frame) && ("result" in frame || "error" in frame))

export const callMcpTool = (options: {
  readonly provider: string
  readonly url: string
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly headers?: Readonly<Record<string, string>>
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    let sessionId: string | undefined
    let nextId = 0

    const send = (payload: Record<string, unknown>) =>
      Effect.gen(function* () {
        let request = HttpClientRequest.post(options.url).pipe(
          HttpClientRequest.accept("application/json, text/event-stream"),
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.setHeader("user-agent", USER_AGENT),
          HttpClientRequest.setHeader("mcp-protocol-version", PROTOCOL_VERSION),
          HttpClientRequest.setHeaders(options.headers ?? {}),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...payload }),
        )
        if (sessionId) {
          request = request.pipe(HttpClientRequest.setHeader("mcp-session-id", sessionId))
        }
        const toRequestError = (error: { readonly _tag?: string; readonly reason?: unknown; readonly message?: string }) =>
          new ApiRequestError({
            provider: options.provider,
            method: "POST",
            path: options.url,
            reason: String(error.reason ?? error._tag ?? "RequestError"),
            message: error.message ?? "MCP request failed",
          })
        const response = yield* client.execute(request).pipe(Effect.mapError(toRequestError))
        const text = yield* response.text.pipe(Effect.mapError(toRequestError))
        const issued = Option.getOrUndefined(Headers.get(response.headers, "mcp-session-id"))
        if (issued && issued.trim().length > 0) sessionId = issued.trim()
        if (response.status < 200 || response.status >= 300) {
          const body =
            text.trim().length === 0
              ? undefined
              : yield* decodeUnknownJsonText(text, "mcp-response").pipe(
                  Effect.catch(() => Effect.succeed<unknown>(text)),
                )
          return yield* new ApiResponseError({
            provider: options.provider,
            method: "POST",
            path: options.url,
            status: response.status,
            message:
              isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
                ? body.error.message
                : `${options.provider} MCP request failed with status ${response.status}`,
            body,
          })
        }
        return text
      })

    const rpc = (method: string, params: Record<string, unknown>) =>
      Effect.gen(function* () {
        nextId += 1
        const id = nextId
        const text = yield* send({ id, method, params })
        const reply = pickReply(parseFrames(text), id)
        if (!isRecord(reply)) {
          return yield* new ApiDecodeError({
            provider: options.provider,
            method: "POST",
            path: options.url,
            message: `${options.provider} MCP ${method} returned no JSON-RPC reply`,
          })
        }
        if (isRecord(reply.error)) {
          return yield* new ApiResponseError({
            provider: options.provider,
            method: "POST",
            path: options.url,
            status: 200,
            message: typeof reply.error.message === "string" ? reply.error.message : `${method} failed`,
            body: reply.error,
          })
        }
        return reply.result
      })

    yield* rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLI_NAME, version: CLI_VERSION },
    })
    yield* send({ method: "notifications/initialized" })
    const result = yield* rpc("tools/call", { name: options.tool, arguments: options.arguments })

    const content = isRecord(result) && Array.isArray(result.content) ? result.content : []
    const text = content
      .flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
      .join("\n")
    return {
      is_error: isRecord(result) && result.isError === true,
      ...(text.length > 0 ? { text } : {}),
      ...(isRecord(result) && result.structuredContent !== undefined
        ? { structured: result.structuredContent }
        : {}),
    } satisfies McpToolResult
  })
