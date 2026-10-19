import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"
import { Command } from "effect/unstable/cli"

import { makeJsonCommand } from "../core/command"
import { registerContracts } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { recordRun } from "../core/runs"
import { parallelApi } from "../providers/parallel"
import { tinyfishApi } from "../providers/tinyfish"

const MonitorProvider = Schema.optional(Schema.Literals(["parallel", "tinyfish"]))

const MonitorCreateInput = Schema.Struct({
  provider: MonitorProvider,
  type: Schema.String,
  query: Schema.optional(Schema.String),
  objective: Schema.optional(Schema.String),
  cadence: Schema.optional(Schema.Literals(["hourly", "daily", "weekly", "every_two_weeks"])),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  // TinyFish (type: fetch | search)
  config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  schedule_cron: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  webhook_url: Schema.optional(Schema.String),
})
type MonitorCreateInput = typeof MonitorCreateInput.Type

const MonitorIdInput = Schema.Struct({
  provider: MonitorProvider,
  monitor_id: Schema.String,
})

const MonitorListInput = Schema.Struct({
  provider: MonitorProvider,
  limit: Schema.optional(Schema.Int),
  cursor: Schema.optional(Schema.String),
})

const CADENCE_CRON: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 1",
}

const tinyfishCreate = (input: MonitorCreateInput) =>
  Effect.gen(function* () {
    if (input.type !== "fetch" && input.type !== "search") {
      return yield* new CommandInputError({
        field: "type",
        message: 'tinyfish monitors use type "fetch" (page) or "search" (topic)',
      })
    }
    const schedule = input.schedule_cron ?? (input.cadence ? CADENCE_CRON[input.cadence] : undefined)
    if (schedule === undefined) {
      return yield* new CommandInputError({
        field: "schedule_cron",
        message: "tinyfish monitors need schedule_cron or cadence hourly|daily|weekly",
      })
    }
    const query = input.query ?? input.objective
    const config = input.config ?? (input.type === "search" && query ? { query } : undefined)
    if (config === undefined) {
      return yield* new CommandInputError({
        field: "config",
        message: "tinyfish monitors need config ({url} for fetch, {query} for search)",
      })
    }
    // tinyfishApi.monitorCreate records the run itself.
    const created = yield* tinyfishApi.monitorCreate({
      type: input.type,
      config,
      schedule_cron: schedule,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.webhook_url !== undefined ? { webhook_url: input.webhook_url } : {}),
    })
    return { monitor: created, provider: "tinyfish" }
  })

const monitorCreate = makeJsonCommand({
  name: "create",
  commandName: "monitor create",
  description: "Create a monitor (Parallel GA monitors, or TinyFish with provider: tinyfish)",
  schema: MonitorCreateInput,
  run: (input) =>
    input.provider === "tinyfish" ? tinyfishCreate(input) : Effect.gen(function* () {
      const created = yield* parallelApi.monitorCreate({
        type: input.type,
        query: input.query,
        objective: input.objective,
        cadence: input.cadence as never,
        settings: input.settings,
        metadata: input.metadata,
        ...(input.webhook_url !== undefined ? { webhook_url: input.webhook_url } : {}),
      } as never) as Effect.Effect<unknown, unknown, AppEnv>
      const record = created as Record<string, unknown>
      const remoteId = typeof record.monitor_id === "string" ? record.monitor_id : typeof record.id === "string" ? record.id : undefined
      const run = yield* recordRun({
        provider: "parallel",
        kind: "parallel.monitor",
        remoteId,
        status: "running",
        payload: input,
      })
      return { monitor: created, run_id: run?.id ?? null }
    }),
})

const monitorList = makeJsonCommand({
  name: "list",
  commandName: "monitor list",
  description: "List monitors",
  schema: MonitorListInput,
  run: (input) =>
    (input.provider === "tinyfish" ? tinyfishApi.monitorList : parallelApi.monitorList) as Effect.Effect<unknown, unknown, AppEnv>,
})

const monitorInspect = makeJsonCommand({
  name: "inspect",
  commandName: "monitor inspect",
  description: "Inspect a monitor",
  schema: MonitorIdInput,
  run: (input) =>
    (input.provider === "tinyfish"
      ? tinyfishApi.monitorInspect({ id: input.monitor_id })
      : parallelApi.monitorInspect(input.monitor_id as never)) as Effect.Effect<unknown, unknown, AppEnv>,
})

const monitorEvents = makeJsonCommand({
  name: "events",
  commandName: "monitor events",
  description: "Fetch monitor events",
  schema: MonitorIdInput,
  run: (input) =>
    (input.provider === "tinyfish"
      ? Effect.succeed(tinyfishApi.monitorEventsUnsupported({ id: input.monitor_id }))
      : parallelApi.monitorEvents({ monitor_id: input.monitor_id } as never)) as Effect.Effect<unknown, unknown, AppEnv>,
})

const monitorTrigger = makeJsonCommand({
  name: "trigger",
  commandName: "monitor trigger",
  description: "Trigger a monitor now",
  schema: MonitorIdInput,
  run: (input) =>
    (input.provider === "tinyfish"
      ? tinyfishApi.monitorTrigger({ id: input.monitor_id })
      : parallelApi.monitorTrigger(input.monitor_id as never)) as Effect.Effect<unknown, unknown, AppEnv>,
})

const monitorCancel = makeJsonCommand({
  name: "cancel",
  commandName: "monitor cancel",
  description: "Cancel a monitor (TinyFish: pauses it; use tinyfish monitor delete to remove)",
  schema: MonitorIdInput,
  run: (input) =>
    (input.provider === "tinyfish"
      ? tinyfishApi.monitorUpdate({ id: input.monitor_id, status: "paused" })
      : parallelApi.monitorCancel(input.monitor_id as never)) as Effect.Effect<unknown, unknown, AppEnv>,
})

export const monitorCommand = Command.make("monitor").pipe(
  Command.withDescription("Normalized provider monitors (Parallel default, TinyFish via provider: tinyfish)"),
  Command.withSubcommands([
    monitorCreate,
    monitorList,
    monitorInspect,
    monitorEvents,
    monitorTrigger,
    monitorCancel,
  ]),
)

const PARALLEL_MONITOR_ID = { monitor_id: "monitor_abc123" }
const TINYFISH_MONITOR_ID = { provider: "tinyfish", monitor_id: "mon_abc123" }

registerContracts([
  {
    command: "monitor create",
    description:
      "Create a monitor. Default provider parallel; provider: tinyfish takes type fetch|search, config, schedule_cron (or cadence hourly|daily|weekly), name, purpose, webhook_url.",
    inputSchema: MonitorCreateInput,
    examples: [
      { name: "parallel monitor", input: { type: "event_stream", query: "new Bun releases", cadence: "daily" } },
      {
        name: "tinyfish topic monitor",
        input: { provider: "tinyfish", type: "search", query: "tinyfish api launch", cadence: "daily" },
      },
      {
        name: "tinyfish page monitor",
        input: {
          provider: "tinyfish",
          type: "fetch",
          config: { url: "https://example.com/pricing", format: "markdown" },
          schedule_cron: "0 9 * * *",
          purpose: "Alert when plan prices change",
        },
      },
    ],
  },
  {
    command: "monitor list",
    description: "List monitors for one provider (default parallel)",
    inputSchema: MonitorListInput,
    examples: [{ name: "parallel", input: {} }, { name: "tinyfish", input: { provider: "tinyfish" } }],
  },
  {
    command: "monitor inspect",
    description: "Inspect a monitor",
    inputSchema: MonitorIdInput,
    examples: [{ name: "parallel", input: PARALLEL_MONITOR_ID }, { name: "tinyfish", input: TINYFISH_MONITOR_ID }],
  },
  {
    command: "monitor events",
    description: "Fetch monitor events (TinyFish has no run-history endpoint: returns supported:false)",
    inputSchema: MonitorIdInput,
    examples: [{ name: "parallel", input: PARALLEL_MONITOR_ID }, { name: "tinyfish", input: TINYFISH_MONITOR_ID }],
  },
  {
    command: "monitor trigger",
    description: "Trigger a monitor run now",
    inputSchema: MonitorIdInput,
    examples: [{ name: "parallel", input: PARALLEL_MONITOR_ID }, { name: "tinyfish", input: TINYFISH_MONITOR_ID }],
  },
  {
    command: "monitor cancel",
    description: "Cancel a monitor (TinyFish: pauses it)",
    inputSchema: MonitorIdInput,
    examples: [{ name: "parallel", input: PARALLEL_MONITOR_ID }, { name: "tinyfish", input: TINYFISH_MONITOR_ID }],
  },
])
