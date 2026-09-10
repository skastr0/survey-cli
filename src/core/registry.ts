import { Effect, FileSystem, Schema } from "effect"

import { CommandInputError, MissingApiKeyError } from "./errors"
import { decodeUnknownJsonText } from "./json"
import { authPath } from "./paths"

export const ProviderName = Schema.Literals([
  "exa",
  "firecrawl",
  "parallel",
  "keenable",
  "llama",
])
export type ProviderName = typeof ProviderName.Type

export const Capability = Schema.Literals([
  "search",
  "fetch",
  "extract",
  "deep_research",
  "monitor",
  "parse",
  "sql",
  "answer",
  "map",
  "crawl",
  "batch",
  "interact",
  "find_similar",
  "code_context",
  "entity_search",
  "files",
])
export type Capability = typeof Capability.Type

export type AuthStrategy =
  | { readonly kind: "header"; readonly header: string }
  | { readonly kind: "bearer" }
  | {
      readonly kind: "keenable"
    }

export interface ProviderSpec {
  readonly name: ProviderName
  readonly envVar: string
  readonly baseUrlEnv: string
  readonly defaultBaseUrl: string
  readonly keyHint: string
  readonly auth: AuthStrategy
  readonly capabilities: ReadonlyArray<Capability>
  readonly publicFallback: boolean
}

export const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  exa: {
    name: "exa",
    envVar: "EXA_API_KEY",
    baseUrlEnv: "EXA_API_BASE_URL",
    defaultBaseUrl: "https://api.exa.ai",
    keyHint: "Export EXA_API_KEY from your Exa API settings.",
    auth: { kind: "header", header: "x-api-key" },
    capabilities: [
      "search",
      "fetch",
      "answer",
      "deep_research",
      "find_similar",
      "code_context",
    ],
    publicFallback: false,
  },
  firecrawl: {
    name: "firecrawl",
    envVar: "FIRECRAWL_API_KEY",
    baseUrlEnv: "FIRECRAWL_API_BASE_URL",
    defaultBaseUrl: "https://api.firecrawl.dev/v2",
    keyHint: "Export FIRECRAWL_API_KEY from your Firecrawl dashboard.",
    auth: { kind: "bearer" },
    capabilities: [
      "fetch",
      "search",
      "extract",
      "parse",
      "map",
      "crawl",
      "batch",
      "interact",
      "deep_research",
    ],
    publicFallback: false,
  },
  parallel: {
    name: "parallel",
    envVar: "PARALLEL_API_KEY",
    baseUrlEnv: "PARALLEL_API_BASE_URL",
    defaultBaseUrl: "https://api.parallel.ai",
    keyHint: "Export PARALLEL_API_KEY from your Parallel dashboard.",
    auth: { kind: "header", header: "x-api-key" },
    capabilities: [
      "search",
      "fetch",
      "deep_research",
      "entity_search",
      "monitor",
    ],
    publicFallback: false,
  },
  keenable: {
    name: "keenable",
    envVar: "KEENABLE_API_KEY",
    baseUrlEnv: "KEENABLE_API_BASE_URL",
    defaultBaseUrl: "https://api.keenable.ai",
    keyHint:
      "Export KEENABLE_API_KEY from your Keenable dashboard. Without a key, search and fetch use public endpoints.",
    auth: { kind: "keenable" },
    capabilities: ["search", "fetch", "sql"],
    publicFallback: true,
  },
  llama: {
    name: "llama",
    envVar: "LLAMA_CLOUD_API_KEY",
    baseUrlEnv: "LLAMA_CLOUD_API_BASE_URL",
    defaultBaseUrl: "https://api.cloud.llamaindex.ai",
    keyHint: "Export LLAMA_CLOUD_API_KEY from https://cloud.llamaindex.ai.",
    auth: { kind: "bearer" },
    capabilities: ["files", "parse", "extract"],
    publicFallback: false,
  },
}

export const providerNames = ProviderName.literals

export const parseProvider = (value: string) =>
  Schema.decodeUnknownEffect(ProviderName)(value).pipe(
    Effect.mapError(
      () =>
        new CommandInputError({
          field: "provider",
          message: `Unknown provider "${value}". Expected one of: ${providerNames.join(", ")}`,
        }),
    ),
  )

export interface ProviderConfig {
  readonly provider: ProviderName
  readonly apiBaseUrl: string
  readonly credential?: string
}

const normalizeBaseUrl = (rawValue: string, envField: string) =>
  Effect.gen(function* () {
    const trimmed = rawValue.trim()

    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new CommandInputError({
          field: envField,
          message: "Base URL cannot be empty",
        }),
      )
    }

    const url = yield* Effect.try({
      try: () => new URL(trimmed),
      catch: () =>
        new CommandInputError({
          field: envField,
          message: "Invalid API base URL",
        }),
    })

    return url.toString().replace(/\/+$/, "")
  })

const AuthFileSchema = Schema.Record(Schema.String, Schema.Struct({
  api_key: Schema.String,
}))

const readAuthFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* authPath
  const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
  if (!exists) {
    return {} as Record<string, { api_key: string }>
  }
  const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => "{}"))
  const parsed = yield* decodeUnknownJsonText(text, path).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(AuthFileSchema)(value).pipe(
        Effect.orElseSucceed(() => ({} as Record<string, { api_key: string }>)),
      ),
    ),
    Effect.orElseSucceed(() => ({} as Record<string, { api_key: string }>)),
  )
  return parsed
})

export const writeApiKey = (provider: ProviderName, apiKey: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* authPath
    const current = yield* readAuthFile
    const next = { ...current, [provider]: { api_key: apiKey } }
    yield* fs.writeFileString(path, JSON.stringify(next, null, 2)).pipe(
      Effect.mapError(
        (error) =>
          new CommandInputError({
            field: "api_key",
            message: `Cannot write ${path}: ${(error as { message?: string }).message ?? "write failed"}`,
          }),
      ),
    )
    yield* fs.chmod(path, 0o600).pipe(Effect.ignore)
    return path
  })

export const loadProviderConfig = Effect.fn("loadProviderConfig")(function* (
  provider: ProviderName,
) {
  const spec = PROVIDERS[provider]
  const apiBaseUrl = yield* normalizeBaseUrl(
    Bun.env[spec.baseUrlEnv] ?? spec.defaultBaseUrl,
    spec.baseUrlEnv,
  )

  const envKey = Bun.env[spec.envVar]?.trim()
  if (envKey && envKey.length > 0) {
    return { provider, apiBaseUrl, credential: envKey } satisfies ProviderConfig
  }

  const authFile = yield* readAuthFile
  const stored = authFile[provider]?.api_key?.trim()

  return {
    provider,
    apiBaseUrl,
    ...(stored && stored.length > 0 ? { credential: stored } : {}),
  } satisfies ProviderConfig
})

export const requireCredential = Effect.fn("requireCredential")(function* (
  provider: ProviderName,
) {
  const config = yield* loadProviderConfig(provider)

  if (!config.credential) {
    const spec = PROVIDERS[provider]
    return yield* Effect.fail(
      new MissingApiKeyError({
        provider,
        envVar: spec.envVar,
        hint: spec.keyHint,
      }),
    )
  }

  return config.credential
})
