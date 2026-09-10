import { createHash } from "node:crypto"

import { Effect, FileSystem, Path } from "effect"

import { CommandInputError, JsonInputError } from "../../core/errors"
import { surveyHome } from "../../core/paths"

export interface IdempotencyReceipt {
  readonly key: string
  readonly command: string
  readonly input_hash: string
  readonly created_at: string
  readonly response: unknown
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`
  }

  return JSON.stringify(value)
}

const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex")

const receiptPath = (key: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const home = yield* surveyHome
    const digest = hashText(key)
    return path.join(home, "idempotency", `${digest}.json`)
  })

const readReceipt = (key: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* receiptPath(key)

    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(
        (error) =>
          new JsonInputError({
            source: path,
            reason: "ReadFailed",
            message:
              (error as { message?: string }).message ??
              "Failed to stat idempotency receipt",
          }),
      ),
    )

    if (!exists) {
      return undefined
    }

    const text = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new JsonInputError({
            source: path,
            reason: "ReadFailed",
            message:
              (error as { message?: string }).message ??
              "Failed to read idempotency receipt",
          }),
      ),
    )

    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as IdempotencyReceipt,
      catch: (cause) =>
        new JsonInputError({
          source: path,
          reason: "InvalidJson",
          message:
            cause instanceof Error
              ? cause.message
              : "Failed to parse idempotency receipt",
        }),
    })

    return parsed
  })

const writeReceipt = (receipt: IdempotencyReceipt) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* receiptPath(receipt.key)
    const dir = yield* Path.Path

    yield* fs
      .makeDirectory(dir.dirname(path), { recursive: true })
      .pipe(
        Effect.andThen(
          fs.writeFileString(path, `${JSON.stringify(receipt, null, 2)}\n`),
        ),
        Effect.mapError(
          (error) =>
            new JsonInputError({
              source: path,
              reason: "WriteFailed",
              message:
                (error as { message?: string }).message ??
                "Failed to write idempotency receipt",
            }),
        ),
      )
  })

const attachIdempotency = (
  data: unknown,
  status: "stored" | "replayed",
  key: string,
) => {
  const idempotency = {
    key,
    status,
    scope: "local_success_receipt",
    retry_behavior:
      "Repeating the same command and payload with this key replays the stored success response on this machine.",
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    return {
      ...data,
      idempotency,
    }
  }

  return {
    result: data,
    idempotency,
  }
}

/**
 * Local success-receipt idempotency. The key is never sent to the provider —
 * it only replays a stored success response on this machine.
 */
export const withIdempotency = <A, E, R>(
  command: string,
  key: string | undefined,
  input: unknown,
  submit: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (!key) {
      return yield* submit
    }

    const inputHash = hashText(stableJson(input))
    const existing = yield* readReceipt(key)

    if (existing) {
      if (existing.command === command && existing.input_hash === inputHash) {
        return attachIdempotency(existing.response, "replayed", key)
      }

      return yield* new CommandInputError({
        field: "idempotency_key",
        message: `idempotency key "${key}" already has a receipt for a different command or payload (command: ${existing.command}, requested: ${command})`,
      })
    }

    const response = yield* submit
    yield* writeReceipt({
      key,
      command,
      input_hash: inputHash,
      created_at: new Date().toISOString(),
      response,
    })

    return attachIdempotency(response, "stored", key)
  })
