#!/usr/bin/env bun

import { Console, Effect, Layer } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { CliError, CliOutput, Command } from "effect/unstable/cli"

import { authCommand } from "./commands/auth"
import { mcpCommand } from "./commands/mcp"
import {
  capabilitiesCommand,
  contractHelpFormatter,
  doctorCommand,
  examplesCommand,
  registerCommandTree,
  schemaCommand,
} from "./commands/discovery"
import { compareCommand } from "./capabilities/compare"
import { corpusCommand } from "./capabilities/corpus"
import { convertCommand } from "./capabilities/convert"
import { extractCommand } from "./capabilities/extract"
import { fetchCommand } from "./capabilities/fetch"
import { monitorCommand } from "./capabilities/monitor"
import { papersCommand } from "./capabilities/papers"
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
import { CliUsageError } from "./core/errors"
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
    papersCommand,
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

registerCommandTree(rootCommand)

const runtimeLayer = Layer.mergeAll(
  BunServices.layer,
  HttpClientLayer,
  Store.layer.pipe(Layer.provide(BunServices.layer)),
  Corpus.layer.pipe(Layer.provide(BunServices.layer)),
)

/**
 * The CLI framework prints help, version, and completions through `Console.log`
 * — including the help it renders before failing on a parse error. Domain
 * output never uses `Console`, so buffer it and decide at the end: flush for
 * explicit `--help`/`--version`, discard when the argv was invalid so stdout
 * stays empty and stderr carries one `CliUsageError` envelope.
 */
const frameworkStdout: Array<string> = []
const bufferedConsole: Console.Console = {
  ...globalThis.console,
  log: (...args: ReadonlyArray<unknown>) => {
    frameworkStdout.push(args.map(String).join(" "))
  },
}
const flushFrameworkStdout = Effect.sync(() => {
  for (const line of frameworkStdout.splice(0)) process.stdout.write(`${line}\n`)
})

const toUsageError = (error: CliError.ShowHelp) => {
  const issues = error.errors.map((issue) => ({ type: issue._tag, message: issue.message }))
  return new CliUsageError({
    command_path: error.commandPath,
    issues,
    suggestions: error.errors.flatMap((issue) =>
      "suggestions" in issue && Array.isArray(issue.suggestions) ? issue.suggestions : [],
    ),
    message: issues.map((issue) => issue.message.split("\n")[0]).join("; "),
  })
}

const program = rootCommand.pipe(
  Command.run({ version: CLI_VERSION, renderErrors: false }),
  Effect.provideService(Console.Console, bufferedConsole),
  Effect.provideService(CliOutput.Formatter, contractHelpFormatter(CliOutput.defaultFormatter())),
  Effect.andThen(flushFrameworkStdout),
  Effect.catch((error: unknown) =>
    CliError.isCliError(error) && error._tag === "ShowHelp"
      ? error.errors.length === 0
        ? flushFrameworkStdout
        : Effect.sync(() => frameworkStdout.splice(0)).pipe(
            Effect.andThen(setExitCode(1)),
            Effect.andThen(writeFailureEnvelope(error.commandPath.slice(1).join(" ") || undefined, toUsageError(error))),
          )
      : setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(undefined, error))),
  ),
  Effect.catchCause((cause) =>
    setExitCode(1).pipe(Effect.andThen(writeCauseEnvelope(undefined, cause))),
  ),
  Effect.provide(runtimeLayer),
  // Layer construction (e.g. opening the store) fails outside the handlers above.
  Effect.catch((error: unknown) =>
    setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(undefined, error))),
  ),
)

program.pipe(BunRuntime.runMain)
