import { Effect, FileSystem, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { extname } from "node:path"

import { USER_AGENT } from "../core/constants"
import { ApiRequestError, ApiResponseError, CommandInputError } from "../core/errors"

export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000

/** Input fields shared by every local document command: exactly one of path | url | base64. */
export const documentSourceFields = {
  path: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  base64: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  max_bytes: Schema.optional(Schema.Int),
  timeout_ms: Schema.optional(Schema.Int),
} as const

export interface DocumentSourceInput {
  readonly path?: string | undefined
  readonly url?: string | undefined
  readonly base64?: string | undefined
  readonly filename?: string | undefined
  readonly max_bytes?: number | undefined
  readonly timeout_ms?: number | undefined
}

export type SourceKind = "path" | "url" | "base64"

export interface LoadedDocument {
  readonly kind: SourceKind
  readonly bytes: Uint8Array
  readonly path: string | null
  readonly url: string | null
  /** Best name for extension-based format hints. */
  readonly filename: string | null
  readonly content_type: string | null
}

export interface SourceSummary {
  readonly kind: SourceKind
  readonly path?: string
  readonly url?: string
  readonly filename?: string
  readonly content_type?: string
  readonly bytes: number
}

export const summarizeSource = (doc: LoadedDocument): SourceSummary => ({
  kind: doc.kind,
  ...(doc.path ? { path: doc.path } : {}),
  ...(doc.url ? { url: doc.url } : {}),
  ...(doc.filename && doc.filename !== doc.path && doc.filename !== doc.url
    ? { filename: doc.filename }
    : {}),
  ...(doc.content_type ? { content_type: doc.content_type } : {}),
  bytes: doc.bytes.byteLength,
})

const fail = (field: string, message: string) =>
  Effect.fail(new CommandInputError({ field, message }))

export const sourceKindOf = (input: DocumentSourceInput) => {
  const present = (
    [
      ["path", input.path],
      ["url", input.url],
      ["base64", input.base64],
    ] as const
  ).filter(([, value]) => value !== undefined && value.length > 0)
  return present.map(([kind]) => kind)
}

export const expandHome = (path: string) => {
  if (path === "~" || path.startsWith("~/")) {
    const home = Bun.env.HOME ?? process.env.HOME
    return home ? `${home}${path.slice(1)}` : path
  }
  return path
}

export const urlExtension = (url: string) => {
  try {
    return extname(new URL(url).pathname).replace(/^\./, "").toLowerCase()
  } catch {
    return ""
  }
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/epub+zip": "epub",
}

export const extensionForContentType = (contentType: string | null) =>
  contentType === null
    ? undefined
    : EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0]!.trim().toLowerCase()]

const decodeBase64 = (value: string) =>
  Effect.try({
    try: () => {
      const stripped = value.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "")
      if (stripped.length === 0 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(stripped)) {
        throw new Error("not base64")
      }
      return new Uint8Array(Buffer.from(stripped, "base64"))
    },
    catch: () =>
      new CommandInputError({
        field: "base64",
        message: "base64 is empty or not valid base64 (a data: URI prefix is accepted)",
      }),
  })

const download = (url: string, maxBytes: number, timeoutMs: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeader("user-agent", USER_AGENT),
      HttpClientRequest.setHeader("accept", "*/*"),
    )
    const response = yield* client.execute(request).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError(
        (error) =>
          new ApiRequestError({
            provider: "local",
            method: "GET",
            path: url,
            reason: String((error as { reason?: unknown; _tag?: unknown }).reason ?? (error as { _tag?: unknown })._tag ?? "RequestError"),
            message: (error as { message?: string }).message ?? "download failed",
          }),
      ),
    )

    if (response.status < 200 || response.status >= 300) {
      return yield* new ApiResponseError({
        provider: "local",
        method: "GET",
        path: url,
        status: response.status,
        message: `Download failed with HTTP ${response.status}`,
        body: null,
      })
    }

    const declared = Number(response.headers["content-length"] ?? "")
    if (Number.isFinite(declared) && declared > maxBytes) {
      return yield* fail("url", `Document is ${declared} bytes, over max_bytes ${maxBytes}`)
    }

    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError(
        (error) =>
          new ApiRequestError({
            provider: "local",
            method: "GET",
            path: url,
            reason: String((error as { reason?: unknown }).reason ?? "BodyError"),
            message: (error as { message?: string }).message ?? "download body failed",
          }),
      ),
    )
    if (buffer.byteLength > maxBytes) {
      return yield* fail("url", `Document is ${buffer.byteLength} bytes, over max_bytes ${maxBytes}`)
    }
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers["content-type"] ?? null,
    }
  })

/** Resolve exactly one of path | url | base64 into bytes plus naming hints. */
export const loadDocumentSource = (input: DocumentSourceInput) =>
  Effect.gen(function* () {
    const kinds = sourceKindOf(input)
    if (kinds.length !== 1) {
      return yield* fail(
        "source",
        kinds.length === 0
          ? "Provide exactly one of path, url, or base64"
          : `Provide exactly one of path, url, or base64 (got ${kinds.join(", ")})`,
      )
    }
    const maxBytes = input.max_bytes ?? DEFAULT_MAX_BYTES
    const kind = kinds[0]!

    if (kind === "path") {
      const path = expandHome(input.path!)
      const fs = yield* FileSystem.FileSystem
      const bytes = yield* fs.readFile(path).pipe(
        Effect.mapError(
          (error) =>
            new CommandInputError({
              field: "path",
              message: `Cannot read ${path}: ${(error as { message?: string }).message ?? "read failed"}`,
            }),
        ),
      )
      if (bytes.byteLength === 0) return yield* fail("path", `${path} is empty`)
      if (bytes.byteLength > maxBytes) {
        return yield* fail("path", `${path} is ${bytes.byteLength} bytes, over max_bytes ${maxBytes}`)
      }
      return {
        kind,
        bytes,
        path,
        url: null,
        filename: input.filename ?? path,
        content_type: null,
      } satisfies LoadedDocument
    }

    if (kind === "url") {
      const url = input.url!
      if (!/^https?:\/\//i.test(url)) {
        return yield* fail("url", "url must start with http:// or https://")
      }
      const downloaded = yield* download(
        url,
        maxBytes,
        input.timeout_ms ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      )
      if (downloaded.bytes.byteLength === 0) return yield* fail("url", `${url} returned an empty body`)
      return {
        kind,
        bytes: downloaded.bytes,
        path: null,
        url,
        filename: input.filename ?? (urlExtension(url) ? url : null),
        content_type: downloaded.contentType,
      } satisfies LoadedDocument
    }

    const bytes = yield* decodeBase64(input.base64!)
    if (bytes.byteLength > maxBytes) {
      return yield* fail("base64", `Decoded document is ${bytes.byteLength} bytes, over max_bytes ${maxBytes}`)
    }
    return {
      kind,
      bytes,
      path: null,
      url: null,
      filename: input.filename ?? null,
      content_type: null,
    } satisfies LoadedDocument
  })

/** Extension hint (no dot) from filename, then content type. */
export const extensionHint = (doc: LoadedDocument) => {
  const fromName = doc.filename
    ? doc.filename.startsWith("http")
      ? urlExtension(doc.filename)
      : extname(doc.filename).replace(/^\./, "").toLowerCase()
    : ""
  return fromName || extensionForContentType(doc.content_type) || undefined
}
