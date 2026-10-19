import { Effect, FileSystem, Schema } from "effect"
import { createHash } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"

import { Corpus } from "../core/corpus"
import { CommandInputError } from "../core/errors"
import { setExitCode, toErrorDetails } from "../core/output"
import { expandHome } from "../local/source"

/** Input fields shared by every directory-ingest command. */
export const directoryFields = {
  dir: Schema.optional(Schema.NonEmptyString),
  /** `*`, `**`, `?`, `{a,b}`; without a `/` it matches the file name at any depth. */
  glob: Schema.optional(Schema.String),
  recursive: Schema.optional(Schema.Boolean),
  concurrency: Schema.optional(Schema.Int),
  max_files: Schema.optional(Schema.Int),
  /** List what would be processed or skipped without converting or storing. */
  dry_run: Schema.optional(Schema.Boolean),
  /** Re-convert files whose content hash matches the stored copy. */
  force: Schema.optional(Schema.Boolean),
} as const

export interface DirectoryInput {
  readonly dir?: string | undefined
  readonly glob?: string | undefined
  readonly recursive?: boolean | undefined
  readonly concurrency?: number | undefined
  readonly max_files?: number | undefined
  readonly dry_run?: boolean | undefined
  readonly force?: boolean | undefined
}

export const DEFAULT_MAX_FILES = 1000
export const DEFAULT_INGEST_CONCURRENCY = 4

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".hg", ".svn"])

/** Compile a small glob dialect to a RegExp over POSIX-style relative paths. */
export const globToRegExp = (glob: string) => {
  let source = ""
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/"
        source += slash ? "(?:.*/)?" : ".*"
        i += slash ? 2 : 1
      } else {
        source += "[^/]*"
      }
    } else if (char === "?") {
      source += "[^/]"
    } else if (char === "{") {
      const end = glob.indexOf("}", i)
      if (end === -1) {
        source += "\\{"
      } else {
        source += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`
        i = end
      }
    } else {
      source += char.replace(/[.+^$()|[\]\\}]/g, "\\$&")
    }
  }
  return new RegExp(`^${source}$`, "i")
}

const walk = async (root: string, recursive: boolean): Promise<Array<string>> => {
  const files: Array<string> = []
  const visit = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && !entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name)) {
          await visit(full)
        }
      } else if (entry.isFile() && !entry.name.startsWith(".")) {
        files.push(full)
      }
    }
  }
  await visit(root)
  return files
}

export interface IngestFile {
  readonly path: string
  readonly relative: string
  readonly sha256: string
  readonly bytes: number
}

export type IngestStatus =
  | "stored"
  | "updated"
  | "unchanged"
  | "skipped_unchanged"
  | "converted"
  | "needs_ocr"
  | "failed"
  | "would_process"
  | "would_skip_unchanged"

export interface IngestOutcome {
  readonly status: Exclude<IngestStatus, "skipped_unchanged" | "failed" | "would_process" | "would_skip_unchanged">
  readonly corpus?: { readonly id: number; readonly version: number; readonly changed?: boolean; readonly created?: boolean }
  readonly route?: string
  readonly detail?: string
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Corpus key used by every ingest path for a local file. */
export const fileUrl = (path: string) => `file://${resolve(path)}`

/**
 * Walk a directory, skip files whose content hash matches the corpus copy
 * (no conversion at all), and run `process` on the rest with bounded
 * concurrency. Failures are per file; the call fails only on a bad directory.
 */
export const ingestDirectory = <E, R>(options: {
  readonly input: DirectoryInput
  readonly defaultGlob: string
  readonly process: (file: IngestFile) => Effect.Effect<IngestOutcome, E, R>
  /** False when the caller will not store results, so unchanged-skipping is impossible. */
  readonly storing: boolean
}) =>
  Effect.gen(function* () {
    const input = options.input
    const dir = resolve(expandHome(input.dir!))
    const stats = yield* Effect.promise(() => stat(dir).catch(() => undefined))
    if (stats === undefined || !stats.isDirectory()) {
      return yield* new CommandInputError({ field: "dir", message: `${dir} is not a directory` })
    }
    const concurrency = input.concurrency ?? DEFAULT_INGEST_CONCURRENCY
    const maxFiles = input.max_files ?? DEFAULT_MAX_FILES
    if (concurrency <= 0 || maxFiles <= 0) {
      return yield* new CommandInputError({
        field: concurrency <= 0 ? "concurrency" : "max_files",
        message: "concurrency and max_files must be positive integers",
      })
    }

    const glob = input.glob ?? options.defaultGlob
    const matcher = globToRegExp(glob)
    const matchesName = !glob.includes("/")
    const all = yield* Effect.promise(() => walk(dir, input.recursive ?? true))
    const matched = all
      .map((path) => ({ path, relative: relative(dir, path).split(sep).join("/") }))
      .filter((file) => matcher.test(matchesName ? basename(file.path) : file.relative))
    const selected = matched.slice(0, maxFiles)

    const fs = yield* FileSystem.FileSystem
    const corpus = yield* Effect.serviceOption(Corpus)

    const results = yield* Effect.forEach(
      selected,
      (file) =>
        Effect.gen(function* () {
          const bytes = yield* fs.readFile(file.path)
          const entry: IngestFile = { ...file, sha256: sha256Hex(bytes), bytes: bytes.byteLength }

          if (options.storing && !input.force && corpus._tag === "Some") {
            const existing = yield* corpus.value
              .get({ url: fileUrl(file.path) })
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (existing !== undefined && existing.metadata?.source_sha256 === entry.sha256) {
              return {
                path: file.path,
                relative: file.relative,
                status: (input.dry_run ? "would_skip_unchanged" : "skipped_unchanged") as IngestStatus,
                corpus: { id: existing.id, version: existing.version },
              }
            }
          }
          if (input.dry_run) {
            return { path: file.path, relative: file.relative, status: "would_process" as IngestStatus }
          }

          const outcome = yield* options.process(entry)
          return { path: file.path, relative: file.relative, ...outcome }
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              path: file.path,
              relative: file.relative,
              status: "failed" as IngestStatus,
              error: toErrorDetails(error),
            }),
          ),
        ),
      { concurrency },
    )

    const count = (...statuses: ReadonlyArray<IngestStatus>) =>
      results.filter((r) => statuses.includes(r.status)).length
    const failed = count("failed")
    if (failed > 0) yield* setExitCode(1)

    return {
      dir,
      glob,
      recursive: input.recursive ?? true,
      dry_run: input.dry_run ?? false,
      matched: matched.length,
      processed: selected.length,
      truncated: matched.length > selected.length,
      stored: count("stored"),
      updated: count("updated"),
      unchanged: count("unchanged"),
      skipped_unchanged: count("skipped_unchanged", "would_skip_unchanged"),
      converted: count("converted"),
      needs_ocr: count("needs_ocr"),
      failed,
      results,
    }
  })
