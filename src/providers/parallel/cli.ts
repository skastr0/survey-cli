#!/usr/bin/env bun

/**
 * Standalone entrypoint for the `parallel` namespace — used by tests before
 * the namespace is wired into the root command, and handy for direct runs:
 *
 *   bun run src/providers/parallel/cli.ts search '{"objective":"docs"}'
 */

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"

import { CLI_VERSION } from "../../core/constants"
import { HttpClientLayer } from "../../core/http"
import {
  setExitCode,
  writeCauseEnvelope,
  writeFailureEnvelope,
} from "../../core/output"
import { Store } from "../../core/store"
import { parallelCommand } from "./index"

const runtimeLayer = Layer.mergeAll(
  BunServices.layer,
  HttpClientLayer,
  Store.layer.pipe(Layer.provide(BunServices.layer)),
)

const program = parallelCommand.pipe(
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
