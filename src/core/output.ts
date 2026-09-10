import { Cause, Effect } from "effect"

import { ARTIFACT_DIR_ENV, CLI_HOME_ENV } from "./constants"

interface SuccessEnvelope {
  readonly ok: true
  readonly command: string
  readonly data: unknown
}

export interface ErrorEnvelope {
  readonly ok: false
  readonly command?: string
  readonly error: {
    readonly type: string
    readonly message: string
    readonly details?: unknown
  }
}

const writeLine = (stream: NodeJS.WriteStream, text: string) =>
  Effect.sync(() => {
    stream.write(`${text}\n`)
  })

export const setExitCode = (exitCode: number) =>
  Effect.sync(() => {
    process.exitCode = exitCode
  })

const isTaggedError = (
  error: unknown,
): error is Error & { _tag: string; message: string; [key: string]: unknown } =>
  error instanceof Error &&
  "_tag" in error &&
  typeof (error as Record<string, unknown>)._tag === "string"

const secretKeyPattern = /api[-_]?key|authorization|bearer|cookie|password|secret|token|credential/i

const sanitizeForDetails = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sanitizeForDetails)
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        secretKeyPattern.test(key) ? "[redacted]" : sanitizeForDetails(nestedValue),
      ]),
    )
  }

  return value
}

const isRetryableStatus = (status: number) =>
  status === 408 || status === 409 || status === 429 || status >= 500

export const toErrorDetails = (error: unknown): ErrorEnvelope["error"] => {
  if (isTaggedError(error)) {
    switch (error._tag) {
      case "ConfigurationError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            field: error.field as string,
            retryable: false,
            hint: "Fix the configuration value and rerun the command.",
          },
        }
      }
      case "MissingApiKeyError": {
        return {
          type: error._tag,
          message: `${error.envVar as string} is not configured`,
          details: {
            provider: error.provider as string,
            env_var: error.envVar as string,
            hint: error.hint as string,
            next_step: `Set ${error.envVar as string} in the environment or run \`survey auth set '{"provider":"${error.provider as string}"}'\` before retrying.`,
            retryable: false,
          },
        }
      }
      case "JsonInputError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            source: error.source as string,
            reason: error.reason as string,
            hint: "Provide a JSON object, JSON array, @file path, -, or @- input.",
            retryable: false,
          },
        }
      }
      case "CommandInputError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            field: error.field as string,
            hint: "Correct the field value and rerun the command.",
            retryable: false,
          },
        }
      }
      case "ApiRequestError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            provider: error.provider as string,
            method: error.method as string,
            path: error.path as string,
            reason: error.reason as string,
            hint: "Check network connectivity, API base URL, and provider availability.",
            retryable: true,
          },
        }
      }
      case "ApiResponseError": {
        const status = error.status as number

        return {
          type: error._tag,
          message: error.message,
          details: {
            provider: error.provider as string,
            method: error.method as string,
            path: error.path as string,
            status,
            body: sanitizeForDetails(error.body),
            hint: isRetryableStatus(status)
              ? "Retry after the provider recovers or rate limits reset."
              : "Inspect the request payload and provider error body.",
            retryable: isRetryableStatus(status),
          },
        }
      }
      case "ApiDecodeError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            provider: error.provider as string,
            method: error.method as string,
            path: error.path as string,
            hint: "The provider returned a response that does not match the expected JSON contract.",
            retryable: true,
          },
        }
      }
      case "ArtifactWriteError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            path: error.path as string,
            hint: `Check that the artifact directory is writable or set ${CLI_HOME_ENV} or ${ARTIFACT_DIR_ENV}.`,
            retryable: false,
          },
        }
      }
      case "JobWaitTimeoutError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            provider: error.provider as string,
            job_id: error.jobId as string,
            timeout_ms: error.timeoutMs as number,
            last_status: error.lastStatus,
            hint: "Inspect the job later or rerun wait with a larger timeout_ms.",
            retryable: true,
          },
        }
      }
      case "ProviderUnsupportedError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            provider: error.provider as string,
            capability: error.capability as string,
            hint: "Check `survey capabilities` for which providers support this capability.",
            retryable: false,
          },
        }
      }
      case "StoreError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            operation: error.operation as string,
            hint: `Check that the survey home directory is writable or set ${CLI_HOME_ENV}.`,
            retryable: true,
          },
        }
      }
      case "McpError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            provider: error.provider as string,
            retryable: true,
          },
        }
      }
    }
  }

  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      message: error.message,
    }
  }

  return {
    type: "Error",
    message: String(error),
  }
}

export const renderSuccessEnvelope = (command: string, data: unknown) =>
  JSON.stringify(
    {
      ok: true,
      command,
      data,
    } satisfies SuccessEnvelope,
    null,
    2,
  )

export const renderFailureEnvelope = (command: string | undefined, error: unknown) =>
  JSON.stringify(
    {
      ok: false,
      ...(command ? { command } : {}),
      error: toErrorDetails(error),
    } satisfies ErrorEnvelope,
    null,
    2,
  )

export const writeSuccessEnvelope = (command: string, data: unknown) =>
  writeLine(process.stdout, renderSuccessEnvelope(command, data))

export const writeFailureEnvelope = (command: string | undefined, error: unknown) =>
  writeLine(process.stderr, renderFailureEnvelope(command, error))

export const writeCauseEnvelope = (command: string | undefined, cause: Cause.Cause<unknown>) =>
  writeLine(
    process.stderr,
    JSON.stringify(
      {
        ok: false,
        ...(command ? { command } : {}),
        error: {
          type: "UnexpectedError",
          message: Cause.pretty(cause),
        },
      } satisfies ErrorEnvelope,
      null,
      2,
    ),
  )

export const executeJsonCommand = <A, E, R>(command: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flatMap((data) => writeSuccessEnvelope(command, data)),
    Effect.catch((error) =>
      setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(command, error))),
    ),
  )
