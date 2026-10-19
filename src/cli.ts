#!/usr/bin/env bun

import { Effect, Layer } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Command } from "effect/unstable/cli"

import { authCommand } from "./commands/auth"
import { mcpCommand } from "./commands/mcp"
import {
  capabilitiesCommand,
  doctorCommand,
  examplesCommand,
  schemaCommand,
} from "./commands/discovery"
import { compareCommand } from "./capabilities/compare"
import { corpusCommand } from "./capabilities/corpus"
import { convertCommand } from "./capabilities/convert"
import { extractCommand } from "./capabilities/extract"
import { fetchCommand } from "./capabilities/fetch"
import { monitorCommand } from "./capabilities/monitor"
import { pipeCommand } from "./capabilities/pipe"
import { researchCommand } from "./capabilities/research"
import { runsCommand } from "./capabilities/runs"
import { searchCommand } from "./capabilities/search"
import { sourcesCommand } from "./capabilities/sources"
import { sqlCommand } from "./capabilities/sql"
import { verifyCommand } from "./capabilities/verify"
import { watchCommand } from "./capabilities/watch"
import { CLI_NAME, CLI_VERSION } from "./core/constants"
import { Corpus } from "./core/corpus"
import { HttpClientLayer } from "./core/http"
import { setExitCode, writeCauseEnvelope, writeFailureEnvelope } from "./core/output"
import { Store } from "./core/store"
import { anydocCommand } from "./providers/anydoc"
import { exaCommand } from "./providers/exa"
import { firecrawlCommand } from "./providers/firecrawl"
import { keenableCommand } from "./providers/keenable"
import { llamaCommand } from "./providers/llama"
import { parallelCommand } from "./providers/parallel"
import { pdfInspectorCommand } from "./providers/pdf-inspector"
import { tinyfishCommand } from "./providers/tinyfish"

export const rootCommand = Command.make(CLI_NAME).pipe(
  Command.withDescription("Consolidated researcher toolkit CLI — one binary, six providers, cross-provider research"),
  Command.withSubcommands([
    authCommand,
    capabilitiesCommand,
    doctorCommand,
    examplesCommand,
    schemaCommand,
    exaCommand,
    firecrawlCommand,
    parallelCommand,
    keenableCommand,
    llamaCommand,
    anydocCommand,
    pdfInspectorCommand,
    tinyfishCommand,
    searchCommand,
    fetchCommand,
    extractCommand,
    convertCommand,
    researchCommand,
    verifyCommand,
    runsCommand,
    sourcesCommand,
    monitorCommand,
    sqlCommand,
    corpusCommand,
    mcpCommand,
    pipeCommand,
    compareCommand,
    watchCommand,
  ]),
)

const runtimeLayer = Layer.mergeAll(
  BunServices.layer,
  HttpClientLayer,
  Store.layer.pipe(Layer.provide(BunServices.layer)),
  Corpus.layer.pipe(Layer.provide(BunServices.layer)),
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
