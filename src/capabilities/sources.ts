import { Effect, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import { makeJsonCommand } from "../core/command"
import { registerContracts } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { canonicalizeUrl, Store } from "../core/store"

const ListSourcesInput = Schema.Struct({
  provider: Schema.optional(Schema.String),
  canonical_url: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
})

const ShowSourceInput = Schema.Struct({ url: Schema.NonEmptyString })

const DedupeInput = Schema.Struct({
  min_providers: Schema.optional(Schema.Int),
  limit: Schema.optional(Schema.Int),
})

export const sourcesList = makeJsonCommand({
  name: "list",
  commandName: "sources list",
  description: "List rows from the local source ledger, newest first (run_id returns that run's rows in insert order). Input: {provider?, canonical_url?, run_id?, limit? (200)}. Returns {sources[], count}.",
  schema: ListSourcesInput,
  run: (input) =>
    Effect.gen(function* () {
      const store = yield* Store
      if (input.run_id) {
        const rows = yield* store.sourcesForRun(input.run_id)
        return { sources: rows, count: rows.length }
      }
      const rows = yield* store.listSources({
        provider: input.provider,
        canonicalUrl: input.canonical_url ? canonicalizeUrl(input.canonical_url) : undefined,
        limit: input.limit ?? 200,
      })
      return { sources: rows, count: rows.length }
    }),
})

export const sourcesDedupe = makeJsonCommand({
  name: "dedupe",
  commandName: "sources dedupe",
  description: "Group ledger rows by canonical URL, most-corroborated first. Input: {min_providers? (1), limit? (rows scanned, 2000)}. Returns {groups[{canonical_url, providers, provider_count}], count}.",
  schema: DedupeInput,
  run: (input) =>
    Effect.gen(function* () {
      const store = yield* Store
      const rows = yield* store.listSources({ limit: input.limit ?? 2000 })
      const groups = new Map<string, { canonical_url: string; providers: Set<string>; titles: Set<string>; count: number }>()
      for (const row of rows) {
        const group = groups.get(row.canonical_url) ?? {
          canonical_url: row.canonical_url,
          providers: new Set<string>(),
          titles: new Set<string>(),
          count: 0,
        }
        group.providers.add(row.provider)
        if (row.title) group.titles.add(row.title)
        group.count += 1
        groups.set(row.canonical_url, group)
      }
      const minProviders = input.min_providers ?? 1
      const grouped = [...groups.values()]
        .filter((g) => g.providers.size >= minProviders)
        .map((g) => ({
          canonical_url: g.canonical_url,
          providers: [...g.providers],
          provider_count: g.providers.size,
          titles: [...g.titles],
          appearances: g.count,
        }))
        .sort((a, b) => b.provider_count - a.provider_count)
      return { groups: grouped, count: grouped.length }
    }),
})

export const sourcesShow = makeJsonCommand({
  name: "show",
  commandName: "sources show",
  description: "Show every ledger row (up to 100) for one URL after canonicalization. Input: {url}. Returns {canonical_url, sources[]}; fails with CommandInputError when nothing is recorded.",
  schema: ShowSourceInput,
  run: (input) =>
    Effect.gen(function* () {
      const store = yield* Store
      const canonical = canonicalizeUrl(input.url)
      const rows = yield* store.listSources({ canonicalUrl: canonical, limit: 100 })
      if (rows.length === 0) {
        return yield* new CommandInputError({
          field: "url",
          message: `No sources recorded for ${canonical}`,
        })
      }
      return { canonical_url: canonical, sources: rows }
    }),
})

export const sourcesCommand = Command.make("sources").pipe(
  Command.withDescription("Source ledger: every URL providers returned, canonicalized with provenance; list, dedupe, show"),
  Command.withSubcommands([sourcesList, sourcesDedupe, sourcesShow]),
)

registerContracts([
  {
    command: "sources list",
    description: "List rows from the local source ledger, newest first (run_id returns that run's rows in insert order). Input: {provider?, canonical_url?, run_id?, limit? (200)}. Returns {sources[], count}.",
    output: "{ sources[{ id, run_id, provider, url, canonical_url, title, snippet, content_hash, fetched_at }], count }",
    inputSchema: ListSourcesInput,
    examples: [
      { name: "recent", input: { limit: 20 } },
      { name: "one run", input: { run_id: "srv_..." } },
    ],
  },
  {
    command: "sources dedupe",
    description: "Group ledger rows by canonical URL, most-corroborated first. Input: {min_providers? (1), limit? (rows scanned, 2000)}. Returns {groups[{canonical_url, providers, provider_count}], count}.",
    output: "{ groups[{ canonical_url, providers[], provider_count, titles[], appearances }], count }",
    inputSchema: DedupeInput,
    examples: [{ name: "corroborated only", input: { min_providers: 2 } }],
  },
  {
    command: "sources show",
    description: "Show every ledger row (up to 100) for one URL after canonicalization. Input: {url}. Returns {canonical_url, sources[]}; fails with CommandInputError when nothing is recorded.",
    output: "{ canonical_url, sources[{ id, run_id, provider, url, canonical_url, title, snippet, content_hash, fetched_at }] }",
    inputSchema: ShowSourceInput,
    examples: [{ name: "by url", input: { url: "https://effect.website" } }],
  },
])
