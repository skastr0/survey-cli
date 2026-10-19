import { Effect, Schema } from "effect"

import { makeJsonCommand } from "../core/command"
import { getContract, registerContract } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { type Envelope, envelopeOf, type Executor, spawnExecutor } from "../core/exec"
import { PathError, resolveReference, resolveValue, type Scope } from "../core/jsonpath"

/**
 * Declarative multi-step pipelines: each step runs one survey command (as a
 * subprocess of this binary), and later steps reference earlier outputs with
 * `$.<step>.data...` paths, `{{ }}` templates, and `foreach` fan-out. One
 * call composes search → fetch → corpus → extract without the agent shuttling
 * intermediate JSON through its context.
 */

export const PipeStep = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))),
  command: Schema.NonEmptyString,
  input: Schema.optional(Schema.Unknown),
  foreach: Schema.optional(Schema.String),
  concurrency: Schema.optional(Schema.Int),
  if: Schema.optional(Schema.String),
  select: Schema.optional(Schema.String),
  on_error: Schema.optional(Schema.Literals(["stop", "continue"])),
  timeout_ms: Schema.optional(Schema.Int),
})
export type PipeStep = typeof PipeStep.Type

export const PipeInput = Schema.Struct({
  steps: Schema.Array(PipeStep),
  vars: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  output: Schema.optional(Schema.Unknown),
  max_items: Schema.optional(Schema.Int),
})
export type PipeInput = typeof PipeInput.Type

/** Commands that cannot run inside a pipeline step. */
const FORBIDDEN = new Set(["mcp serve"])
const EXTRA_ALLOWED = new Set(["doctor", "capabilities"])

interface StepReport {
  readonly id: string
  readonly command: string
  readonly ok: boolean
  readonly skipped?: boolean
  readonly duration_ms: number
  readonly items?: number
  readonly error_count?: number
  readonly error?: Envelope["error"]
}

const truthy = (value: unknown) =>
  !(value === undefined || value === null || value === false || value === 0 || value === "" ||
    (Array.isArray(value) && value.length === 0))

const pathError = (field: string) => (error: unknown) =>
  new CommandInputError({ field, message: error instanceof PathError ? error.message : String(error) })

const execOnce = (exec: Executor, step: PipeStep, input: unknown) =>
  Effect.tryPromise({
    try: () => exec(step.command.split(" "), JSON.stringify(input ?? {})),
    catch: (error) => error,
  }).pipe(
    Effect.map(envelopeOf),
    (effect) =>
      step.timeout_ms === undefined
        ? effect
        : effect.pipe(
            Effect.timeoutOrElse({
              duration: step.timeout_ms,
              orElse: () =>
                Effect.succeed<Envelope>({
                  ok: false,
                  error: { type: "TimeoutError", message: `step ${step.id} timed out after ${step.timeout_ms}ms` },
                }),
            }),
          ),
    Effect.catch((error) =>
      Effect.succeed<Envelope>({
        ok: false,
        error: { type: "ExecError", message: error instanceof Error ? error.message : String(error) },
      }),
    ),
  )

export const validatePipeline = (input: PipeInput) =>
  Effect.gen(function* () {
    const seen = new Set<string>(["vars"])
    for (const [index, step] of input.steps.entries()) {
      if (seen.has(step.id)) {
        return yield* new CommandInputError({ field: `steps[${index}].id`, message: `Duplicate or reserved step id "${step.id}"` })
      }
      seen.add(step.id)
      if (FORBIDDEN.has(step.command) || (getContract(step.command) === undefined && !EXTRA_ALLOWED.has(step.command))) {
        return yield* new CommandInputError({
          field: `steps[${index}].command`,
          message: `"${step.command}" is not a pipeline-runnable command. Run \`survey schema list\`.`,
        })
      }
    }
  })

export const runPipeline = (input: PipeInput, exec: Executor = spawnExecutor) =>
  Effect.gen(function* () {
    yield* validatePipeline(input)
    const root: Record<string, unknown> = { vars: input.vars ?? {} }
    const reports: Array<StepReport> = []
    const maxItems = input.max_items ?? 100
    let stopped: string | undefined

    for (const step of input.steps) {
      const started = Date.now()
      const scope: Scope = { root }

      if (step.if !== undefined) {
        const condition = yield* Effect.try({ try: () => resolveReference(step.if!, scope), catch: pathError(`${step.id}.if`) })
        if (!truthy(condition)) {
          root[step.id] = { ok: true, skipped: true, command: step.command, data: null }
          reports.push({ id: step.id, command: step.command, ok: true, skipped: true, duration_ms: 0 })
          continue
        }
      }

      let envelope: Record<string, unknown>
      let report: StepReport
      if (step.foreach !== undefined) {
        const items = yield* Effect.try({ try: () => resolveReference(step.foreach!, scope), catch: pathError(`${step.id}.foreach`) })
        if (!Array.isArray(items)) {
          return yield* new CommandInputError({
            field: `${step.id}.foreach`,
            message: `${step.foreach} resolved to ${items === undefined ? "nothing" : typeof items}, expected an array`,
          })
        }
        const bounded = items.slice(0, maxItems)
        const results = yield* Effect.forEach(
          bounded,
          (item, index) =>
            Effect.gen(function* () {
              const resolved = yield* Effect.try({
                try: () => resolveValue(step.input ?? {}, { root, item, index }),
                catch: pathError(`${step.id}.input`),
              })
              return yield* execOnce(exec, step, resolved)
            }),
          { concurrency: Math.max(1, step.concurrency ?? 4) },
        )
        const errorCount = results.filter((result) => !result.ok).length
        envelope = {
          ok: errorCount === 0,
          command: step.command,
          data: results.filter((result) => result.ok).map((result) => result.data),
          items: results.map((result, index) =>
            result.ok ? { index, ok: true } : { index, ok: false, error: result.error },
          ),
          error_count: errorCount,
          truncated_items: Math.max(0, items.length - bounded.length),
        }
        report = {
          id: step.id,
          command: step.command,
          ok: errorCount === 0,
          duration_ms: Date.now() - started,
          items: bounded.length,
          error_count: errorCount,
        }
      } else {
        const resolved = yield* Effect.try({
          try: () => resolveValue(step.input ?? {}, scope),
          catch: pathError(`${step.id}.input`),
        })
        const result = yield* execOnce(exec, step, resolved)
        envelope = { ...result }
        report = {
          id: step.id,
          command: step.command,
          ok: result.ok,
          duration_ms: Date.now() - started,
          ...(result.error === undefined ? {} : { error: result.error }),
        }
      }

      if (step.select !== undefined && envelope.ok !== false) {
        envelope.data = yield* Effect.try({
          try: () => resolveReference(step.select!, { root: envelope }),
          catch: pathError(`${step.id}.select`),
        })
      }
      root[step.id] = envelope
      reports.push(report)

      if (!report.ok && (step.on_error ?? "stop") === "stop") {
        stopped = step.id
        break
      }
    }

    const ok = reports.every((report) => report.ok)
    const output =
      input.output === undefined
        ? undefined
        : yield* Effect.try({ try: () => resolveValue(input.output, { root }), catch: pathError("output") })

    return {
      ok,
      ...(stopped === undefined ? {} : { stopped_at: stopped }),
      steps: reports,
      ...(input.output === undefined ? { results: root } : { output }),
    }
  })

export const pipeCommand = makeJsonCommand({
  name: "pipe",
  commandName: "pipe",
  description:
    "Run a multi-step pipeline of survey commands in one call. Steps reference earlier results with $.<id>.data… paths (keys, [n], [*], [a:b]) or {{ }} templates; foreach fans a step out over an array ($item/$index) with bounded concurrency; if skips a step when its reference is falsy; select projects a step's envelope; output shapes the final result.",
  schema: PipeInput,
  run: (input) => runPipeline(input),
})

registerContract({
  command: "pipe",
  description: "Compose survey commands into one declarative pipeline",
  inputSchema: PipeInput,
  examples: [
    {
      name: "search then fetch top results into the corpus",
      input: {
        vars: { topic: "effect-ts schema decoding" },
        steps: [
          { id: "s", command: "search", input: { query: "$.vars.topic", limit: 5 }, select: "$.data.results[0:3]" },
          { id: "f", command: "fetch", foreach: "$.s.data", input: { url: "$item.url", max_age_ms: 86400000 }, concurrency: 3 },
          { id: "hits", command: "corpus search", input: { query: "decodeUnknown", limit: 5 } },
        ],
        output: { fetched: "$.f.data[*].url", hits: "$.hits.data.hits[*].url" },
      },
    },
    {
      name: "conditional verify",
      input: {
        steps: [
          { id: "q", command: "keenable search", input: { query: "bun 1.3 release date" } },
          { id: "v", command: "verify", if: "$.q.data", input: { claim: "Bun 1.3 was released in 2025" }, on_error: "continue" },
        ],
      },
    },
  ],
})
