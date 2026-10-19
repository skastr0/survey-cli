import { Effect, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import { decodeBatchItem, summarizeBatchResults } from "../core/batch"
import {
  applyOutputPolicy,
  concurrencyFlag,
  jsonInputArg,
  outputFlag,
} from "../core/command"
import { CommandInputError } from "../core/errors"
import { decodeJsonValue, loadJsonInput } from "../core/json"
import { executeJsonCommand, setExitCode, toErrorDetails } from "../core/output"

/**
 * Object-or-array command: one JSON object returns its result directly, a JSON
 * array returns an ordered batch summary (`results[i]` matches input `i`).
 */
export const makeOneOrManyCommand = <S extends Schema.Constraint, E, R>(options: {
  readonly name: string
  readonly commandName: string
  readonly description: string
  readonly schema: S
  readonly run: (item: S["Type"]) => Effect.Effect<unknown, E, R>
}) =>
  Command.make(
    options.name,
    { input: jsonInputArg, output: outputFlag, concurrency: concurrencyFlag },
    ({ input, output, concurrency }) =>
      executeJsonCommand(
        options.commandName,
        Effect.gen(function* () {
          if (concurrency <= 0) {
            return yield* new CommandInputError({
              field: "concurrency",
              message: "concurrency must be a positive integer",
            })
          }
          const raw = yield* loadJsonInput(Schema.Unknown, input)
          if (!Array.isArray(raw)) {
            const item = yield* decodeJsonValue(options.schema, raw, "inline")
            return yield* options.run(item)
          }
          const results = yield* Effect.forEach(
            raw,
            (entry, index) =>
              decodeBatchItem(options.schema, entry, index).pipe(
                Effect.flatMap(options.run),
                Effect.map((data) => ({ index, ok: true as const, data })),
                Effect.catch((error) =>
                  Effect.succeed({ index, ok: false as const, error: toErrorDetails(error) }),
                ),
              ),
            { concurrency },
          )
          const summary = summarizeBatchResults(concurrency, results)
          if (summary.error_count > 0) yield* setExitCode(1)
          return summary
        }).pipe(
          Effect.flatMap((data) =>
            applyOutputPolicy({ command: options.commandName, mode: output, data }),
          ),
        ),
      ),
  ).pipe(Command.withDescription(options.description))
