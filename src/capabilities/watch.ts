import { Effect, Schema } from "effect"

import { makeJsonCommand } from "../core/command"
import { Corpus } from "../core/corpus"
import { diffLines } from "../core/diff"
import { registerContract } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { toErrorDetails } from "../core/output"
import { ProviderName } from "../core/registry"
import { unifiedFetch } from "./fetch"

/**
 * DIY monitoring: re-fetch a watch list, let the corpus detect content
 * changes by hash, and return diffs for what moved. Web monitoring is polling
 * everywhere; this keeps the diffs in the local ledger and lets any scheduler
 * (cron, a watching agent seat) drive the cadence for free.
 */

export const WatchInput = Schema.Struct({
  urls: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  tag: Schema.optional(Schema.String),
  providers: Schema.optional(Schema.Array(ProviderName)),
  concurrency: Schema.optional(Schema.Int),
  include_diff: Schema.optional(Schema.Boolean),
  diff_context: Schema.optional(Schema.Int),
  max_hunks: Schema.optional(Schema.Int),
})
export type WatchInput = typeof WatchInput.Type

export const watchRun = (input: WatchInput) =>
  Effect.gen(function* () {
    const corpus = yield* Corpus
    const tag = input.tag ?? "watch"
    const tagged = yield* corpus.list({ limit: 1000, filter: { tag } })
    const urls = [...new Set([...(input.urls ?? []), ...tagged.map((doc) => doc.url)])]
    if (urls.length === 0) {
      return yield* new CommandInputError({
        field: "urls",
        message: `Nothing to watch: pass urls, or tag corpus documents with "${tag}" (fetch {url, tags:["${tag}"]}).`,
      })
    }

    const checks = yield* Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          const fetched = yield* unifiedFetch({
            url,
            tags: [tag],
            ...(input.providers === undefined ? {} : { providers: input.providers }),
          })
          const entry = fetched.corpus
          if (entry === undefined) {
            return { url, status: "unstored" as const, provider: fetched.provider }
          }
          if (entry.created) {
            return { url, status: "new" as const, provider: fetched.provider, id: entry.id, version: entry.version }
          }
          if (!entry.changed) {
            return { url, status: "unchanged" as const, provider: fetched.provider, id: entry.id, version: entry.version }
          }
          if (input.include_diff === false) {
            return { url, status: "changed" as const, provider: fetched.provider, id: entry.id, version: entry.version }
          }
          const before = yield* corpus.versionContent(entry.id, entry.version - 1)
          const diff = before === undefined ? undefined : diffLines(before, fetched.content ?? "", input.diff_context ?? 1)
          return {
            url,
            status: "changed" as const,
            provider: fetched.provider,
            id: entry.id,
            version: entry.version,
            ...(diff === undefined
              ? {}
              : { diff: { ...diff, hunks: diff.hunks.slice(0, input.max_hunks ?? 10), total_hunks: diff.hunks.length } }),
          }
        }).pipe(Effect.catch((error) => Effect.succeed({ url, status: "failed" as const, error: toErrorDetails(error) }))),
      { concurrency: Math.max(1, input.concurrency ?? 4) },
    )

    const by = (status: string) => checks.filter((check) => check.status === status)
    return {
      tag,
      checked: checks.length,
      changed: by("changed"),
      new: by("new"),
      unchanged: by("unchanged").map((check) => check.url),
      failed: by("failed"),
      checked_at: new Date().toISOString(),
    }
  })

export const watchCommand = makeJsonCommand({
  name: "watch",
  commandName: "watch",
  description:
    "Re-fetch a watch list (explicit urls plus every corpus document tagged `watch` or `tag`) and report new/changed/unchanged/failed pages with line diffs of what changed. Watched URLs are tagged so later runs need no input. Schedule it with cron or an agent loop.",
  schema: WatchInput,
  optionalInput: true,
  run: watchRun,
})

registerContract({
  command: "watch",
  description: "DIY page monitoring via corpus change detection and diffs",
  inputSchema: WatchInput,
  examples: [
    { name: "start watching", input: { urls: ["https://example.com/pricing", "https://example.com/changelog"] } },
    { name: "re-check the watch list", input: {} },
    { name: "free providers only", input: { tag: "competitors", providers: ["keenable"] } },
  ],
})
