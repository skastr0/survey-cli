import { Duration, Effect, Option, Schema } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http"

import { CLI_NAME, CLI_VERSION, USER_AGENT } from "../../core/constants"
import {
  ApiDecodeError,
  ApiRequestError,
  ApiResponseError,
  McpError,
} from "../../core/errors"
import { decodeUnknownJsonText } from "../../core/json"
import { requireCredential } from "../../core/registry"
import { MCP_PROTOCOL_VERSION, resolveTitle, selectMcpUrl } from "./config"

const PROVIDER = "keenable" as const

export interface McpToolCallResult {
  readonly auth_mode: "keyed"
  readonly endpoint: string
  readonly tool: string
  readonly protocol_version: string
  readonly session_id?: string
  readonly is_error: boolean
  readonly content: unknown
  readonly text?: string
  readonly structured?: unknown
  readonly result_set_id?: string
}

const JsonRpcErrorSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
})

const JsonRpcEnvelopeSchema = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcErrorSchema),
})

const McpTextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})

const McpContentSchema = Schema.Union([
  McpTextContentSchema,
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.String,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
])

const McpCallResultSchema = Schema.StructWithRest(
  Schema.Struct({
    content: Schema.optional(Schema.Array(McpContentSchema)),
    structuredContent: Schema.optional(Schema.Unknown),
    isError: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

const parseRetryAfter = (headers: Headers.Headers, body: unknown): number | undefined => {
  const headerValue = Option.getOrUndefined(Headers.get(headers, "retry-after"))
  if (headerValue) {
    const fromHeader = Number(headerValue)
    if (Number.isFinite(fromHeader)) {
      return fromHeader
    }
  }

  if (body && typeof body === "object" && "retryAfter" in body) {
    const value = (body as { retryAfter?: unknown }).retryAfter
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }

  return undefined
}

const extractApiMessage = (status: number, body: unknown) => {
  if (typeof body === "string" && body.trim().length > 0) {
    return body
  }

  if (body && typeof body === "object") {
    if ("error" in body && typeof body.error === "string" && body.error.trim().length > 0) {
      if ("message" in body && typeof body.message === "string" && body.message.trim().length > 0) {
        return `${body.error}: ${body.message}`
      }
      return body.error
    }

    if ("message" in body && typeof body.message === "string" && body.message.trim().length > 0) {
      return body.message
    }
  }

  return `Keenable SELECT MCP request failed with status ${status}`
}

const parseSseJsonValues = (text: string): unknown[] => {
  const values: unknown[] = []
  let dataLines: string[] = []

  const flush = () => {
    if (dataLines.length === 0) {
      return
    }

    const raw = dataLines.join("\n").trim()
    dataLines = []
    if (raw.length === 0 || raw === "[DONE]") {
      return
    }

    try {
      values.push(JSON.parse(raw) as unknown)
    } catch {
      // Ignore malformed SSE data frames; the JSON-RPC matcher will fail closed.
    }
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
      continue
    }

    if (line.trim().length === 0) {
      flush()
    }
  }

  flush()
  return values
}

const decodeJsonRpc = (value: unknown) => Schema.decodeUnknownEffect(JsonRpcEnvelopeSchema)(value)

const pickJsonRpcMessage = (values: ReadonlyArray<unknown>, id: number) =>
  values.find((value) => {
    if (!value || typeof value !== "object" || !("jsonrpc" in value)) {
      return false
    }

    const candidate = value as { id?: unknown }
    return candidate.id === id
  })

const RESULT_SET_ID_PATTERN = /\b(r[0-9a-f]{8,})\b/i

const extractResultSetId = (text: string | undefined, structured: unknown): string | undefined => {
  if (structured && typeof structured === "object" && "result_set_id" in structured) {
    const value = (structured as { result_set_id?: unknown }).result_set_id
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }

  if (!text) {
    return undefined
  }

  return text.match(RESULT_SET_ID_PATTERN)?.[1]
}

interface ParsedToolContent {
  readonly is_error: boolean
  readonly content: unknown
  readonly text?: string
  readonly structured?: unknown
  readonly result_set_id?: string
}

const parseToolContent = (result: unknown): Effect.Effect<ParsedToolContent> =>
  Schema.decodeUnknownEffect(McpCallResultSchema)(result).pipe(
    Effect.map((decoded): ParsedToolContent => {
      const textParts = (decoded.content ?? []).flatMap((item) =>
        item.type === "text" && "text" in item && typeof item.text === "string" ? [item.text] : [],
      )
      const text = textParts.length > 0 ? textParts.join("\n") : undefined
      let parsed: unknown = text
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown
        } catch {
          parsed = text
        }
      }

      const resultSetId = extractResultSetId(text, decoded.structuredContent)
      return {
        is_error: decoded.isError === true,
        content: decoded.structuredContent ?? parsed ?? decoded,
        ...(text ? { text } : {}),
        ...(decoded.structuredContent !== undefined ? { structured: decoded.structuredContent } : {}),
        ...(resultSetId ? { result_set_id: resultSetId } : {}),
      }
    }),
    Effect.orElseSucceed(
      (): ParsedToolContent => ({
        is_error: false,
        content: result,
      }),
    ),
  )

interface McpSession {
  readonly url: string
  readonly protocolVersion: string
  readonly sessionId?: string
  readonly nextId: () => number
}

const headerValue = (headers: Headers.Headers, name: string) =>
  Option.getOrUndefined(Headers.get(headers, name))

export const callSelectMcpTool = (options: {
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly timeoutSeconds: number
}) =>
  Effect.gen(function* () {
    const apiKey = yield* requireCredential(PROVIDER)
    const url = yield* selectMcpUrl
    const client = yield* HttpClient.HttpClient
    const title = resolveTitle()
    const timeoutSeconds = options.timeoutSeconds
    let rpcId = 0
    const nextId = () => {
      rpcId += 1
      return rpcId
    }

    const send = (spec: {
      readonly payload: unknown
      readonly expectJsonRpcId?: number
      readonly allowEmpty?: boolean
    }) =>
      Effect.gen(function* () {
        const session = currentSession
        let request = HttpClientRequest.post(session.url).pipe(
          HttpClientRequest.accept("application/json, text/event-stream"),
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.setHeader("user-agent", USER_AGENT),
          HttpClientRequest.setHeader("X-Keenable-Title", title),
          HttpClientRequest.setHeader("X-API-Key", apiKey),
          HttpClientRequest.setHeader("MCP-Protocol-Version", session.protocolVersion),
          HttpClientRequest.bodyJsonUnsafe(spec.payload),
        )

        if (session.sessionId) {
          request = request.pipe(HttpClientRequest.setHeader("Mcp-Session-Id", session.sessionId))
        }

        const toRequestError = (error: { readonly _tag?: string; readonly reason?: unknown; readonly message?: string }) =>
          new ApiRequestError({
            provider: PROVIDER,
            method: "POST",
            path: session.url,
            reason: String(error.reason ?? error._tag ?? "RequestError"),
            message: error.message ?? "HTTP request failed",
          })

        const response = yield* client.execute(request).pipe(
          Effect.mapError(toRequestError),
        )

        const responseText = yield* response.text.pipe(
          Effect.mapError(toRequestError),
        )

        const sessionHeader = headerValue(response.headers, "mcp-session-id")
        if (sessionHeader && sessionHeader.trim().length > 0) {
          currentSession = {
            ...session,
            sessionId: sessionHeader.trim(),
          }
        }

        if (response.status < 200 || response.status >= 300) {
          const body =
            responseText.trim().length === 0
              ? undefined
              : yield* decodeUnknownJsonText(responseText, "mcp-response").pipe(
                  Effect.catch(() => Effect.succeed<unknown>(responseText)),
                )
          const retryAfter = parseRetryAfter(response.headers, body)
          const message = extractApiMessage(response.status, body)

          return yield* Effect.fail(
            new ApiResponseError({
              provider: PROVIDER,
              method: "POST",
              path: session.url,
              status: response.status,
              message: retryAfter !== undefined ? `${message} (retry after ${retryAfter}s)` : message,
              body,
            }),
          )
        }

        if (spec.allowEmpty && responseText.trim().length === 0) {
          return undefined
        }

        const contentType = headerValue(response.headers, "content-type") ?? ""
        const values = contentType.includes("text/event-stream")
          ? parseSseJsonValues(responseText)
          : [yield* decodeUnknownJsonText(responseText, "mcp-response")]

        if (spec.expectJsonRpcId === undefined) {
          return values[0]
        }

        const matched = pickJsonRpcMessage(values, spec.expectJsonRpcId) ?? values[0]
        const envelope = yield* decodeJsonRpc(matched).pipe(
          Effect.mapError(
            (error) =>
              new ApiDecodeError({
                provider: PROVIDER,
                method: "POST",
                path: session.url,
                message: error.message,
              }),
          ),
        )

        if (envelope.error) {
          return yield* Effect.fail(
            new McpError({
              provider: PROVIDER,
              message:
                `SELECT MCP JSON-RPC error ${envelope.error.code}: ${envelope.error.message}` +
                (envelope.error.data !== undefined ? ` — ${JSON.stringify(envelope.error.data)}` : ""),
            }),
          )
        }

        if (envelope.result === undefined) {
          return yield* Effect.fail(
            new McpError({
              provider: PROVIDER,
              message: "SELECT MCP response did not include a JSON-RPC result",
            }),
          )
        }

        return envelope.result
      })

    let currentSession: McpSession = {
      url,
      protocolVersion: MCP_PROTOCOL_VERSION,
      nextId,
    }

    const initializeId = nextId()
    yield* send({
      payload: {
        jsonrpc: "2.0",
        id: initializeId,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: CLI_NAME,
            version: CLI_VERSION,
          },
        },
      },
      expectJsonRpcId: initializeId,
    })

    yield* send({
      payload: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      allowEmpty: true,
    })

    const callId = nextId()
    const result = yield* send({
      payload: {
        jsonrpc: "2.0",
        id: callId,
        method: "tools/call",
        params: {
          name: options.tool,
          arguments: options.arguments,
        },
      },
      expectJsonRpcId: callId,
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(timeoutSeconds),
        orElse: () =>
          Effect.fail(
            new McpError({
              provider: PROVIDER,
              message: `SELECT MCP tool ${options.tool} timed out after ${timeoutSeconds} seconds`,
            }),
          ),
      }),
    )

    const parsed = yield* parseToolContent(result)
    if (parsed.is_error) {
      return yield* Effect.fail(
        new McpError({
          provider: PROVIDER,
          message:
            typeof parsed.text === "string" && parsed.text.trim().length > 0
              ? parsed.text
              : `SELECT MCP tool ${options.tool} returned isError=true`,
        }),
      )
    }

    return {
      auth_mode: "keyed" as const,
      endpoint: currentSession.url,
      tool: options.tool,
      protocol_version: currentSession.protocolVersion,
      ...(currentSession.sessionId ? { session_id: currentSession.sessionId } : {}),
      is_error: false,
      content: parsed.content,
      ...(parsed.text ? { text: parsed.text } : {}),
      ...(parsed.structured !== undefined ? { structured: parsed.structured } : {}),
      ...(parsed.result_set_id ? { result_set_id: parsed.result_set_id } : {}),
    } satisfies McpToolCallResult
  })
