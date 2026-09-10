import { Effect, Schema } from "effect"

import { CommandInputError } from "../../core/errors"
import { requestJson, requestText } from "../../core/http"
import { decodeUnknownJsonText } from "../../core/json"

import {
  DeepResearchEventsInput,
  DeepResearchInput,
  EntitySearchResponse,
  ExtractInput,
  ExtractResponse,
  FindAllEnrichInput,
  FindAllEntitySearchInput,
  FindAllEventsInput,
  FindAllExtendInput,
  FindAllIngestResponse,
  FindAllRun,
  FindAllRunResult,
  FindAllSchemaResponse,
  FindAllStartInput,
  JsonOutputSchema,
  Monitor,
  MonitorCreateInput,
  MonitorEventsInput,
  MonitorEventsResponse,
  MonitorsResponse,
  SearchInput,
  SearchResponse,
  SourcePolicy,
  TaskRun,
  TaskRunResult,
  type FindAllEnrichment,
  type FindAllEnrichmentV1,
  type TaskRunStatus,
} from "./schemas"
import { parseServerSentEvents } from "./sse"

export const BETA_HEADER = "parallel-beta"
export const TASK_EVENTS_BETA = "events-sse-2025-07-24"

const SEARCH_MODE_ALIASES = {
  "one-shot": "basic",
  agentic: "advanced",
} as const

const omitUndefined = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  )

const compactObject = (value: Record<string, unknown> | undefined) => {
  if (!value) {
    return undefined
  }

  const compact = omitUndefined(value)
  return Object.keys(compact).length > 0 ? compact : undefined
}

export const ensurePositiveInteger = (
  field: string,
  value: number | undefined,
  fallback: number,
) =>
  Effect.gen(function* () {
    const resolved = value ?? fallback

    if (!Number.isInteger(resolved) || resolved <= 0) {
      return yield* new CommandInputError({
        field,
        message: `${field} must be a positive integer`,
      })
    }

    return resolved
  })

const ensureMatchLimit = (
  field: string,
  value: number | undefined,
  fallback: number,
) =>
  Effect.gen(function* () {
    const resolved = value ?? fallback

    if (!Number.isInteger(resolved) || resolved < 5 || resolved > 1000) {
      return yield* new CommandInputError({
        field,
        message: `${field} must be an integer between 5 and 1000`,
      })
    }

    return resolved
  })

export const isTaskInProgress = (
  run: Pick<TaskRun, "status" | "is_active">,
) => run.is_active || run.status === "queued" || run.status === "running"

export const isFindAllInProgress = (run: FindAllRun) =>
  run.status.is_active ||
  run.status.status === "queued" ||
  run.status.status === "running"

const resolveSearchQueries = (input: SearchInput) =>
  Effect.gen(function* () {
    const provided = (input.search_queries ?? [])
      .map((query) => query.trim())
      .filter((query) => query.length > 0)
    const objective = input.objective?.trim()

    if (provided.length > 0) {
      return provided
    }

    if (objective && objective.length > 0) {
      return [objective]
    }

    return yield* new CommandInputError({
      field: "search_queries",
      message:
        "search_queries requires at least one non-empty query, or provide objective to derive one",
    })
  })

const resolveSearchMode = (mode: SearchInput["mode"]) => {
  if (!mode) {
    return "fast"
  }

  return mode in SEARCH_MODE_ALIASES
    ? SEARCH_MODE_ALIASES[mode as keyof typeof SEARCH_MODE_ALIASES]
    : mode
}

const resolveSourcePolicy = (input: {
  readonly source_policy?: SourcePolicy | undefined
  readonly advanced_settings?:
    | { readonly source_policy?: SourcePolicy | undefined }
    | undefined
  readonly allowed_domains?: ReadonlyArray<string> | undefined
  readonly disallowed_domains?: ReadonlyArray<string> | undefined
  readonly include_domains?: ReadonlyArray<string> | undefined
  readonly exclude_domains?: ReadonlyArray<string> | undefined
  readonly after_date?: string | undefined
}) => {
  const base = input.advanced_settings?.source_policy ?? input.source_policy
  return compactObject({
    include_domains:
      base?.include_domains ?? input.include_domains ?? input.allowed_domains,
    exclude_domains:
      base?.exclude_domains ?? input.exclude_domains ?? input.disallowed_domains,
    after_date: base?.after_date ?? input.after_date,
  })
}

export const search = (input: SearchInput) =>
  Effect.gen(function* () {
    const searchQueries = yield* resolveSearchQueries(input)
    const sourcePolicy = resolveSourcePolicy(input)
    const advancedSettings = compactObject({
      source_policy: sourcePolicy,
      fetch_policy: compactObject(
        input.fetch_policy ?? input.advanced_settings?.fetch_policy,
      ),
      excerpt_settings: compactObject(
        input.excerpt_settings ?? input.advanced_settings?.excerpt_settings,
      ),
      location: input.location ?? input.advanced_settings?.location,
      max_results: input.max_results ?? input.advanced_settings?.max_results,
    })

    return yield* requestJson({
      provider: "parallel",
      method: "POST",
      path: "/v1/search",
      body: omitUndefined({
        objective: input.objective,
        search_queries: searchQueries,
        mode: resolveSearchMode(input.mode),
        max_chars_total: input.max_chars_total,
        session_id: input.session_id,
        client_model: input.client_model,
        advanced_settings: advancedSettings,
      }),
      responseSchema: SearchResponse,
    })
  })

export const extract = (input: ExtractInput) =>
  Effect.gen(function* () {
    if (input.urls.length === 0) {
      return yield* new CommandInputError({
        field: "urls",
        message: "urls must contain at least one URL",
      })
    }

    if (input.urls.length > 20) {
      return yield* new CommandInputError({
        field: "urls",
        message: "urls accepts at most 20 URLs per v1 extract request",
      })
    }

    if (input.objective && input.objective.length > 5000) {
      return yield* new CommandInputError({
        field: "objective",
        message: "objective must be at most 5000 characters",
      })
    }

    if (input.excerpts === false) {
      return yield* new CommandInputError({
        field: "excerpts",
        message:
          "v1 extract always returns excerpts; omit excerpts or pass excerpt size settings",
      })
    }

    const excerptSettings = compactObject(
      input.excerpt_settings ??
        input.advanced_settings?.excerpt_settings ??
        (input.excerpts && input.excerpts !== true ? input.excerpts : undefined),
    )
    const fullContent = input.full_content ?? input.advanced_settings?.full_content
    const advancedSettings = compactObject({
      fetch_policy: compactObject(
        input.fetch_policy ?? input.advanced_settings?.fetch_policy,
      ),
      excerpt_settings: excerptSettings,
      full_content: fullContent === false ? undefined : fullContent,
    })

    return yield* requestJson({
      provider: "parallel",
      method: "POST",
      path: "/v1/extract",
      body: omitUndefined({
        urls: input.urls,
        objective: input.objective,
        search_queries: input.search_queries,
        max_chars_total: input.max_chars_total,
        session_id: input.session_id,
        client_model: input.client_model,
        advanced_settings: advancedSettings,
      }),
      responseSchema: ExtractResponse,
    })
  })

export const createTaskRun = (
  input: DeepResearchInput,
  defaultOutput: "auto" | "text",
) =>
  requestJson({
    provider: "parallel",
    method: "POST",
    path: "/v1/tasks/runs",
    ...(input.enable_events
      ? { headers: { [BETA_HEADER]: TASK_EVENTS_BETA } }
      : {}),
    body: omitUndefined({
      input: input.input,
      processor: input.processor?.trim() || "base",
      task_spec: {
        output_schema: input.output_schema ?? { type: defaultOutput },
        ...(input.input_schema ? { input_schema: input.input_schema } : {}),
      },
      metadata: input.metadata,
      source_policy: compactObject({
        include_domains: input.allowed_domains,
        exclude_domains: input.disallowed_domains,
      }),
      advanced_settings: compactObject({
        location: input.location,
      }),
      memory_scope_key: input.memory_scope_key,
      previous_interaction_id: input.previous_interaction_id,
      enable_events: input.enable_events,
      webhook: input.webhook_url ? { url: input.webhook_url } : undefined,
    }),
    responseSchema: TaskRun,
  })

export const getTaskRun = (runId: string) =>
  requestJson({
    provider: "parallel",
    method: "GET",
    path: `/v1/tasks/runs/${encodeURIComponent(runId)}`,
    responseSchema: TaskRun,
  })

export const getTaskResult = (runId: string, timeoutSeconds?: number) =>
  requestJson({
    provider: "parallel",
    method: "GET",
    path: `/v1/tasks/runs/${encodeURIComponent(runId)}/result`,
    ...(timeoutSeconds === undefined
      ? {}
      : { urlParams: { timeout: String(timeoutSeconds) } }),
    responseSchema: TaskRunResult,
  })

export const getTaskRunEvents = (input: DeepResearchEventsInput) =>
  requestText({
    provider: "parallel",
    method: "GET",
    path: `/v1/tasks/runs/${encodeURIComponent(input.run_id)}/events`,
    headers: { [BETA_HEADER]: TASK_EVENTS_BETA },
    urlParams: {
      ...(input.timeout_seconds === undefined
        ? {}
        : { timeout: String(input.timeout_seconds) }),
      ...(input.last_event_id ? { last_event_id: input.last_event_id } : {}),
    },
  }).pipe(
    Effect.map((text) => ({
      run_id: input.run_id,
      event_count: parseServerSentEvents(text).length,
      events: parseServerSentEvents(text),
    })),
  )

export const ingestFindAll = (objective: string) =>
  requestJson({
    provider: "parallel",
    method: "POST",
    path: "/v1beta/findall/ingest",
    body: { objective },
    responseSchema: FindAllIngestResponse,
  })

const normalizeJsonOutputSchema = (schema: JsonOutputSchema) => ({
  type: "json" as const,
  json_schema: schema.json_schema,
})

const toEnrichmentPayload = (
  enrichment: FindAllEnrichment,
): {
  readonly processor: string
  readonly output_schema: {
    readonly type: "json"
    readonly json_schema: Record<string, unknown>
  }
} => {
  if ("output_schema" in enrichment) {
    return {
      processor: enrichment.processor ?? "core",
      output_schema: normalizeJsonOutputSchema(enrichment.output_schema),
    }
  }

  return {
    processor: enrichment.processor ?? "core",
    output_schema: {
      type: "json",
      json_schema: {
        type: "object",
        properties: {
          [enrichment.name]: {
            type: "string",
            description: enrichment.description,
          },
        },
        required: [enrichment.name],
        additionalProperties: false,
      },
    },
  }
}

export const enrichFindAllRun = (input: FindAllEnrichInput) =>
  requestJson({
    provider: "parallel",
    method: "POST",
    path: `/v1beta/findall/runs/${encodeURIComponent(input.findall_id)}/enrich`,
    body: omitUndefined({
      processor: input.processor ?? "core",
      output_schema: normalizeJsonOutputSchema(input.output_schema),
    }),
    responseSchema: FindAllSchemaResponse,
  }).pipe(
    Effect.map((schema) => ({
      findall_id: input.findall_id,
      schema,
    })),
  )

export const extendFindAllRun = (input: FindAllExtendInput) =>
  Effect.gen(function* () {
    if (
      !Number.isInteger(input.additional_match_limit) ||
      input.additional_match_limit <= 0
    ) {
      return yield* new CommandInputError({
        field: "additional_match_limit",
        message: "additional_match_limit must be an integer greater than 0",
      })
    }

    const schema = yield* requestJson({
      provider: "parallel",
      method: "POST",
      path: `/v1beta/findall/runs/${encodeURIComponent(input.findall_id)}/extend`,
      body: { additional_match_limit: input.additional_match_limit },
      responseSchema: FindAllSchemaResponse,
    })

    return {
      findall_id: input.findall_id,
      schema,
    }
  })

export const entitySearch = (input: FindAllEntitySearchInput) =>
  Effect.gen(function* () {
    const matchLimit = yield* ensureMatchLimit(
      "match_limit",
      input.match_limit,
      100,
    )

    return yield* requestJson({
      provider: "parallel",
      method: "POST",
      path: "/v1beta/findall/entity-search",
      body: {
        entity_type: input.entity_type,
        objective: input.objective,
        match_limit: matchLimit,
      },
      responseSchema: EntitySearchResponse,
    })
  })

export const createFindAllRun = (input: FindAllStartInput) =>
  Effect.gen(function* () {
    const inferred =
      input.match_conditions && input.match_conditions.length > 0
        ? undefined
        : yield* ingestFindAll(input.objective)

    const entityType = input.entity_type ?? inferred?.entity_type ?? "entities"
    const matchConditions = input.match_conditions ?? inferred?.match_conditions
    const matchLimit = yield* ensureMatchLimit(
      "match_limit",
      input.match_limit,
      10,
    )

    if (!matchConditions || matchConditions.length === 0) {
      return yield* new CommandInputError({
        field: "match_conditions",
        message: "match_conditions are required when ingest does not infer them",
      })
    }

    const created = yield* requestJson({
      provider: "parallel",
      method: "POST",
      path: "/v1beta/findall/runs",
      body: omitUndefined({
        objective: input.objective,
        entity_type: entityType,
        match_conditions: matchConditions,
        generator: input.generator ?? inferred?.generator ?? "core",
        match_limit: matchLimit,
        exclude_list: input.exclude_list,
        metadata: input.metadata,
        webhook: input.webhook_url ? { url: input.webhook_url } : undefined,
        memory_scope_key: input.memory_scope_key,
      }),
      responseSchema: Schema.Struct({ findall_id: Schema.String }),
    })

    const enrichments = input.enrichments ?? inferred?.enrichments ?? []
    const appliedEnrichments = yield* Effect.forEach(
      enrichments,
      (enrichment) =>
        enrichFindAllRun({
          findall_id: created.findall_id,
          ...toEnrichmentPayload(enrichment),
        }).pipe(Effect.map((result) => result.schema)),
      { concurrency: 1 },
    )

    return {
      findall_id: created.findall_id,
      entity_type: entityType,
      match_conditions: matchConditions,
      generator: input.generator ?? inferred?.generator ?? "core",
      match_limit: matchLimit,
      ...(appliedEnrichments.length > 0
        ? { enrichments: appliedEnrichments }
        : {}),
    }
  })

export const getFindAllRun = (findallId: string) =>
  requestJson({
    provider: "parallel",
    method: "GET",
    path: `/v1beta/findall/runs/${encodeURIComponent(findallId)}`,
    responseSchema: FindAllRun,
  })

export const getFindAllResult = (findallId: string) =>
  requestJson({
    provider: "parallel",
    method: "GET",
    path: `/v1beta/findall/runs/${encodeURIComponent(findallId)}/result`,
    responseSchema: FindAllRunResult,
  })

export const getFindAllEvents = (input: FindAllEventsInput) =>
  requestText({
    provider: "parallel",
    method: "GET",
    path: `/v1beta/findall/runs/${encodeURIComponent(input.findall_id)}/events`,
    urlParams: {
      ...(input.timeout_seconds === undefined
        ? {}
        : { timeout: String(input.timeout_seconds) }),
      ...(input.last_event_id ? { last_event_id: input.last_event_id } : {}),
    },
  }).pipe(
    Effect.map((text) => ({
      findall_id: input.findall_id,
      event_count: parseServerSentEvents(text).length,
      events: parseServerSentEvents(text),
    })),
  )

export const cancelFindAllRun = (findallId: string) =>
  requestText({
    provider: "parallel",
    method: "POST",
    path: `/v1beta/findall/runs/${encodeURIComponent(findallId)}/cancel`,
  }).pipe(
    Effect.flatMap((text) =>
      text.trim().length === 0
        ? Effect.succeed<unknown>({})
        : decodeUnknownJsonText(text, "findall-cancel-response"),
    ),
    Effect.map((response) => ({
      findall_id: findallId,
      cancelled: true,
      response,
    })),
  )

const cadenceToFrequency = (
  cadence: NonNullable<MonitorCreateInput["cadence"]>,
) => {
  switch (cadence) {
    case "hourly":
      return "1h"
    case "daily":
      return "1d"
    case "weekly":
      return "1w"
    case "every_two_weeks":
      return "2w"
  }
}

export const createMonitor = (input: MonitorCreateInput) =>
  Effect.gen(function* () {
    const type = input.type ?? (input.task_run_id ? "snapshot" : "event_stream")
    const frequency =
      input.frequency ??
      (input.cadence ? cadenceToFrequency(input.cadence) : undefined)

    if (!frequency) {
      return yield* new CommandInputError({
        field: "frequency",
        message: "frequency or cadence is required",
      })
    }

    const sourcePolicy = compactObject({
      include_domains: input.include_domains,
      exclude_domains: input.exclude_domains,
      after_date: input.after_date,
    })
    const advancedSettings = compactObject({
      source_policy: sourcePolicy,
      location: input.location,
    })

    const settings =
      type === "snapshot"
        ? (() => {
            const taskRunId = input.task_run_id
            if (!taskRunId) {
              return undefined
            }

            return { task_run_id: taskRunId }
          })()
        : compactObject({
            query: input.query,
            output_schema: input.output_schema
              ? normalizeJsonOutputSchema(input.output_schema)
              : undefined,
            include_backfill: input.include_backfill,
            advanced_settings: advancedSettings,
          })

    if (type === "snapshot" && !input.task_run_id) {
      return yield* new CommandInputError({
        field: "task_run_id",
        message: "task_run_id is required for snapshot monitors",
      })
    }

    if (type === "event_stream" && !input.query) {
      return yield* new CommandInputError({
        field: "query",
        message: "query is required for event_stream monitors",
      })
    }

    return yield* requestJson({
      provider: "parallel",
      method: "POST",
      path: "/v1/monitors",
      body: omitUndefined({
        type,
        frequency,
        processor: input.processor ?? "lite",
        settings,
        webhook: input.webhook_url
          ? { url: input.webhook_url, event_types: ["monitor.event.detected"] }
          : undefined,
        metadata: input.metadata,
        memory_scope_key: input.memory_scope_key,
      }),
      responseSchema: Monitor,
    })
  })

export const listMonitors = requestJson({
  provider: "parallel",
  method: "GET",
  path: "/v1/monitors",
  responseSchema: MonitorsResponse,
}).pipe(
  Effect.map((page) => ({
    monitor_count: page.monitors.length,
    monitors: page.monitors,
    ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
  })),
)

export const getMonitor = (monitorId: string) =>
  requestJson({
    provider: "parallel",
    method: "GET",
    path: `/v1/monitors/${encodeURIComponent(monitorId)}`,
    responseSchema: Monitor,
  })

export const cancelMonitor = (monitorId: string) =>
  requestJson({
    provider: "parallel",
    method: "POST",
    path: `/v1/monitors/${encodeURIComponent(monitorId)}/cancel`,
    responseSchema: Monitor,
  }).pipe(
    Effect.map((monitor) => ({
      monitor_id: monitorId,
      cancelled: true,
      monitor,
    })),
  )

export const triggerMonitorRun = (monitorId: string) =>
  requestText({
    provider: "parallel",
    method: "POST",
    path: `/v1/monitors/${encodeURIComponent(monitorId)}/trigger`,
  }).pipe(
    Effect.map(() => ({
      monitor_id: monitorId,
      triggered: true,
    })),
  )

export const listMonitorEvents = (input: MonitorEventsInput) =>
  Effect.gen(function* () {
    if (input.lookback !== undefined || input.lookback_period !== undefined) {
      return yield* new CommandInputError({
        field: "lookback_period",
        message:
          "Monitor V1 removed lookback_period; use cursor and limit for event pagination",
      })
    }

    return yield* requestJson({
      provider: "parallel",
      method: "GET",
      path: `/v1/monitors/${encodeURIComponent(input.monitor_id)}/events`,
      urlParams: {
        ...(input.event_group_id
          ? { event_group_id: input.event_group_id }
          : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
        ...(input.include_completions === undefined
          ? {}
          : { include_completions: String(input.include_completions) }),
      },
      responseSchema: MonitorEventsResponse,
    })
  })

export type { FindAllEnrichment, FindAllEnrichmentV1, TaskRunStatus }
