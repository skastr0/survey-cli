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
