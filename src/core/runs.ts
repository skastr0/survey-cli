import { Effect } from "effect"

import type { ProviderName } from "./registry"
import { Store, type RunStatus } from "./store"

const newId = () =>
  `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

/**
 * Record a provider job in the local run registry. Best-effort: a store
 * failure must never fail the provider call itself.
 */
export const recordRun = (options: {
  readonly provider: ProviderName
  readonly kind: string
  readonly remoteId?: string | undefined
  readonly status: RunStatus
  readonly payload?: unknown
}) =>
  Effect.gen(function* () {
    const store = yield* Store
    const id = newId()
    const record = yield* store.upsertRun({
      id,
      provider: options.provider,
      kind: options.kind,
      remoteId: options.remoteId,
      status: options.status,
      payload: options.payload,
    })
    return record
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

export const updateRun = (
  id: string | undefined,
  patch: { readonly status?: RunStatus; readonly remoteId?: string; readonly resultRef?: string },
) =>
  id === undefined
    ? Effect.void
    : Effect.gen(function* () {
        const store = yield* Store
        yield* store.updateRun(id, patch)
      }).pipe(Effect.catch(() => Effect.void))

export interface SourceLike {
  readonly url: string
  readonly title?: string | undefined
  readonly snippet?: string | undefined
}

/**
 * Normalize provider results into the shared source ledger. Best-effort —
 * store failures never fail the command.
 */
export const recordSources = (
  provider: ProviderName,
  items: ReadonlyArray<SourceLike>,
  runId?: string,
) =>
  items.length === 0
    ? Effect.succeed(0)
    : Effect.gen(function* () {
        const store = yield* Store
        return yield* store.insertSources(
          items.map((item) => ({
            provider,
            url: item.url,
            ...(item.title !== undefined ? { title: item.title } : {}),
            ...(item.snippet !== undefined ? { snippet: item.snippet } : {}),
            ...(runId !== undefined ? { runId } : {}),
          })),
        )
      }).pipe(Effect.catch(() => Effect.succeed(0)))

/** Extract {url,title,snippet} rows from a provider result payload (deep scan). */
export const extractUrls = (value: unknown, depth = 0): ReadonlyArray<SourceLike> => {
  if (depth > 6 || value === null || typeof value !== "object") {
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractUrls(item, depth + 1))
  }
  const record = value as Record<string, unknown>
  const out: Array<SourceLike> = []
  if (typeof record.url === "string" && /^https?:\/\//.test(record.url)) {
    out.push({
      url: record.url,
      title: typeof record.title === "string" ? record.title : undefined,
      snippet:
        typeof record.snippet === "string"
          ? record.snippet
          : typeof record.text === "string"
            ? record.text.slice(0, 280)
            : typeof record.summary === "string"
              ? record.summary.slice(0, 280)
              : undefined,
    })
  }
  for (const nested of Object.values(record)) {
    if (nested !== null && typeof nested === "object") {
      out.push(...extractUrls(nested, depth + 1))
    }
  }
  return out
}
