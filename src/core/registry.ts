import { Context, Effect, FileSystem, Schema } from "effect"

import { CommandInputError, MissingApiKeyError } from "./errors"
import { decodeUnknownJsonText } from "./json"
import { authPath } from "./paths"
import { LOCAL_TOOL_SPECS, type LocalToolName } from "../local/tools"

export const ProviderName = Schema.Literals([
  "exa",
  "firecrawl",
  "parallel",
  "keenable",
  "llama",
  "tinyfish",
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
  "papers",
  "browser",
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
    keyHint:
      "Export EXA_API_KEY from your Exa API settings. Without a key, web-search and contents (by URL) use Exa's keyless hosted MCP tier.",
    auth: { kind: "header", header: "x-api-key" },
    capabilities: [
      "search",
      "fetch",
      "answer",
      "deep_research",
      "find_similar",
      "code_context",
    ],
    publicFallback: true,
  },
  firecrawl: {
    name: "firecrawl",
    envVar: "FIRECRAWL_API_KEY",
    baseUrlEnv: "FIRECRAWL_API_BASE_URL",
    defaultBaseUrl: "https://api.firecrawl.dev/v2",
    keyHint:
      "Export FIRECRAWL_API_KEY from your Firecrawl dashboard. Without a key, search, scrape, parse, interact, and the research index use the rate-limited keyless free tier.",
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
      "papers",
    ],
    publicFallback: true,
  },
  parallel: {
    name: "parallel",
    envVar: "PARALLEL_API_KEY",
    baseUrlEnv: "PARALLEL_API_BASE_URL",
    defaultBaseUrl: "https://api.parallel.ai",
    keyHint:
      "Export PARALLEL_API_KEY from your Parallel dashboard. Without a key, search and extract use Parallel's free Search MCP.",
    auth: { kind: "header", header: "x-api-key" },
    capabilities: [
      "search",
      "fetch",
      "deep_research",
      "entity_search",
      "monitor",
    ],
    publicFallback: true,
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
  tinyfish: {
    name: "tinyfish",
    envVar: "TINYFISH_API_KEY",
    baseUrlEnv: "TINYFISH_API_BASE_URL",
    defaultBaseUrl: "https://agent.tinyfish.ai",
    keyHint:
      "Export TINYFISH_API_KEY from https://agent.tinyfish.ai/api-keys. Search and Fetch have a free daily allowance but still require a key.",
    auth: { kind: "header", header: "x-api-key" },
    capabilities: ["search", "fetch", "browser", "interact", "deep_research", "monitor"],
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

/**
 * When true, provider configs ignore stored and env credentials, so every call
 * goes through keyless public endpoints or fails with MissingApiKeyError.
 * Unified commands set it for `tier: "free"` so no account credits are spent.
 */
export const KeylessOnly = Context.Reference<boolean>("survey/core/registry/KeylessOnly", {
  defaultValue: () => false,
})

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

  if (yield* KeylessOnly) {
    return { provider, apiBaseUrl } satisfies ProviderConfig
  }

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

/**
 * Local providers run in-process or as a PATH CLI: no key, no base URL, no
 * network. They are modeled separately from `PROVIDERS` so credential, auth
 * and HTTP code paths can never be handed a keyless provider.
 */
export interface LocalProviderSpec {
  readonly kind: "local"
  readonly name: LocalToolName
  readonly npmPackage: string
  readonly cli: string
  readonly description: string
  readonly capabilities: ReadonlyArray<string>
  readonly requiresKey: false
  readonly network: false
}

export const LOCAL_PROVIDERS: Record<LocalToolName, LocalProviderSpec> = {
  anydoc: {
    kind: "local",
    name: "anydoc",
    npmPackage: LOCAL_TOOL_SPECS.anydoc.npmPackage,
    cli: LOCAL_TOOL_SPECS.anydoc.cli,
    description: LOCAL_TOOL_SPECS.anydoc.description,
    capabilities: ["convert"],
    requiresKey: false,
    network: false,
  },
  "pdf-inspector": {
    kind: "local",
    name: "pdf-inspector",
    npmPackage: LOCAL_TOOL_SPECS["pdf-inspector"].npmPackage,
    cli: LOCAL_TOOL_SPECS["pdf-inspector"].cli,
    description: LOCAL_TOOL_SPECS["pdf-inspector"].description,
    capabilities: ["classify", "convert"],
    requiresKey: false,
    network: false,
  },
}

export const localProviderNames = Object.keys(LOCAL_PROVIDERS) as ReadonlyArray<LocalToolName>
