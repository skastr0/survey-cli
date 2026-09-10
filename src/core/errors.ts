import { Schema } from "effect"

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
  },
) {}

export class CommandInputError extends Schema.TaggedError<CommandInputError>()(
  "CommandInputError",
  {
    field: Schema.String,
    message: Schema.String,
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
