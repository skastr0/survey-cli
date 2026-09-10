import { Effect, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"

import type { OutputPolicy } from "./artifacts"
import { emitOutput } from "./artifacts"
import { loadJsonInput } from "./json"
import { executeJsonCommand } from "./output"
import { runMutationBatch } from "./batch"

export const jsonInputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON payload: inline JSON, @file, -, or @-"),
)

export const optionalJsonInputArg = Argument.string("input").pipe(
  Argument.optional,
  Argument.withDescription("Optional JSON payload: inline JSON, @file, -, or @-"),
)

export const outputFlag = Flag.choice("output", ["inline", "artifact", "auto"]).pipe(
  Flag.withDefault("auto" as const),
  Flag.withDescription("Emit large results inline or as an artifact"),
)

export const concurrencyFlag = Flag.integer("concurrency").pipe(
  Flag.withDefault(5),
  Flag.withDescription("Batch concurrency (positive integer)"),
)

export const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription("Per-operation timeout in milliseconds"),
)

export const waitFlag = Flag.boolean("wait").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Wait for job completion before returning"),
)

export const idempotencyFlag = Flag.string("idempotency-key").pipe(
  Flag.optional,
  Flag.withDescription("Local idempotency receipt key (not a provider guarantee)"),
)

export interface JsonCommandOptions<S extends Schema.Constraint, E, R> {
  readonly name: string
  readonly commandName: string
  readonly description: string
  readonly schema: S
  readonly run: (input: S["Type"]) => Effect.Effect<unknown, E, R>
  readonly contract?: {
    readonly examples?: ReadonlyArray<{ name: string; description?: string; input: unknown }>
    readonly output?: string
    readonly orbit?: ReadonlyArray<string>
  }
}

export const applyOutputPolicy = (options: {
  readonly command: string
  readonly mode: OutputPolicy
  readonly data: unknown
}) =>
  Effect.gen(function* () {
    const serialized = JSON.stringify(options.data)
    if (options.mode === "inline") {
      return options.data
    }
    return yield* emitOutput({
      policy: options.mode,
      key: options.command.replace(/\s+/g, "-"),
      kind: "json",
      contents: serialized,
      summary: `${options.command} produced ${serialized.length} bytes.`,
      inlineData: options.data,
    }).pipe(
      Effect.map((emitted) =>
        emitted.kind === "inline" ? options.data : emitted,
      ),
    )
  })

export const makeJsonCommand = <S extends Schema.Constraint, E, R>(
  options: JsonCommandOptions<S, E, R>,
) =>
  Command.make(
    options.name,
    { input: jsonInputArg, output: outputFlag },
    ({ input, output }) =>
      executeJsonCommand(
        options.commandName,
        loadJsonInput(options.schema, input).pipe(
          Effect.flatMap(options.run),
          Effect.flatMap((data) =>
            applyOutputPolicy({
              command: options.commandName,
              mode: output,
              data,
            }),
          ),
        ),
      ),
  ).pipe(Command.withDescription(options.description))

export const makeBatchJsonCommand = <S extends Schema.Constraint, E, R>(options: {
  readonly name: string
  readonly commandName: string
  readonly description: string
  readonly schema: S
  readonly run: (item: S["Type"], index: number) => Effect.Effect<unknown, E, R>
  readonly validate?: (item: S["Type"]) => Effect.Effect<void, never>
}) =>
  Command.make(
    options.name,
    { input: jsonInputArg, output: outputFlag, concurrency: concurrencyFlag },
    ({ input, output, concurrency }) =>
      executeJsonCommand(
        options.commandName,
        runMutationBatch({
          input,
          concurrency,
          itemSchema: options.schema,
          run: (item, index) => options.run(item, index),
        }).pipe(
          Effect.flatMap((summary) =>
            applyOutputPolicy({
              command: options.commandName,
              mode: output,
              data: summary,
            }),
          ),
        ),
      ),
  ).pipe(Command.withDescription(options.description))
