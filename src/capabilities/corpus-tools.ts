import { Effect, FileSystem, Path, Schema } from "effect"

import { makeJsonCommand } from "../core/command"
import {
  Corpus,
  hashContent,
  type DocumentFilter,
  type DocumentRecord,
  type DocumentRef,
} from "../core/corpus"
import { CommandInputError } from "../core/errors"
import { toErrorDetails, setExitCode } from "../core/output"
import { artifactDir } from "../core/paths"
import { expandHome } from "../local/source"

const FilterFields = {
  provider: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
}

type FilterInput = {
  readonly provider?: string | undefined
  readonly kind?: string | undefined
  readonly domain?: string | undefined
  readonly tag?: string | undefined
  readonly since?: string | undefined
}

const filterOf = (input: FilterInput): DocumentFilter => ({
  provider: input.provider,
  kind: input.kind,
  domain: input.domain,
  tag: input.tag,
  since: input.since,
})

const hasFilter = (input: FilterInput) =>
  [input.provider, input.kind, input.domain, input.tag, input.since].some((value) => value !== undefined)

const fsFailure = (path: string, error: unknown) =>
  new CommandInputError({
    field: "path",
    message: `${path}: ${(error as { message?: string }).message ?? "file operation failed"}`,
  })

// ---------------------------------------------------------------------------
// export

export const EXPORT_SCHEMA = "survey.corpus.document/v1"

export const CorpusExportInput = Schema.Struct({
  /** jsonl: one record per line (re-importable). markdown: one .md file. bundle: a directory with index.md + one .md per document. */
  format: Schema.optional(Schema.Literals(["jsonl", "markdown", "bundle"])),
  ids: Schema.optional(Schema.Array(Schema.Int)),
  ...FilterFields,
  /** jsonl only: include every stored version's content so history round-trips. */
  include_versions: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int),
  /** File (jsonl, markdown) or directory (bundle). Defaults to the artifact directory. */
  path: Schema.optional(Schema.String),
})

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "document"

const yamlString = (value: string) => JSON.stringify(value)

export const frontMatter = (doc: DocumentRecord) =>
  [
    "---",
    `url: ${yamlString(doc.url)}`,
    `title: ${yamlString(doc.title ?? "")}`,
    `kind: ${yamlString(doc.kind)}`,
    `provider: ${yamlString(doc.provider ?? "")}`,
    `tags: [${doc.tags.map(yamlString).join(", ")}]`,
    `version: ${doc.version}`,
    `content_hash: ${yamlString(doc.content_hash)}`,
    `updated_at: ${yamlString(doc.updated_at)}`,
    "---",
  ].join("\n")

export const renderMarkdownDocument = (doc: DocumentRecord) => `${frontMatter(doc)}\n\n${doc.content.trimEnd()}\n`

export const renderIndex = (
  entries: ReadonlyArray<{ readonly doc: DocumentRecord; readonly file: string }>,
  generatedAt: string,
) =>
  [
    "# Corpus export",
    "",
    `Generated ${generatedAt} — ${entries.length} document${entries.length === 1 ? "" : "s"}.`,
    "",
    ...entries.map(({ doc, file }) => {
      const tags = doc.tags.length > 0 ? ` — tags: ${doc.tags.join(", ")}` : ""
      return `- [${doc.title ?? doc.url}](${file}) — ${doc.url} (${doc.kind}${doc.provider ? `, ${doc.provider}` : ""}, v${doc.version})${tags}`
    }),
    "",
  ].join("\n")

const exportRecord = (
  doc: DocumentRecord,
  versions: ReadonlyArray<{ version: number; content_hash: string; fetched_at: string; content: string }> | undefined,
) => ({
  schema: EXPORT_SCHEMA,
  url: doc.url,
  title: doc.title,
  provider: doc.provider,
  kind: doc.kind,
  tags: doc.tags,
  metadata: doc.metadata,
  content: doc.content,
  content_hash: doc.content_hash,
  version: doc.version,
  created_at: doc.created_at,
  updated_at: doc.updated_at,
  changed_at: doc.changed_at,
  ...(versions ? { versions } : {}),
})

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-")

export const corpusExport = (input: typeof CorpusExportInput.Type) =>
  Effect.gen(function* () {
    const format = input.format ?? "jsonl"
    const corpus = yield* Corpus
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const docs = yield* corpus.scan({
      ...(input.ids?.length ? { ids: input.ids } : {}),
      filter: filterOf(input),
      limit: input.limit ?? 100_000,
    })
    const ordered = [...docs].sort((a, b) => a.id - b.id)
    const filters = {
      ids: input.ids ?? null,
      kind: input.kind ?? null,
      tag: input.tag ?? null,
      provider: input.provider ?? null,
      domain: input.domain ?? null,
      since: input.since ?? null,
    }
    if (ordered.length === 0) {
      return { format, path: null, documents: 0, bytes: 0, filters, include_versions: false }
    }

    const generatedAt = new Date().toISOString()
    const target = input.path !== undefined ? path.resolve(expandHome(input.path)) : undefined
    const base = target === undefined ? yield* artifactDir : undefined

    if (format === "bundle") {
      const dir = target ?? path.join(base!, `corpus-bundle-${stamp()}`)
      const docsDir = path.join(dir, "docs")
      yield* fs.makeDirectory(docsDir, { recursive: true }).pipe(Effect.mapError((e) => fsFailure(docsDir, e)))
      const entries = ordered.map((doc) => ({
        doc,
        file: `docs/${String(doc.id).padStart(4, "0")}-${slug(doc.title ?? doc.url)}.md`,
      }))
      let bytes = 0
      for (const { doc, file } of entries) {
        const body = renderMarkdownDocument(doc)
        bytes += Buffer.byteLength(body)
        const full = path.join(dir, file)
        yield* fs.writeFileString(full, body).pipe(Effect.mapError((e) => fsFailure(full, e)))
      }
      const index = renderIndex(entries, generatedAt)
      const indexPath = path.join(dir, "index.md")
      yield* fs.writeFileString(indexPath, index).pipe(Effect.mapError((e) => fsFailure(indexPath, e)))
      return {
        format,
        path: dir,
        index: indexPath,
        documents: ordered.length,
        bytes: bytes + Buffer.byteLength(index),
        files: entries.map((e) => e.file),
        filters,
        include_versions: false,
      }
    }

    const includeVersions = format === "jsonl" && input.include_versions === true
    let contents: string
    if (format === "jsonl") {
      const lines: Array<string> = []
      for (const doc of ordered) {
        const versions = includeVersions
          ? yield* Effect.forEach(yield* corpus.versions(doc.id), (v) =>
              corpus.versionContent(doc.id, v.version).pipe(
                Effect.map((content) => ({ ...v, content: content ?? "" })),
              ),
            )
          : undefined
        lines.push(JSON.stringify(exportRecord(doc, versions)))
      }
      contents = `${lines.join("\n")}\n`
    } else {
      const entries = ordered.map((doc) => ({ doc, file: `#${String(doc.id)}` }))
      contents = [
        renderIndex(entries, generatedAt).replace(/\]\(#/g, "](#doc-"),
        ...ordered.map((doc) => `\n<a id="doc-${doc.id}"></a>\n\n${renderMarkdownDocument(doc)}`),
      ].join("\n")
    }

    const file = target ?? path.join(base!, `corpus-${stamp()}.${format === "jsonl" ? "jsonl" : "md"}`)
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.mapError((e) => fsFailure(file, e)))
    yield* fs.writeFileString(file, contents).pipe(Effect.mapError((e) => fsFailure(file, e)))
    return {
      format,
      path: file,
      documents: ordered.length,
      bytes: Buffer.byteLength(contents),
      filters,
      include_versions: includeVersions,
    }
  })

// ---------------------------------------------------------------------------
// import

const ImportedVersion = Schema.Struct({
  version: Schema.Int,
  content: Schema.String,
})

export const ImportedRecord = Schema.Struct({
  url: Schema.NonEmptyString,
  content: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  provider: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  versions: Schema.optional(Schema.Array(ImportedVersion)),
})

export const CorpusImportInput = Schema.Struct({
  /** A jsonl file written by `corpus export`. */
  path: Schema.optional(Schema.String),
  /** Or the jsonl text itself. */
  content: Schema.optional(Schema.String),
  /** Extra tags added to every imported document. */
  tags: Schema.optional(Schema.Array(Schema.String)),
  dry_run: Schema.optional(Schema.Boolean),
})

export const corpusImport = (input: typeof CorpusImportInput.Type) =>
  Effect.gen(function* () {
    if ((input.path === undefined) === (input.content === undefined)) {
      return yield* new CommandInputError({ field: "path", message: "Provide exactly one of path or content" })
    }
    const corpus = yield* Corpus
    const fs = yield* FileSystem.FileSystem
    const source = input.path !== undefined ? expandHome(input.path) : "inline"
    const text =
      input.content ??
      (yield* fs.readFileString(source).pipe(Effect.mapError((e) => fsFailure(source, e))))

    const lines = text.split("\n").map((line, index) => ({ line: line.trim(), number: index + 1 })).filter((l) => l.line.length > 0)
    const results = yield* Effect.forEach(lines, ({ line, number }) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: () => new CommandInputError({ field: `line ${number}`, message: "not valid JSON" }),
        })
        const record = yield* Schema.decodeUnknownEffect(ImportedRecord)(parsed).pipe(
          Effect.mapError((e) => new CommandInputError({ field: `line ${number}`, message: String(e.message ?? e) })),
        )
        const tags = [...(record.tags ?? []), ...(input.tags ?? [])]
        const base = {
          url: record.url,
          title: record.title ?? undefined,
          provider: record.provider ?? undefined,
          kind: record.kind ?? undefined,
          tags,
          metadata: record.metadata ?? undefined,
        }
        const existing = yield* corpus.get({ url: record.url })

        if (input.dry_run === true) {
          const status =
            existing === undefined ? "would_create" : existing.content_hash === hashContent(record.content) ? "unchanged" : "would_update"
          return { line: number, url: record.url, status }
        }

        // Replay history oldest-first, skipping versions the store already holds.
        const known = new Set<string>()
        if (existing !== undefined) {
          for (const v of yield* corpus.versions(existing.id)) known.add(v.content_hash)
        }
        let replayed = false
        const history = (record.versions ?? [])
          .filter((v) => v.content !== record.content)
          .sort((a, b) => a.version - b.version)
        for (const old of history) {
          if (known.has(hashContent(old.content)) || old.content.length === 0) continue
          yield* corpus.put({ ...base, content: old.content })
          known.add(hashContent(old.content))
          replayed = true
        }
        const put = yield* corpus.put({ ...base, content: record.content })
        const status =
          existing === undefined ? "created" : put.changed || replayed ? "updated" : "unchanged"
        return { line: number, url: record.url, status, id: put.id, version: put.version }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ line: number, url: "", status: "failed" as const, error: toErrorDetails(error) }),
        ),
      ),
    )

    const count = (...statuses: ReadonlyArray<string>) => results.filter((r) => statuses.includes(r.status)).length
    const failed = count("failed")
    if (failed > 0) yield* setExitCode(1)
    return {
      source,
      dry_run: input.dry_run === true,
      lines: lines.length,
      created: count("created", "would_create"),
      updated: count("updated", "would_update"),
      unchanged: count("unchanged"),
      failed,
      results,
    }
  })

// ---------------------------------------------------------------------------
// tag

export const CorpusTagInput = Schema.Struct({
  ids: Schema.optional(Schema.Array(Schema.Int)),
  urls: Schema.optional(Schema.Array(Schema.String)),
  /** Select by filter (combine with ids/urls for a union). */
  ...FilterFields,
  add: Schema.optional(Schema.Array(Schema.String)),
  remove: Schema.optional(Schema.Array(Schema.String)),
  /** Replace the whole tag set. Cannot be combined with add/remove. */
  set: Schema.optional(Schema.Array(Schema.String)),
  dry_run: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int),
})

const clean = (tags: ReadonlyArray<string> | undefined) =>
  [...new Set((tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0))]

export const corpusTag = (input: typeof CorpusTagInput.Type) =>
  Effect.gen(function* () {
    const add = clean(input.add)
    const remove = clean(input.remove)
    const set = input.set === undefined ? undefined : clean(input.set)
    if (set !== undefined && (add.length > 0 || remove.length > 0)) {
      return yield* new CommandInputError({ field: "set", message: "set replaces all tags; do not combine it with add/remove" })
    }
    if (set === undefined && add.length === 0 && remove.length === 0) {
      return yield* new CommandInputError({ field: "add", message: "Provide add, remove, or set" })
    }
    if (!input.ids?.length && !input.urls?.length && !hasFilter(input)) {
      return yield* new CommandInputError({ field: "ids", message: "Select documents with ids, urls, or a filter (kind/tag/provider/domain/since)" })
    }

    const corpus = yield* Corpus
    const targets = new Map<number, DocumentRecord>()
    if (input.ids?.length || hasFilter(input)) {
      const selected = yield* corpus.scan({
        ...(input.ids?.length && !hasFilter(input) ? { ids: input.ids } : {}),
        filter: filterOf(input),
        limit: input.limit ?? 1000,
      })
      // ids + filter is a union: ids are always included, the filter adds more.
      for (const doc of selected) targets.set(doc.id, doc)
      if (input.ids?.length && hasFilter(input)) {
        for (const doc of yield* corpus.scan({ ids: input.ids, filter: {}, limit: input.ids.length })) {
          targets.set(doc.id, doc)
        }
      }
    }
    const missing: Array<DocumentRef> = []
    for (const url of input.urls ?? []) {
      const doc = yield* corpus.get({ url })
      if (doc === undefined) missing.push({ url })
      else targets.set(doc.id, doc)
    }
    for (const id of input.ids ?? []) {
      if (!targets.has(id)) missing.push({ id })
    }

    const dryRun = input.dry_run === true
    const documents = yield* Effect.forEach([...targets.values()].sort((a, b) => a.id - b.id), (doc) =>
      Effect.gen(function* () {
        const before = [...doc.tags]
        const next =
          set !== undefined
            ? set
            : [...new Set([...before, ...add])].filter((tag) => !remove.includes(tag))
        const after = [...new Set(next)].sort()
        const changed = JSON.stringify([...before].sort()) !== JSON.stringify(after)
        if (changed && !dryRun) yield* corpus.setTags(doc.id, after)
        return { id: doc.id, url: doc.url, title: doc.title, before, after, changed }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ id: doc.id, url: doc.url, title: doc.title, before: [...doc.tags], after: [...doc.tags], changed: false, error: toErrorDetails(error) }),
        ),
      ),
    )
    const failed = documents.filter((d) => "error" in d).length
    if (failed > 0) yield* setExitCode(1)
    return {
      dry_run: dryRun,
      matched: documents.length,
      changed: documents.filter((d) => d.changed).length,
      failed,
      not_found: missing,
      documents,
    }
  })

// ---------------------------------------------------------------------------
// links

export const CorpusLinksInput = Schema.Struct({
  id: Schema.optional(Schema.Int),
  url: Schema.optional(Schema.NonEmptyString),
  version: Schema.optional(Schema.Int),
  /** internal: same host as the document; external: other hosts. */
  scope: Schema.optional(Schema.Literals(["all", "internal", "external"])),
  include_images: Schema.optional(Schema.Boolean),
  /** Drop links that are already in the corpus - what is left is what you have not read yet. */
  new_only: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int),
})

export type LinkKind = "link" | "image" | "reference" | "autolink" | "html" | "bare"

export interface ExtractedLink {
  readonly url: string
  readonly text: string
  readonly kind: LinkKind
  readonly occurrences: number
}

const KIND_RANK: Record<LinkKind, number> = { link: 0, html: 1, reference: 2, autolink: 3, image: 4, bare: 5 }

const stripCode = (markdown: string) =>
  markdown
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, "$1")
    .replace(/`[^`\n]+`/g, " ")

/** Resolve one raw target to a crawlable http(s) URL, or undefined. */
export const resolveLink = (raw: string, base: string | undefined) => {
  const target = raw.trim().replace(/^<|>$/g, "")
  if (target.length === 0 || target.startsWith("#")) return undefined
  try {
    const url = base !== undefined && /^https?:/i.test(base) ? new URL(target, base) : new URL(target)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    url.hash = ""
    return url.toString()
  } catch {
    return undefined
  }
}

/** Outbound http(s) links in markdown, deduped, in document order. */
export const extractLinks = (markdown: string, baseUrl?: string): Array<ExtractedLink> => {
  const text = stripCode(markdown)
  const found = new Map<string, { text: string; kind: LinkKind; position: number; occurrences: number }>()
  const add = (raw: string, label: string, kind: LinkKind, position: number) => {
    const url = resolveLink(raw, baseUrl)
    if (url === undefined) return
    const existing = found.get(url)
    if (existing === undefined) {
      found.set(url, { text: label.trim(), kind, position, occurrences: 1 })
      return
    }
    existing.occurrences += 1
    existing.position = Math.min(existing.position, position)
    if (KIND_RANK[kind] < KIND_RANK[existing.kind]) {
      existing.kind = kind
      if (label.trim().length > 0) existing.text = label.trim()
    }
  }

  const INLINE = /(!?)\[((?:[^\]\\]|\\.)*)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
  const REFERENCE = /^[ ]{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm
  const AUTOLINK = /<(https?:\/\/[^>\s]+)>/g
  const ANCHOR = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi

  for (const m of text.matchAll(INLINE)) add(m[3]!, m[2]!, m[1] === "!" ? "image" : "link", m.index)
  for (const m of text.matchAll(REFERENCE)) add(m[2]!, m[1]!, "reference", m.index)
  for (const m of text.matchAll(AUTOLINK)) add(m[1]!, "", "autolink", m.index)
  for (const m of text.matchAll(ANCHOR)) add(m[1]!, "", "html", m.index)

  // Bare URLs: blank out what was already consumed (same length, so positions hold).
  const blank = (match: string) => " ".repeat(match.length)
  const remainder = text
    .replace(INLINE, blank)
    .replace(AUTOLINK, blank)
    .replace(/<a\s[^>]*>/gi, blank)
    .replace(/^[ ]{0,3}\[[^\]]+\]:.*$/gm, blank)
  for (const m of remainder.matchAll(/https?:\/\/[^\s<>"'`\])]+/g)) {
    add(m[0].replace(/[.,;:!?]+$/, ""), "", "bare", m.index)
  }

  return [...found.entries()]
    .sort((a, b) => a[1].position - b[1].position)
    .map(([url, value]) => ({ url, text: value.text, kind: value.kind, occurrences: value.occurrences }))
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return ""
  }
}

export const corpusLinks = (input: typeof CorpusLinksInput.Type) =>
  Effect.gen(function* () {
    if (input.id === undefined && input.url === undefined) {
      return yield* new CommandInputError({ field: "id", message: "Provide id or url" })
    }
    const corpus = yield* Corpus
    const doc = yield* corpus.get({ id: input.id, url: input.url })
    if (doc === undefined) {
      return yield* new CommandInputError({
        field: input.id !== undefined ? "id" : "url",
        message: `No corpus document for ${input.id ?? input.url}`,
      })
    }
    let content = doc.content
    if (input.version !== undefined && input.version !== doc.version) {
      const old = yield* corpus.versionContent(doc.id, input.version)
      if (old === undefined) {
        return yield* new CommandInputError({ field: "version", message: `Document ${doc.id} has no version ${input.version}` })
      }
      content = old
    }

    const scope = input.scope ?? "all"
    const docHost = hostOf(doc.url)
    const all = extractLinks(content, doc.url).filter((link) => input.include_images === true || link.kind !== "image")
    const scoped = all.filter((link) => {
      const internal = docHost !== "" && hostOf(link.url) === docHost
      return scope === "all" || (scope === "internal" ? internal : !internal)
    })

    const limit = Math.max(1, input.limit ?? 500)
    const enriched = yield* Effect.forEach(scoped, (link) =>
      corpus.get({ url: link.url }).pipe(
        Effect.map((known) => ({
          ...link,
          internal: docHost !== "" && hostOf(link.url) === docHost,
          in_corpus: known !== undefined,
          ...(known ? { corpus_id: known.id } : {}),
        })),
      ),
    )
    const links = enriched.filter((link) => input.new_only !== true || !link.in_corpus).slice(0, limit)

    return {
      id: doc.id,
      url: doc.url,
      version: input.version ?? doc.version,
      count: links.length,
      total_found: all.length,
      known: enriched.filter((l) => l.in_corpus).length,
      truncated: enriched.filter((link) => input.new_only !== true || !link.in_corpus).length > links.length,
      /** Plain URL list for `pipe` foreach. */
      urls: links.map((link) => link.url),
      links,
    }
  })

// ---------------------------------------------------------------------------
// commands + contracts

export const corpusExportCommand = makeJsonCommand({
  name: "export",
  commandName: "corpus export",
  description: "Write corpus documents to a portable file or directory: jsonl (re-importable), markdown, or a bundle",
  schema: CorpusExportInput,
  run: corpusExport,
})

export const corpusImportCommand = makeJsonCommand({
  name: "import",
  commandName: "corpus import",
  description: "Import a jsonl file written by `corpus export`; idempotent by url + content hash",
  schema: CorpusImportInput,
  run: corpusImport,
})

export const corpusTagCommand = makeJsonCommand({
  name: "tag",
  commandName: "corpus tag",
  description: "Add, remove or set tags on documents selected by id, url or filter",
  schema: CorpusTagInput,
  run: corpusTag,
})

export const corpusLinksCommand = makeJsonCommand({
  name: "links",
  commandName: "corpus links",
  description: "Outbound http(s) links of a stored document, resolved and deduped, marked with what is already in the corpus",
  schema: CorpusLinksInput,
  run: corpusLinks,
})

export const corpusToolContracts = [
  {
    command: "corpus export",
    description:
      "Hand a corpus to another tool or seat. format jsonl writes one record per line (url, title, provider, kind, tags, metadata, content, hashes, timestamps; include_versions adds every stored version) and round-trips through `corpus import`; markdown writes one .md with an index and front-matter per document; bundle writes a directory with index.md and docs/<id>-<slug>.md. Filters: ids, kind, tag, provider, domain, since. Default location is the artifact directory; path overrides it. Returns the path.",
    inputSchema: CorpusExportInput,
    examples: [
      { name: "everything as jsonl", input: {} },
      { name: "tagged papers as a markdown bundle", input: { format: "bundle", tag: "relevant", kind: "document" } },
      { name: "history included, to a chosen file", input: { format: "jsonl", include_versions: true, path: "./handoff/corpus.jsonl" } },
      { name: "specific documents as one markdown file", input: { format: "markdown", ids: [3, 7, 9] } },
    ],
  },
  {
    command: "corpus import",
    description:
      "Import a jsonl file written by `corpus export` (path, or content inline). Idempotent: documents are keyed by url and compared by content hash, so re-importing reports unchanged. Versions in the file are replayed oldest-first, skipping ones the store already has. dry_run previews; tags adds tags to everything imported.",
    inputSchema: CorpusImportInput,
    examples: [
      { name: "import a handoff file", input: { path: "./handoff/corpus.jsonl" } },
      { name: "preview, tagging on the way in", input: { path: "./handoff/corpus.jsonl", tags: ["from-seat-b"], dry_run: true } },
    ],
  },
  {
    command: "corpus tag",
    description:
      "Curate documents: add and/or remove tags, or set the whole tag set, on documents selected by ids, urls and/or a filter (union). Tag edits never change content, version or timestamps. dry_run previews; each document reports before/after.",
    inputSchema: CorpusTagInput,
    examples: [
      { name: "mark documents relevant", input: { ids: [1, 4], add: ["relevant"] } },
      { name: "retag by filter", input: { kind: "web", domain: "example.com", add: ["watch"], remove: ["inbox"] } },
      { name: "by url, replacing all tags", input: { urls: ["https://example.com/post"], set: ["archived"] }},
      { name: "preview", input: { tag: "inbox", add: ["triaged"], dry_run: true } },
    ],
  },
  {
    command: "corpus links",
    description:
      "Outbound http(s) links in a stored document's markdown (inline, reference, autolink, <a href>, bare URLs; code blocks ignored; relative links resolved against the document url; fragments stripped), deduped with occurrence counts. Each link says whether it is internal (same host) and already in the corpus; new_only keeps only unread links. `urls` is a plain list ready for `pipe` foreach.",
    inputSchema: CorpusLinksInput,
    examples: [
      { name: "all links of a document", input: { id: 3 } },
      { name: "unread external links to crawl next", input: { id: 3, scope: "external", new_only: true, limit: 20 } },
      { name: "by url, including images", input: { url: "https://example.com/docs", include_images: true } },
    ],
  },
] as const

