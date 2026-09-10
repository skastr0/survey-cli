import { Effect, Option, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import {
  applyOutputPolicy,
  jsonInputArg,
  makeJsonCommand,
  optionalJsonInputArg,
  outputFlag,
  timeoutFlag,
  waitFlag,
} from "../../core/command"
import { CommandInputError } from "../../core/errors"
import { decodeJsonValue, loadJsonInput } from "../../core/json"
import { executeJsonCommand } from "../../core/output"
import { recordRun, updateRun } from "../../core/runs"
import {
  DEFAULT_JOB_POLL_INTERVAL_MS,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  defaultParseExpand,
  parseCreate,
  parseList,
  parseResult,
  parseUpload,
  parseVersions,
  parseWait,
  type ParseConfiguration,
} from "./api"

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown)

export const parseConfigurationFields = {
  tier: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  configuration_id: Schema.optional(Schema.String),
  page_ranges: Schema.optional(Schema.Unknown),
  crop_box: Schema.optional(Schema.Unknown),
  disable_cache: Schema.optional(Schema.Boolean),
  input_options: Schema.optional(Schema.Unknown),
  output_options: Schema.optional(Schema.Unknown),
  processing_options: Schema.optional(Schema.Unknown),
  processing_control: Schema.optional(Schema.Unknown),
  agentic_options: Schema.optional(Schema.Unknown),
  user_metadata: Schema.optional(JsonObjectSchema),
  webhook_configurations: Schema.optional(Schema.Unknown),
  webhook_configuration_ids: Schema.optional(Schema.Array(Schema.String)),
  http_proxy: Schema.optional(Schema.String),
  client_name: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
} as const

export const parseCreateInputSchema = Schema.Struct({
  file_id: Schema.optional(Schema.String),
  source_url: Schema.optional(Schema.String),
  expand: Schema.optional(Schema.Array(Schema.String)),
  image_filenames: Schema.optional(Schema.Array(Schema.String)),
  ...parseConfigurationFields,
})

export const parseUploadInputSchema = Schema.Struct({
  file_path: Schema.String,
  file_name: Schema.optional(Schema.String),
  expand: Schema.optional(Schema.Array(Schema.String)),
  image_filenames: Schema.optional(Schema.Array(Schema.String)),
  ...parseConfigurationFields,
})

export const parseResultInputSchema = Schema.Struct({
  job_id: Schema.String,
  expand: Schema.optional(Schema.Array(Schema.String)),
  image_filenames: Schema.optional(Schema.Array(Schema.String)),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const parseListInputSchema = Schema.Struct({
  page_size: Schema.optional(Schema.Number),
  page_token: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const parseWaitInputSchema = Schema.Struct({
  job_id: Schema.String,
  expand: Schema.optional(Schema.Array(Schema.String)),
  image_filenames: Schema.optional(Schema.Array(Schema.String)),
  timeout_seconds: Schema.optional(Schema.Number),
  poll_interval_ms: Schema.optional(Schema.Number),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const parseRunInputSchema = Schema.Struct({
  file_path: Schema.optional(Schema.String),
  file_id: Schema.optional(Schema.String),
  source_url: Schema.optional(Schema.String),
  file_name: Schema.optional(Schema.String),
  expand: Schema.optional(Schema.Array(Schema.String)),
  timeout_seconds: Schema.optional(Schema.Number),
  poll_interval_ms: Schema.optional(Schema.Number),
  ...parseConfigurationFields,
})

const parseVersionsInputSchema = Schema.Struct({
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

type ParseCreateInput = typeof parseCreateInputSchema.Type
type ParseUploadInput = typeof parseUploadInputSchema.Type
type ParseRunInput = typeof parseRunInputSchema.Type

const validatePositiveInteger = (field: string, value: number | undefined) => {
  if (value === undefined) {
    return Effect.void
  }

  if (!Number.isInteger(value) || value <= 0) {
    return Effect.fail(
      new CommandInputError({
        field,
        message: `${field} must be a positive integer`,
      }),
    )
  }

  return Effect.void
}

const toConfig = (
  input: ParseCreateInput | ParseUploadInput | ParseRunInput,
): ParseConfiguration => ({
  ...(input.tier !== undefined ? { tier: input.tier } : {}),
  ...(input.version !== undefined ? { version: input.version } : {}),
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.configuration_id !== undefined
    ? { configuration_id: input.configuration_id }
    : {}),
  ...(input.page_ranges !== undefined ? { page_ranges: input.page_ranges } : {}),
  ...(input.crop_box !== undefined ? { crop_box: input.crop_box } : {}),
  ...(input.disable_cache !== undefined ? { disable_cache: input.disable_cache } : {}),
  ...(input.input_options !== undefined ? { input_options: input.input_options } : {}),
  ...(input.output_options !== undefined
    ? { output_options: input.output_options }
    : {}),
  ...(input.processing_options !== undefined
    ? { processing_options: input.processing_options }
    : {}),
  ...(input.processing_control !== undefined
    ? { processing_control: input.processing_control }
    : {}),
  ...(input.agentic_options !== undefined
    ? { agentic_options: input.agentic_options }
    : {}),
  ...(input.user_metadata !== undefined ? { user_metadata: input.user_metadata } : {}),
  ...(input.webhook_configurations !== undefined
    ? { webhook_configurations: input.webhook_configurations }
    : {}),
  ...(input.webhook_configuration_ids !== undefined
    ? { webhook_configuration_ids: input.webhook_configuration_ids }
    : {}),
  ...(input.http_proxy !== undefined ? { http_proxy: input.http_proxy } : {}),
  ...(input.client_name !== undefined ? { client_name: input.client_name } : {}),
})

const projectFrom = (input: {
  organization_id?: string | undefined
  project_id?: string | undefined
}) => ({
  ...(input.organization_id !== undefined
    ? { organization_id: input.organization_id }
    : {}),
  ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
})

const validateFileOrUrl = (input: {
  file_id?: string | undefined
  source_url?: string | undefined
}) => {
  const hasFile = typeof input.file_id === "string" && input.file_id.trim().length > 0
  const hasUrl =
    typeof input.source_url === "string" && input.source_url.trim().length > 0

  if (hasFile === hasUrl) {
    return Effect.fail(
      new CommandInputError({
        field: "file_id",
        message: "Provide exactly one of file_id or source_url",
      }),
    )
  }

  return Effect.void
}

const waitParamsFrom = (
  input: {
    expand?: ReadonlyArray<string> | undefined
    image_filenames?: ReadonlyArray<string> | undefined
    timeout_seconds?: number | undefined
    poll_interval_ms?: number | undefined
    organization_id?: string | undefined
    project_id?: string | undefined
    tier?: string | undefined
  },
  jobId: string,
  timeoutOverride?: number | undefined,
) => ({
  jobId,
  // Default expand is markdown — except fast tier, which must use text.
  expand: input.expand ?? [...defaultParseExpand(input.tier)],
  ...(input.image_filenames !== undefined
    ? { imageFilenames: input.image_filenames }
    : {}),
  timeoutSeconds:
    timeoutOverride ?? input.timeout_seconds ?? DEFAULT_JOB_TIMEOUT_SECONDS,
  pollIntervalMs: input.poll_interval_ms ?? DEFAULT_JOB_POLL_INTERVAL_MS,
  ...projectFrom(input),
})

/** Track a parse job in the local run registry (best-effort). */
const trackParseJob = (jobId: string, payload: unknown) =>
  recordRun({
    provider: "llama",
    kind: "llama.parse",
    remoteId: jobId,
    status: "running",
    payload,
  })

const settleRun = (runId: string | undefined) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tap(() => updateRun(runId, { status: "succeeded" })),
    Effect.tapError(() => updateRun(runId, { status: "failed" })),
  )

const parseCreateCommand = Command.make(
  "create",
  { input: jsonInputArg, wait: waitFlag, timeout: timeoutFlag, output: outputFlag },
  ({ input, wait, timeout, output }) =>
    executeJsonCommand(
      "llama parse create",
      Effect.gen(function* () {
        const payload = yield* loadJsonInput(parseCreateInputSchema, input)
        yield* validateFileOrUrl(payload)
        const timeoutMs = Option.getOrUndefined(timeout)
        yield* validatePositiveInteger("timeout", timeoutMs)
        const timeoutSeconds =
          timeoutMs !== undefined ? Math.max(1, Math.round(timeoutMs / 1_000)) : undefined

        const job = yield* parseCreate({
          ...toConfig(payload),
          ...(payload.file_id !== undefined ? { file_id: payload.file_id } : {}),
          ...(payload.source_url !== undefined
            ? { source_url: payload.source_url }
            : {}),
          ...projectFrom(payload),
        })

        const run = yield* trackParseJob(job.id, payload)

        if (!wait) {
          return yield* applyOutputPolicy({
            command: "llama parse create",
            mode: output,
            data: job,
          })
        }

        const result = yield* parseWait(
          waitParamsFrom(payload, job.id, timeoutSeconds),
        ).pipe(settleRun(run?.id))
        return yield* applyOutputPolicy({
          command: "llama parse create",
          mode: output,
          data: result,
        })
      }),
    ),
).pipe(
  Command.withDescription("Start a parse job from a file_id or source_url"),
)

const parseUploadCommand = Command.make(
  "upload",
  { input: jsonInputArg, wait: waitFlag, timeout: timeoutFlag, output: outputFlag },
  ({ input, wait, timeout, output }) =>
    executeJsonCommand(
      "llama parse upload",
      Effect.gen(function* () {
        const payload = yield* loadJsonInput(parseUploadInputSchema, input)

        if (payload.file_path.trim().length === 0) {
          return yield* new CommandInputError({
            field: "file_path",
            message: "file_path is required",
          })
        }

        const timeoutMs = Option.getOrUndefined(timeout)
        yield* validatePositiveInteger("timeout", timeoutMs)
        const timeoutSeconds =
          timeoutMs !== undefined ? Math.max(1, Math.round(timeoutMs / 1_000)) : undefined

        const job = yield* parseUpload({
          filePath: payload.file_path,
          ...(payload.file_name !== undefined
            ? { fileName: payload.file_name }
            : {}),
          configuration: toConfig(payload),
          ...projectFrom(payload),
        })

        const run = yield* trackParseJob(job.id, payload)

        if (!wait) {
          return yield* applyOutputPolicy({
            command: "llama parse upload",
            mode: output,
            data: job,
          })
        }

        const result = yield* parseWait(
          waitParamsFrom(payload, job.id, timeoutSeconds),
        ).pipe(settleRun(run?.id))
        return yield* applyOutputPolicy({
          command: "llama parse upload",
          mode: output,
          data: result,
        })
      }),
    ),
).pipe(
  Command.withDescription(
    "Upload a local file and start a parse job in one multipart request",
  ),
)

const parseListCommand = Command.make(
  "list",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    executeJsonCommand(
      "llama parse list",
      Effect.gen(function* () {
        const payload = Option.isNone(input)
          ? yield* decodeJsonValue(parseListInputSchema, {}, "default")
          : yield* loadJsonInput(parseListInputSchema, input.value)
        yield* validatePositiveInteger("page_size", payload.page_size)

        const data = yield* parseList({
          ...(payload.page_size !== undefined
            ? { pageSize: payload.page_size }
            : {}),
          ...(payload.page_token !== undefined
            ? { pageToken: payload.page_token }
            : {}),
          ...(payload.status !== undefined ? { status: payload.status } : {}),
          ...projectFrom(payload),
        })

        return yield* applyOutputPolicy({
          command: "llama parse list",
          mode: output,
          data,
        })
      }),
    ),
).pipe(Command.withDescription("List parse jobs"))

const parseResultCommand = makeJsonCommand({
  name: "result",
  commandName: "llama parse result",
  description: "Get parse job status and optional expanded results",
  schema: parseResultInputSchema,
  run: (payload) =>
    Effect.gen(function* () {
      if (payload.job_id.trim().length === 0) {
        return yield* new CommandInputError({
          field: "job_id",
          message: "job_id is required",
        })
      }

      return yield* parseResult({
        jobId: payload.job_id,
        ...(payload.expand !== undefined ? { expand: payload.expand } : {}),
        ...(payload.image_filenames !== undefined
          ? { imageFilenames: payload.image_filenames }
          : {}),
        ...projectFrom(payload),
      })
    }),
})

const parseWaitCommand = Command.make(
  "wait",
  { input: jsonInputArg, timeout: timeoutFlag, output: outputFlag },
  ({ input, timeout, output }) =>
    executeJsonCommand(
      "llama parse wait",
      Effect.gen(function* () {
        const payload = yield* loadJsonInput(parseWaitInputSchema, input)

        if (payload.job_id.trim().length === 0) {
          return yield* new CommandInputError({
            field: "job_id",
            message: "job_id is required",
          })
        }

        const timeoutMs = Option.getOrUndefined(timeout)
        yield* validatePositiveInteger("timeout_seconds", payload.timeout_seconds)
        yield* validatePositiveInteger("poll_interval_ms", payload.poll_interval_ms)
        yield* validatePositiveInteger("timeout", timeoutMs)
        const timeoutSeconds =
          timeoutMs !== undefined ? Math.max(1, Math.round(timeoutMs / 1_000)) : undefined

        const data = yield* parseWait(
          waitParamsFrom(payload, payload.job_id, timeoutSeconds),
        )
        return yield* applyOutputPolicy({
          command: "llama parse wait",
          mode: output,
          data,
        })
      }),
    ),
).pipe(
  Command.withDescription(
    "Poll a parse job until COMPLETED, FAILED, or CANCELLED",
  ),
)

const parseRunCommand = Command.make(
  "run",
  { input: jsonInputArg, timeout: timeoutFlag, output: outputFlag },
  ({ input, timeout, output }) =>
    executeJsonCommand(
      "llama parse run",
      Effect.gen(function* () {
        const payload = yield* loadJsonInput(parseRunInputSchema, input)
        const hasPath =
          typeof payload.file_path === "string" && payload.file_path.trim().length > 0
        const hasFile =
          typeof payload.file_id === "string" && payload.file_id.trim().length > 0
        const hasUrl =
          typeof payload.source_url === "string" && payload.source_url.trim().length > 0
        const sources = [hasPath, hasFile, hasUrl].filter(Boolean).length

        if (sources !== 1) {
          return yield* new CommandInputError({
            field: "file_path",
            message: "Provide exactly one of file_path, file_id, or source_url",
          })
        }

        const timeoutMs = Option.getOrUndefined(timeout)
        yield* validatePositiveInteger("timeout_seconds", payload.timeout_seconds)
        yield* validatePositiveInteger("poll_interval_ms", payload.poll_interval_ms)
        yield* validatePositiveInteger("timeout", timeoutMs)
        const timeoutSeconds =
          timeoutMs !== undefined ? Math.max(1, Math.round(timeoutMs / 1_000)) : undefined

        const job = hasPath
          ? yield* parseUpload({
              filePath: payload.file_path as string,
              ...(payload.file_name !== undefined
                ? { fileName: payload.file_name }
                : {}),
              configuration: toConfig(payload),
              ...projectFrom(payload),
            })
          : yield* parseCreate({
              ...toConfig(payload),
              ...(hasFile ? { file_id: payload.file_id } : {}),
              ...(hasUrl ? { source_url: payload.source_url } : {}),
              ...projectFrom(payload),
            })

        const run = yield* trackParseJob(job.id, payload)

        const data = yield* parseWait(
          waitParamsFrom(payload, job.id, timeoutSeconds),
        ).pipe(settleRun(run?.id))
        return yield* applyOutputPolicy({
          command: "llama parse run",
          mode: output,
          data,
        })
      }),
    ),
).pipe(
  Command.withDescription(
    "Upload or start a parse job and wait for markdown results",
  ),
)

const parseVersionsCommand = Command.make(
  "versions",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    executeJsonCommand(
      "llama parse versions",
      Effect.gen(function* () {
        const payload = Option.isNone(input)
          ? yield* decodeJsonValue(parseVersionsInputSchema, {}, "default")
          : yield* loadJsonInput(parseVersionsInputSchema, input.value)
        const data = yield* parseVersions(projectFrom(payload))
        return yield* applyOutputPolicy({
          command: "llama parse versions",
          mode: output,
          data,
        })
      }),
    ),
).pipe(Command.withDescription("List available LlamaParse tier versions"))

export const parseCommand = Command.make("parse").pipe(
  Command.withDescription("LlamaParse v2 jobs"),
  Command.withSubcommands([
    parseCreateCommand,
    parseUploadCommand,
    parseListCommand,
    parseResultCommand,
    parseWaitCommand,
    parseRunCommand,
    parseVersionsCommand,
  ]),
)
