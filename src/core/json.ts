import { Effect, FileSystem, Schema, SchemaIssue } from "effect"

import { type InputIssue, JsonInputError } from "./errors"

const formatStandardIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const formatPath = (path: ReadonlyArray<PropertyKey>) =>
  path.reduce<string>(
    (acc, segment) =>
      typeof segment === "number"
        ? `${acc}[${segment}]`
        : acc.length === 0
          ? String(segment)
          : `${acc}.${String(segment)}`,
    "",
  )

/** Flatten a Schema issue tree into `{path, message}` pairs an agent can act on. */
export const toInputIssues = (issue: SchemaIssue.Issue): ReadonlyArray<InputIssue> =>
  formatStandardIssues(issue).issues.map((entry) => ({
    path: formatPath((entry.path ?? []).map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment,
    )),
    message: entry.message,
  }))

const parseJsonText = (text: string, source: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) =>
      new JsonInputError({
        source,
        reason: "InvalidJson",
        message: cause instanceof Error ? cause.message : "Invalid JSON",
      }),
  })

export const decodeJsonValue = <S extends Schema.Constraint>(schema: S, value: unknown, source: string) =>
  Schema.decodeUnknownEffect(schema)(value, { errors: "all" }).pipe(
    Effect.mapError((error) => {
      const issues = toInputIssues(error.issue)
      return new JsonInputError({
        source,
        reason: "InvalidShape",
        message: issues.length > 0
          ? issues.map((entry) => (entry.path ? `${entry.path}: ${entry.message}` : entry.message)).join("; ")
          : String(error.message ?? error),
        issues,
      })
    }),
  ) as Effect.Effect<S["Type"], JsonInputError, S["DecodingServices"]>

const decodeJsonWithSchema = <S extends Schema.Constraint>(
  schema: S,
  text: string,
  source: string,
) => parseJsonText(text, source).pipe(Effect.flatMap((value) => decodeJsonValue(schema, value, source)))

export const decodeUnknownJsonText = (text: string, source: string) =>
  decodeJsonWithSchema(Schema.Unknown, text, source)

export const decodeJsonText = <S extends Schema.Constraint>(
  schema: S,
  text: string,
  source: string,
) => decodeJsonWithSchema(schema, text, source)

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
