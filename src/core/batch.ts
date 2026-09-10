import { Effect, Schema } from "effect"

import { CommandInputError } from "./errors"
import { decodeJsonValue, loadBatchJsonInput } from "./json"
import { setExitCode, toErrorDetails } from "./output"

export interface BatchResultItem {
  readonly index: number
  readonly ok: boolean
  readonly data?: unknown
  readonly error?: unknown
}

export interface BatchSummary {
  readonly outcome: "succeeded" | "partial_failure" | "failed"
  readonly total: number
  readonly success_count: number
  readonly error_count: number
  readonly concurrency: number
  readonly results: ReadonlyArray<BatchResultItem>
}

export const summarizeBatchResults = (
  concurrency: number,
  results: ReadonlyArray<BatchResultItem>,
): BatchSummary => {
  const successCount = results.filter((result) => result.ok).length
  const errorCount = results.length - successCount

  return {
    outcome:
      errorCount === 0
        ? "succeeded"
        : successCount === 0
          ? "failed"
          : "partial_failure",
    total: results.length,
    success_count: successCount,
    error_count: errorCount,
    concurrency,
    results,
  }
}

export const decodeBatchItem = <S extends Schema.Constraint>(
  schema: S,
  raw: unknown,
  index: number,
) =>
  decodeJsonValue(schema, raw, `batch[${index}]`).pipe(
    Effect.mapError(
      (error) =>
        new CommandInputError({
          field: `items[${index}]`,
          message: error.message,
        }),
    ),
  )

export const runMutationBatch = <S extends Schema.Constraint, E, R, SR>(options: {
  readonly input: string
  readonly concurrency: number
  readonly itemSchema: S
  readonly validate?: (item: S["Type"]) => Effect.Effect<void, CommandInputError>
  readonly run: (item: S["Type"], index: number) => Effect.Effect<SR, E, R>
  readonly toSuccess?: (item: S["Type"], result: SR, index: number) => BatchResultItem
}) =>
  Effect.gen(function* () {
    if (options.concurrency <= 0) {
      return yield* Effect.fail(
        new CommandInputError({
          field: "concurrency",
          message: "concurrency must be a positive integer",
        }),
      )
    }

    const rawItems = yield* loadBatchJsonInput(options.input)
    const results = yield* Effect.forEach(
      rawItems,
      (raw, index) =>
        Effect.gen(function* () {
          const item = yield* decodeBatchItem(options.itemSchema, raw, index)
          if (options.validate) {
            yield* options.validate(item)
          }
          const result = yield* options.run(item, index)
          return options.toSuccess
            ? options.toSuccess(item, result, index)
            : { index, ok: true as const, data: result }
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              index,
              ok: false as const,
              error: toErrorDetails(error),
            }),
          ),
        ),
      { concurrency: options.concurrency },
    )

    const summary = summarizeBatchResults(options.concurrency, results)

    if (summary.error_count > 0) {
      yield* setExitCode(1)
    }

    return summary
  })
