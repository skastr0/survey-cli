import { Effect, FileSystem, Path } from "effect"

import { artifactDir } from "./paths"
import { ArtifactWriteError } from "./errors"
import { ARTIFACT_INLINE_THRESHOLD_BYTES } from "./constants"

export type OutputPolicy = "inline" | "artifact" | "auto"

export interface ArtifactRecord {
  readonly kind: string
  readonly key: string
  readonly absolute_path: string
  readonly size_bytes: number
}

export interface SummaryArtifact {
  readonly kind: "summary+artifact"
  readonly summary: string
  readonly artifact: ArtifactRecord
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "artifact"

export const writeArtifact = (options: {
  readonly key: string
  readonly kind: string
  readonly contents: string | Uint8Array
}) =>
  Effect.gen(function* () {
    const dir = yield* artifactDir
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem

    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(options.key)}`
    const extension = options.kind === "json" ? ".json" : options.kind === "markdown" ? ".md" : options.kind === "binary" ? ".bin" : ".txt"
    const absolutePath = path.join(dir, `${filename}${extension}`)

    yield* (typeof options.contents === "string"
      ? fs.writeFileString(absolutePath, options.contents)
      : fs.writeFile(absolutePath, options.contents)).pipe(
      Effect.mapError(
        (error) =>
          new ArtifactWriteError({
            path: absolutePath,
            message: (error as { message?: string }).message ?? "write failed",
          }),
      ),
    )

    const size = typeof options.contents === "string"
      ? new TextEncoder().encode(options.contents).length
      : options.contents.length

    return {
      kind: options.kind,
      key: options.key,
      absolute_path: absolutePath,
      size_bytes: size,
    } satisfies ArtifactRecord
  })

export const emitOutput = (options: {
  readonly policy: OutputPolicy
  readonly key: string
  readonly kind: string
  readonly contents: string
  readonly summary: string
  readonly inlineData?: unknown
}) =>
  Effect.gen(function* () {
    const size = new TextEncoder().encode(options.contents).length

    const useArtifact =
      options.policy === "artifact" ||
      (options.policy === "auto" && size > ARTIFACT_INLINE_THRESHOLD_BYTES)

    if (!useArtifact) {
      return options.inlineData !== undefined
        ? { kind: "inline" as const, data: options.inlineData }
        : { kind: "inline" as const, contents: options.contents }
    }

    const artifact = yield* writeArtifact({
      key: options.key,
      kind: options.kind,
      contents: options.contents,
    })

    return {
      kind: "summary+artifact" as const,
      summary: options.summary,
      artifact,
    } satisfies SummaryArtifact
  })
