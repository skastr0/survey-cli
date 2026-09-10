import { readFile, stat } from "node:fs/promises"
import { basename, extname } from "node:path"

import { Effect, Schema } from "effect"
import type { FileSystem, Path } from "effect"
import type { HttpClient } from "effect/unstable/http"

import { USER_AGENT } from "../../core/constants"
import { CommandInputError, JobWaitTimeoutError } from "../../core/errors"
import { requestJson, requestText } from "../../core/http"
import { recordRun, updateRun } from "../../core/runs"

export const DEFAULT_JOB_TIMEOUT_SECONDS = 300
export const DEFAULT_JOB_POLL_INTERVAL_MS = 2_000

export const PARSE_TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const

const DEFAULT_PARSE_EXPAND = ["markdown"] as const
const FAST_PARSE_EXPAND = ["text"] as const

/**
 * Default expand for parse wait/run. Fast-tier jobs 422 on `markdown`, so the
 * fast tier expands `text` instead (regression fix — do not force markdown).
 */
export const defaultParseExpand = (tier?: string | undefined): ReadonlyArray<string> =>
  tier?.trim().toLowerCase() === "fast" ? FAST_PARSE_EXPAND : DEFAULT_PARSE_EXPAND

export const FILE_PURPOSES = [
  "user_data",
  "parse",
  "extract",
  "classify",
  "split",
  "sheet",
  "agent_app",
] as const

/** A provider-side job reached a terminal failure status while waiting. */
export class JobFailedError extends Schema.TaggedError<JobFailedError>()(
  "JobFailedError",
  {
    jobId: Schema.String,
    status: Schema.String,
    message: Schema.String,
    errorMessage: Schema.NullishOr(Schema.String),
  },
) {}

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

export const FileRecordSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    project_id: Schema.optional(Schema.String),
    file_type: Schema.optional(Schema.NullOr(Schema.String)),
    purpose: Schema.optional(Schema.NullOr(Schema.String)),
    expires_at: Schema.optional(Schema.NullOr(Schema.String)),
    external_file_id: Schema.optional(Schema.NullOr(Schema.String)),
    last_modified_at: Schema.optional(Schema.NullOr(Schema.String)),
    download_url: Schema.optional(Schema.Unknown),
  }),
  [JsonRecordSchema],
)
export type FileRecord = typeof FileRecordSchema.Type

export const FileListResponseSchema = Schema.Struct({
  items: Schema.Array(FileRecordSchema),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
  total_size: Schema.optional(Schema.NullOr(Schema.Number)),
})
export type FileListResponse = typeof FileListResponseSchema.Type

export const FileContentResponseSchema = Schema.Struct({
  expires_at: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  form_fields: Schema.optional(Schema.Unknown),
})

export const ParseJobSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    project_id: Schema.optional(Schema.String),
    status: Schema.String,
    created_at: Schema.optional(Schema.String),
    updated_at: Schema.optional(Schema.String),
    error_message: Schema.optional(Schema.NullOr(Schema.String)),
    name: Schema.optional(Schema.NullOr(Schema.String)),
    tier: Schema.optional(Schema.String),
    user_metadata: Schema.optional(JsonRecordSchema),
    usage: Schema.optional(Schema.Unknown),
  }),
  [JsonRecordSchema],
)
export type ParseJob = typeof ParseJobSchema.Type

export const ParseListResponseSchema = Schema.Struct({
  items: Schema.Array(ParseJobSchema),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
  total_size: Schema.optional(Schema.NullOr(Schema.Number)),
})

export const ParseGetResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    job: ParseJobSchema,
    markdown: Schema.optional(Schema.Unknown),
    text: Schema.optional(Schema.Unknown),
    items: Schema.optional(Schema.Unknown),
    metadata: Schema.optional(Schema.Unknown),
    job_metadata: Schema.optional(Schema.Unknown),
    text_full: Schema.optional(Schema.Unknown),
    markdown_full: Schema.optional(Schema.Unknown),
    result_content_metadata: Schema.optional(Schema.Unknown),
    images_content_metadata: Schema.optional(Schema.Unknown),
  }),
  [JsonRecordSchema],
)
export type ParseGetResponse = typeof ParseGetResponseSchema.Type

export const ExtractJobSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    created_at: Schema.optional(Schema.String),
    updated_at: Schema.optional(Schema.String),
    file_input: Schema.optional(Schema.String),
    project_id: Schema.optional(Schema.String),
    configuration: Schema.optional(Schema.Unknown),
    configuration_id: Schema.optional(Schema.NullOr(Schema.String)),
    error_message: Schema.optional(Schema.NullOr(Schema.String)),
    extract_result: Schema.optional(Schema.Unknown),
    extract_metadata: Schema.optional(Schema.Unknown),
    metadata: Schema.optional(Schema.Unknown),
    usage: Schema.optional(Schema.Unknown),
  }),
  [JsonRecordSchema],
)
export type ExtractJob = typeof ExtractJobSchema.Type

export const ExtractListResponseSchema = Schema.Struct({
  items: Schema.Array(ExtractJobSchema),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
  total_size: Schema.optional(Schema.NullOr(Schema.Number)),
})

export interface ProjectQuery {
  readonly organization_id?: string | undefined
  readonly project_id?: string | undefined
}

type QueryValue = string | ReadonlyArray<string> | number | boolean | undefined

const mimeByExtension: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".rtf": "application/rtf",
  ".html": "text/html",
  ".htm": "text/html",
  ".epub": "application/epub+zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
}

export const mimeForFileName = (fileName: string) =>
  mimeByExtension[extname(fileName).toLowerCase()] ?? "application/octet-stream"

export const omitUndefined = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))

/**
 * Drop undefined, empty-string, and empty-array query params so the wire query
 * matches the legacy CLI exactly (no dangling `?key=` or empty repeated params).
 */
const compactParams = (query: Record<string, QueryValue>) => {
  const out: Record<string, string | ReadonlyArray<string> | number | boolean> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      const items = value.filter((item) => item !== "")
      if (items.length > 0) out[key] = items
      continue
    }
    if (value !== "") out[key] = value
  }
  return out
}

const projectQuery = (query: ProjectQuery | undefined) =>
  compactParams({
    organization_id: query?.organization_id,
    project_id: query?.project_id,
  })

/** parse expand is a single comma-separated query param. */
const joinExpand = (expand: ReadonlyArray<string> | undefined) =>
  expand && expand.length > 0 ? expand.join(",") : undefined

/** extract expand is sent as repeated `expand=` query params. */
const repeatedQuery = (values: ReadonlyArray<string> | undefined) =>
  values && values.length > 0 ? [...values] : undefined

export const readLocalFileBytes = (filePath: string) =>
  Effect.tryPromise({
    try: async () => {
      const fileStats = await stat(filePath)

      if (!fileStats.isFile()) {
        throw new Error("Path does not point to a file")
      }

      const bytes = await readFile(filePath)

      if (bytes.byteLength === 0) {
        throw new Error("File is empty")
      }

      return bytes
    },
    catch: (cause) =>
      new CommandInputError({
        field: "file_path",
        message: `Cannot read ${filePath}: ${cause instanceof Error ? cause.message : "Failed to read file"}`,
      }),
  })

// ---------------------------------------------------------------------------
// Files — /api/v1/beta/files

export const uploadFile = (params: {
  readonly filePath: string
  readonly purpose: string
  readonly fileName?: string
  readonly externalFileId?: string
  readonly organizationId?: string
  readonly projectId?: string
}) =>
  Effect.gen(function* () {
    const fileName = params.fileName?.trim() || basename(params.filePath)
    const bytes = yield* readLocalFileBytes(params.filePath)
    const form = new FormData()
    form.append("file", new Blob([bytes], { type: mimeForFileName(fileName) }), fileName)
    form.append("purpose", params.purpose)

    if (params.externalFileId) {
      form.append("external_file_id", params.externalFileId)
    }

    return yield* requestJson({
      provider: "llama",
      method: "POST",
      path: "/api/v1/beta/files",
      urlParams: compactParams({
        organization_id: params.organizationId,
        project_id: params.projectId,
      }),
      formData: form,
      responseSchema: FileRecordSchema,
    })
  })

export const listFiles = (params: {
  readonly pageSize?: number
  readonly pageToken?: string
  readonly fileName?: string
  readonly fileIds?: ReadonlyArray<string>
  readonly externalFileId?: string
  readonly organizationId?: string
  readonly projectId?: string
}) =>
  requestJson({
    provider: "llama",
    method: "GET",
    path: "/api/v1/beta/files",
    urlParams: compactParams({
      organization_id: params.organizationId,
      project_id: params.projectId,
      page_size: params.pageSize,
      page_token: params.pageToken,
      file_name: params.fileName,
      // file_ids is sent as repeated query params
      file_ids: params.fileIds,
      external_file_id: params.externalFileId,
    }),
    responseSchema: FileListResponseSchema,
  })

export const getFile = (params: { readonly fileId: string } & ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "GET",
    path: `/api/v1/beta/files/${encodeURIComponent(params.fileId)}`,
    urlParams: projectQuery(params),
    responseSchema: FileRecordSchema,
  })

export const getFileContent = (params: {
  readonly fileId: string
  readonly expiresAtSeconds?: number
} & ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "GET",
    path: `/api/v1/beta/files/${encodeURIComponent(params.fileId)}/content`,
    urlParams: compactParams({
      organization_id: params.organization_id,
      project_id: params.project_id,
      expires_at_seconds: params.expiresAtSeconds,
    }),
    responseSchema: FileContentResponseSchema,
  })

export const deleteFile = (params: { readonly fileId: string } & ProjectQuery) =>
  // LlamaCloud returns 204 No Content; read as text so an empty body is fine.
  requestText({
    provider: "llama",
    method: "DELETE",
    path: `/api/v1/beta/files/${encodeURIComponent(params.fileId)}`,
    urlParams: projectQuery(params),
  }).pipe(Effect.as({ deleted: true, file_id: params.fileId }))

// ---------------------------------------------------------------------------
// Parse — /api/v2/parse

export interface ParseConfiguration {
  readonly tier?: string | undefined
  readonly version?: string | undefined
  readonly name?: string | undefined
  readonly file_id?: string | undefined
  readonly source_url?: string | undefined
  readonly configuration_id?: string | undefined
  readonly page_ranges?: unknown
  readonly crop_box?: unknown
  readonly disable_cache?: boolean | undefined
  readonly input_options?: unknown
  readonly output_options?: unknown
  readonly processing_options?: unknown
  readonly processing_control?: unknown
  readonly agentic_options?: unknown
  readonly user_metadata?: Record<string, unknown> | undefined
  readonly webhook_configurations?: unknown
  readonly webhook_configuration_ids?: ReadonlyArray<string> | undefined
  readonly http_proxy?: string | undefined
  readonly client_name?: string | undefined
}

/**
 * Build the parse job body. When `configuration_id` references a saved parse
 * configuration, do NOT inject default tier/version — they would override the
 * saved configuration on the provider side.
 */
export const toParseBody = (config: ParseConfiguration) =>
  omitUndefined({
    tier: config.tier ?? (config.configuration_id === undefined ? "agentic" : undefined),
    version: config.version ?? (config.configuration_id === undefined ? "latest" : undefined),
    name: config.name,
    file_id: config.file_id,
    source_url: config.source_url,
    configuration_id: config.configuration_id,
    page_ranges: config.page_ranges,
    crop_box: config.crop_box,
    disable_cache: config.disable_cache,
    input_options: config.input_options,
    output_options: config.output_options,
    processing_options: config.processing_options,
    processing_control: config.processing_control,
    agentic_options: config.agentic_options,
    user_metadata: config.user_metadata,
    webhook_configurations: config.webhook_configurations,
    webhook_configuration_ids: config.webhook_configuration_ids,
    http_proxy: config.http_proxy,
    client_name: config.client_name ?? USER_AGENT,
  })

export const parseCreate = (params: ParseConfiguration & ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "POST",
    path: "/api/v2/parse",
    urlParams: projectQuery(params),
    body: toParseBody(params),
    responseSchema: ParseJobSchema,
  })

export const parseUpload = (params: {
  readonly filePath: string
  readonly fileName?: string
  readonly configuration: ParseConfiguration
} & ProjectQuery) =>
  Effect.gen(function* () {
    const fileName = params.fileName?.trim() || basename(params.filePath)
    const bytes = yield* readLocalFileBytes(params.filePath)
    const form = new FormData()
    form.append("file", new Blob([bytes], { type: mimeForFileName(fileName) }), fileName)
    form.append("configuration", JSON.stringify(toParseBody(params.configuration)))

    return yield* requestJson({
      provider: "llama",
      method: "POST",
      path: "/api/v2/parse/upload",
      urlParams: projectQuery(params),
      formData: form,
      responseSchema: ParseJobSchema,
    })
  })

export const parseResult = (params: {
  readonly jobId: string
  readonly expand?: ReadonlyArray<string> | undefined
  readonly imageFilenames?: ReadonlyArray<string> | undefined
} & ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "GET",
    path: `/api/v2/parse/${encodeURIComponent(params.jobId)}`,
    urlParams: compactParams({
      organization_id: params.organization_id,
      project_id: params.project_id,
      expand: joinExpand(params.expand),
      image_filenames: params.imageFilenames && params.imageFilenames.length > 0
        ? params.imageFilenames.join(",")
        : undefined,
    }),
    responseSchema: ParseGetResponseSchema,
  })

export const parseList = (params: {
  readonly pageSize?: number
  readonly pageToken?: string
  readonly status?: string
} & ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "GET",
    path: "/api/v2/parse",
    urlParams: compactParams({
      organization_id: params.organization_id,
      project_id: params.project_id,
      page_size: params.pageSize,
      page_token: params.pageToken,
      status: params.status,
    }),
    responseSchema: ParseListResponseSchema,
  })

export const parseVersions = (query?: ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "GET",
    path: "/api/v2/parse/versions",
    urlParams: projectQuery(query),
    responseSchema: Schema.Unknown,
  })

const isTerminalStatus = (status: string) =>
  (PARSE_TERMINAL_STATUSES as readonly string[]).includes(status.toUpperCase())

export const isTerminalJobStatus = isTerminalStatus

export const parseWait = (params: {
  readonly jobId: string
  readonly expand?: ReadonlyArray<string> | undefined
  readonly imageFilenames?: ReadonlyArray<string> | undefined
  readonly timeoutSeconds?: number | undefined
  readonly pollIntervalMs?: number | undefined
} & ProjectQuery) => {
  const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_SECONDS
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_JOB_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutSeconds * 1_000

  const loop = (): Effect.Effect<
    ParseGetResponse,
    unknown,
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  > =>
    parseResult(params).pipe(
      Effect.flatMap((result) => {
        const status = result.job.status.toUpperCase()

        if (status === "COMPLETED") {
          return Effect.succeed(result)
        }

        if (status === "FAILED" || status === "CANCELLED") {
          return Effect.fail(
            new JobFailedError({
              jobId: params.jobId,
              status: result.job.status,
              errorMessage: result.job.error_message ?? undefined,
              message:
                result.job.error_message ??
                `Parse job ${params.jobId} ended as ${result.job.status}`,
            }),
          )
        }

        if (Date.now() >= deadline) {
          return Effect.fail(
            new JobWaitTimeoutError({
              provider: "llama",
              jobId: params.jobId,
              timeoutMs: timeoutSeconds * 1_000,
              lastStatus: result.job.status,
              message: `Parse job ${params.jobId} is still ${result.job.status} after ${timeoutSeconds}s`,
            }),
          )
        }

        return Effect.sleep(pollIntervalMs).pipe(Effect.andThen(loop()))
      }),
    )

  return loop()
}

/** Create or upload-then-create a parse job from exactly one source. */
export const parseRun = (params: {
  readonly filePath?: string | undefined
  readonly fileId?: string | undefined
  readonly sourceUrl?: string | undefined
  readonly fileName?: string | undefined
  readonly configuration: ParseConfiguration
} & ProjectQuery) =>
  params.filePath !== undefined
    ? parseUpload({
      filePath: params.filePath,
      ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
      configuration: params.configuration,
      organization_id: params.organization_id,
      project_id: params.project_id,
    })
    : parseCreate({
      ...params.configuration,
      ...(params.fileId !== undefined ? { file_id: params.fileId } : {}),
      ...(params.sourceUrl !== undefined ? { source_url: params.sourceUrl } : {}),
      organization_id: params.organization_id,
      project_id: params.project_id,
    })

// ---------------------------------------------------------------------------
// Extract — /api/v2/extract

export const extractCreate = (params: {
  readonly file_input: string
  readonly configuration?: unknown
  readonly configuration_id?: string
  readonly webhook_configurations?: unknown
} & ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "POST",
    path: "/api/v2/extract",
    urlParams: projectQuery(params),
    body: omitUndefined({
      file_input: params.file_input,
      configuration: params.configuration,
      configuration_id: params.configuration_id,
      webhook_configurations: params.webhook_configurations,
    }),
    responseSchema: ExtractJobSchema,
  })

export const extractGet = (params: {
  readonly jobId: string
  readonly expand?: ReadonlyArray<string> | undefined
  } & ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "GET",
    path: `/api/v2/extract/${encodeURIComponent(params.jobId)}`,
    urlParams: compactParams({
      organization_id: params.organization_id,
      project_id: params.project_id,
      expand: repeatedQuery(params.expand),
    }),
    responseSchema: ExtractJobSchema,
  })

export const extractList = (params: {
  readonly pageSize?: number
  readonly pageToken?: string
  readonly status?: string
} & ProjectQuery) =>
  requestJson({
    provider: "llama",
    method: "GET",
    path: "/api/v2/extract",
    urlParams: compactParams({
      organization_id: params.organization_id,
      project_id: params.project_id,
      page_size: params.pageSize,
      page_token: params.pageToken,
      status: params.status,
    }),
    responseSchema: ExtractListResponseSchema,
  })

export const extractWait = (params: {
  readonly jobId: string
  readonly expand?: ReadonlyArray<string> | undefined
  readonly timeoutSeconds?: number | undefined
  readonly pollIntervalMs?: number | undefined
} & ProjectQuery) => {
  const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_SECONDS
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_JOB_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutSeconds * 1_000

  const loop = (): Effect.Effect<
    ExtractJob,
    unknown,
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  > =>
    extractGet(params).pipe(
      Effect.flatMap((job) => {
        const status = job.status.toUpperCase()

        if (status === "COMPLETED") {
          return Effect.succeed(job)
        }

        if (status === "FAILED" || status === "CANCELLED") {
          const errorMessage =
            typeof job.error_message === "string" ? job.error_message : undefined
          return Effect.fail(
            new JobFailedError({
              jobId: params.jobId,
              status: job.status,
              errorMessage,
              message: errorMessage ?? `Extract job ${params.jobId} ended as ${job.status}`,
            }),
          )
        }

        if (Date.now() >= deadline) {
          return Effect.fail(
            new JobWaitTimeoutError({
              provider: "llama",
              jobId: params.jobId,
              timeoutMs: timeoutSeconds * 1_000,
              lastStatus: job.status,
              message: `Extract job ${params.jobId} is still ${job.status} after ${timeoutSeconds}s`,
            }),
          )
        }

        return Effect.sleep(pollIntervalMs).pipe(Effect.andThen(loop()))
      }),
    )

  return loop()
}

/** Upload a local file if needed, then create the extract job. */
export const extractRun = (params: {
  readonly filePath?: string | undefined
  readonly fileName?: string | undefined
  readonly fileInput?: string | undefined
  readonly purpose?: string | undefined
  readonly configuration?: unknown
  readonly configuration_id?: string | undefined
  readonly webhook_configurations?: unknown
} & ProjectQuery) =>
  Effect.gen(function* () {
    let fileInput = params.fileInput

    if (params.filePath !== undefined) {
      const uploaded = yield* uploadFile({
        filePath: params.filePath,
        purpose: params.purpose ?? "extract",
        ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
        ...(params.organization_id !== undefined
          ? { organizationId: params.organization_id }
          : {}),
        ...(params.project_id !== undefined ? { projectId: params.project_id } : {}),
      })
      fileInput = uploaded.id
    }

    return yield* extractCreate({
      file_input: fileInput as string,
      ...(params.configuration !== undefined ? { configuration: params.configuration } : {}),
      ...(params.configuration_id !== undefined
        ? { configuration_id: params.configuration_id }
        : {}),
      ...(params.webhook_configurations !== undefined
        ? { webhook_configurations: params.webhook_configurations }
        : {}),
      organization_id: params.organization_id,
      project_id: params.project_id,
    })
  })

// ---------------------------------------------------------------------------
// Cross-provider helpers (used by the unified `extract`/`runs` capability layer)

/** One-shot status check for a parse job (snake_case input, run-registry shape). */
export const parseCheck = (params: {
  readonly job_id: string
  readonly expand?: ReadonlyArray<string> | undefined
  readonly image_filenames?: ReadonlyArray<string> | undefined
} & ProjectQuery) =>
  parseResult({
    jobId: params.job_id,
    expand: params.expand,
    imageFilenames: params.image_filenames,
    organization_id: params.organization_id,
    project_id: params.project_id,
  })

/** One-shot status check for an extract job. */
export const extractCheck = (params: {
  readonly job_id: string
  readonly expand?: ReadonlyArray<string> | undefined
} & ProjectQuery) =>
  extractGet({
    jobId: params.job_id,
    expand: params.expand,
    organization_id: params.organization_id,
    project_id: params.project_id,
  })

/**
 * Unified extract route for local files: upload, start an extract job with an
 * optional inline data_schema/system_prompt, and optionally wait for the
 * structured result.
 */
export const parseAndExtract = (params: {
  readonly filePath: string
  readonly fileName?: string | undefined
  readonly schema?: unknown
  readonly prompt?: string | undefined
  readonly wait?: boolean | undefined
  readonly timeoutMs?: number | undefined
  readonly expand?: ReadonlyArray<string> | undefined
} & ProjectQuery) =>
  Effect.gen(function* () {
    const uploaded = yield* uploadFile({
      filePath: params.filePath,
      purpose: "extract",
      ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
      ...(params.organization_id !== undefined
        ? { organizationId: params.organization_id }
        : {}),
      ...(params.project_id !== undefined ? { projectId: params.project_id } : {}),
    })

    const configuration = omitUndefined({
      data_schema: params.schema,
      system_prompt: params.prompt,
    })

    const job = yield* extractCreate({
      file_input: uploaded.id,
      ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
      organization_id: params.organization_id,
      project_id: params.project_id,
    })

    const run = yield* recordRun({
      provider: "llama",
      kind: "llama.extract",
      remoteId: job.id,
      status: "running",
      payload: params,
    })

    if (params.wait === false) {
      return job
    }

    return yield* extractWait({
      jobId: job.id,
      ...(params.expand !== undefined ? { expand: params.expand } : {}),
      timeoutSeconds:
        params.timeoutMs !== undefined
          ? Math.max(1, Math.round(params.timeoutMs / 1_000))
          : undefined,
      organization_id: params.organization_id,
      project_id: params.project_id,
    }).pipe(
      Effect.tap(() => updateRun(run?.id, { status: "succeeded" })),
      Effect.tapError(() => updateRun(run?.id, { status: "failed" })),
    )
  })
