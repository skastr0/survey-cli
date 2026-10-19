import { Cause, Effect } from "effect"

import { ARTIFACT_DIR_ENV, CLI_HOME_ENV, CLI_NAME } from "./constants"

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

type TaggedRecord = { readonly _tag: string; readonly message: string; readonly [key: string]: unknown }

/**
 * Tagged errors arrive as `Schema.TaggedError` instances, but a plain
 * `Effect.fail({ _tag, ... })` record must render the same envelope rather
 * than collapsing to `{ type: "Error", message: "[object Object]" }`.
 */
const asTagged = (error: unknown): TaggedRecord | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  const record = error as Record<string, unknown>
  if (typeof record._tag !== "string") return undefined
  if (error instanceof Error) return error as unknown as TaggedRecord
  return { ...record, _tag: record._tag, message: typeof record.message === "string" ? record.message : record._tag }
}

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

export interface ErrorContext {
  /** Command path the error came from; enables `survey schema show` next steps. */
  readonly command?: string | undefined
}

const DISCOVERY_COMMANDS = new Set(["schema show", "schema list", "examples show", "examples list"])

const inputContractStep = (context: ErrorContext | undefined) =>
  context?.command && !DISCOVERY_COMMANDS.has(context.command)
    ? `Run \`${CLI_NAME} schema show "${context.command}"\` for the input contract and \`${CLI_NAME} examples show "${context.command}"\` for working payloads.`
    : `Run \`${CLI_NAME} schema list\` to find the command, then \`${CLI_NAME} schema show "<command>"\`.`

const jsonInputHint = (reason: string) => {
  switch (reason) {
    case "EmptyInput":
      return "Pass the JSON payload as the argument, or @file, -, or @- to read it from a file or stdin."
    case "InvalidJson":
      return "The input is not valid JSON. Single-quote inline payloads for the shell, or pass them via @file."
    case "InvalidShape":
      return "The JSON parsed but does not match the command's input schema; fix the fields listed in issues."
    case "MissingFilePath":
      return "Write the path after @, e.g. @payload.json."
    case "ReadFailed":
      return "Check that the file exists and is readable, or pass the JSON inline."
    default:
      return "Provide a JSON object, JSON array, @file path, -, or @- input."
  }
}

/** Fields every tagged error already exposes elsewhere in the envelope. */
const ENVELOPE_KEYS = new Set(["_tag", "message", "name", "stack", "cause"])

const genericTaggedDetails = (error: TaggedRecord) =>
  sanitizeForDetails(
    Object.fromEntries(
      Object.entries(error).filter(([key, value]) => !ENVELOPE_KEYS.has(key) && typeof value !== "function" && typeof key === "string"),
    ),
  ) as Record<string, unknown>

export const toErrorDetails = (rawError: unknown, context?: ErrorContext): ErrorEnvelope["error"] => {
  const error = asTagged(rawError)
  if (error) {
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
            next_step: `Set ${error.envVar as string} in the environment or run \`${CLI_NAME} auth set '{"provider":"${error.provider as string}","api_key":"..."}'\` before retrying.`,
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
            ...(error.issues ? { issues: error.issues } : {}),
            hint: jsonInputHint(error.reason as string),
            next_step: inputContractStep(context),
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
            ...(error.issues ? { issues: error.issues } : {}),
            hint: "Correct the field value and rerun the command.",
            next_step: inputContractStep(context),
            retryable: false,
          },
        }
      }
      case "CliUsageError": {
        const commandPath = error.command_path as ReadonlyArray<string>
        return {
          type: error._tag,
          message: error.message,
          details: {
            command_path: commandPath,
            issues: error.issues,
            suggestions: error.suggestions,
            hint: "Domain input goes in one JSON argument; flags are execution controls only.",
            next_step: `Run \`${commandPath.join(" ")} --help\` for usage, or \`${CLI_NAME} capabilities\` for every command and the flags it accepts.`,
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
      case "LocalToolUnavailableError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            tool: error.tool as string,
            operation: error.operation as string,
            attempts: error.attempts,
            install_hint: error.install_hint as string,
            next_step: error.install_hint as string,
            retryable: false,
          },
        }
      }
      case "LocalToolError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            tool: error.tool as string,
            operation: error.operation as string,
            mode: error.mode as string,
            code: error.code ?? null,
            ...(error.pages ? { pages: error.pages } : {}),
            ...(error.page_count !== undefined && error.page_count !== null
              ? { page_count: error.page_count }
              : {}),
            hint:
              error.code === "needsOcr"
                ? "The PDF has scanned or image-only pages. Use `survey convert` with a LlamaCloud key for the OCR fallback."
                : "The local tool rejected this document; inspect the code and message.",
            retryable: false,
          },
        }
      }
      case "McpError": {
        return {
          type: error._tag,
          message: error.message,
          details: {
            provider: error.provider as string,
            hint: "The MCP transport or remote MCP server failed; retry, then check the provider's MCP endpoint.",
            retryable: true,
          },
        }
      }
    }

    return {
      type: error._tag,
      message: error.message,
      details: {
        ...genericTaggedDetails(error),
        hint: "Unclassified failure; inspect the message and details.",
        retryable: false,
      },
    }
  }

  if (rawError instanceof Error) {
    return {
      type: rawError.name || "Error",
      message: rawError.message,
      details: {
        hint: "Unclassified failure; inspect the message.",
        retryable: false,
      },
    }
  }

  return {
    type: "Error",
    message: String(rawError),
    details: {
      hint: "Unclassified failure; inspect the message.",
      retryable: false,
    },
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
      error: toErrorDetails(error, { command }),
    } satisfies ErrorEnvelope,
    null,
    2,
  )

export const writeSuccessEnvelope = (command: string, data: unknown) =>
  writeLine(process.stdout, renderSuccessEnvelope(command, data))

export const writeFailureEnvelope = (command: string | undefined, error: unknown) =>
  writeLine(process.stderr, renderFailureEnvelope(command, error))

/** Render a defect or interruption: the squashed error leads, the full trace sits in details. */
export const causeToErrorDetails = (cause: Cause.Cause<unknown>): ErrorEnvelope["error"] => {
  if (Cause.hasInterruptsOnly(cause)) {
    return {
      type: "InterruptedError",
      message: "The command was interrupted before it finished.",
      details: { hint: "Rerun the command; partial work may have been recorded.", retryable: true },
    }
  }
  const squashed = Cause.squash(cause)
  return {
    type: "UnexpectedError",
    message: squashed instanceof Error ? squashed.message : String(squashed),
    details: {
      trace: Cause.pretty(cause),
      hint: `This is a ${CLI_NAME} defect, not an input problem. Report it with the trace.`,
      retryable: false,
    },
  }
}

export const writeCauseEnvelope = (command: string | undefined, cause: Cause.Cause<unknown>) =>
  writeLine(
    process.stderr,
    JSON.stringify(
      {
        ok: false,
        ...(command ? { command } : {}),
        error: causeToErrorDetails(cause),
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
    // Defects still get an envelope that names the command; interrupts propagate.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : setExitCode(1).pipe(Effect.andThen(writeCauseEnvelope(command, cause))),
    ),
  )
