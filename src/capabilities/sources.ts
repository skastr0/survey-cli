import { Effect, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { canonicalizeUrl, Store } from "../core/store"

const ListSourcesInput = Schema.Struct({
  provider: Schema.optional(Schema.String),
  canonical_url: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
})

const DedupeInput = Schema.Struct({
  min_providers: Schema.optional(Schema.Int),
  limit: Schema.optional(Schema.Int),
})

export const sourcesList = makeJsonCommand({
  name: "list",
  commandName: "sources list",
  description: "List sources in the ledger",
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
  description: "Group sources by canonical URL with provider provenance sets",
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
  description: "Show all ledger rows for one canonical URL",
  schema: Schema.Struct({ url: Schema.NonEmptyString }),
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
  Command.withDescription("Source ledger — normalized provenance across providers"),
  Command.withSubcommands([sourcesList, sourcesDedupe, sourcesShow]),
)

for (const [command, description] of [
  ["sources list", "List sources in the ledger"],
  ["sources dedupe", "Group sources by canonical URL"],
  ["sources show", "Show ledger rows for a URL"],
] as const) {
  registerContract({ command, description })
}
