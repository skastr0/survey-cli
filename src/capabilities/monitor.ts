import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"
import { Command } from "effect/unstable/cli"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { recordRun } from "../core/runs"
import { parallelApi } from "../providers/parallel"

const MonitorCreateInput = Schema.Struct({
  type: Schema.String,
  query: Schema.optional(Schema.String),
  objective: Schema.optional(Schema.String),
  cadence: Schema.optional(Schema.Literals(["hourly", "daily", "weekly", "every_two_weeks"])),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const MonitorIdInput = Schema.Struct({
  monitor_id: Schema.String,
})

const MonitorListInput = Schema.Struct({
  limit: Schema.optional(Schema.Int),
  cursor: Schema.optional(Schema.String),
})

const monitorCreate = makeJsonCommand({
  name: "create",
  commandName: "monitor create",
  description: "Create a monitor (Parallel GA monitors)",
  schema: MonitorCreateInput,
  run: (input) =>
    Effect.gen(function* () {
      const created = yield* parallelApi.monitorCreate({
        type: input.type,
        query: input.query,
        objective: input.objective,
        cadence: input.cadence as never,
        settings: input.settings,
        metadata: input.metadata,
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
  run: () => parallelApi.monitorList as Effect.Effect<unknown, unknown, AppEnv>,
})

const monitorInspect = makeJsonCommand({
  name: "inspect",
  commandName: "monitor inspect",
  description: "Inspect a monitor",
  schema: MonitorIdInput,
  run: (input) => parallelApi.monitorInspect(input.monitor_id as never) as Effect.Effect<unknown, unknown, AppEnv>,
})

const monitorEvents = makeJsonCommand({
  name: "events",
  commandName: "monitor events",
  description: "Fetch monitor events",
  schema: MonitorIdInput,
  run: (input) => parallelApi.monitorEvents(input as never) as Effect.Effect<unknown, unknown, AppEnv>,
})

const monitorTrigger = makeJsonCommand({
  name: "trigger",
  commandName: "monitor trigger",
  description: "Trigger a monitor now",
  schema: MonitorIdInput,
  run: (input) => parallelApi.monitorTrigger(input.monitor_id as never) as Effect.Effect<unknown, unknown, AppEnv>,
})

const monitorCancel = makeJsonCommand({
  name: "cancel",
  commandName: "monitor cancel",
  description: "Cancel a monitor",
  schema: MonitorIdInput,
  run: (input) => parallelApi.monitorCancel(input.monitor_id as never) as Effect.Effect<unknown, unknown, AppEnv>,
})

export const monitorCommand = Command.make("monitor").pipe(
  Command.withDescription("Normalized provider monitors (Parallel GA today)"),
  Command.withSubcommands([
    monitorCreate,
    monitorList,
    monitorInspect,
    monitorEvents,
    monitorTrigger,
    monitorCancel,
  ]),
)

for (const [command, description] of [
  ["monitor create", "Create a monitor"],
  ["monitor list", "List monitors"],
  ["monitor inspect", "Inspect a monitor"],
  ["monitor events", "Fetch monitor events"],
  ["monitor trigger", "Trigger a monitor"],
  ["monitor cancel", "Cancel a monitor"],
] as const) {
  registerContract({ command, description })
}
