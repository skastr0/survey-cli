import { Clock, Duration, Effect, Option } from "effect"
import { Command } from "effect/unstable/cli"

import {
  applyOutputPolicy,
  concurrencyFlag,
  idempotencyFlag,
  jsonInputArg,
  makeBatchJsonCommand,
  makeJsonCommand,
  optionalJsonInputArg,
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
  MonitorListInput,
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
  description: "Run Parallel web searches (POST /v1/search; keyless public MCP fallback without a key). Input: {objective?, search_queries?, mode?, max_results?}; array for batch. Returns per item {search_id, results}.",
  schema: SearchInput,
  run: (request) =>
    search(request).pipe(
      Effect.tap((response) =>
        recordSources("parallel", extractUrls(response.results))
      ),
      Effect.map((response) => ({
        auth_mode: response.auth_mode,
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
    "Extract content from URLs via Parallel Extract (POST /v1/extract; keyless fallback without a key). Input: {urls, objective?, full_content?}; array for batch. Returns per item {extract_id, results, errors}.",
  schema: ExtractInput,
  run: (request) =>
    extract(request).pipe(
      Effect.tap((response) =>
        recordSources("parallel", extractUrls(response.results))
      ),
      Effect.map((response) => ({
        auth_mode: response.auth_mode,
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
    "Submit Parallel Task Runs (deep research) without waiting. Input: {input, processor?, output_schema?}; array for batch. Returns per item {run_id, status, next_actions}; poll with deep-research check/wait.",
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
    "Submit a Parallel Task Run and poll until complete or max_wait_seconds (default 120). Input: {input, processor?, output_schema?, max_wait_seconds?}. Returns {completed, run_id, status, output?, basis?}.",
  ),
)

const deepResearchInspect = makeJsonCommand({
  name: "inspect",
  commandName: "parallel deep-research inspect",
  description: "Inspect a Task Run without fetching results (GET /v1/tasks/runs/{run_id}). Input: {run_id}. Returns the raw provider run {run_id, status, is_active, processor}.",
  schema: DeepResearchCheckInput,
  run: (request) => getTaskRun(request.run_id),
})

const deepResearchCheck = makeJsonCommand({
  name: "check",
  commandName: "parallel deep-research check",
  description:
    "Check a Task Run once and fetch its result if completed. Input: {run_id, timeout_seconds?}. Returns {completed, run_id, status} plus output and basis when done, else next_actions.",
  schema: DeepResearchCheckInput,
  run: checkTaskRun,
})

const deepResearchWait = makeJsonCommand({
  name: "wait",
  commandName: "parallel deep-research wait",
  description: "Poll an existing Task Run until complete or max_wait_seconds (default 120). Input: {run_id, max_wait_seconds?, poll_interval_seconds?}. Returns {completed, run_id, status, output?, basis?}.",
  schema: DeepResearchWaitInput,
  run: waitForTaskRun,
})

const deepResearchEvents = makeJsonCommand({
  name: "events",
  commandName: "parallel deep-research events",
  description: "Read Task Run SSE events (parallel-beta events-sse-2025-07-24). Input: {run_id, timeout_seconds?, last_event_id?}. Returns {run_id, event_count, events}.",
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
    "Submit Parallel FindAll entity discovery runs (/v1beta/findall/*). Input: {objective, entity_type?, match_conditions?, generator?, match_limit?}; array for batch. Returns per item {findall_id, next_actions}.",
  ),
)

const findAllEntitySearch = makeBatchJsonCommand({
  name: "entity-search",
  commandName: "parallel findall entity-search",
  description:
    "Run a synchronous ranked people or company search without per-candidate verification. Input: {entity_type: people|companies, objective, match_limit?}; array for batch. Returns {entity_set_id, entities}.",
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
  description: "Inspect a FindAll run without fetching candidates. Input: {findall_id}. Returns the raw provider run {findall_id, status: {status, is_active, metrics}, generator}.",
  schema: FindAllCheckInput,
  run: (request) => getFindAllRun(request.findall_id),
})

const findAllCheck = makeJsonCommand({
  name: "check",
  commandName: "parallel findall check",
  description:
    "Check a FindAll run once and fetch candidates when complete. Input: {findall_id}. Returns {completed, findall_id, status} plus candidates when done, else progress and next_actions.",
  schema: FindAllCheckInput,
  run: checkFindAllRun,
})

const findAllWait = makeJsonCommand({
  name: "wait",
  commandName: "parallel findall wait",
  description: "Poll a FindAll run until complete or max_wait_seconds (default 120). Input: {findall_id, max_wait_seconds?, poll_interval_seconds?}. Returns {completed, findall_id, status, candidates?}.",
  schema: FindAllWaitInput,
  run: waitForFindAllRun,
})

const findAllEvents = makeJsonCommand({
  name: "events",
  commandName: "parallel findall events",
  description: "Read FindAll SSE events. Input: {findall_id, timeout_seconds?, last_event_id?}. Returns {findall_id, event_count, events}.",
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
    "Add a Task-powered enrichment to an existing FindAll run. Input: {findall_id, output_schema: {json_schema}, processor?}. Returns {findall_id, schema} with the run's updated schema.",
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
    "Increase the match limit of an existing FindAll run. Input: {findall_id, additional_match_limit}. Returns {findall_id, schema} with the updated match_limit.",
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
).pipe(Command.withDescription("Cancel a FindAll run (POST /v1beta/findall/runs/{id}/cancel). Input: {findall_id}. Returns {findall_id, cancelled: true, response}."))

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
).pipe(Command.withDescription("Create scheduled web monitors (POST /v1/monitors). Input: {query, cadence?, type?, processor?, webhook_url?}; array for batch. Returns per item {monitor_id, status, cadence, next_actions}."))

const monitorList = Command.make("list", { input: optionalJsonInputArg, output: outputFlag }, ({ input, output }) =>
  executeJsonCommand(
    "parallel monitors list",
    loadJsonInput(MonitorListInput, Option.getOrElse(input, () => "{}")).pipe(
      Effect.andThen(listMonitors),
      Effect.flatMap(applyPolicy("parallel monitors list", output)),
    ),
  ),
).pipe(Command.withDescription("List Parallel monitors (GET /v1/monitors). Input optional; must be {} if given. Returns {monitor_count, monitors, next_cursor?}."))

const monitorInspect = makeJsonCommand({
  name: "inspect",
  commandName: "parallel monitors inspect",
  description: "Retrieve a monitor by id (GET /v1/monitors/{id}). Input: {monitor_id}. Returns the raw provider monitor {monitor_id, status, query, cadence, created_at}.",
  schema: MonitorIdInput,
  run: (request) => getMonitor(request.monitor_id),
})

const monitorEvents = makeJsonCommand({
  name: "events",
  commandName: "parallel monitors events",
  description: "List monitor events or fetch one event group. Input: {monitor_id, cursor?, limit?, event_group_id?}; Monitor V1 removed lookback_period. Returns {monitor_id, event_count, events}.",
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
).pipe(Command.withDescription("Enqueue a real off-schedule monitor run (POST /v1/monitors/{id}/trigger). Input: {monitor_id}. Returns {monitor_id, triggered: true}."))

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
).pipe(Command.withDescription("Cancel a monitor to stop future executions (POST /v1/monitors/{id}/cancel). Input: {monitor_id}. Returns {monitor_id, cancelled: true, monitor}."))

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
