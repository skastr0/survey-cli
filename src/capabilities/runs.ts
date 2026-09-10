import { Effect, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { CommandInputError, ProviderUnsupportedError } from "../core/errors"
import { executeJsonCommand, toErrorDetails } from "../core/output"
import type { AppEnv } from "../core/env"
import { Store, type RunStatus } from "../core/store"
import { exaApi } from "../providers/exa"
import { firecrawlApi } from "../providers/firecrawl"
import { parallelApi } from "../providers/parallel"
import { llamaApi } from "../providers/llama"

const ListRunsInput = Schema.Struct({
  provider: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
})

const RunIdInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  remote_id: Schema.optional(Schema.String),
})

const WaitInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  remote_id: Schema.optional(Schema.String),
  interval_ms: Schema.optional(Schema.Int),
  timeout_ms: Schema.optional(Schema.Int),
})

interface RunAdapter {
  readonly check?: (remoteId: string) => Effect.Effect<unknown, unknown, AppEnv>
  readonly cancel?: (remoteId: string) => Effect.Effect<unknown, unknown, AppEnv>
  readonly events?: (remoteId: string) => Effect.Effect<unknown, unknown, AppEnv>
  readonly list?: () => Effect.Effect<unknown, unknown, AppEnv>
}

const runAdapters: Record<string, (kind: string) => RunAdapter> = {
  exa: () => ({
    check: (id) => exaApi.agentCheck({ id } as never),
    cancel: (id) => exaApi.agentCancel({ id } as never),
    events: (id) => exaApi.agentEvents({ id } as never),
    list: () => exaApi.agentList({} as never),
  }),
  parallel: (kind) =>
    kind === "parallel.monitor"
      ? {
          check: (id) => parallelApi.monitorInspect?.(id as never),
          cancel: (id) => parallelApi.monitorCancel?.(id as never),
          events: (id) => parallelApi.monitorEvents?.({ monitor_id: id } as never),
          list: () => parallelApi.monitorList,
        }
      : kind === "parallel.findall"
        ? {
            check: (id) => parallelApi.findallCheck?.({ run_id: id } as never),
            cancel: (id) => parallelApi.findallCancel?.({ run_id: id } as never),
            events: (id) => parallelApi.findallEvents?.({ run_id: id } as never),
          }
        : {
            check: (id) => parallelApi.taskCheck?.({ run_id: id } as never),
          },
  firecrawl: (kind) =>
    kind === "firecrawl.extract"
      ? {
          check: (id) => firecrawlApi.extractCheck?.({ id } as never),
        }
      : kind === "firecrawl.crawl" || kind === "firecrawl.batch"
        ? {
            check: (id) => firecrawlApi.crawlCheck?.({ id } as never),
            cancel: (id) => firecrawlApi.crawlCancel?.({ id } as never),
          }
        : {
            check: (id) => firecrawlApi.agentCheck?.({ id } as never),
            cancel: (id) => firecrawlApi.agentCancel?.({ id } as never),
          },
  llama: (kind) =>
    kind === "llama.parse"
      ? { check: (id) => llamaApi.parseCheck?.({ job_id: id } as never) }
      : { check: (id) => llamaApi.extractCheck?.({ job_id: id } as never) },
}

const normalizeStatus = (value: unknown): RunStatus => {
  const status =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "status" in value
        ? String((value as Record<string, unknown>).status)
        : "unknown"
  const s = status.toLowerCase()
  if (["completed", "complete", "succeeded", "success", "done", "finished"].includes(s)) return "succeeded"
  if (["failed", "error", "errored"].includes(s)) return "failed"
  if (["canceled", "cancelled", "stopped"].includes(s)) return "canceled"
  if (["queued", "pending", "created"].includes(s)) return "queued"
  return "running"
}

const resolveRun = (input: { id?: string | undefined; provider?: string | undefined; remote_id?: string | undefined }) =>
  Effect.gen(function* () {
    const store = yield* Store
    if (input.id) {
      const run = yield* store.getRun(input.id)
      if (run) return run
      const byRemote = yield* store.findRunByRemote(input.provider ?? "", input.id).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (byRemote) return byRemote
    }
    if (input.provider && input.remote_id) {
      const run = yield* store.findRunByRemote(input.provider, input.remote_id)
      if (run) return run
    }
    return yield* new CommandInputError({
      field: "id",
      message: "No run found. Provide a survey run id (srv_...) or provider + remote_id.",
    })
  })

const adapterFor = (run: { provider: string; kind: string }) =>
  runAdapters[run.provider]?.(run.kind)

export const runsList = makeJsonCommand({
  name: "list",
  commandName: "runs list",
  description: "List tracked runs across all providers",
  schema: ListRunsInput,
  run: (input) =>
    Effect.gen(function* () {
      const store = yield* Store
      const runs = yield* store.listRuns({
        provider: input.provider,
        status: input.status,
        limit: input.limit ?? 100,
      })
      return { runs, count: runs.length }
    }),
})

export const runsInspect = makeJsonCommand({
  name: "inspect",
  commandName: "runs inspect",
  description: "Inspect a run: local record + live provider status",
  schema: RunIdInput,
  run: (input) =>
    Effect.gen(function* () {
      const run = yield* resolveRun(input)
      const adapter = adapterFor(run)
      let live: unknown = null
      if (adapter?.check && run.remote_id) {
        const outcome = yield* Effect.result(adapter.check(run.remote_id))
        if (outcome._tag === "Success") {
          live = outcome.success
          const store = yield* Store
          yield* store
            .updateRun(run.id, { status: normalizeStatus(live) })
            .pipe(Effect.catch(() => Effect.void))
        } else {
          live = { error: toErrorDetails(outcome.failure) }
        }
      }
      return { run, live }
    }),
})

export const runsWait = makeJsonCommand({
  name: "wait",
  commandName: "runs wait",
  description: "Poll a run until terminal status",
  schema: WaitInput,
  run: (input) =>
    Effect.gen(function* () {
      const run = yield* resolveRun(input)
      const adapter = adapterFor(run)
      if (!adapter?.check || !run.remote_id) {
        return yield* new ProviderUnsupportedError({
          provider: run.provider,
          capability: "runs.wait",
          message: `${run.provider} ${run.kind} has no check endpoint`,
        })
      }
      const intervalMs = input.interval_ms ?? 2000
      const timeoutMs = input.timeout_ms ?? 300_000
      const deadline = Date.now() + timeoutMs
      const store = yield* Store

      while (true) {
        const outcome = yield* Effect.result(adapter.check(run.remote_id))
        if (outcome._tag === "Success") {
          const status = normalizeStatus(outcome.success)
          yield* store.updateRun(run.id, { status }).pipe(Effect.catch(() => Effect.void))
          if (["succeeded", "failed", "canceled"].includes(status)) {
            return { run: { ...run, status }, result: outcome.success, waited_ms: timeoutMs - (deadline - Date.now()) }
          }
        }
        if (Date.now() >= deadline) {
          return yield* Effect.fail({
            _tag: "JobWaitTimeoutError" as const,
            provider: run.provider,
            jobId: run.remote_id,
            timeoutMs,
            lastStatus: run.status,
            message: `Run ${run.id} did not reach terminal status within ${timeoutMs}ms`,
          })
        }
        yield* Effect.sleep(intervalMs)
      }
    }),
})

export const runsCancel = makeJsonCommand({
  name: "cancel",
  commandName: "runs cancel",
  description: "Cancel a run where the provider supports it",
  schema: RunIdInput,
  run: (input) =>
    Effect.gen(function* () {
      const run = yield* resolveRun(input)
      const adapter = adapterFor(run)
      if (!adapter?.cancel || !run.remote_id) {
        return yield* new ProviderUnsupportedError({
          provider: run.provider,
          capability: "runs.cancel",
          message: `${run.provider} ${run.kind} does not support cancel`,
        })
      }
      const result = yield* adapter.cancel(run.remote_id)
      const store = yield* Store
      yield* store.updateRun(run.id, { status: "canceled" }).pipe(Effect.catch(() => Effect.void))
      return { run_id: run.id, remote_id: run.remote_id, result }
    }),
})

export const runsEvents = makeJsonCommand({
  name: "events",
  commandName: "runs events",
  description: "Fetch provider events for a run",
  schema: RunIdInput,
  run: (input) =>
    Effect.gen(function* () {
      const run = yield* resolveRun(input)
      const adapter = adapterFor(run)
      if (!adapter?.events || !run.remote_id) {
        return yield* new ProviderUnsupportedError({
          provider: run.provider,
          capability: "runs.events",
          message: `${run.provider} ${run.kind} does not expose events`,
        })
      }
      const events = yield* adapter.events(run.remote_id)
      return { run_id: run.id, remote_id: run.remote_id, provider: run.provider, events }
    }),
})

export const runsCommand = Command.make("runs").pipe(
  Command.withDescription("Unified run registry across all providers"),
  Command.withSubcommands([runsList, runsInspect, runsWait, runsCancel, runsEvents]),
)

for (const [command, description] of [
  ["runs list", "List tracked runs"],
  ["runs inspect", "Inspect a run with live provider status"],
  ["runs wait", "Poll a run to terminal status"],
  ["runs cancel", "Cancel a run if supported"],
  ["runs events", "Fetch provider events for a run"],
] as const) {
  registerContract({ command, description })
}
