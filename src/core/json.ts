import { Effect, FileSystem, Schema } from "effect"

import { JsonInputError } from "./errors"

const decodeJsonWithSchema = <S extends Schema.Constraint>(
  schema: S,
  text: string,
  source: string,
) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (error) =>
        new JsonInputError({
          source,
          reason: "InvalidJson",
          message: String(error.message ?? error),
        }),
    ),
  )

export const decodeUnknownJsonText = (text: string, source: string) =>
  decodeJsonWithSchema(Schema.Unknown, text, source)

export const decodeJsonText = <S extends Schema.Constraint>(
  schema: S,
  text: string,
  source: string,
) => decodeJsonWithSchema(schema, text, source)

export const decodeJsonValue = <S extends Schema.Constraint>(schema: S, value: unknown, source: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (error) =>
        new JsonInputError({
          source,
          reason: "InvalidShape",
          message: String(error.message ?? error),
        }),
    ),
  )

const readStdinText = Effect.tryPromise({
  try: () => new Response(Bun.stdin.stream()).text(),
  catch: (cause) =>
    new JsonInputError({
      source: "stdin",
      reason: "ReadFailed",
      message: cause instanceof Error ? cause.message : "Failed to read stdin",
    }),
})

export const loadJsonInput = <S extends Schema.Constraint>(schema: S, input: string) =>
  Effect.gen(function* () {
    const trimmed = input.trim()

    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new JsonInputError({
          source: "inline",
          reason: "EmptyInput",
          message: "JSON input is empty",
        }),
      )
    }

    if (trimmed === "-" || trimmed === "@-") {
      const stdin = yield* readStdinText
      return yield* decodeJsonText(schema, stdin, "stdin")
    }

    if (trimmed.startsWith("@")) {
      const filePath = trimmed.slice(1)

      if (filePath.length === 0) {
        return yield* Effect.fail(
          new JsonInputError({
            source: input,
            reason: "MissingFilePath",
            message: "@file input is missing a file path",
          }),
        )
      }

      const fileSystem = yield* FileSystem.FileSystem
      const contents = yield* fileSystem.readFileString(filePath).pipe(
        Effect.mapError(
          (error) =>
            new JsonInputError({
              source: filePath,
              reason: "ReadFailed",
              message: (error as { message?: string }).message ?? "read failed",
            }),
        ),
      )

      return yield* decodeJsonText(schema, contents, filePath)
    }

    return yield* decodeJsonText(schema, trimmed, "inline")
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const loadBatchJsonInput = (input: string) =>
  loadJsonInput(Schema.Unknown, input).pipe(
    Effect.flatMap((value) => {
      if (Array.isArray(value)) {
        return Effect.succeed(value)
      }

      if (isRecord(value)) {
        return Effect.succeed([value])
      }

      return Effect.fail(
        new JsonInputError({
          source: "input",
          reason: "InvalidShape",
          message: "batch input must be a JSON object or array of objects",
        }),
      )
    }),
  )
