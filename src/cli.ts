#!/usr/bin/env bun

import { Effect, Layer } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Command } from "effect/unstable/cli"

import { authCommand } from "./commands/auth"
import {
  capabilitiesCommand,
  doctorCommand,
  examplesCommand,
  schemaCommand,
} from "./commands/discovery"
import { CLI_NAME, CLI_VERSION } from "./core/constants"
import { HttpClientLayer } from "./core/http"
import { setExitCode, writeCauseEnvelope, writeFailureEnvelope } from "./core/output"
import { Store } from "./core/store"

export const rootCommand = Command.make(CLI_NAME).pipe(
  Command.withDescription("Consolidated researcher toolkit CLI — one binary, five providers, cross-provider research"),
  Command.withSubcommands([
    authCommand,
    capabilitiesCommand,
    doctorCommand,
    examplesCommand,
    schemaCommand,
  ]),
)

const runtimeLayer = Layer.mergeAll(
  BunServices.layer,
  HttpClientLayer,
  Store.layer.pipe(Layer.provide(BunServices.layer)),
)

const program = rootCommand.pipe(
  Command.run({ version: CLI_VERSION }),
  Effect.catch((error: unknown) =>
    setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(undefined, error))),
  ),
  Effect.catchCause((cause) =>
    setExitCode(1).pipe(Effect.andThen(writeCauseEnvelope(undefined, cause))),
  ),
  Effect.provide(runtimeLayer),
)

program.pipe(BunRuntime.runMain)
