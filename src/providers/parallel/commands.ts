import { Clock, Duration, Effect, Option } from "effect"
import { Command } from "effect/unstable/cli"

import {
  applyOutputPolicy,
  concurrencyFlag,
  idempotencyFlag,
  jsonInputArg,
  makeBatchJsonCommand,
  makeJsonCommand,
  outputFlag,
} from "../../core/command"
import { loadJsonInput } from "../../core/json"
import { executeJsonCommand } from "../../core/output"
import { runMutationBatch } from "../../core/batch"
import { extractUrls, recordRun, recordSources, updateRun } from "../../core/runs"
import { Store, type RunStatus } from "../../core/store"

import {
  cancelFindAllRun,
  cancelMonitor,
  createFindAllRun,
  createMonitor,
  createTaskRun,
  enrichFindAllRun,
  ensurePositiveInteger,
  entitySearch,
  extendFindAllRun,
  extract,
  getFindAllEvents,
  getFindAllResult,
  getFindAllRun,
  getMonitor,
  getTaskResult,
  getTaskRun,
  getTaskRunEvents,
  isFindAllInProgress,
  isTaskInProgress,
  listMonitorEvents,
  listMonitors,
  search,
  triggerMonitorRun,
} from "./api"
import { withIdempotency } from "./idempotency"
import {
  DeepResearchCheckInput,
  DeepResearchEventsInput,
  DeepResearchInput,
  DeepResearchWaitInput,
  ExtractInput,
  FindAllCancelInput,
  FindAllCheckInput,
  FindAllEnrichInput,
  FindAllEntitySearchInput,
  FindAllEventsInput,
  FindAllExtendInput,
  FindAllStartInput,
  FindAllWaitInput,
  MonitorCreateInput,
  MonitorEventsInput,
  MonitorIdInput,
  SearchInput,
  type FindAllRun,
  type TaskRun,
  type TaskRunStatus,
} from "./schemas"

const optionToUndefined = <A>(option: Option.Option<A>) =>
  Option.getOrUndefined(option)

const scopedIdempotencyKey = (key: string | undefined, index: number | undefined) =>
  key && index !== undefined ? `${key}:${index}` : key

// ---- run registry helpers (best-effort, never fail the command) ----

const taskRunStatus = (status: TaskRunStatus): RunStatus => {
  switch (status) {
    case "queued":
      return "queued"
    case "running":
    case "action_required":
      return "running"
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "cancelling":
    case "cancelled":
      return "canceled"
  }
}

const updateRunByRemote = (
  remoteId: string,
  patch: { readonly status?: RunStatus; readonly resultRef?: string },
) =>
  Effect.gen(function* () {
    const store = yield* Store
    const existing = yield* store.findRunByRemote("parallel", remoteId)
    if (existing) {
      yield* store.updateRun(existing.id, patch)
    }
  }).pipe(Effect.catch(() => Effect.void))

// ---- deep-research normalization (ported from parallel-cli) ----

const normalizeTaskResult = (
  runId: string,
  run: {
    readonly status: string
    readonly processor: string
    readonly interaction_id?: string | undefined
    readonly warnings?: unknown
  },
  result: {
    readonly run?: {
      readonly status?: string
      readonly processor?: string
      readonly interaction_id?: string | undefined
      readonly warnings?: unknown
    }
    readonly output?: {
      readonly content?: unknown
      readonly type?: string
      readonly output_schema?: unknown
      readonly basis?: unknown
    }
  },
) => ({
  completed: true,
  run_id: runId,
  status: result.run?.status ?? run.status,
  processor: result.run?.processor ?? run.processor,
  interaction_id: result.run?.interaction_id ?? run.interaction_id,
  output: result.output?.content,
  output_type: result.output?.type,
  output_schema: result.output?.output_schema,
  basis: result.output?.basis,
  warnings: result.run?.warnings ?? run.warnings,
})

const normalizeTaskRun = (
  runId: string,
  run: {
    readonly status: string
    readonly is_active?: boolean
    readonly processor: string
    readonly interaction_id?: string | undefined
    readonly warnings?: unknown
    readonly error?: unknown
  },
) => ({
  completed: false,
  run_id: runId,
  status: run.status,
  is_active: run.is_active,
  processor: run.processor,
  interaction_id: run.interaction_id,
  warnings: run.warnings,
  provider_error: run.error,
  next_action: "parallel deep-research check",
  next_actions: {
    inspect: "parallel deep-research inspect",
    check: "parallel deep-research check",
    wait: "parallel deep-research wait",
    events: "parallel deep-research events",
  },
})

const taskStartData = (run: TaskRun) => ({
  run_id: run.run_id,
  status: run.status,
  processor: run.processor,
  interaction_id: run.interaction_id,
  warnings: run.warnings,
  lifecycle: {
    provider_async: true,
    supported_actions: ["check", "inspect", "wait", "events"],
    unsupported_actions: [
      { action: "cancel", reason: "Task Run cancel is not documented." },
    ],
  },
  next_actions: {
    inspect: "parallel deep-research inspect",
    check: "parallel deep-research check",
    wait: "parallel deep-research wait",
    events: "parallel deep-research events",
  },
})

export const checkTaskRun = (request: DeepResearchCheckInput) =>
  Effect.gen(function* () {
    const run = yield* getTaskRun(request.run_id)

    if (isTaskInProgress(run)) {
      return normalizeTaskRun(request.run_id, run)
    }

    if (run.status !== "completed") {
      yield* updateRunByRemote(request.run_id, {
        status: taskRunStatus(run.status),
      })
      return normalizeTaskRun(request.run_id, run)
    }

    const result = yield* getTaskResult(
      request.run_id,
      request.timeout_seconds,
    )
    yield* updateRunByRemote(request.run_id, { status: "succeeded" })
    yield* recordSources("parallel", extractUrls(result.output.basis ?? []))
    return normalizeTaskResult(request.run_id, run, result)
  })

export const waitForTaskRun = (request: DeepResearchWaitInput) =>
  Effect.gen(function* () {
    const maxWaitSeconds = yield* ensurePositiveInteger(
      "max_wait_seconds",
      request.max_wait_seconds,
      120,
    )
    const pollIntervalSeconds = yield* ensurePositiveInteger(
      "poll_interval_seconds",
      request.poll_interval_seconds,
      5,
    )
    const startMs = yield* Clock.currentTimeMillis
    const deadline = startMs + maxWaitSeconds * 1000
    let current = yield* getTaskRun(request.run_id)

    while (isTaskInProgress(current)) {
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) {
        return normalizeTaskRun(request.run_id, current)
      }

      yield* Effect.sleep(Duration.seconds(pollIntervalSeconds))
      current = yield* getTaskRun(request.run_id)
    }

    if (current.status !== "completed") {
      yield* updateRunByRemote(request.run_id, {
        status: taskRunStatus(current.status),
      })
      return normalizeTaskRun(request.run_id, current)
    }

    const result = yield* getTaskResult(
      request.run_id,
      request.timeout_seconds,
    )
    yield* updateRunByRemote(request.run_id, { status: "succeeded" })
    yield* recordSources("parallel", extractUrls(result.output.basis ?? []))
    return normalizeTaskResult(request.run_id, current, result)
  })

export const runDeepResearch = (request: DeepResearchInput) =>
  Effect.gen(function* () {
    const started = yield* createTaskRun(request, "auto")
    const run = yield* recordRun({
      provider: "parallel",
      kind: "parallel.task",
      remoteId: started.run_id,
      status: taskRunStatus(started.status),
      payload: request,
    })
    const outcome = yield* waitForTaskRun({
      run_id: started.run_id,
      max_wait_seconds: request.max_wait_seconds,
      poll_interval_seconds: request.poll_interval_seconds,
    })
    yield* updateRun(run?.id, {
      status: outcome.completed ? "succeeded" : taskRunStatus(started.status),
    })
    return outcome
  })

// ---- findall normalization ----

const normalizeFindAllRun = (findallId: string, run: FindAllRun) => ({
  completed: false,
  findall_id: findallId,
  status: run.status.status,
  is_active: run.status.is_active,
  progress: {
    generated_candidates: run.status.metrics.generated_candidates_count,
    matched_candidates: run.status.metrics.matched_candidates_count,
  },
  next_action: "parallel findall check",
  next_actions: {
    inspect: "parallel findall inspect",
    check: "parallel findall check",
    wait: "parallel findall wait",
    events: "parallel findall events",
    enrich: "parallel findall enrich",
    extend: "parallel findall extend",
    cancel: "parallel findall cancel",
  },
})

export const checkFindAllRun = (request: FindAllCheckInput) =>
  Effect.gen(function* () {
    const run = yield* getFindAllRun(request.findall_id)

    if (isFindAllInProgress(run)) {
      return normalizeFindAllRun(request.findall_id, run)
    }

    if (run.status.status !== "completed") {
      yield* updateRunByRemote(request.findall_id, {
        status: taskRunStatus(run.status.status),
      })
      return normalizeFindAllRun(request.findall_id, run)
    }

    const result = yield* getFindAllResult(request.findall_id)
    yield* updateRunByRemote(request.findall_id, { status: "succeeded" })
    yield* recordSources("parallel", extractUrls(result.candidates))
    return {
      completed: true,
      findall_id: request.findall_id,
      status: result.status.status,
      total_matched: result.status.metrics.matched_candidates_count,
      candidates: result.candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        name: candidate.name,
        url: candidate.url,
        description: candidate.description,
        match_status: candidate.match_status,
        match_results: candidate.output,
        basis: candidate.basis,
      })),
    }
  })

export const waitForFindAllRun = (request: FindAllWaitInput) =>
  Effect.gen(function* () {
    const maxWaitSeconds = yield* ensurePositiveInteger(
      "max_wait_seconds",
      request.max_wait_seconds,
      120,
    )
    const pollIntervalSeconds = yield* ensurePositiveInteger(
      "poll_interval_seconds",
      request.poll_interval_seconds,
      5,
    )
    const startMs = yield* Clock.currentTimeMillis
    const deadline = startMs + maxWaitSeconds * 1000
    let current = yield* getFindAllRun(request.findall_id)

    while (isFindAllInProgress(current)) {
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) {
        return normalizeFindAllRun(request.findall_id, current)
      }

      yield* Effect.sleep(Duration.seconds(pollIntervalSeconds))
      current = yield* getFindAllRun(request.findall_id)
    }

    if (current.status.status !== "completed") {
      yield* updateRunByRemote(request.findall_id, {
        status: taskRunStatus(current.status.status),
      })
      return normalizeFindAllRun(request.findall_id, current)
    }

    return yield* checkFindAllRun({ findall_id: request.findall_id })
  })

// ---- monitors normalization ----

const normalizeMonitor = (monitor: {
  readonly monitor_id: string
  readonly type?: string | undefined
  readonly query?: string | undefined
  readonly frequency?: string | undefined
  readonly cadence?: string | undefined
  readonly processor?: string | undefined
  readonly status: string
  readonly webhook?: unknown | undefined
  readonly settings?: { readonly query?: string | undefined } | undefined
}) => ({
  monitor_id: monitor.monitor_id,
  type: monitor.type,
  query: monitor.settings?.query ?? monitor.query,
  frequency: monitor.frequency,
  cadence: monitor.cadence,
  processor: monitor.processor,
  status: monitor.status,
  webhook_configured: Boolean(monitor.webhook),
  lifecycle: {
    provider_async: true,
    supported_actions: ["inspect", "events", "trigger", "cancel"],
    unsupported_actions: [
      {
        action: "wait",
        reason:
          "Monitor execution is scheduled or webhook-driven; use events for history.",
      },
      {
        action: "stream",
        reason:
          "Monitor API exposes webhooks and event history, not an SSE stream.",
      },
    ],
  },
  next_actions: {
    inspect: "parallel monitors inspect",
    events: "parallel monitors events",
    trigger: "parallel monitors trigger",
    cancel: "parallel monitors cancel",
  },
})

const applyPolicy = (command: string, output: "inline" | "artifact" | "auto") =>
  (data: unknown) => applyOutputPolicy({ command, mode: output, data })

// ---- search / extract (batch) ----

export const parallelSearchCommand = makeBatchJsonCommand({
  name: "search",
  commandName: "parallel search",
  description: "Run one or more Parallel web searches (POST /v1/search)",
  schema: SearchInput,
  run: (request) =>
    search(request).pipe(
      Effect.tap((response) =>
        recordSources("parallel", extractUrls(response.results))
      ),
      Effect.map((response) => ({
        search_id: response.search_id,
        session_id: response.session_id,
        results: response.results,
        result_count: response.results.length,
        warnings: response.warnings,
        usage: response.usage,
      })),
    ),
})

export const parallelExtractCommand = makeBatchJsonCommand({
  name: "extract",
  commandName: "parallel extract",
  description:
    "Extract content from URLs via Parallel Extract (POST /v1/extract)",
  schema: ExtractInput,
  run: (request) =>
    extract(request).pipe(
      Effect.tap((response) =>
        recordSources("parallel", extractUrls(response.results))
      ),
      Effect.map((response) => ({
        extract_id: response.extract_id,
        session_id: response.session_id,
        results: response.results,
        errors: response.errors,
        result_count: response.results.length,
        error_count: response.errors.length,
        warnings: response.warnings,
        usage: response.usage,
      })),
    ),
})

// ---- deep-research orbit ----

const deepResearchStart = Command.make(
  "start",
  {
    input: jsonInputArg,
    output: outputFlag,
    concurrency: concurrencyFlag,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, output, concurrency, idempotencyKey }) =>
    executeJsonCommand(
      "parallel deep-research start",
      Effect.gen(function* () {
        const baseKey = optionToUndefined(idempotencyKey)
        const summary = yield* runMutationBatch({
          input,
          concurrency,
          itemSchema: DeepResearchInput,
          run: (request, index) =>
            withIdempotency(
              "deep-research start",
              scopedIdempotencyKey(baseKey, index),
              request,
              Effect.gen(function* () {
                const run = yield* createTaskRun(request, "text")
                yield* recordRun({
                  provider: "parallel",
                  kind: "parallel.task",
                  remoteId: run.run_id,
                  status: taskRunStatus(run.status),
                  payload: request,
                })
                return taskStartData(run)
              }),
            ),
        })
        return yield* applyPolicy("parallel deep-research start", output)(
          summary,
        )
      }),
    ),
).pipe(
  Command.withDescription(
    "Start one or more Parallel Task API deep research runs",
  ),
)

const deepResearchRun = Command.make(
  "run",
  {
    input: jsonInputArg,
    output: outputFlag,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, output, idempotencyKey }) =>
    executeJsonCommand(
      "parallel deep-research run",
      loadJsonInput(DeepResearchInput, input).pipe(
        Effect.flatMap((request) =>
          withIdempotency(
            "deep-research run",
            optionToUndefined(idempotencyKey),
            request,
            runDeepResearch(request),
          ),
        ),
        Effect.flatMap(applyPolicy("parallel deep-research run", output)),
      ),
    ),
).pipe(
  Command.withDescription(
    "Start a deep research run and poll until complete or timed out",
  ),
)

const deepResearchInspect = makeJsonCommand({
  name: "inspect",
  commandName: "parallel deep-research inspect",
  description: "Inspect a Parallel Task API run without fetching results",
  schema: DeepResearchCheckInput,
  run: (request) => getTaskRun(request.run_id),
})

const deepResearchCheck = makeJsonCommand({
  name: "check",
  commandName: "parallel deep-research check",
  description:
    "Check a Parallel Task API run and fetch results when complete",
  schema: DeepResearchCheckInput,
  run: checkTaskRun,
})

const deepResearchWait = makeJsonCommand({
  name: "wait",
  commandName: "parallel deep-research wait",
  description: "Wait for an existing Parallel Task API run",
  schema: DeepResearchWaitInput,
  run: waitForTaskRun,
})

const deepResearchEvents = makeJsonCommand({
  name: "events",
  commandName: "parallel deep-research events",
  description: "Fetch Parallel Task API run SSE events",
  schema: DeepResearchEventsInput,
  run: getTaskRunEvents,
})

export const deepResearchCommand = Command.make("deep-research").pipe(
  Command.withDescription("Parallel Task API deep research commands"),
  Command.withSubcommands([
    deepResearchRun,
    deepResearchStart,
    deepResearchInspect,
    deepResearchCheck,
    deepResearchWait,
    deepResearchEvents,
  ]),
)

// ---- findall orbit ----

const findAllStart = Command.make(
  "start",
  {
    input: jsonInputArg,
    output: outputFlag,
    concurrency: concurrencyFlag,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, output, concurrency, idempotencyKey }) =>
    executeJsonCommand(
      "parallel findall start",
      Effect.gen(function* () {
        const baseKey = optionToUndefined(idempotencyKey)
        const summary = yield* runMutationBatch({
          input,
          concurrency,
          itemSchema: FindAllStartInput,
          run: (request, index) =>
            withIdempotency(
              "findall start",
              scopedIdempotencyKey(baseKey, index),
              request,
              createFindAllRun(request).pipe(
                Effect.tap((created) =>
                  recordRun({
                    provider: "parallel",
                    kind: "parallel.findall",
                    remoteId: created.findall_id,
                    status: "queued",
                    payload: request,
                  }),
                ),
                Effect.map((created) => ({
                  ...created,
                  lifecycle: {
                    provider_async: true,
                    supported_actions: [
                      "check",
                      "inspect",
                      "wait",
                      "events",
                      "enrich",
                      "extend",
                      "cancel",
                    ],
                  },
                  next_actions: {
                    inspect: "parallel findall inspect",
                    check: "parallel findall check",
                    wait: "parallel findall wait",
                    events: "parallel findall events",
                    enrich: "parallel findall enrich",
                    extend: "parallel findall extend",
                    cancel: "parallel findall cancel",
                  },
                })),
              ),
            ),
        })
        return yield* applyPolicy("parallel findall start", output)(summary)
      }),
    ),
).pipe(
  Command.withDescription(
    "Start one or more Parallel FindAll entity discovery runs",
  ),
)

const findAllEntitySearch = makeBatchJsonCommand({
  name: "entity-search",
  commandName: "parallel findall entity-search",
  description:
    "Run a synchronous FindAll entity search for people or companies",
  schema: FindAllEntitySearchInput,
  run: (request) =>
    entitySearch(request).pipe(
      Effect.tap((response) =>
        recordSources("parallel", extractUrls(response.entities))
      ),
      Effect.map((response) => ({
        entity_set_id: response.entity_set_id,
        entities: response.entities,
        entity_count: response.entities.length,
      })),
    ),
})

const findAllInspect = makeJsonCommand({
  name: "inspect",
  commandName: "parallel findall inspect",
  description: "Inspect a Parallel FindAll run",
  schema: FindAllCheckInput,
  run: (request) => getFindAllRun(request.findall_id),
})

const findAllCheck = makeJsonCommand({
  name: "check",
  commandName: "parallel findall check",
  description:
    "Check a Parallel FindAll run and fetch candidates when complete",
  schema: FindAllCheckInput,
  run: checkFindAllRun,
})

const findAllWait = makeJsonCommand({
  name: "wait",
  commandName: "parallel findall wait",
  description: "Wait for an existing Parallel FindAll run",
  schema: FindAllWaitInput,
  run: waitForFindAllRun,
})

const findAllEvents = makeJsonCommand({
  name: "events",
  commandName: "parallel findall events",
  description: "Fetch Parallel FindAll SSE events",
  schema: FindAllEventsInput,
  run: getFindAllEvents,
})

const findAllEnrich = Command.make(
  "enrich",
  {
    input: jsonInputArg,
    output: outputFlag,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, output, idempotencyKey }) =>
    executeJsonCommand(
      "parallel findall enrich",
      loadJsonInput(FindAllEnrichInput, input).pipe(
        Effect.flatMap((request) =>
          withIdempotency(
            "findall enrich",
            optionToUndefined(idempotencyKey),
            request,
            enrichFindAllRun(request),
          ),
        ),
        Effect.flatMap(applyPolicy("parallel findall enrich", output)),
      ),
    ),
).pipe(
  Command.withDescription(
    "Add a Task-powered enrichment to an existing FindAll run",
  ),
)

const findAllExtend = Command.make(
  "extend",
  {
    input: jsonInputArg,
    output: outputFlag,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, output, idempotencyKey }) =>
    executeJsonCommand(
      "parallel findall extend",
      loadJsonInput(FindAllExtendInput, input).pipe(
        Effect.flatMap((request) =>
          withIdempotency(
            "findall extend",
            optionToUndefined(idempotencyKey),
            request,
            extendFindAllRun(request),
          ),
        ),
        Effect.flatMap(applyPolicy("parallel findall extend", output)),
      ),
    ),
).pipe(
  Command.withDescription(
    "Increase the match limit of an existing FindAll run",
  ),
)

const findAllCancel = Command.make(
  "cancel",
  {
    input: jsonInputArg,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, idempotencyKey }) =>
    executeJsonCommand(
      "parallel findall cancel",
      loadJsonInput(FindAllCancelInput, input).pipe(
        Effect.flatMap((request) =>
          withIdempotency(
            "findall cancel",
            optionToUndefined(idempotencyKey),
            request,
            cancelFindAllRun(request.findall_id).pipe(
              Effect.tap(() =>
                updateRunByRemote(request.findall_id, { status: "canceled" }),
              ),
            ),
          ),
        ),
      ),
    ),
).pipe(Command.withDescription("Cancel a Parallel FindAll run"))

export const findAllCommand = Command.make("findall").pipe(
  Command.withDescription("Parallel FindAll entity discovery commands"),
  Command.withSubcommands([
    findAllStart,
    findAllEntitySearch,
    findAllInspect,
    findAllCheck,
    findAllWait,
    findAllEvents,
    findAllEnrich,
    findAllExtend,
    findAllCancel,
  ]),
)

// ---- monitors orbit ----

const monitorCreate = Command.make(
  "create",
  {
    input: jsonInputArg,
    output: outputFlag,
    concurrency: concurrencyFlag,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, output, concurrency, idempotencyKey }) =>
    executeJsonCommand(
      "parallel monitors create",
      Effect.gen(function* () {
        const baseKey = optionToUndefined(idempotencyKey)
        const summary = yield* runMutationBatch({
          input,
          concurrency,
          itemSchema: MonitorCreateInput,
          run: (request, index) =>
            withIdempotency(
              "monitors create",
              scopedIdempotencyKey(baseKey, index),
              request,
              createMonitor(request).pipe(
                Effect.tap((monitor) =>
                  recordRun({
                    provider: "parallel",
                    kind: "parallel.monitor",
                    remoteId: monitor.monitor_id,
                    status: "running",
                    payload: request,
                  }),
                ),
                Effect.map(normalizeMonitor),
              ),
            ),
        })
        return yield* applyPolicy("parallel monitors create", output)(summary)
      }),
    ),
).pipe(Command.withDescription("Create one or more Parallel monitors"))

const monitorList = Command.make("list", { output: outputFlag }, ({ output }) =>
  executeJsonCommand(
    "parallel monitors list",
    listMonitors.pipe(
      Effect.flatMap(applyPolicy("parallel monitors list", output)),
    ),
  ),
).pipe(Command.withDescription("List Parallel monitors"))

const monitorInspect = makeJsonCommand({
  name: "inspect",
  commandName: "parallel monitors inspect",
  description: "Inspect a Parallel monitor",
  schema: MonitorIdInput,
  run: (request) => getMonitor(request.monitor_id),
})

const monitorEvents = makeJsonCommand({
  name: "events",
  commandName: "parallel monitors events",
  description: "List Parallel monitor events or fetch one event group",
  schema: MonitorEventsInput,
  run: (request) =>
    listMonitorEvents(request).pipe(
      Effect.map((response) => ({
        monitor_id: request.monitor_id,
        event_group_id: request.event_group_id,
        event_count: response.events.length,
        events: response.events,
        ...("has_more" in response ? { has_more: response.has_more } : {}),
        ...("next_cursor" in response && response.next_cursor
          ? { next_cursor: response.next_cursor }
          : {}),
      })),
    ),
})

const monitorTrigger = Command.make(
  "trigger",
  {
    input: jsonInputArg,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, idempotencyKey }) =>
    executeJsonCommand(
      "parallel monitors trigger",
      loadJsonInput(MonitorIdInput, input).pipe(
        Effect.flatMap((request) =>
          withIdempotency(
            "monitors trigger",
            optionToUndefined(idempotencyKey),
            request,
            triggerMonitorRun(request.monitor_id),
          ),
        ),
      ),
    ),
).pipe(Command.withDescription("Enqueue a real off-schedule monitor run"))

const monitorCancel = Command.make(
  "cancel",
  {
    input: jsonInputArg,
    idempotencyKey: idempotencyFlag,
  },
  ({ input, idempotencyKey }) =>
    executeJsonCommand(
      "parallel monitors cancel",
      loadJsonInput(MonitorIdInput, input).pipe(
        Effect.flatMap((request) =>
          withIdempotency(
            "monitors cancel",
            optionToUndefined(idempotencyKey),
            request,
            cancelMonitor(request.monitor_id).pipe(
              Effect.tap(() =>
                updateRunByRemote(request.monitor_id, { status: "canceled" }),
              ),
            ),
          ),
        ),
      ),
    ),
).pipe(Command.withDescription("Cancel a monitor to stop future executions"))

export const monitorsCommand = Command.make("monitors").pipe(
  Command.withDescription("Parallel monitor commands"),
  Command.withSubcommands([
    monitorCreate,
    monitorList,
    monitorInspect,
    monitorEvents,
    monitorTrigger,
    monitorCancel,
  ]),
)
