import { Effect, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import { registerContract } from "../core/discovery"
import { makeJsonCommand } from "../core/command"
import { executeJsonCommand } from "../core/output"
import { authPath } from "../core/paths"
import { loadProviderConfig, localProviderNames, PROVIDERS, providerNames, ProviderName, writeApiKey } from "../core/registry"

const AuthSetInput = Schema.Struct({
  provider: ProviderName,
  api_key: Schema.NonEmptyString,
})

const authStatus = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    yield* executeJsonCommand(
      "auth status",
      Effect.gen(function* () {
        const rows = yield* Effect.forEach(providerNames, (name) =>
          Effect.gen(function* () {
            const spec = PROVIDERS[name]
            const config = yield* loadProviderConfig(name)
            const envPresent = Boolean(Bun.env[spec.envVar]?.trim())
            return {
              provider: name,
              env_var: spec.envVar,
              env_present: envPresent,
              configured: config.credential !== undefined,
              credential_source:
                config.credential === undefined ? null : envPresent ? "env" : "auth.json",
              public_fallback: spec.publicFallback,
              api_base_url: config.apiBaseUrl,
            }
          }),
        )
        const path = yield* authPath
        const local = localProviderNames.map((name) => ({
          provider: name,
          kind: "local" as const,
          credential_required: false,
          network: false,
        }))
        return { auth_file: path, providers: rows, local_providers: local }
      }),
    )
  }),
).pipe(Command.withDescription("Report, per provider, whether a key is configured and where it comes from (env var or auth file), plus local tool status. No input; never prints key values"))

const authSet = makeJsonCommand({
  name: "set",
  commandName: "auth set",
  description: "Store a provider API key in auth.json under the survey home (mode 0600). Input: {provider, api_key}. Returns {provider, stored, auth_file}; an env var for the same provider still takes precedence",
  schema: AuthSetInput,
  run: (input) =>
    Effect.gen(function* () {
      const path = yield* writeApiKey(input.provider, input.api_key)
      return { provider: input.provider, stored: true, auth_file: path }
    }),
})

registerContract({
  command: "auth set",
  description: "Store a provider API key in the survey auth file (env vars take precedence)",
  output: "{provider, stored: true, auth_file}",
  inputSchema: AuthSetInput,
  examples: [
    {
      name: "store exa key",
      input: { provider: "exa", api_key: "..." },
    },
  ],
})

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage provider credentials"),
  Command.withSubcommands([authStatus, authSet]),
)
