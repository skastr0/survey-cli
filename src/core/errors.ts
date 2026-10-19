import { Schema } from "effect"

/** One schema decoding failure: dotted/indexed path into the input and what was wrong there. */
export const InputIssue = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
})
export type InputIssue = typeof InputIssue.Type

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class MissingApiKeyError extends Schema.TaggedError<MissingApiKeyError>()(
  "MissingApiKeyError",
  {
    provider: Schema.String,
    envVar: Schema.String,
    hint: Schema.String,
  },
) {}

export class JsonInputError extends Schema.TaggedError<JsonInputError>()(
  "JsonInputError",
  {
    source: Schema.String,
    reason: Schema.String,
    message: Schema.String,
    issues: Schema.optional(Schema.Array(InputIssue)),
  },
) {}

export class CommandInputError extends Schema.TaggedError<CommandInputError>()(
  "CommandInputError",
  {
    field: Schema.String,
    message: Schema.String,
    issues: Schema.optional(Schema.Array(InputIssue)),
    /** Replaces the generic hint when the raiser knows what is wrong. */
    hint: Schema.optional(Schema.String),
    /** Replaces the `schema show` next_step when a concrete recovery call exists. */
    next_step: Schema.optional(Schema.String),
  },
) {}

export class ApiRequestError extends Schema.TaggedError<ApiRequestError>()(
  "ApiRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    path: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export class ApiResponseError extends Schema.TaggedError<ApiResponseError>()(
  "ApiResponseError",
  {
    provider: Schema.String,
    method: Schema.String,
    path: Schema.String,
    status: Schema.Number,
    message: Schema.String,
    body: Schema.NullishOr(Schema.Unknown),
  },
) {}

export class ApiDecodeError extends Schema.TaggedError<ApiDecodeError>()(
  "ApiDecodeError",
  {
    provider: Schema.String,
    method: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class ArtifactWriteError extends Schema.TaggedError<ArtifactWriteError>()(
  "ArtifactWriteError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class JobWaitTimeoutError extends Schema.TaggedError<JobWaitTimeoutError>()(
  "JobWaitTimeoutError",
  {
    provider: Schema.String,
    jobId: Schema.String,
    timeoutMs: Schema.Number,
    lastStatus: Schema.NullishOr(Schema.String),
    message: Schema.String,
  },
) {}

export class ProviderUnsupportedError extends Schema.TaggedError<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    capability: Schema.String,
    message: Schema.String,
  },
) {}

/** Every provider in a fallback chain failed or was skipped; `attempted` holds each outcome. */
export class AllProvidersFailedError extends Schema.TaggedError<AllProvidersFailedError>()(
  "AllProvidersFailedError",
  {
    capability: Schema.String,
    target: Schema.String,
    attempted: Schema.Array(Schema.Unknown),
    message: Schema.String,
  },
) {}

export class StoreError extends Schema.TaggedError<StoreError>()(
  "StoreError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class McpError extends Schema.TaggedError<McpError>()(
  "McpError",
  {
    provider: Schema.String,
    message: Schema.String,
  },
) {}

export class LocalToolUnavailableError extends Schema.TaggedError<LocalToolUnavailableError>()(
  "LocalToolUnavailableError",
  {
    tool: Schema.String,
    operation: Schema.String,
    attempts: Schema.Array(
      Schema.Struct({
        mode: Schema.String,
        detail: Schema.String,
      }),
    ),
    install_hint: Schema.String,
    message: Schema.String,
  },
) {}

export class LocalToolError extends Schema.TaggedError<LocalToolError>()(
  "LocalToolError",
  {
    tool: Schema.String,
    operation: Schema.String,
    mode: Schema.String,
    code: Schema.NullishOr(Schema.String),
    pages: Schema.NullishOr(Schema.Array(Schema.Number)),
    page_count: Schema.NullishOr(Schema.Number),
    message: Schema.String,
  },
) {}

/** A well-formed request named something that does not exist (corpus document, run, monitor, file). */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "NotFoundError",
  {
    resource: Schema.String,
    id: Schema.String,
    message: Schema.String,
    next_step: Schema.optional(Schema.String),
  },
) {}

/** The argv itself could not be parsed: unknown command or flag, missing argument, bad flag value. */
export class CliUsageError extends Schema.TaggedError<CliUsageError>()(
  "CliUsageError",
  {
    command_path: Schema.Array(Schema.String),
    issues: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        message: Schema.String,
      }),
    ),
    suggestions: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export type AppError =
  | ConfigurationError
  | MissingApiKeyError
  | JsonInputError
  | CommandInputError
  | ApiRequestError
  | ApiResponseError
  | ApiDecodeError
  | ArtifactWriteError
  | JobWaitTimeoutError
  | ProviderUnsupportedError
  | StoreError
  | McpError
  | LocalToolUnavailableError
  | LocalToolError
  | CliUsageError
  | NotFoundError

/** Every error `type` an envelope can carry, with what it means for the caller. */
export const ERROR_TYPES: Readonly<Record<AppError["_tag"] | "UnexpectedError" | "InterruptedError" | "TimeoutError", string>> = {
  CliUsageError: "argv could not be parsed (unknown command/flag, missing argument); fix the invocation",
  JsonInputError: "payload is empty, not JSON, unreadable (@file/stdin), or does not match the schema (details.issues)",
  CommandInputError: "payload decoded but a field value is unacceptable (details.field)",
  NotFoundError: "the named resource does not exist (details.resource, details.id)",
  ConfigurationError: "an environment or config value is invalid",
  MissingApiKeyError: "the provider needs a key for this call; set details.env_var or choose a keyless route",
  ApiRequestError: "network/transport failure reaching the provider; retryable",
  ApiResponseError: "provider returned a non-2xx status; retryable for 408/409/429/5xx (details.status)",
  ApiDecodeError: "provider response did not match the expected contract",
  ProviderUnsupportedError: "the provider cannot perform this capability; pick another provider",
  JobWaitTimeoutError: "a job did not finish within the wait budget; inspect or wait again (retryable)",
  ArtifactWriteError: "could not write an artifact under the survey home",
  StoreError: "local SQLite store failure",
  McpError: "remote MCP transport or server failure; retryable",
  LocalToolUnavailableError: "a local tool (anydoc, pdf-inspector) is not installed; see details.install_hint",
  LocalToolError: "a local tool rejected the document (details.code, e.g. needsOcr)",
  TimeoutError: "a composed call (pipe step, MCP tool) exceeded its timeout; retryable",
  UnexpectedError: "a survey defect; details.trace has the cause",
  InterruptedError: "the command was interrupted before finishing; retryable",
}
