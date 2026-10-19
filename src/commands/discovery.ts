import { Effect, Exit, Option, Schema } from "effect"
import { Argument, CliOutput, Command } from "effect/unstable/cli"

import { ARTIFACT_INLINE_THRESHOLD_BYTES, CLI_NAME, CLI_VERSION } from "../core/constants"
import { type CommandContract, getContract, contractJsonSchema, listContracts } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { executeJsonCommand } from "../core/output"
import { artifactDir, storePath, surveyHome } from "../core/paths"
import { loadProviderConfig, LOCAL_PROVIDERS, localProviderNames, PROVIDERS, providerNames } from "../core/registry"
import { resolveAccess, tierTable, TIER_RULES } from "../core/tiers"
import { localToolStatus } from "../local/tools"

/** One flag or positional as the parser actually accepts it. */
export interface ParamSurface {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly description: string | null
}

/** What a leaf command accepts on argv, read from its `Command` definition. */
export interface CommandSurface {
  readonly command: string
  readonly description: string | null
  /** `required`/`optional`: one JSON payload argument; `none`: no input; `positional`: non-JSON args. */
  readonly input: "required" | "optional" | "none" | "positional"
  readonly args: ReadonlyArray<ParamSurface>
  readonly flags: ReadonlyArray<ParamSurface>
}

interface HelpParam {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly description: Option.Option<string>
}

// `buildHelpDoc` is the parser's own view of a command's params. It is not on
// the public `Command` interface, so read it structurally (effect is pinned).
type HelpDocSource = Command.Command.Any & {
  readonly buildHelpDoc?: (path: ReadonlyArray<string>) => {
    readonly args: ReadonlyArray<HelpParam>
    readonly flags: ReadonlyArray<HelpParam>
  }
}

const toParamSurface = (param: HelpParam): ParamSurface => ({
  name: param.name,
  type: param.type,
  required: param.required,
  description: Option.getOrNull(param.description),
})

let commandTree: Command.Command.Any | undefined

/** Called once by the entry point so discovery can describe the real command tree. */
export const registerCommandTree = (root: Command.Command.Any) => {
  commandTree = root
}

export const listCommandSurfaces = (): ReadonlyArray<CommandSurface> => {
  if (commandTree === undefined) return []
  const surfaces: Array<CommandSurface> = []
  const walk = (command: HelpDocSource, path: ReadonlyArray<string>) => {
    const children = command.subcommands.flatMap((group) => group.commands)
    if (children.length > 0) {
      for (const child of children) walk(child as HelpDocSource, [...path, child.name])
      return
    }
    const doc = command.buildHelpDoc?.([CLI_NAME, ...path])
    const args = (doc?.args ?? []).map(toParamSurface)
    const input = args.find((arg) => arg.name === "input")
    surfaces.push({
      command: path.join(" "),
      description: command.description ?? null,
      input: input ? (input.required ? "required" : "optional") : args.length > 0 ? "positional" : "none",
      args,
      flags: (doc?.flags ?? []).map(toParamSurface),
    })
  }
  walk(commandTree as HelpDocSource, [])
  return surfaces.sort((a, b) => a.command.localeCompare(b.command))
}

/**
 * The parser takes the JSON argument as optional everywhere so an omitted
 * payload yields a JsonInputError with a schema next_step. Whether a payload
 * is really needed is decided by the schema: does `{}` decode?
 */
export const contractInputMode = (contract: CommandContract): "required" | "optional" | "none" => {
  if (contract.inputSchema === undefined) return "none"
  const decode = Schema.decodeUnknownExit(contract.inputSchema as Schema.Codec<unknown, unknown, never, never>)
  return Exit.isSuccess(decode({})) ? "optional" : "required"
}

/** Top-level property names the schema requires, for one-glance payload construction. */
export const requiredFields = (contract: CommandContract): ReadonlyArray<string> => {
  const document = contractJsonSchema(contract) as { schema?: { required?: ReadonlyArray<string> } } | undefined
  return document?.schema?.required ?? []
}

const commandPathFromUsage = (usage: string) =>
  usage
    .replace(new RegExp(`^${CLI_NAME}\\s*`), "")
    .split(/\s+[[<]/)[0]!
    .trim()

/** The CONTRACT help section for one command: input, output, examples, schema pointer. */
export const contractHelpSection = (command: string): string | undefined => {
  const contract = getContract(command)
  if (contract === undefined) return undefined
  const mode = contractInputMode(contract)
  const required = requiredFields(contract)
  const examples = (contract.examples ?? []).map((example) => example.name)
  const rows: Array<[string, string]> = [
    [
      "Input",
      mode === "none"
        ? "none"
        : `one JSON ${contract.batch ? "object or an array of objects" : "object"} (${mode})${required.length > 0 ? `; required fields: ${required.join(", ")}` : ""}`,
    ],
    [
      "Returns",
      contract.output ??
        (contract.batch
          ? "{outcome, total, success_count, error_count, results[{index, ok, data|error}]} on stdout; exit 1 if any item failed"
          : "{ok: true, command, data} on stdout; failures as {ok: false, error} on stderr, exit 1"),
    ],
    ...(contract.orbit && contract.orbit.length > 0 ? [["Lifecycle", contract.orbit.join(" → ")] as [string, string]] : []),
    ...(examples.length > 0
      ? [["Examples", `${examples.join(", ")} — ${CLI_NAME} examples show "${command}"`] as [string, string]]
      : []),
    ["Schema", `${CLI_NAME} schema show "${command}"`],
  ]
  return ["CONTRACT", ...rows.map(([label, value]) => `  ${label.padEnd(10)}${value}`)].join("\n")
}

/** Wrap the help formatter so every command's --help ends with its JSON contract. */
export const contractHelpFormatter = (base: CliOutput.Formatter): CliOutput.Formatter => ({
  ...base,
  formatHelpDoc: (doc) => {
    const text = base.formatHelpDoc(doc)
    const section = contractHelpSection(commandPathFromUsage(doc.usage))
    if (section === undefined) return text
    const globalFlags = text.indexOf("\nGLOBAL FLAGS")
    return globalFlags === -1
      ? `${text}\n\n${section}`
      : `${text.slice(0, globalFlags)}\n${section}\n${text.slice(globalFlags)}`
  },
})

const surfaceIndex = () => new Map(listCommandSurfaces().map((surface) => [surface.command, surface]))

export const doctorCommand = Command.make(
  "doctor",
  {},
  Effect.fn(function* () {
    yield* executeJsonCommand(
      "doctor",
      Effect.gen(function* () {
        const home = yield* surveyHome
        const artifacts = yield* artifactDir
        const store = yield* storePath

        const providers = yield* Effect.forEach(providerNames, (name) =>
          Effect.gen(function* () {
            const config = yield* loadProviderConfig(name)
            const spec = PROVIDERS[name]
            const keyed = config.credential !== undefined
            return {
              provider: name,
              configured: keyed,
              api_base_url: config.apiBaseUrl,
              public_fallback: spec.publicFallback,
              access: Object.fromEntries(
                spec.capabilities.map((capability) => [capability, resolveAccess(name, capability, keyed)]),
              ),
              ...(keyed
                ? {}
                : {
                    hint: spec.keyHint,
                    next_step: `Export ${spec.envVar} or run \`${CLI_NAME} auth set '{"provider":"${name}","api_key":"..."}'\`.`,
                  }),
            }
          }),
        )

        const localTools = yield* Effect.forEach(localProviderNames, localToolStatus)
        const configured = providers.filter((provider) => provider.configured).map((provider) => provider.provider)

        const free = [
          ...providers.flatMap((p) =>
            Object.entries(p.access)
              .filter(([, access]) => access.available && access.cost === "free")
              .map(([capability, access]) => ({ provider: p.provider as string, capability, mode: access.mode })),
          ),
          ...localTools
            .filter((tool) => tool.available)
            .flatMap((tool) =>
              LOCAL_PROVIDERS[tool.tool].capabilities.map((capability) => ({
                provider: tool.tool as string,
                capability,
                mode: "local" as const,
              })),
            ),
        ]

        return {
          cli: CLI_NAME,
          version: CLI_VERSION,
          summary: {
            providers_configured: configured,
            providers_missing_key: providers.filter((provider) => !provider.configured).map((provider) => provider.provider),
            keyless_available: providers
              .filter((provider) => !provider.configured && provider.public_fallback)
              .map((provider) => provider.provider),
            local_tools_available: localTools.filter((tool) => tool.available).map((tool) => tool.tool),
          },
          home,
          artifact_dir: artifacts,
          store_path: store,
          providers,
          local_tools: localTools,
          free_capabilities: free,
        }
      }),
    )
  }),
).pipe(Command.withDescription(
      "Report environment readiness: survey home, artifact dir, store path, which providers have credentials (and how to add missing ones), and local tool availability. No input",
    ))

export const capabilitiesCommand = Command.make(
  "capabilities",
  {},
  Effect.fn(function* () {
    yield* executeJsonCommand(
      "capabilities",
      Effect.gen(function* () {
        const contracts = listContracts()

        const providers = providerNames.map((name) => {
          const spec = PROVIDERS[name]
          return {
            provider: name,
            env_var: spec.envVar,
            base_url_env: spec.baseUrlEnv,
            default_base_url: spec.defaultBaseUrl,
            auth: spec.auth.kind,
            public_fallback: spec.publicFallback,
            capabilities: spec.capabilities,
            keyless_capabilities: TIER_RULES[name]?.public ?? [],
            local_capabilities: TIER_RULES[name]?.local ?? [],
          }
        })

        const localProviders = yield* Effect.forEach(localProviderNames, (name) =>
          localToolStatus(name).pipe(
            Effect.map((status) => ({
              provider: name,
              kind: LOCAL_PROVIDERS[name].kind,
              npm_package: LOCAL_PROVIDERS[name].npmPackage,
              cli: LOCAL_PROVIDERS[name].cli,
              requires_key: false,
              network: false,
              capabilities: LOCAL_PROVIDERS[name].capabilities,
              mode: status.mode,
              available: status.available,
              version: status.version,
              operations: status.operations,
            })),
          ),
        )

        const surfaces = surfaceIndex()
        const contracted = new Set(contracts.map((contract) => contract.command))
        const flagNames = (command: string) => surfaces.get(command)?.flags.map((flag) => flag.name) ?? []
        const executionFlags = [...new Set([...surfaces.values()].flatMap((surface) => surface.flags.map((flag) => flag.name)))].sort()

        return {
          protocol: "survey-cli/v1",
          input: {
            domain_payloads: "one JSON object (or array, for batch commands) via inline JSON, @file, -, or @-",
            execution_flags: executionFlags.map((name) => `--${name}`),
            flags_note: "Flags are per command: see commands[].flags. Passing a flag a command does not declare is a CliUsageError.",
          },
          output: {
            success_envelope: '{ "ok": true, "command": string, "data": object }',
            failure_envelope:
              '{ "ok": false, "command": string, "error": { "type": string, "message": string, "details": object } }',
            stdout: "success envelopes only (plus explicit --help/--version text)",
            stderr: "failure envelopes only",
          },
          exit_codes: {
            "0": "success; one envelope on stdout",
            "1": "failure; one envelope on stderr. Includes batches with error_count > 0 (full results still on stdout) and CliUsageError for unparseable argv",
          },
          errors: {
            details_contract: {
              retryable: "boolean, always present: whether rerunning the same call can succeed",
              hint: "string, always present: what went wrong in agent terms",
              next_step: "string, when a concrete recovery command exists",
              issues: "[{path, message}] on JsonInputError/CommandInputError schema mismatches",
            },
            input_types: ["JsonInputError", "CommandInputError", "CliUsageError"],
            discovery: `${CLI_NAME} schema show "<command>" and ${CLI_NAME} examples show "<command>"`,
          },
          batch: {
            input: "single JSON object or array of objects",
            outcome_values: ["succeeded", "partial_failure", "failed"],
            item_shape: '{ "index": number, "ok": boolean, "data"?: object, "error"?: object }',
            exit_code: "1 when error_count > 0",
            concurrency: "--concurrency <n> (default 5, positive integer) on commands that declare it",
          },
          artifacts: {
            flag: "--output inline|artifact|auto (default auto)",
            auto_threshold_bytes: ARTIFACT_INLINE_THRESHOLD_BYTES,
            record: '{ "kind": "summary+artifact", "summary": string, "artifact": { "kind", "key", "absolute_path", "size_bytes", "created_at" }, "next_step": string }',
            directory: yield* artifactDir,
          },
          idempotency: {
            status: "local success-receipt; not a provider guarantee",
            commands: [...surfaces.values()]
              .filter((surface) => surface.flags.some((flag) => flag.name === "idempotency-key"))
              .map((surface) => surface.command),
          },
          discovery: ["doctor", "capabilities", "schema list", "schema show", "examples list", "examples show"],
          providers,
          local_providers: localProviders,
          tiers: {
            modes: {
              keyed: "API key configured; spends account credits (cost paid)",
              public: "keyless endpoint, rate-limited (cost free)",
              local: "runs on this machine (cost free)",
              unavailable: "needs a key that is not configured, or not supported",
            },
            routing: 'unified search/fetch/research/verify/papers accept tier: "free" to use only public/local access',
            matrix: tierTable(),
          },
          commands: contracts.map((contract) => ({
            command: contract.command,
            description: contract.description,
            input: contractInputMode(contract),
            required_fields: requiredFields(contract),
            flags: flagNames(contract.command),
            batch: contract.batch ?? false,
            orbit: contract.orbit ?? [],
            ...(contract.output ? { output: contract.output } : {}),
          })),
          other_commands: [...surfaces.values()]
            .filter((surface) => !contracted.has(surface.command))
            .map((surface) => ({
              command: surface.command,
              description: surface.description,
              input: surface.input,
              args: surface.args.map((arg) => arg.name),
              flags: surface.flags.map((flag) => flag.name),
            })),
        }
      }),
    )
  }),
).pipe(Command.withDescription(
      "Report the protocol contract (envelopes, exit codes, error details, batch, artifacts, idempotency), every command with its input mode, required fields and accepted flags, and the provider capability matrix. No input",
    ))

export const schemaCommand = Command.make("schema").pipe(
  Command.withDescription("Inspect JSON input contracts"),
  Command.withSubcommands([
    Command.make(
      "list",
      {},
      Effect.fn(function* () {
        yield* executeJsonCommand(
          "schema list",
          Effect.succeed({
            commands: listContracts()
              .filter((contract) => contract.inputSchema !== undefined)
              .map((contract) => ({
                command: contract.command,
                description: contract.description,
              })),
          }),
        )
      }),
    ).pipe(Command.withDescription("List every command that takes a JSON payload, with its description. No input")),
    Command.make(
      "show",
      { command: Argument.string("command").pipe(Argument.withDescription("Command path, e.g. \"exa web-search\" or \"search\"")) },
      Effect.fn(function* ({ command }) {
        yield* executeJsonCommand(
          "schema show",
          Effect.gen(function* () {
            const contract = getContract(command)
            if (!contract) {
              return yield* new CommandInputError({
                field: "command",
                message: `No contract registered for "${command}". Run \`survey schema list\`.`,
              })
            }
            const doc = contractJsonSchema(contract)
            const surface = surfaceIndex().get(contract.command)
            return {
              command: contract.command,
              description: contract.description,
              input: contractInputMode(contract),
              batch: contract.batch ?? false,
              required_fields: requiredFields(contract),
              flags: surface?.flags ?? [],
              ...(contract.output ? { output: contract.output } : {}),
              orbit: contract.orbit ?? [],
              examples: (contract.examples ?? []).map((example) => example.name),
              json_schema: doc ?? null,
            }
          }),
        )
      }),
    ).pipe(Command.withDescription(
      "Show one command's input contract: JSON Schema, required fields, batch support, accepted flags, output notes, and example names. Argument: the command path, e.g. \"exa web-search\"",
    )),
  ]),
)

export const examplesCommand = Command.make("examples").pipe(
  Command.withDescription("List and show executable command examples"),
  Command.withSubcommands([
    Command.make(
      "list",
      {},
      Effect.fn(function* () {
        yield* executeJsonCommand(
          "examples list",
          Effect.succeed({
            commands: listContracts()
              .filter((contract) => (contract.examples?.length ?? 0) > 0)
              .map((contract) => ({
                command: contract.command,
                examples: contract.examples?.map((example) => example.name) ?? [],
              })),
          }),
        )
      }),
    ).pipe(Command.withDescription("List every command with the names of its executable example payloads. No input")),
    Command.make(
      "show",
      { command: Argument.string("command").pipe(Argument.withDescription("Command path or example name")) },
      Effect.fn(function* ({ command }) {
        yield* executeJsonCommand(
          "examples show",
          Effect.gen(function* () {
            const contract = getContract(command)
            if (contract) {
              return {
                command: contract.command,
                examples: contract.examples ?? [],
              }
            }
            const match = listContracts().flatMap((entry) =>
              (entry.examples ?? [])
                .filter((example) => example.name === command)
                .map((example) => ({ command: entry.command, example })),
            )
            if (match.length === 0) {
              return yield* new CommandInputError({
                field: "command",
                message: `No examples for "${command}". Run \`survey examples list\`.`,
              })
            }
            return { matches: match }
          }),
        )
      }),
    ).pipe(Command.withDescription(
      "Show copy-pastable example payloads. Argument: a command path (all its examples) or one example name (matching examples across commands)",
    )),
  ]),
)
