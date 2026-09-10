import { Database } from "bun:sqlite"
import { Context, Effect, Layer } from "effect"

import { StoreError } from "./errors"
import { storePath } from "./paths"

export const RunStatus = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unsupported",
] as const
export type RunStatus = (typeof RunStatus)[number]

export interface RunRecord {
  readonly id: string
  readonly provider: string
  readonly kind: string
  readonly remote_id: string | null
  readonly status: RunStatus
  readonly payload: string | null
  readonly result_ref: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface SourceRecord {
  readonly id: number
  readonly run_id: string | null
  readonly provider: string
  readonly url: string
  readonly canonical_url: string
  readonly title: string | null
  readonly snippet: string | null
  readonly content_hash: string | null
  readonly fetched_at: string
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "ref",
])

export const canonicalizeUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl)
    url.hash = ""
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "")
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key)
      }
    }
    const out = url.toString()
    return out.endsWith("/") ? out.slice(0, -1) : out
  } catch {
    return rawUrl.trim()
  }
}

const now = () => new Date().toISOString()

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  remote_id TEXT,
  status TEXT NOT NULL,
  payload TEXT,
  result_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_remote ON runs(provider, remote_id);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  provider TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT,
  snippet TEXT,
  content_hash TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_canonical ON sources(canonical_url);
CREATE INDEX IF NOT EXISTS idx_sources_run ON sources(run_id);
`

export class Store extends Context.Service<Store, {
  readonly upsertRun: (run: {
    readonly id: string
    readonly provider: string
    readonly kind: string
    readonly remoteId?: string | undefined
    readonly status: RunStatus
    readonly payload?: unknown
    readonly resultRef?: string | undefined
  }) => Effect.Effect<RunRecord, StoreError>
  readonly getRun: (id: string) => Effect.Effect<RunRecord | undefined, StoreError>
  readonly findRunByRemote: (
    provider: string,
    remoteId: string,
  ) => Effect.Effect<RunRecord | undefined, StoreError>
  readonly listRuns: (options?: {
    readonly provider?: string | undefined
    readonly status?: string | undefined
    readonly limit?: number | undefined
  }) => Effect.Effect<ReadonlyArray<RunRecord>, StoreError>
  readonly updateRun: (
    id: string,
    patch: {
      readonly status?: RunStatus | undefined
      readonly remoteId?: string | undefined
      readonly resultRef?: string | undefined
    },
  ) => Effect.Effect<void, StoreError>
  readonly insertSources: (
    sources: ReadonlyArray<{
      readonly runId?: string | undefined
      readonly provider: string
      readonly url: string
      readonly title?: string | undefined
      readonly snippet?: string | undefined
      readonly contentHash?: string | undefined
    }>,
  ) => Effect.Effect<number, StoreError>
  readonly sourcesForRun: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<SourceRecord>, StoreError>
  readonly listSources: (options?: {
    readonly provider?: string | undefined
    readonly canonicalUrl?: string | undefined
    readonly limit?: number | undefined
  }) => Effect.Effect<ReadonlyArray<SourceRecord>, StoreError>
  readonly citationOverlap: (
    urls: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<{ canonical_url: string; providers: string }>, StoreError>
}>()("survey/Store") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const path = yield* storePath
      const db = yield* Effect.try({
        try: () => {
          const database = new Database(path, { create: true })
          database.exec("PRAGMA journal_mode = WAL")
          database.exec(MIGRATIONS)
          return database
        },
        catch: (error) =>
          new StoreError({
            operation: "open",
            message: error instanceof Error ? error.message : String(error),
          }),
      })

      const run = <A>(operation: string, f: () => A) =>
        Effect.try({
          try: f,
          catch: (error) =>
            new StoreError({
              operation,
              message: error instanceof Error ? error.message : String(error),
            }),
        })

      return Store.of({
        upsertRun: (input) =>
          run("upsertRun", () => {
            const ts = now()
            const payload = input.payload === undefined ? null : JSON.stringify(input.payload)
            db.query(
              `INSERT INTO runs (id, provider, kind, remote_id, status, payload, result_ref, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 remote_id = COALESCE(excluded.remote_id, runs.remote_id),
                 status = excluded.status,
                 result_ref = COALESCE(excluded.result_ref, runs.result_ref),
                 updated_at = excluded.updated_at`,
            ).run(
              input.id,
              input.provider,
              input.kind,
              input.remoteId ?? null,
              input.status,
              payload,
              input.resultRef ?? null,
              ts,
              ts,
            )
            return {
              id: input.id,
              provider: input.provider,
              kind: input.kind,
              remote_id: input.remoteId ?? null,
              status: input.status,
              payload,
              result_ref: input.resultRef ?? null,
              created_at: ts,
              updated_at: ts,
            } satisfies RunRecord
          }),

        getRun: (id) =>
          run("getRun", () =>
            (db.query(`SELECT * FROM runs WHERE id = ?`).get(id) ?? undefined) as
              | RunRecord
              | undefined,
          ),

        findRunByRemote: (provider, remoteId) =>
          run("findRunByRemote", () =>
            (db
              .query(`SELECT * FROM runs WHERE provider = ? AND remote_id = ? ORDER BY created_at DESC LIMIT 1`)
              .get(provider, remoteId) ?? undefined) as RunRecord | undefined,
          ),

        listRuns: (options) =>
          run("listRuns", () => {
            const clauses: Array<string> = []
            const params: Array<string | number> = []
            if (options?.provider) {
              clauses.push(`provider = ?`)
              params.push(options.provider)
            }
            if (options?.status) {
              clauses.push(`status = ?`)
              params.push(options.status)
            }
            const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
            const limit = options?.limit ?? 100
            params.push(limit)
            return db
              .query(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`)
              .all(...params) as ReadonlyArray<RunRecord>
          }),

        updateRun: (id, patch) =>
          run("updateRun", () => {
            const sets: Array<string> = [`updated_at = ?`]
            const params: Array<string> = [now()]
            if (patch.status !== undefined) {
              sets.push(`status = ?`)
              params.push(patch.status)
            }
            if (patch.remoteId !== undefined) {
              sets.push(`remote_id = ?`)
              params.push(patch.remoteId)
            }
            if (patch.resultRef !== undefined) {
              sets.push(`result_ref = ?`)
              params.push(patch.resultRef)
            }
            params.push(id)
            db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...params)
          }),

        insertSources: (sources) =>
          run("insertSources", () => {
            const stmt = db.prepare(
              `INSERT INTO sources (run_id, provider, url, canonical_url, title, snippet, content_hash, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            const ts = now()
            let count = 0
            for (const source of sources) {
              stmt.run(
                source.runId ?? null,
                source.provider,
                source.url,
                canonicalizeUrl(source.url),
                source.title ?? null,
                source.snippet ?? null,
                source.contentHash ?? null,
                ts,
              )
              count += 1
            }
            return count
          }),

        sourcesForRun: (runId) =>
          run("sourcesForRun", () =>
            db
              .query(`SELECT * FROM sources WHERE run_id = ? ORDER BY id`)
              .all(runId) as ReadonlyArray<SourceRecord>,
          ),

        listSources: (options) =>
          run("listSources", () => {
            const clauses: Array<string> = []
            const params: Array<string | number> = []
            if (options?.provider) {
              clauses.push(`provider = ?`)
              params.push(options.provider)
            }
            if (options?.canonicalUrl) {
              clauses.push(`canonical_url = ?`)
              params.push(options.canonicalUrl)
            }
            const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
            const limit = options?.limit ?? 200
            params.push(limit)
            return db
              .query(`SELECT * FROM sources ${where} ORDER BY id DESC LIMIT ?`)
              .all(...params) as ReadonlyArray<SourceRecord>
          }),

        citationOverlap: (urls) =>
          run("citationOverlap", () => {
            if (urls.length === 0) {
              return [] as ReadonlyArray<{ canonical_url: string; providers: string }>
            }
            const canonical = urls.map(canonicalizeUrl)
            const placeholders = canonical.map(() => "?").join(",")
            return db
              .query(
                `SELECT canonical_url, GROUP_CONCAT(DISTINCT provider) AS providers
                 FROM sources WHERE canonical_url IN (${placeholders})
                 GROUP BY canonical_url`,
              )
              .all(...canonical) as ReadonlyArray<{ canonical_url: string; providers: string }>
          }),
      })
    }),
  )
}
