import { Effect } from "effect"

import { toolEnvelope } from "../../local/result"
import {
  extensionHint,
  loadDocumentSource,
  summarizeSource,
  type LoadedDocument,
} from "../../local/source"
import { cliFailure, runLocalTool } from "../../local/tools"
import { runCli } from "../../local/native"
import type {
  AnydocConvertInput,
  AnydocDetectInput,
  AnydocDocumentInput,
} from "./schemas"

/** The subset of the `@firecrawl/anydoc` node API survey uses. */
export interface AnydocBinding {
  readonly toMarkdownBytes: (bytes: Uint8Array, format?: string | null) => Promise<string>
  readonly toDocument: (bytes: Uint8Array, format?: string | null) => Promise<unknown>
  readonly formatFromBytes: (bytes: Uint8Array) => string | null
  readonly formatFromExtension: (extension: string) => string | null
}

const TOOL = "anydoc"

const NEEDS_OCR_EXIT = 3

/** Explicit format wins; otherwise content detection, then the extension (CSV has no signature). */
const chooseFormat = (
  binding: AnydocBinding,
  doc: LoadedDocument,
  explicit: string | undefined,
) => {
  if (explicit !== undefined) {
    const resolved = binding.formatFromExtension(explicit)
    if (resolved === null) {
      throw Object.assign(new Error(`Unknown format "${explicit}"`), { code: "unsupported" })
    }
    return { format: resolved, sent: resolved as string | null }
  }
  const detected = binding.formatFromBytes(doc.bytes)
  if (detected !== null) return { format: detected, sent: null }
  const ext = extensionHint(doc)
  const fromExt = ext === undefined ? null : binding.formatFromExtension(ext)
  return { format: fromExt, sent: fromExt }
}

const cliConvert = async (cli: string, doc: LoadedDocument, explicit: string | undefined) => {
  const ext = extensionHint(doc)
  const format = explicit ?? (ext === "csv" ? "csv" : undefined)
  const args = [doc.path ?? "-", ...(format ? ["--format", format] : [])]
  const run = await runCli(cli, args, doc.path ? {} : { stdin: doc.bytes })
  if (run.exitCode !== 0) {
    throw cliFailure(
      run.stderr.trim() || `anydoc exited ${run.exitCode}`,
      run.exitCode === NEEDS_OCR_EXIT ? "needsOcr" : undefined,
    )
  }
  return { markdown: run.stdout.toString("utf8"), format: format ?? null }
}

/** Convert already-loaded bytes; shared with the unified `convert` router. */
export const convertDocument = (
  doc: LoadedDocument,
  explicitFormat: string | undefined,
  started: number = Date.now(),
) =>
  Effect.gen(function* () {
    const served = yield* runLocalTool(TOOL, "convert", {
      node_module: async (binding: AnydocBinding) => {
        const { format, sent } = chooseFormat(binding, doc, explicitFormat)
        return {
          markdown: await binding.toMarkdownBytes(doc.bytes, sent),
          format,
        }
      },
      path_cli: (cli) => cliConvert(cli, doc, explicitFormat),
    })
    return {
      ...toolEnvelope(TOOL, "convert", served, summarizeSource(doc), started),
      format: served.value.format,
      chars: served.value.markdown.length,
      markdown: served.value.markdown,
    }
  })

export const convert = (input: AnydocConvertInput) => {
  const started = Date.now()
  return loadDocumentSource(input).pipe(
    Effect.flatMap((doc) => convertDocument(doc, input.format, started)),
  )
}

export const detect = (input: AnydocDetectInput) =>
  Effect.gen(function* () {
    const started = Date.now()
    const doc = yield* loadDocumentSource(input)
    const served = yield* runLocalTool(TOOL, "detect", {
      node_module: async (binding: AnydocBinding) => {
        const ext = extensionHint(doc)
        return {
          from_content: binding.formatFromBytes(doc.bytes),
          from_extension: ext === undefined ? null : binding.formatFromExtension(ext),
        }
      },
    })
    return {
      ...toolEnvelope(TOOL, "detect", served, summarizeSource(doc), started),
      format: served.value.from_content ?? served.value.from_extension,
      ...served.value,
    }
  })

interface RawAsset {
  readonly id: number
  readonly mediaType: string
  readonly originPart: string
  readonly data: Uint8Array
}

export const document = (input: AnydocDocumentInput) =>
  Effect.gen(function* () {
    const started = Date.now()
    const doc = yield* loadDocumentSource(input)
    const served = yield* runLocalTool(TOOL, "document", {
      node_module: async (binding: AnydocBinding) => {
        const { format, sent } = chooseFormat(binding, doc, input.format)
        const model = (await binding.toDocument(doc.bytes, sent)) as {
          blocks: unknown
          notes: unknown
          assets: ReadonlyArray<RawAsset>
        }
        return {
          format,
          document: {
            blocks: model.blocks,
            notes: model.notes,
            assets: model.assets.map((asset) => ({
              id: asset.id,
              mediaType: asset.mediaType,
              originPart: asset.originPart,
              bytes: asset.data.byteLength,
              ...(input.include_assets
                ? { data_base64: Buffer.from(asset.data).toString("base64") }
                : {}),
            })),
          },
        }
      },
    })
    return {
      ...toolEnvelope(TOOL, "document", served, summarizeSource(doc), started),
      format: served.value.format,
      document: served.value.document,
    }
  })
