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
  extractCreate,
  extractGet,
  extractList,
  extractWait,
  uploadFile,
} from "./api"

const ExtractConfigurationSchema = Schema.Struct({
  data_schema: Schema.optional(Schema.Unknown),
  cite_sources: Schema.optional(Schema.Boolean),
  confidence_scores: Schema.optional(Schema.Boolean),
  extraction_target: Schema.optional(
    Schema.Literals(["per_doc", "per_page", "per_table_row"]),
  ),
  max_pages: Schema.optional(Schema.Number),
  parse_config_id: Schema.optional(Schema.String),
  parse_tier: Schema.optional(Schema.String),
  system_prompt: Schema.optional(Schema.String),
  target_pages: Schema.optional(Schema.String),
  tier: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
})

export const extractCreateInputSchema = Schema.Struct({
  file_input: Schema.String,
  configuration: Schema.optional(ExtractConfigurationSchema),
  configuration_id: Schema.optional(Schema.String),
  webhook_configurations: Schema.optional(Schema.Unknown),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const extractGetInputSchema = Schema.Struct({
  job_id: Schema.String,
  expand: Schema.optional(Schema.Array(Schema.String)),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const extractListInputSchema = Schema.Struct({
  page_size: Schema.optional(Schema.Number),
  page_token: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const extractWaitInputSchema = Schema.Struct({
  job_id: Schema.String,
  expand: Schema.optional(Schema.Array(Schema.String)),
  timeout_seconds: Schema.optional(Schema.Number),
  poll_interval_ms: Schema.optional(Schema.Number),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const extractRunInputSchema = Schema.Struct({
  file_path: Schema.optional(Schema.String),
  file_name: Schema.optional(Schema.String),
  file_input: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.Literals(["extract", "parse"])),
  configuration: Schema.optional(ExtractConfigurationSchema),
  configuration_id: Schema.optional(Schema.String),
  webhook_configurations: Schema.optional(Schema.Unknown),
  expand: Schema.optional(Schema.Array(Schema.String)),
  timeout_seconds: Schema.optional(Schema.Number),
  poll_interval_ms: Schema.optional(Schema.Number),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

type ExtractCreateInput = typeof extractCreateInputSchema.Type

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

const projectFrom = (input: {
  organization_id?: string | undefined
  project_id?: string | undefined
}) => ({
  ...(input.organization_id !== undefined
    ? { organization_id: input.organization_id }
    : {}),
  ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
})

const validateExtractConfig = (input: {
  configuration?: typeof ExtractConfigurationSchema.Type | undefined
  configuration_id?: string | undefined
}) => {
  const hasConfig = input.configuration !== undefined
  const hasConfigId =
    typeof input.configuration_id === "string" &&
    input.configuration_id.trim().length > 0

  if (hasConfig === hasConfigId) {
    return Effect.fail(
      new CommandInputError({
        field: "configuration",
        message: "Provide exactly one of configuration or configuration_id",
      }),
    )
  }

  if (hasConfig && input.configuration?.data_schema === undefined) {
    return Effect.fail(
      new CommandInputError({
        field: "configuration.data_schema",
        message:
          "configuration.data_schema is required when using an inline configuration",
      }),
    )
  }

  return Effect.void
}

const createFromPayload = (payload: ExtractCreateInput) =>
  extractCreate({
    file_input: payload.file_input,
    ...(payload.configuration !== undefined
      ? { configuration: payload.configuration }
      : {}),
    ...(payload.configuration_id !== undefined
      ? { configuration_id: payload.configuration_id }
      : {}),
    ...(payload.webhook_configurations !== undefined
      ? { webhook_configurations: payload.webhook_configurations }
      : {}),
    ...projectFrom(payload),
  })

const waitParamsFrom = (
  input: {
    expand?: ReadonlyArray<string> | undefined
    timeout_seconds?: number | undefined
    poll_interval_ms?: number | undefined
    organization_id?: string | undefined
    project_id?: string | undefined
  },
  jobId: string,
  timeoutOverride?: number | undefined,
) => ({
  jobId,
  ...(input.expand !== undefined ? { expand: input.expand } : {}),
  timeoutSeconds:
    timeoutOverride ?? input.timeout_seconds ?? DEFAULT_JOB_TIMEOUT_SECONDS,
  pollIntervalMs: input.poll_interval_ms ?? DEFAULT_JOB_POLL_INTERVAL_MS,
  ...projectFrom(input),
})

const trackExtractJob = (jobId: string, payload: unknown) =>
  recordRun({
    provider: "llama",
    kind: "llama.extract",
    remoteId: jobId,
    status: "running",
    payload,
  })

const settleRun =
  (runId: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tap(() => updateRun(runId, { status: "succeeded" })),
      Effect.tapError(() => updateRun(runId, { status: "failed" })),
    )

const extractCreateCommand = Command.make(
  "create",
  { input: jsonInputArg, wait: waitFlag, timeout: timeoutFlag, output: outputFlag },
  ({ input, wait, timeout, output }) =>
    executeJsonCommand(
      "llama extract create",
      Effect.gen(function* () {
        const payload = yield* loadJsonInput(extractCreateInputSchema, input)

        if (payload.file_input.trim().length === 0) {
          return yield* new CommandInputError({
            field: "file_input",
            message: "file_input is required",
          })
        }

        const timeoutMs = Option.getOrUndefined(timeout)
        yield* validateExtractConfig(payload)
        yield* validatePositiveInteger("timeout", timeoutMs)
        const timeoutSeconds =
          timeoutMs !== undefined ? Math.max(1, Math.round(timeoutMs / 1_000)) : undefined

        const job = yield* createFromPayload(payload)
        const run = yield* trackExtractJob(job.id, payload)

        if (!wait) {
          return yield* applyOutputPolicy({
            command: "llama extract create",
            mode: output,
            data: job,
          })
        }

        const result = yield* extractWait(
          waitParamsFrom(payload, job.id, timeoutSeconds),
        ).pipe(settleRun(run?.id))
        return yield* applyOutputPolicy({
          command: "llama extract create",
          mode: output,
          data: result,
        })
      }),
    ),
).pipe(
  Command.withDescription(
    "Start an extract v2 job from a file_id or parse job id",
  ),
)

const extractGetCommand = makeJsonCommand({
  name: "get",
  commandName: "llama extract get",
  description: "Get extract job status and results",
  schema: extractGetInputSchema,
  run: (payload) =>
    Effect.gen(function* () {
      if (payload.job_id.trim().length === 0) {
        return yield* new CommandInputError({
          field: "job_id",
          message: "job_id is required",
        })
      }

      return yield* extractGet({
        jobId: payload.job_id,
        ...(payload.expand !== undefined ? { expand: payload.expand } : {}),
        ...projectFrom(payload),
      })
    }),
})

const extractListCommand = Command.make(
  "list",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    executeJsonCommand(
      "llama extract list",
      Effect.gen(function* () {
        const payload = Option.isNone(input)
          ? yield* decodeJsonValue(extractListInputSchema, {}, "default")
          : yield* loadJsonInput(extractListInputSchema, input.value)
        yield* validatePositiveInteger("page_size", payload.page_size)

        const data = yield* extractList({
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
          command: "llama extract list",
          mode: output,
          data,
        })
      }),
    ),
).pipe(Command.withDescription("List extract jobs"))

const extractWaitCommand = Command.make(
  "wait",
  { input: jsonInputArg, timeout: timeoutFlag, output: outputFlag },
  ({ input, timeout, output }) =>
    executeJsonCommand(
      "llama extract wait",
      Effect.gen(function* () {
        const payload = yield* loadJsonInput(extractWaitInputSchema, input)

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

        const data = yield* extractWait(
          waitParamsFrom(payload, payload.job_id, timeoutSeconds),
        )
        return yield* applyOutputPolicy({
          command: "llama extract wait",
          mode: output,
          data,
        })
      }),
    ),
).pipe(
  Command.withDescription(
    "Poll an extract job until COMPLETED, FAILED, or CANCELLED",
  ),
)

const extractRunCommand = Command.make(
  "run",
  { input: jsonInputArg, timeout: timeoutFlag, output: outputFlag },
  ({ input, timeout, output }) =>
    executeJsonCommand(
      "llama extract run",
      Effect.gen(function* () {
        const payload = yield* loadJsonInput(extractRunInputSchema, input)
        const hasPath =
          typeof payload.file_path === "string" && payload.file_path.trim().length > 0
        const hasInput =
          typeof payload.file_input === "string" && payload.file_input.trim().length > 0

        if (hasPath === hasInput) {
          return yield* new CommandInputError({
            field: "file_path",
            message: "Provide exactly one of file_path or file_input",
          })
        }

        const timeoutMs = Option.getOrUndefined(timeout)
        yield* validateExtractConfig(payload)
        yield* validatePositiveInteger("timeout_seconds", payload.timeout_seconds)
        yield* validatePositiveInteger("poll_interval_ms", payload.poll_interval_ms)
        yield* validatePositiveInteger("timeout", timeoutMs)
        const timeoutSeconds =
          timeoutMs !== undefined ? Math.max(1, Math.round(timeoutMs / 1_000)) : undefined

        let fileInput = payload.file_input

        if (hasPath) {
          const uploaded = yield* uploadFile({
            filePath: payload.file_path as string,
            purpose: payload.purpose ?? "extract",
            ...(payload.file_name !== undefined
              ? { fileName: payload.file_name }
              : {}),
            ...(payload.organization_id !== undefined
              ? { organizationId: payload.organization_id }
              : {}),
            ...(payload.project_id !== undefined
              ? { projectId: payload.project_id }
              : {}),
          })
          fileInput = uploaded.id
        }

        const job = yield* extractCreate({
          file_input: fileInput as string,
          ...(payload.configuration !== undefined
            ? { configuration: payload.configuration }
            : {}),
          ...(payload.configuration_id !== undefined
            ? { configuration_id: payload.configuration_id }
            : {}),
          ...(payload.webhook_configurations !== undefined
            ? { webhook_configurations: payload.webhook_configurations }
            : {}),
          ...projectFrom(payload),
        })

        const run = yield* trackExtractJob(job.id, payload)

        const data = yield* extractWait(
          waitParamsFrom(payload, job.id, timeoutSeconds),
        ).pipe(settleRun(run?.id))
        return yield* applyOutputPolicy({
          command: "llama extract run",
          mode: output,
          data,
        })
      }),
    ),
).pipe(
  Command.withDescription(
    "Upload a file if needed, start extract, and wait for structured results",
  ),
)

export const extractCommand = Command.make("extract").pipe(
  Command.withDescription("LlamaExtract v2 jobs"),
  Command.withSubcommands([
    extractCreateCommand,
    extractGetCommand,
    extractListCommand,
    extractWaitCommand,
    extractRunCommand,
  ]),
)
