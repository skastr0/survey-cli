import { pathToFileURL } from "node:url"

import { Effect, FileSystem, Path, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import { makeBatchJsonCommand, makeJsonCommand } from "../core/command"
import { Corpus, type DocumentFilter, type DocumentRecord, type DocumentSummary, toFtsQuery } from "../core/corpus"
import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { setExitCode, toErrorDetails } from "../core/output"
import { diffLines } from "../core/diff"
import { registerContracts } from "../core/discovery"
import { CommandInputError } from "../core/errors"
import { convertIngestFile, corpusRecord, DOCUMENT_EXTENSIONS, isConvertiblePath, unifiedConvert } from "./convert"
import {
  corpusExportCommand,
  corpusImportCommand,
  corpusLinksCommand,
  corpusTagCommand,
  corpusToolContracts,
} from "./corpus-tools"
import { directoryFields, fileUrl, ingestDirectory, type IngestOutcome } from "./ingest"
import { basename } from "node:path"
import { unifiedFetch } from "./fetch"
import { loadDocumentSource } from "../local/source"

const FilterFields = {
  provider: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
}

const RefFields = {
  id: Schema.optional(Schema.Int),
  url: Schema.optional(Schema.NonEmptyString),
}

export const CorpusAddInput = Schema.Struct({
  url: Schema.optional(Schema.NonEmptyString),
  path: Schema.optional(Schema.NonEmptyString),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  fetch: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** Add every matching file under `dir` (see directoryFields). */
  ...directoryFields,
})

export const CorpusSearchInput = Schema.Struct({
  query: Schema.NonEmptyString,
  limit: Schema.optional(Schema.Int),
  syntax: Schema.optional(Schema.Literals(["terms", "fts"])),
  snippet_tokens: Schema.optional(Schema.Int),
  max_lines: Schema.optional(Schema.Int),
  ...FilterFields,
})

export const CorpusReadInput = Schema.Struct({
  ...RefFields,
  version: Schema.optional(Schema.Int),
  offset: Schema.optional(Schema.Int),
  length: Schema.optional(Schema.Int),
  lines: Schema.optional(Schema.String),
})

export const CorpusGrepInput = Schema.Struct({
  pattern: Schema.NonEmptyString,
  regex: Schema.optional(Schema.Boolean),
  ignore_case: Schema.optional(Schema.Boolean),
  context: Schema.optional(Schema.Int),
  max_matches: Schema.optional(Schema.Int),
  ids: Schema.optional(Schema.Array(Schema.Int)),
  max_documents: Schema.optional(Schema.Int),
  ...FilterFields,
})

export const CorpusListInput = Schema.Struct({
  limit: Schema.optional(Schema.Int),
  offset: Schema.optional(Schema.Int),
  ...FilterFields,
})

export const CorpusRefInput = Schema.Struct(RefFields)

export const CorpusPruneInput = Schema.Struct({
  /** Remove documents whose file:// source no longer exists (default true). */
  missing_files: Schema.optional(Schema.Boolean),
  /** Remove documents last updated before now - duration (`30d`, `12h`, `2w`, `90m`) or before an ISO date. */
  older_than: Schema.optional(Schema.String),
  /** Scope filters; they restrict every criterion. */
  kind: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  /** Preview only (default true). Pass false to actually remove. */
  dry_run: Schema.optional(Schema.Boolean),
  /** Safety cap on documents removed in one call (default 1000). */
  max_remove: Schema.optional(Schema.Int),
})

const PRUNE_PAGE = 500

const DURATION_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `30d` / `12h` / ISO date -> cutoff epoch ms. */
export const parseCutoff = (value: string, now: number = Date.now()) => {
  const match = /^(\d+)\s*([smhdw])$/i.exec(value.trim())
  if (match) return now - Number(match[1]) * DURATION_MS[match[2]!.toLowerCase()]!
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

const localPathOf = (url: string) => {
  if (!url.startsWith("file://")) return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

export const corpusPrune = (input: typeof CorpusPruneInput.Type) =>
  Effect.gen(function* () {
    const checkMissing = input.missing_files ?? true
    const cutoff = input.older_than === undefined ? undefined : parseCutoff(input.older_than)
    if (input.older_than !== undefined && cutoff === undefined) {
      return yield* new CommandInputError({
        field: "older_than",
        message: `Cannot parse "${input.older_than}". Use a duration like 30d, 12h, 2w, 90m or an ISO date.`,
      })
    }
    if (!checkMissing && cutoff === undefined) {
      return yield* new CommandInputError({
        field: "missing_files",
        message: "Nothing to prune by: enable missing_files or set older_than.",
      })
    }
    const maxRemove = input.max_remove ?? 1000
    const dryRun = input.dry_run !== false
    const corpus = yield* Corpus
    const filter = filterOf(input)

    const candidates: Array<{ doc: DocumentSummary; reasons: Array<string> }> = []
    let scanned = 0
    for (let offset = 0; ; offset += PRUNE_PAGE) {
      const page = yield* corpus.list({ limit: PRUNE_PAGE, offset, filter })
      scanned += page.length
      for (const doc of page) {
        const reasons: Array<string> = []
        if (checkMissing) {
          const path = localPathOf(doc.url)
          if (path !== undefined && !(yield* Effect.promise(() => access(path).then(() => true, () => false)))) {
            reasons.push("missing_file")
          }
        }
        if (cutoff !== undefined && Date.parse(doc.updated_at) < cutoff) reasons.push("older_than")
        if (reasons.length > 0) candidates.push({ doc, reasons })
      }
      if (page.length < PRUNE_PAGE) break
    }

    const selected = candidates.slice(0, maxRemove)
    const documents = yield* Effect.forEach(selected, ({ doc, reasons }) =>
      Effect.gen(function* () {
        const base = {
          id: doc.id,
          url: doc.url,
          title: doc.title,
          kind: doc.kind,
          updated_at: doc.updated_at,
          reasons,
        }
        if (dryRun) return { ...base, status: "would_remove" as const }
        return yield* corpus.remove({ id: doc.id }).pipe(
          Effect.map((n) => ({ ...base, status: n > 0 ? ("removed" as const) : ("missing" as const) })),
          Effect.catch((error) =>
            Effect.succeed({ ...base, status: "failed" as const, error: toErrorDetails(error) }),
          ),
        )
      }),
    )

    const failed = documents.filter((d) => d.status === "failed").length
    if (failed > 0) yield* setExitCode(1)
    return {
      dry_run: dryRun,
      criteria: {
        missing_files: checkMissing,
        older_than: input.older_than ?? null,
        cutoff: cutoff === undefined ? null : new Date(cutoff).toISOString(),
        kind: input.kind ?? null,
        tag: input.tag ?? null,
      },
      scanned,
      matched: candidates.length,
      truncated: candidates.length > selected.length,
      removed: documents.filter((d) => d.status === "removed").length,
      would_remove: documents.filter((d) => d.status === "would_remove").length,
      failed,
      documents,
    }
  })

export const CorpusDiffInput = Schema.Struct({
  ...RefFields,
  from: Schema.optional(Schema.Int),
  to: Schema.optional(Schema.Int),
  context: Schema.optional(Schema.Int),
})

const filterOf = (input: {
  readonly provider?: string | undefined
  readonly kind?: string | undefined
  readonly domain?: string | undefined
  readonly tag?: string | undefined
  readonly since?: string | undefined
}): DocumentFilter => ({
  provider: input.provider,
  kind: input.kind,
  domain: input.domain,
  tag: input.tag,
  since: input.since,
})

const requireDocument = (ref: { readonly id?: number | undefined; readonly url?: string | undefined }) =>
  Effect.gen(function* () {
    if (ref.id === undefined && ref.url === undefined) {
      return yield* new CommandInputError({ field: "id", message: "Provide id or url" })
    }
    const corpus = yield* Corpus
    const doc = yield* corpus.get(ref)
    if (doc === undefined) {
      return yield* new CommandInputError({
        field: ref.id !== undefined ? "id" : "url",
        message: `No corpus document for ${ref.id ?? ref.url}`,
      })
    }
    return doc
  })

const summarize = ({ content: _content, ...rest }: DocumentRecord) => rest

export const corpusAdd = (input: typeof CorpusAddInput.Type) =>
  Effect.gen(function* () {
    const corpus = yield* Corpus
    if (input.dir !== undefined) {
      // Binary documents convert (and report needs_ocr); text files take the plain-text path.
      const fs = yield* FileSystem.FileSystem
      return yield* ingestDirectory({
        input,
        storing: true,
        defaultGlob: `*.{${[...DOCUMENT_EXTENSIONS].join(",")},md,markdown,txt,rst}`,
        process: (file) =>
          isConvertiblePath(file.path)
            ? convertIngestFile(file, { ...(input.tags ? { tags: input.tags } : {}) })
            : fs.readFileString(file.path).pipe(
                Effect.flatMap((content) =>
                  corpus.put({
                    url: fileUrl(file.path),
                    content,
                    title: basename(file.path),
                    provider: input.provider ?? "local",
                    kind: input.kind ?? "file",
                    tags: input.tags,
                    metadata: { ...input.metadata, source_sha256: file.sha256 },
                  }),
                ),
                Effect.map(
                  (put): IngestOutcome => ({
                    status: put.created ? "stored" : put.changed ? "updated" : "unchanged",
                    corpus: { id: put.id, version: put.version, changed: put.changed, created: put.created },
                  }),
                ),
              ),
      })
    }
    if (input.path !== undefined) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const absolute = path.resolve(input.path)
      if (input.content === undefined && isConvertiblePath(absolute)) {
        // Binary documents (pdf/docx/pptx/xlsx/epub/...) go through the local-first router.
        const converted = yield* unifiedConvert({ path: absolute, store: false })
        if (!converted.complete || !converted.markdown) {
          return yield* new CommandInputError({
            field: "path",
            message: `${absolute} did not convert completely (${converted.route.reason})${"next_step" in converted && converted.next_step ? `. ${converted.next_step}` : ""}`,
          })
        }
        const doc = yield* loadDocumentSource({ path: absolute })
        const record = corpusRecord(doc, converted, { title: input.title, tags: input.tags })
        const result = yield* corpus.put({
          ...record,
          url: input.url ?? record.url,
          provider: input.provider ?? record.provider,
          kind: input.kind ?? record.kind,
          metadata: { ...record.metadata, ...input.metadata },
        })
        return { ...result, source: "convert" as const, route: converted.route }
      }
      const content =
        input.content ??
        (yield* fs.readFileString(absolute).pipe(
          Effect.mapError(
            (error) =>
              new CommandInputError({
                field: "path",
                message: `Cannot read ${absolute}: ${(error as { message?: string }).message ?? "read failed"}`,
              }),
          ),
        ))
      const result = yield* corpus.put({
        // pathToFileURL percent-encodes `#`/`?` so canonicalization cannot strip them.
        url: input.url ?? pathToFileURL(absolute).href,
        content,
        title: input.title ?? path.basename(absolute),
        provider: input.provider ?? "local",
        kind: input.kind ?? "file",
        tags: input.tags,
        metadata: input.metadata,
      })
      return { ...result, source: "path" as const }
    }
    if (input.url === undefined) {
      return yield* new CommandInputError({ field: "url", message: "Provide url, path, or url+content" })
    }
    if (input.content !== undefined && input.fetch === undefined) {
      const result = yield* corpus.put({
        url: input.url,
        content: input.content,
        title: input.title,
        provider: input.provider,
        kind: input.kind ?? "note",
        tags: input.tags,
        metadata: input.metadata,
      })
      return { ...result, source: "inline" as const }
    }
    const fetched = yield* unifiedFetch({ ...(input.fetch ?? {}), url: input.url, store: false } as never)
    if (fetched.content === null || fetched.content === undefined) {
      return yield* new CommandInputError({
        field: "url",
        message: `Fetched ${input.url} via ${fetched.provider} but it returned no textual content`,
      })
    }
    const result = yield* corpus.put({
      url: input.url,
      content: fetched.content,
      title: input.title,
      provider: fetched.provider,
      kind: input.kind ?? "web",
      tags: input.tags,
      metadata: input.metadata,
    })
    return { ...result, source: "fetch" as const, provider: fetched.provider }
  })

export const corpusSearch = (input: typeof CorpusSearchInput.Type) =>
  Effect.gen(function* () {
    const corpus = yield* Corpus
    const query = input.syntax === "fts" ? input.query : toFtsQuery(input.query)
    const hits = yield* corpus.search({
      query,
      limit: input.limit ?? 10,
      filter: filterOf(input),
      snippetTokens: input.snippet_tokens,
    })
    const maxLines = input.max_lines ?? 3
    if (maxLines <= 0 || hits.length === 0) return { query, hits, count: hits.length }
    const terms = queryTerms(input.query)
    const located = yield* Effect.forEach(hits, (hit) =>
      corpus.get({ id: hit.id }).pipe(
        Effect.map((doc) => ({ ...hit, lines: doc === undefined ? [] : locateLines(doc.content, terms, maxLines) })),
      ),
    )
    return { query, hits: located, count: located.length }
  })

/** Lowercased word terms from a query, minus FTS operators and syntax. */
export const queryTerms = (query: string) =>
  [...new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
      (term) => !["and", "or", "not", "near"].includes(term),
    ),
  )]

/**
 * Lines containing the most query terms (prefix match approximates the
 * porter stemmer), so a hit says where to `corpus read {lines}` next.
 */
export const locateLines = (content: string, terms: ReadonlyArray<string>, max: number) => {
  if (terms.length === 0) return []
  const stems = terms.map((term) => (term.length > 4 ? term.slice(0, Math.max(4, term.length - 2)) : term))
  const scored: Array<{ line: number; text: string; score: number }> = []
  content.split("\n").forEach((text, index) => {
    const lower = text.toLowerCase()
    const score = stems.filter((stem) => lower.includes(stem)).length
    if (score > 0) scored.push({ line: index + 1, text: text.length > 300 ? `${text.slice(0, 300)}…` : text, score })
  })
  return scored
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, max)
    .sort((a, b) => a.line - b.line)
    .map(({ line, text }) => ({ line, text }))
}

const parseLineRange = (spec: string) =>
  Effect.gen(function* () {
    const match = /^\s*(\d+)?\s*(?:-|:)\s*(\d+)?\s*$|^\s*(\d+)\s*$/.exec(spec)
    if (match === null) {
      return yield* new CommandInputError({ field: "lines", message: 'Expected "start-end", "start-", "-end" or "n"' })
    }
    if (match[3] !== undefined) {
      const line = Number(match[3])
      return { start: line, end: line }
    }
    return {
      start: match[1] === undefined ? 1 : Number(match[1]),
      end: match[2] === undefined ? Number.POSITIVE_INFINITY : Number(match[2]),
    }
  })

export const corpusRead = (input: typeof CorpusReadInput.Type) =>
  Effect.gen(function* () {
    const doc = yield* requireDocument(input)
    const corpus = yield* Corpus
    let content = doc.content
    if (input.version !== undefined && input.version !== doc.version) {
      const older = yield* corpus.versionContent(doc.id, input.version)
      if (older === undefined) {
        return yield* new CommandInputError({ field: "version", message: `Document ${doc.id} has no version ${input.version}` })
      }
      content = older
    }
    const totalChars = content.length
    const allLines = content.split("\n")
    if (input.lines !== undefined) {
      const range = yield* parseLineRange(input.lines)
      const start = Math.max(1, range.start)
      const end = Math.min(allLines.length, range.end)
      return {
        document: summarize(doc),
        version: input.version ?? doc.version,
        total_lines: allLines.length,
        total_chars: totalChars,
        lines: { start, end },
        content: allLines.slice(start - 1, end).join("\n"),
        truncated: start > 1 || end < allLines.length,
      }
    }
    const offset = Math.max(0, input.offset ?? 0)
    const length = input.length ?? totalChars
    const slice = content.slice(offset, offset + length)
    return {
      document: summarize(doc),
      version: input.version ?? doc.version,
      total_lines: allLines.length,
      total_chars: totalChars,
      range: { offset, length: slice.length },
      content: slice,
      truncated: offset > 0 || offset + slice.length < totalChars,
    }
  })

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const corpusGrep = (input: typeof CorpusGrepInput.Type) =>
  Effect.gen(function* () {
    const corpus = yield* Corpus
    const flags = input.ignore_case === true ? "i" : ""
    const matcher = yield* Effect.try({
      try: () => new RegExp(input.regex === true ? input.pattern : escapeRegex(input.pattern), flags),
      catch: (error) =>
        new CommandInputError({ field: "pattern", message: error instanceof Error ? error.message : "invalid regex" }),
    })
    const context = Math.max(0, Math.min(20, input.context ?? 0))
    const maxMatches = input.max_matches ?? 200
    const docs = yield* corpus.scan({
      ids: input.ids,
      filter: filterOf(input),
      limit: input.max_documents ?? 1000,
    })
    const matches: Array<{
      document_id: number
      url: string
      title: string | null
      line: number
      text: string
      before?: ReadonlyArray<string>
      after?: ReadonlyArray<string>
    }> = []
    const perDocument = new Map<number, number>()
    let truncated = false
    scan: for (const doc of docs) {
      const lines = doc.content.split("\n")
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher.test(lines[index]!)) continue
        if (matches.length >= maxMatches) {
          truncated = true
          break scan
        }
        perDocument.set(doc.id, (perDocument.get(doc.id) ?? 0) + 1)
        matches.push({
          document_id: doc.id,
          url: doc.url,
          title: doc.title,
          line: index + 1,
          text: lines[index]!,
          ...(context > 0
            ? {
                before: lines.slice(Math.max(0, index - context), index),
                after: lines.slice(index + 1, index + 1 + context),
              }
            : {}),
        })
      }
    }
    return {
      pattern: input.pattern,
      documents_scanned: docs.length,
      documents_matched: perDocument.size,
      matches,
      count: matches.length,
      truncated,
    }
  })

export const corpusDiff = (input: typeof CorpusDiffInput.Type) =>
  Effect.gen(function* () {
    const doc = yield* requireDocument(input)
    const corpus = yield* Corpus
    const to = input.to ?? doc.version
    const from = input.from ?? Math.max(1, to - 1)
    const before = yield* corpus.versionContent(doc.id, from)
    const after = to === doc.version ? doc.content : yield* corpus.versionContent(doc.id, to)
    if (before === undefined || after === undefined) {
      return yield* new CommandInputError({
        field: before === undefined ? "from" : "to",
        message: `Document ${doc.id} has versions 1..${doc.version}`,
      })
    }
    return {
      document: summarize(doc),
      from,
      to,
      changed: before !== after,
      diff: diffLines(before, after, input.context ?? 2),
    }
  })

const corpusAddCommand = makeBatchJsonCommand({
  name: "add",
  commandName: "corpus add",
  description:
    "Add documents to the local corpus: {url, content} stores inline text, {path} reads a local text file, {url} alone fetches via unified fetch. Re-adding the same URL versions it when content changes. Accepts one object or an array.",
  schema: CorpusAddInput,
  run: (item) => corpusAdd(item),
})

const corpusSearchCommand = makeJsonCommand({
  name: "search",
  commandName: "corpus search",
  description:
    "BM25 full-text search (SQLite FTS5) over every document in the local corpus, with highlighted snippets and the best-matching line numbers per hit (max_lines, default 3; feed them to corpus read). syntax=terms (default) quotes each term; syntax=fts passes raw FTS5 (NEAR, prefix*, column:).",
  schema: CorpusSearchInput,
  run: corpusSearch,
})

const corpusReadCommand = makeJsonCommand({
  name: "read",
  commandName: "corpus read",
  description:
    "Read a corpus document by id or url — whole, by char range (offset/length), or by line range (lines: \"40-120\"). version reads an older snapshot.",
  schema: CorpusReadInput,
  run: corpusRead,
})

const corpusGrepCommand = makeJsonCommand({
  name: "grep",
  commandName: "corpus grep",
  description:
    "Line-level grep across corpus documents (literal by default, regex=true for JS regex) with optional context lines — code-search ergonomics over everything survey has read.",
  schema: CorpusGrepInput,
  run: corpusGrep,
})

const corpusListCommand = makeJsonCommand({
  name: "list",
  commandName: "corpus list",
  description: "List corpus documents (metadata only, newest first) with provider/kind/domain/tag/since filters",
  schema: CorpusListInput,
  run: (input) =>
    Effect.gen(function* () {
      const corpus = yield* Corpus
      const documents = yield* corpus.list({
        limit: input.limit ?? 50,
        offset: input.offset,
        filter: filterOf(input),
      })
      return { documents, count: documents.length }
    }),
})

const corpusVersionsCommand = makeJsonCommand({
  name: "versions",
  commandName: "corpus versions",
  description: "List stored content versions of one corpus document",
  schema: CorpusRefInput,
  run: (input) =>
    Effect.gen(function* () {
      const doc = yield* requireDocument(input)
      const corpus = yield* Corpus
      const versions = yield* corpus.versions(doc.id)
      return { document: summarize(doc), versions }
    }),
})

const corpusDiffCommand = makeJsonCommand({
  name: "diff",
  commandName: "corpus diff",
  description: "Line diff between two stored versions of a document (default: previous → latest) — DIY change monitoring",
  schema: CorpusDiffInput,
  run: corpusDiff,
})

const corpusRemoveCommand = makeBatchJsonCommand({
  name: "remove",
  commandName: "corpus remove",
  description: "Remove documents (and their versions) from the corpus by id or url. Accepts one object or an array.",
  schema: CorpusRefInput,
  run: (item) =>
    Effect.gen(function* () {
      const doc = yield* requireDocument(item)
      const corpus = yield* Corpus
      const removed = yield* corpus.remove({ id: doc.id })
      return { id: doc.id, url: doc.url, removed }
    }),
})

const corpusPruneCommand = makeJsonCommand({
  name: "prune",
  commandName: "corpus prune",
  description: "Remove documents whose file:// source is gone and/or that are older than a cutoff. dry_run defaults to true.",
  schema: CorpusPruneInput,
  run: corpusPrune,
})

const corpusStatsCommand = makeJsonCommand({
  name: "stats",
  commandName: "corpus stats",
  description: "Corpus totals by kind, provider, and domain",
  schema: Schema.Struct({}),
  optionalInput: true,
  run: () =>
    Effect.gen(function* () {
      const corpus = yield* Corpus
      return yield* corpus.stats
    }),
})

export const corpusCommand = Command.make("corpus").pipe(
  Command.withDescription(
    "Local research corpus — every fetched page, file, and note, versioned and BM25-indexed for search/grep/read without re-fetching",
  ),
  Command.withSubcommands([
    corpusAddCommand,
    corpusSearchCommand,
    corpusReadCommand,
    corpusGrepCommand,
    corpusListCommand,
    corpusVersionsCommand,
    corpusDiffCommand,
    corpusRemoveCommand,
    corpusPruneCommand,
    corpusExportCommand,
    corpusImportCommand,
    corpusTagCommand,
    corpusLinksCommand,
    corpusStatsCommand,
  ]),
)

registerContracts([
  ...corpusToolContracts,
  {
    command: "corpus add",
    description: "Add/refresh documents in the local corpus (inline, local file, binary document via local convert, or fetched URL)",
    inputSchema: CorpusAddInput,
    batch: true,
    examples: [
      { name: "fetch and store", input: { url: "https://effect.website/docs" } },
      { name: "inline note", input: { url: "note://lit-review/1", content: "Key finding…", tags: ["review"] } },
      { name: "local file", input: { path: "./notes/paper.md", tags: ["papers"] } },
      {
        name: "a whole directory",
        description: "Converts binary documents, stores text files, skips files whose content hash already matches the corpus copy. dry_run previews; force re-converts.",
        input: { dir: "./papers", glob: "**/*.{pdf,md}", recursive: true, concurrency: 4 },
      },
      {
        name: "pdf/docx/pptx/xlsx/epub via local convert",
        description: "Binary documents are converted locally first (see `survey convert`); incomplete (needs OCR) conversions are rejected, not stored.",
        input: { path: "./papers/attention.pdf", tags: ["papers"] },
      },
    ],
  },
  {
    command: "corpus search",
    description: "BM25 full-text search over the local corpus",
    inputSchema: CorpusSearchInput,
    examples: [
      { name: "terms", input: { query: "effect layer composition", limit: 5 } },
      { name: "raw fts5", input: { query: "NEAR(schema decode, 5)", syntax: "fts" } },
      { name: "domain filter", input: { query: "pricing", domain: "firecrawl.dev" } },
    ],
  },
  {
    command: "corpus read",
    description: "Read a corpus document by char or line range",
    inputSchema: CorpusReadInput,
    examples: [
      { name: "line window", input: { id: 1, lines: "1-80" } },
      { name: "by url", input: { url: "https://effect.website/docs", offset: 0, length: 4000 } },
    ],
  },
  {
    command: "corpus grep",
    description: "Line-level grep with context across corpus documents",
    inputSchema: CorpusGrepInput,
    examples: [
      { name: "literal", input: { pattern: "rate limit", ignore_case: true, context: 1 } },
      { name: "regex in one domain", input: { pattern: "\\$\\d+(\\.\\d+)?/mo", regex: true, domain: "exa.ai" } },
    ],
  },
  {
    command: "corpus list",
    description: "List corpus documents (metadata only)",
    inputSchema: CorpusListInput,
    examples: [{ name: "recent", input: { limit: 20 } }, { name: "papers", input: { kind: "paper" } }],
  },
  {
    command: "corpus versions",
    description: "List stored versions of a document",
    inputSchema: CorpusRefInput,
    examples: [{ name: "by id", input: { id: 1 } }],
  },
  {
    command: "corpus diff",
    description: "Diff two versions of a document",
    inputSchema: CorpusDiffInput,
    examples: [
      { name: "latest change", input: { url: "https://example.com/pricing" } },
      { name: "explicit range", input: { id: 3, from: 1, to: 4, context: 3 } },
    ],
  },
  {
    command: "corpus remove",
    description: "Remove documents from the corpus",
    inputSchema: CorpusRefInput,
    batch: true,
    examples: [{ name: "by id", input: { id: 1 } }],
  },
  {
    command: "corpus prune",
    description:
      "Remove stale documents: file:// sources that no longer exist (missing_files, default on) and/or documents last updated before older_than (30d, 12h, 2w, or an ISO date), scoped by kind/tag/provider/domain. dry_run is true unless you pass false; max_remove caps one call. Returns per-document reasons and status.",
    inputSchema: CorpusPruneInput,
    examples: [
      { name: "preview documents whose source file vanished", input: {} },
      { name: "actually remove them", input: { dry_run: false } },
      { name: "old web pages", input: { older_than: "90d", kind: "web", missing_files: false } },
      { name: "old tagged reports, for real", input: { older_than: "2w", kind: "report", tag: "q3", dry_run: false } },
    ],
  },
  {
    command: "corpus stats",
    description: "Corpus totals",
    inputSchema: Schema.Struct({}),
    examples: [{ name: "stats", input: {} }],
  },
])
