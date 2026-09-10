import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { toErrorDetails } from "../core/output"
import { loadProviderConfig, ProviderName } from "../core/registry"
import { firecrawlApi } from "../providers/firecrawl"
import { llamaApi } from "../providers/llama"
import { parallelApi } from "../providers/parallel"

export const UnifiedExtractInput = Schema.Struct({
  provider: Schema.optional(ProviderName),
  url: Schema.optional(Schema.String),
  urls: Schema.optional(Schema.Array(Schema.String)),
  file: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  prompt: Schema.optional(Schema.String),
  objective: Schema.optional(Schema.String),
  entity: Schema.optional(Schema.String),
  wait: Schema.optional(Schema.Boolean),
  timeout_ms: Schema.optional(Schema.Int),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type UnifiedExtractInput = typeof UnifiedExtractInput.Type

type Route =
  | { readonly provider: "llama"; readonly reason: string }
  | { readonly provider: "firecrawl"; readonly reason: string }
  | { readonly provider: "parallel"; readonly reason: string }

const routeExtract = (input: UnifiedExtractInput): Route => {
  if (input.provider) {
    return { provider: input.provider as Route["provider"], reason: "explicit provider selection" }
  }
  if (input.file || input.file_path) {
    return { provider: "llama", reason: "file input routes to LlamaCloud parse/extract" }
  }
  if ((input.url || input.urls) && input.schema) {
    return { provider: "firecrawl", reason: "urls + schema routes to Firecrawl extract" }
  }
  if (input.objective || input.entity) {
    return { provider: "parallel", reason: "objective/entity input routes to Parallel" }
  }
  if (input.url || input.urls) {
    return { provider: "firecrawl", reason: "urls without schema default to Firecrawl extract" }
  }
  return { provider: "llama", reason: "no discriminating input — requires file, url(s), or objective" }
}

export const unifiedExtract = Effect.fn("unifiedExtract")(function* (
  input: UnifiedExtractInput,
) {
  const route = routeExtract(input)

  if (route.provider === "llama" && !(input.file || input.file_path)) {
    return yield* new CommandInputError({
      field: "file",
      message: "llama route requires a file or file_path input",
    })
  }
  if (route.provider === "firecrawl" && !(input.url || (input.urls && input.urls.length > 0))) {
    return yield* new CommandInputError({
      field: "urls",
      message: "firecrawl route requires url or urls",
    })
  }
  if (route.provider === "parallel" && !(input.objective || input.entity || input.urls || input.url)) {
    return yield* new CommandInputError({
      field: "objective",
      message: "parallel route requires objective, entity, or urls",
    })
  }

  const config = yield* loadProviderConfig(route.provider)
  if (config.credential === undefined) {
    return yield* Effect.fail({
      _tag: "MissingApiKeyError" as const,
      provider: route.provider,
      envVar: `${route.provider.toUpperCase()}_API_KEY`,
      hint: `Set the ${route.provider} API key or choose another provider via the \`provider\` field.`,
    })
  }

  const outcome = yield* Effect.result(
    Effect.gen(function* () {
      if (route.provider === "llama") {
        return yield* llamaApi.parseAndExtract?.({
          filePath: (input.file ?? input.file_path)!,
          schema: input.schema,
          prompt: input.prompt,
          wait: input.wait ?? true,
          timeoutMs: input.timeout_ms,
          ...input.options,
        } as never) as Effect.Effect<unknown, unknown, AppEnv>
      }
      if (route.provider === "firecrawl") {
        return yield* firecrawlApi.extractStart({
          urls: input.urls ?? (input.url ? [input.url] : []),
          schema: input.schema,
          prompt: input.prompt,
          ...input.options,
        } as never) as Effect.Effect<unknown, unknown, AppEnv>
      }
      return yield* parallelApi.extract({
        urls: input.urls ?? (input.url ? [input.url] : undefined),
        objective: input.objective,
        search_queries: input.entity ? [input.entity] : undefined,
        ...input.options,
      } as never) as Effect.Effect<unknown, unknown, AppEnv>
    }),
  )

  if (outcome._tag === "Success") {
    return {
      routed_to: route.provider,
      route_reason: route.reason,
      result: outcome.success,
    }
  }

  return yield* Effect.fail(outcome.failure as never)
})

export const extractCommand = makeJsonCommand({
  name: "extract",
  commandName: "extract",
  description: "Route structured extraction to the right provider: file→llama, urls+schema→firecrawl, objective→parallel",
  schema: UnifiedExtractInput,
  run: (input) => unifiedExtract(input),
})

registerContract({
  command: "extract",
  description: "Input-aware extraction router across providers",
  inputSchema: UnifiedExtractInput,
  examples: [
    { name: "pdf parse", input: { file_path: "./paper.pdf" } },
    {
      name: "urls + schema",
      input: {
        urls: ["https://example.com/pricing"],
        schema: { type: "object", properties: { price: { type: "number" } } },
      },
    },
    {
      name: "objective",
      input: { objective: "find the founding year of Effectful Technologies" },
    },
  ],
})
