import { Effect, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import { makeJsonCommand } from "../core/command"
import { registerContracts } from "../core/discovery"
import { CommandInputError, JobWaitTimeoutError, ProviderUnsupportedError } from "../core/errors"
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
            check: (id) => parallelApi.findallCheck?.({ findall_id: id } as never),
            cancel: (id) => parallelApi.findallCancel?.(id as never),
            events: (id) => parallelApi.findallEvents?.({ findall_id: id } as never),
          }
        : {
            check: (id) => parallelApi.taskCheck?.({ run_id: id } as never),
          },
  firecrawl: (kind) =>
    kind === "firecrawl.extract"
      ? {
          check: (id) => firecrawlApi.extractCheck?.({ id } as never),
        }
      : kind === "firecrawl.batch"
        ? {
            check: (id) => firecrawlApi.batchCheck?.({ id } as never),
            cancel: (id) => firecrawlApi.batchCancel?.({ id } as never),
          }
        : kind === "firecrawl.crawl"
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

/** Status string of a provider check result; llama parse nests it under `job`. */
const statusOf = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (record.status !== undefined) {
      return typeof record.status === "object" && record.status !== null && "status" in record.status
        ? String((record.status as Record<string, unknown>).status)
        : String(record.status)
    }
    if (record.job && typeof record.job === "object" && "status" in record.job) {
      return String((record.job as Record<string, unknown>).status)
    }
  }
  return "unknown"
}

export const normalizeStatus = (value: unknown): RunStatus => {
  const status = statusOf(value)
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
  description: "List async provider runs tracked in the local registry, newest first. Input: {provider?, status?, limit? (default 100)}. Returns {runs[], count}.",
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
  description: "Inspect one run: its local record plus a live provider status check, which also refreshes the stored status. Input: {id} or {provider, remote_id}. Returns {run, live}.",
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
  description: "Poll a tracked run until it reaches a terminal status. Input: {id | provider+remote_id, interval_ms? (2000), timeout_ms? (300000)}. Returns {run, result, waited_ms}; fails with JobWaitTimeoutError on timeout.",
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
          return yield* new JobWaitTimeoutError({
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
  description: "Cancel a tracked run at its provider (exa agent, parallel monitor/findall, firecrawl batch/crawl/agent) and mark it canceled locally. Input: {id} or {provider, remote_id}. Returns {run_id, remote_id, result}.",
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
  description: "Fetch the provider's event log for a tracked run (exa agent, parallel monitor/findall). Input: {id} or {provider, remote_id}. Returns {run_id, remote_id, provider, events}.",
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
  Command.withDescription("Unified registry of async provider runs (agents, crawls, monitors, parse jobs): list, inspect, wait, cancel, events"),
  Command.withSubcommands([runsList, runsInspect, runsWait, runsCancel, runsEvents]),
)

const RUN_ID_EXAMPLE = "srv_01j7x9v0m2n4p6q8r0s2t4v6w8"

registerContracts([
  {
    command: "runs list",
    description: "List async provider runs tracked in the local registry, newest first. Input: {provider?, status?, limit? (default 100)}. Returns {runs[], count}.",
    output: "{ runs[{ id, provider, kind, remote_id, status, payload, result_ref, created_at, updated_at }], count }; status is queued|running|succeeded|failed|canceled|unsupported, payload is the JSON-encoded original input",
    inputSchema: ListRunsInput,
    orbit: ["list", "inspect", "wait", "cancel", "events"],
    examples: [
      { name: "recent runs", input: {} },
      { name: "failed parallel runs", input: { provider: "parallel", status: "failed", limit: 20 } },
    ],
  },
  {
    command: "runs inspect",
    description: "Inspect one run: its local record plus a live provider status check, which also refreshes the stored status. Input: {id} or {provider, remote_id}. Returns {run, live}.",
    output: "{ run: { id, provider, kind, remote_id, status, payload, result_ref, created_at, updated_at }, live }; live is the provider's raw check response, null when the run has no check endpoint, or { error } when the check failed",
    inputSchema: RunIdInput,
    orbit: ["list", "inspect", "wait", "cancel", "events"],
    examples: [
      { name: "by survey run id", input: { id: RUN_ID_EXAMPLE } },
      { name: "by provider remote id", input: { provider: "exa", remote_id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } },
    ],
  },
  {
    command: "runs wait",
    description: "Poll a tracked run until it reaches a terminal status. Input: {id | provider+remote_id, interval_ms? (2000), timeout_ms? (300000)}. Returns {run, result, waited_ms}; fails with JobWaitTimeoutError on timeout.",
    output: "{ run: { id, provider, kind, remote_id, status, payload, result_ref, created_at, updated_at }, result, waited_ms }; run.status is succeeded|failed|canceled, result is the provider's raw final check response",
    inputSchema: WaitInput,
    orbit: ["list", "inspect", "wait", "cancel", "events"],
    examples: [
      { name: "wait up to 10 minutes", input: { id: RUN_ID_EXAMPLE, interval_ms: 5000, timeout_ms: 600000 } },
    ],
  },
  {
    command: "runs cancel",
    description: "Cancel a tracked run at its provider (exa agent, parallel monitor/findall, firecrawl batch/crawl/agent) and mark it canceled locally. Input: {id} or {provider, remote_id}. Returns {run_id, remote_id, result}.",
    output: "{ run_id, remote_id, result }; result is the provider's raw cancel response",
    inputSchema: RunIdInput,
    orbit: ["list", "inspect", "wait", "cancel", "events"],
    examples: [{ name: "cancel by id", input: { id: RUN_ID_EXAMPLE } }],
  },
  {
    command: "runs events",
    description: "Fetch the provider's event log for a tracked run (exa agent, parallel monitor/findall). Input: {id} or {provider, remote_id}. Returns {run_id, remote_id, provider, events}.",
    output: "{ run_id, remote_id, provider, events }; events is the provider's raw events response",
    inputSchema: RunIdInput,
    orbit: ["list", "inspect", "wait", "cancel", "events"],
    examples: [{ name: "events by id", input: { id: RUN_ID_EXAMPLE } }],
  },
])
