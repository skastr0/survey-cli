import { Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"

import { CLI_NAME, CLI_VERSION } from "../core/constants"
import { getContract, contractJsonSchema, listContracts } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { executeJsonCommand } from "../core/output"
import { artifactDir, storePath, surveyHome } from "../core/paths"
import { loadProviderConfig, LOCAL_PROVIDERS, localProviderNames, PROVIDERS, providerNames } from "../core/registry"
import { resolveAccess, tierTable, TIER_RULES } from "../core/tiers"
import { localToolStatus } from "../local/tools"

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
            }
          }),
        )

        const localTools = yield* Effect.forEach(localProviderNames, localToolStatus)

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
).pipe(Command.withDescription("Report environment readiness for all providers"))

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

        return {
          protocol: "survey-cli/v1",
          input: {
            domain_payloads: "JSON objects or arrays via inline JSON, @file, -, or @-",
            execution_flags: [
              "--output inline|artifact|auto",
              "--concurrency <n>",
              "--timeout <ms>",
              "--wait",
              "--idempotency-key <key>",
            ],
          },
          output: {
            success_envelope: '{ "ok": true, "command": string, "data": object }',
            failure_envelope:
              '{ "ok": false, "command": string, "error": { "type": string, "message": string, "details": object } }',
            stdout: "success envelopes only",
            stderr: "failure envelopes only",
          },
          batch: {
            input: "single JSON object or array of objects",
            outcome_values: ["succeeded", "partial_failure", "failed"],
            exit_code: "1 when error_count > 0",
          },
          idempotency: {
            status: "local success-receipt; not a provider guarantee",
          },
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
            batch: contract.batch ?? false,
            orbit: contract.orbit ?? [],
          })),
        }
      }),
    )
  }),
).pipe(Command.withDescription("Report the command inventory, protocol contract, and provider capability matrix"))

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
    ).pipe(Command.withDescription("List commands with JSON input schemas")),
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
            return {
              command: contract.command,
              description: contract.description,
              json_schema: doc ?? null,
            }
          }),
        )
      }),
    ).pipe(Command.withDescription("Show the JSON Schema for one command's input")),
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
    ).pipe(Command.withDescription("List commands that have examples")),
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
    ).pipe(Command.withDescription("Show examples for a command or one named example")),
  ]),
)
