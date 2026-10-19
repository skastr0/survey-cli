import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"

import { Context, Effect, Layer } from "effect"

import { StoreError } from "./errors"
import { storePath } from "./paths"
import { canonicalizeUrl } from "./store"

/**
 * Local research corpus: every document survey has read (web fetches, local
 * files, papers, notes), versioned by content hash and indexed with SQLite
 * FTS5 (BM25). Lives in the same store.db as runs/sources so `sql local:true`
 * can join across all three.
 */

export interface DocumentRecord {
  readonly id: number
  readonly url: string
  readonly canonical_url: string
  readonly domain: string
  readonly title: string | null
  readonly provider: string | null
  readonly kind: string
  readonly content: string
  readonly content_hash: string
  readonly bytes: number
  readonly version: number
  readonly tags: ReadonlyArray<string>
  readonly metadata: Record<string, unknown> | null
  readonly created_at: string
  readonly updated_at: string
  readonly changed_at: string
}

export type DocumentSummary = Omit<DocumentRecord, "content">

export interface DocumentVersion {
  readonly version: number
  readonly content_hash: string
  readonly bytes: number
  readonly fetched_at: string
}

export interface PutDocument {
  readonly url: string
  readonly content: string
  readonly title?: string | undefined
  readonly provider?: string | undefined
  readonly kind?: string | undefined
  readonly tags?: ReadonlyArray<string> | undefined
  readonly metadata?: Record<string, unknown> | undefined
}

export interface PutResult {
  readonly id: number
  readonly canonical_url: string
  readonly version: number
  readonly content_hash: string
  readonly created: boolean
  readonly changed: boolean
  readonly previous_hash: string | null
}

export interface DocumentFilter {
  readonly provider?: string | undefined
  readonly kind?: string | undefined
  readonly domain?: string | undefined
  readonly tag?: string | undefined
  readonly since?: string | undefined
}

export interface SearchHit extends DocumentSummary {
  readonly score: number
  readonly snippet: string
}

export interface DocumentRef {
  readonly id?: number | undefined
  readonly url?: string | undefined
}

export interface CorpusStats {
  readonly documents: number
  readonly versions: number
  readonly bytes: number
  readonly by_kind: ReadonlyArray<{ kind: string; documents: number }>
  readonly by_provider: ReadonlyArray<{ provider: string | null; documents: number }>
  readonly by_domain: ReadonlyArray<{ domain: string; documents: number }>
}

export const hashContent = (content: string) =>
  createHash("sha256").update(content).digest("hex")

/** Treat local paths and other non-URL keys as stable identifiers. */
export const documentKey = (url: string) =>
  /^[a-z][a-z0-9+.-]*:/i.test(url) ? canonicalizeUrl(url) : url.trim()

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return ""
  }
}

/**
 * Quote each bare term so arbitrary agent input never trips FTS5 syntax
 * (`-`, `:`, `.`, unbalanced quotes). `syntax: "fts"` callers bypass this.
 */
const FTS_OPERATORS = new Set(["OR", "AND", "NOT"])

export const toFtsQuery = (query: string) => {
  const terms = (query.match(/"[^"]*"|\S+/g) ?? []).filter((term) => term.replace(/"/g, "").length > 0)
  const quote = (term: string) => `"${term.replace(/^"|"$/g, "").replace(/"/g, "\"\"")}"`
  // An operator is only valid FTS5 between two terms; at an edge or next to
  // another operator it is a literal word ("NOT alpha", "alpha OR").
  return terms
    .map((term, index) => {
      const isOperator = FTS_OPERATORS.has(term)
      const prev = terms[index - 1]
      const next = terms[index + 1]
      const between = prev !== undefined && next !== undefined && !FTS_OPERATORS.has(prev) && !FTS_OPERATORS.has(next)
      return isOperator && between ? term : quote(term)
    })
    .join(" ")
}

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL DEFAULT '',
  title TEXT,
  provider TEXT,
  kind TEXT NOT NULL DEFAULT 'web',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_domain ON documents(domain);
CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);

CREATE TABLE IF NOT EXISTS document_versions (
  document_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (document_id, version)
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, content, url,
  content='documents', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, content, url) VALUES (new.id, new.title, new.content, new.url);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content, url) VALUES ('delete', old.id, old.title, old.content, old.url);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content, url) VALUES ('delete', old.id, old.title, old.content, old.url);
  INSERT INTO documents_fts(rowid, title, content, url) VALUES (new.id, new.title, new.content, new.url);
END;
`

const SUMMARY_COLUMNS = `d.id, d.url, d.canonical_url, d.domain, d.title, d.provider, d.kind, d.content_hash,
  d.bytes, d.version, d.tags, d.metadata, d.created_at, d.updated_at, d.changed_at`

interface RawRow {
  readonly tags: string
  readonly metadata: string | null
  readonly [key: string]: unknown
}

const decodeRow = <A>(row: RawRow): A =>
  ({
    ...row,
    tags: JSON.parse(row.tags) as ReadonlyArray<string>,
    metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as Record<string, unknown>),
  }) as A

const filterClauses = (filter: DocumentFilter | undefined) => {
  const clauses: Array<string> = []
  const params: Array<string> = []
  if (filter?.provider) {
    clauses.push(`d.provider = ?`)
    params.push(filter.provider)
  }
  if (filter?.kind) {
    clauses.push(`d.kind = ?`)
    params.push(filter.kind)
  }
  if (filter?.domain) {
    const domain = filter.domain.toLowerCase().replace(/^www\./, "")
    clauses.push(`(d.domain = ? OR d.domain LIKE ?)`)
    params.push(domain, `%.${domain}`)
  }
  if (filter?.tag) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(d.tags) WHERE json_each.value = ?)`)
    params.push(filter.tag)
  }
  if (filter?.since) {
    clauses.push(`d.updated_at >= ?`)
    params.push(filter.since)
  }
  return { clauses, params }
}

const now = () => new Date().toISOString()

export class Corpus extends Context.Service<Corpus, {
  readonly put: (doc: PutDocument) => Effect.Effect<PutResult, StoreError>
  readonly get: (ref: DocumentRef) => Effect.Effect<DocumentRecord | undefined, StoreError>
  readonly versions: (id: number) => Effect.Effect<ReadonlyArray<DocumentVersion>, StoreError>
  readonly versionContent: (
    id: number,
    version: number,
  ) => Effect.Effect<string | undefined, StoreError>
  readonly search: (options: {
    readonly query: string
    readonly limit: number
    readonly filter?: DocumentFilter | undefined
    readonly snippetTokens?: number | undefined
  }) => Effect.Effect<ReadonlyArray<SearchHit>, StoreError>
  readonly list: (options: {
    readonly limit: number
    readonly offset?: number | undefined
    readonly filter?: DocumentFilter | undefined
  }) => Effect.Effect<ReadonlyArray<DocumentSummary>, StoreError>
  readonly scan: (options: {
    readonly ids?: ReadonlyArray<number> | undefined
    readonly filter?: DocumentFilter | undefined
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<DocumentRecord>, StoreError>
  readonly remove: (ref: DocumentRef) => Effect.Effect<number, StoreError>
  readonly stats: Effect.Effect<CorpusStats, StoreError>
}>()("survey/Corpus") {
  static readonly layer = Layer.effect(
    Corpus,
    Effect.gen(function* () {
      const path = yield* storePath
      const db: Database = yield* Effect.tryPromise({
        try: async () => {
          const { Database } = await import("bun:sqlite")
          const database = new Database(path, { create: true })
          database.exec("PRAGMA journal_mode = WAL")
          database.exec("PRAGMA busy_timeout = 5000")
          database.exec(MIGRATIONS)
          return database
        },
        catch: (error) =>
          new StoreError({
            operation: "corpus.open",
            message: error instanceof Error ? error.message : String(error),
          }),
      })

      const run = <A>(operation: string, f: () => A) =>
        Effect.try({
          try: f,
          catch: (error) =>
            new StoreError({
              operation: `corpus.${operation}`,
              message: error instanceof Error ? error.message : String(error),
            }),
        })

      const findRow = (ref: DocumentRef) => {
        if (ref.id !== undefined) {
          return db.query(`SELECT * FROM documents WHERE id = ?`).get(ref.id) as RawRow | null
        }
        if (ref.url !== undefined) {
          return db
            .query(`SELECT * FROM documents WHERE canonical_url = ?`)
            .get(documentKey(ref.url)) as RawRow | null
        }
        return null
      }

      const put = db.transaction((doc: PutDocument): PutResult => {
        const key = documentKey(doc.url)
        const hash = hashContent(doc.content)
        const bytes = Buffer.byteLength(doc.content)
        const ts = now()
        const existing = db
          .query(`SELECT id, version, content_hash, tags FROM documents WHERE canonical_url = ?`)
          .get(key) as { id: number; version: number; content_hash: string; tags: string } | null

        if (existing === null) {
          const inserted = db
            .query(
              `INSERT INTO documents (url, canonical_url, domain, title, provider, kind, content, content_hash,
                 bytes, version, tags, metadata, created_at, updated_at, changed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) RETURNING id`,
            )
            .get(
              doc.url,
              key,
              domainOf(doc.url),
              doc.title ?? null,
              doc.provider ?? null,
              doc.kind ?? "web",
              doc.content,
              hash,
              bytes,
              JSON.stringify(doc.tags ?? []),
              doc.metadata === undefined ? null : JSON.stringify(doc.metadata),
              ts,
              ts,
              ts,
            ) as { id: number }
          db.query(
            `INSERT INTO document_versions (document_id, version, content_hash, content, bytes, fetched_at)
             VALUES (?, 1, ?, ?, ?, ?)`,
          ).run(inserted.id, hash, doc.content, bytes, ts)
          return {
            id: inserted.id,
            canonical_url: key,
            version: 1,
            content_hash: hash,
            created: true,
            changed: true,
            previous_hash: null,
          }
        }

        const tags = [...new Set([...(JSON.parse(existing.tags) as Array<string>), ...(doc.tags ?? [])])]
        const changed = existing.content_hash !== hash
        const version = changed ? existing.version + 1 : existing.version
        db.query(
          `UPDATE documents SET
             url = ?, title = COALESCE(?, title), provider = COALESCE(?, provider),
             kind = COALESCE(?, kind), content = ?, content_hash = ?, bytes = ?, version = ?,
             tags = ?, metadata = COALESCE(?, metadata), updated_at = ?,
             changed_at = CASE WHEN ? THEN ? ELSE changed_at END
           WHERE id = ?`,
        ).run(
          doc.url,
          doc.title ?? null,
          doc.provider ?? null,
          doc.kind ?? null,
          doc.content,
          hash,
          bytes,
          version,
          JSON.stringify(tags),
          doc.metadata === undefined ? null : JSON.stringify(doc.metadata),
          ts,
          changed ? 1 : 0,
          ts,
          existing.id,
        )
        if (changed) {
          db.query(
            `INSERT INTO document_versions (document_id, version, content_hash, content, bytes, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(existing.id, version, hash, doc.content, bytes, ts)
        }
        return {
          id: existing.id,
          canonical_url: key,
          version,
          content_hash: hash,
          created: false,
          changed,
          previous_hash: changed ? existing.content_hash : null,
        }
      })

      return Corpus.of({
        put: (doc) => run("put", () => put(doc)),

        get: (ref) =>
          run("get", () => {
            const row = findRow(ref)
            return row === null ? undefined : decodeRow<DocumentRecord>(row)
          }),

        versions: (id) =>
          run("versions", () =>
            db
              .query(
                `SELECT version, content_hash, bytes, fetched_at FROM document_versions
                 WHERE document_id = ? ORDER BY version`,
              )
              .all(id) as ReadonlyArray<DocumentVersion>,
          ),

        versionContent: (id, version) =>
          run("versionContent", () => {
            const row = db
              .query(`SELECT content FROM document_versions WHERE document_id = ? AND version = ?`)
              .get(id, version) as { content: string } | null
            return row?.content
          }),

        search: (options) =>
          run("search", () => {
            const { clauses, params } = filterClauses(options.filter)
            const where = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : ""
            const tokens = Math.max(4, Math.min(64, options.snippetTokens ?? 24))
            const rows = db
              .query(
                `SELECT ${SUMMARY_COLUMNS}, bm25(documents_fts, 4.0, 1.0, 2.0) AS score,
                   snippet(documents_fts, 1, '«', '»', '…', ${tokens}) AS snippet
                 FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
                 WHERE documents_fts MATCH ? ${where}
                 ORDER BY score LIMIT ?`,
              )
              .all(options.query, ...params, options.limit) as Array<RawRow>
            return rows.map((row) => decodeRow<SearchHit>(row))
          }),

        list: (options) =>
          run("list", () => {
            const { clauses, params } = filterClauses(options.filter)
            const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
            const rows = db
              .query(
                `SELECT ${SUMMARY_COLUMNS} FROM documents d ${where}
                 ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`,
              )
              .all(...params, options.limit, options.offset ?? 0) as Array<RawRow>
            return rows.map((row) => decodeRow<DocumentSummary>(row))
          }),

        scan: (options) =>
          run("scan", () => {
            const { clauses, params } = filterClauses(options.filter)
            const all: Array<string | number> = [...params]
            if (options.ids !== undefined && options.ids.length > 0) {
              clauses.push(`d.id IN (${options.ids.map(() => "?").join(",")})`)
              all.push(...options.ids)
            }
            const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
            const rows = db
              .query(`SELECT d.* FROM documents d ${where} ORDER BY d.updated_at DESC LIMIT ?`)
              .all(...all, options.limit) as Array<RawRow>
            return rows.map((row) => decodeRow<DocumentRecord>(row))
          }),

        remove: (ref) =>
          run("remove", () => {
            const row = findRow(ref) as { id: number } | null
            if (row === null) return 0
            db.query(`DELETE FROM document_versions WHERE document_id = ?`).run(row.id)
            db.query(`DELETE FROM documents WHERE id = ?`).run(row.id)
            return 1
          }),

        stats: run("stats", () => {
          const totals = db
            .query(`SELECT COUNT(*) AS documents, COALESCE(SUM(bytes), 0) AS bytes FROM documents`)
            .get() as { documents: number; bytes: number }
          const versions = db.query(`SELECT COUNT(*) AS n FROM document_versions`).get() as { n: number }
          return {
            documents: totals.documents,
            versions: versions.n,
            bytes: totals.bytes,
            by_kind: db
              .query(`SELECT kind, COUNT(*) AS documents FROM documents GROUP BY kind ORDER BY documents DESC`)
              .all() as ReadonlyArray<{ kind: string; documents: number }>,
            by_provider: db
              .query(
                `SELECT provider, COUNT(*) AS documents FROM documents GROUP BY provider ORDER BY documents DESC`,
              )
              .all() as ReadonlyArray<{ provider: string | null; documents: number }>,
            by_domain: db
              .query(
                `SELECT domain, COUNT(*) AS documents FROM documents WHERE domain != ''
                 GROUP BY domain ORDER BY documents DESC LIMIT 25`,
              )
              .all() as ReadonlyArray<{ domain: string; documents: number }>,
          }
        }),
      })
    }),
  )
}

/**
 * Best-effort corpus write used by fetch-style capabilities. The Corpus
 * service is optional in the environment (tests and embedders may omit it),
 * and a store failure never fails the provider call.
 */
export const rememberDocument = (doc: PutDocument) =>
  Effect.gen(function* () {
    const corpus = yield* Effect.serviceOption(Corpus)
    if (corpus._tag === "None" || doc.content.length === 0) return undefined
    return yield* corpus.value.put(doc)
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

/** Best-effort cache read; undefined when absent, stale, or no corpus. */
export const recallDocument = (url: string, maxAgeMs: number) =>
  Effect.gen(function* () {
    const corpus = yield* Effect.serviceOption(Corpus)
    if (corpus._tag === "None") return undefined
    const doc = yield* corpus.value.get({ url })
    if (doc === undefined) return undefined
    const age = Date.now() - Date.parse(doc.updated_at)
    return age <= maxAgeMs ? { doc, age_ms: age } : undefined
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
