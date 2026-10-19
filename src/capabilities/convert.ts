import { Effect, FileSystem, Schema } from "effect"
import { basename } from "node:path"

import type { AppEnv } from "../core/env"

import { makeOneOrManyCommand } from "../local/command"
import { registerContract } from "../core/discovery"
import { LocalToolError, LocalToolUnavailableError } from "../core/errors"
import { loadProviderConfig } from "../core/registry"
import {
  documentSourceFields,
  extensionHint,
  loadDocumentSource,
  summarizeSource,
  urlExtension,
  type LoadedDocument,
} from "../local/source"
import { anydocApi } from "../providers/anydoc"
import { llamaApi } from "../providers/llama"
import { pdfInspectorApi } from "../providers/pdf-inspector"

export const UnifiedConvertInput = Schema.Struct({
  ...documentSourceFields,
  format: Schema.optional(Schema.String),
  /**
   * auto: local first, hosted OCR only when a LlamaCloud key is set and the
   * PDF needs OCR. local: never leave the machine. llama: skip local tools.
   */
  route: Schema.optional(Schema.Literals(["auto", "local", "llama"])),
  llama_options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type UnifiedConvertInput = typeof UnifiedConvertInput.Type

interface TraceStep {
  readonly step: string
  readonly engine: string
  readonly outcome: string
}

interface Selected {
  readonly engine: "anydoc" | "pdf-inspector" | "llama"
  readonly kind: "local" | "hosted"
  readonly mode: string
  readonly version?: string | null
}

const isPdf = (doc: LoadedDocument, format: string | undefined) => {
  if (format !== undefined) return format.toLowerCase().replace(/^\./, "") === "pdf"
  const head = new TextDecoder("latin1").decode(doc.bytes.subarray(0, 1024))
  return head.includes("%PDF-")
}

const pagesMarkdown = (result: Record<string, unknown>) => {
  const full = result.markdown_full
  if (typeof full === "string") return full
  const markdown = result.markdown as { pages?: ReadonlyArray<{ markdown?: unknown }> } | undefined
  const pages = markdown?.pages
  if (!Array.isArray(pages)) return undefined
  return pages
    .map((page) => (typeof page?.markdown === "string" ? page.markdown : ""))
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const hostedAvailable = loadProviderConfig("llama").pipe(
  Effect.map((config) => config.credential !== undefined),
  Effect.orElseSucceed(() => false),
)

const llamaConvert = (doc: LoadedDocument, input: UnifiedConvertInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const ext = extensionHint(doc)
    const fileName =
      doc.path !== null ? basename(doc.path) : `document.${ext ?? "pdf"}`

    const upload = doc.path !== null
      ? { filePath: doc.path, cleanup: Effect.void }
      : yield* fs.makeTempFile({ suffix: `.${ext ?? "pdf"}` }).pipe(
          Effect.tap((tmp) => fs.writeFile(tmp, doc.bytes)),
          Effect.map((tmp) => ({ filePath: tmp, cleanup: fs.remove(tmp).pipe(Effect.ignore) })),
        )

    const options = (input.llama_options ?? {}) as Record<string, unknown>
    const tier = typeof options.tier === "string" ? options.tier : undefined

    return yield* Effect.gen(function* () {
      const job = (yield* llamaApi.parseRun({
        filePath: upload.filePath,
        fileName,
        configuration: options,
      } as never) as Effect.Effect<{ id: string }, unknown, AppEnv>) as { id: string }
      const finished = (yield* llamaApi.parseWait({
        jobId: job.id,
        expand: [...llamaApi.defaultParseExpand(tier)],
        ...(input.timeout_ms !== undefined
          ? { timeoutSeconds: Math.max(1, Math.round(input.timeout_ms / 1_000)) }
          : {}),
      } as never) as Effect.Effect<Record<string, unknown>, unknown, AppEnv>) as Record<string, unknown>
      return {
        job_id: job.id,
        markdown: pagesMarkdown(finished),
      }
    }).pipe(Effect.ensuring(upload.cleanup))
  })

const done = (parts: {
  readonly selected: Selected
  readonly reason: string
  readonly trace: ReadonlyArray<TraceStep>
  readonly doc: LoadedDocument
  readonly markdown?: string | undefined
  readonly format?: string | null | undefined
  readonly classification?: unknown
  readonly needs_ocr?: boolean
  readonly complete?: boolean
  readonly next_step?: string
  readonly extra?: Record<string, unknown>
}) => {
  const complete = parts.complete ?? parts.markdown !== undefined
  return {
  status: parts.needs_ocr && !complete ? ("needs_ocr" as const) : ("converted" as const),
  needs_ocr: parts.needs_ocr ?? false,
  complete,
  route: {
    selected: `${parts.selected.kind}:${parts.selected.engine}`,
    kind: parts.selected.kind,
    engine: parts.selected.engine,
    mode: parts.selected.mode,
    version: parts.selected.version ?? null,
    reason: parts.reason,
    trace: parts.trace,
  },
  source: summarizeSource(parts.doc),
  ...(parts.format !== undefined ? { format: parts.format } : {}),
  ...(parts.classification !== undefined ? { classification: parts.classification } : {}),
  ...(parts.markdown !== undefined ? { chars: parts.markdown.length, markdown: parts.markdown } : {}),
  ...(parts.next_step !== undefined ? { next_step: parts.next_step } : {}),
  ...parts.extra,
  }
}

const OCR_NEXT_STEP =
  "Set LLAMA_CLOUD_API_KEY (or `survey auth set`) to OCR hosted via LlamaCloud, or run `survey pdf-inspector ocr` with PDFium + ONNX Runtime installed for local OCR."

/** A PDF that needs OCR: hosted when allowed and keyed, otherwise report the classification. */
const needsOcr = (
  doc: LoadedDocument,
  input: UnifiedConvertInput,
  context: {
    readonly selected: Selected
    readonly reason: string
    readonly trace: ReadonlyArray<TraceStep>
    readonly classification?: unknown
    readonly pages_needing_ocr?: ReadonlyArray<number> | null
    readonly partial?: string
  },
) =>
  Effect.gen(function* () {
    const allowHosted = (input.route ?? "auto") !== "local"
    const keyed = allowHosted && (yield* hostedAvailable)

    if (!keyed) {
      const why = !allowHosted
        ? "route=local forbids hosted OCR"
        : "no LLAMA_CLOUD_API_KEY configured"
      const trace = [
        ...context.trace,
        { step: "ocr", engine: "llama", outcome: `skipped: ${why}` },
      ]
      return done({
        selected: context.selected,
        reason: `${context.reason}; ${why}`,
        trace,
        doc,
        markdown: context.partial,
        classification: context.classification,
        needs_ocr: true,
        complete: false,
        ...(allowHosted ? { next_step: OCR_NEXT_STEP } : {}),
        extra: { pages_needing_ocr: context.pages_needing_ocr ?? null },
      })
    }

    const hosted = yield* llamaConvert(doc, input)
    return done({
      selected: { engine: "llama", kind: "hosted", mode: "api" },
      reason: `${context.reason}; routed to LlamaCloud parse (LLAMA_CLOUD_API_KEY present)`,
      trace: [
        ...context.trace,
        { step: "ocr", engine: "llama", outcome: `parse job ${hosted.job_id}` },
      ],
      doc,
      markdown: hosted.markdown,
      classification: context.classification,
      needs_ocr: true,
      complete: hosted.markdown !== undefined,
      extra: { job_id: hosted.job_id, pages_needing_ocr: context.pages_needing_ocr ?? null },
    })
  })

const convertPdf = (doc: LoadedDocument, input: UnifiedConvertInput) =>
  Effect.gen(function* () {
    const trace: Array<TraceStep> = []
    const classified = yield* Effect.result(pdfInspectorApi.classifyDocument(doc))

    if (classified._tag === "Failure") {
      const error = classified.failure
      if (!(error instanceof LocalToolUnavailableError)) return yield* Effect.fail(error)

      // pdf-inspector is absent; anydoc embeds the same engine for text PDFs.
      trace.push({
        step: "classify",
        engine: "pdf-inspector",
        outcome: `unavailable: ${error.attempts.map((a) => a.detail).join("; ")}`,
      })
      const viaAnydoc = yield* Effect.result(anydocApi.convertDocument(doc, "pdf"))
      if (viaAnydoc._tag === "Success") {
        trace.push({ step: "convert", engine: "anydoc", outcome: "converted text PDF" })
        return done({
          selected: { engine: "anydoc", kind: "local", mode: viaAnydoc.success.tool.mode, version: viaAnydoc.success.tool.version },
          reason: "pdf-inspector unavailable; anydoc's built-in PDF engine converted it (text layer present)",
          trace,
          doc,
          markdown: viaAnydoc.success.markdown,
          format: "pdf",
        })
      }
      const failure = viaAnydoc.failure
      if (failure instanceof LocalToolError && failure.code === "needsOcr") {
        trace.push({
          step: "convert",
          engine: "anydoc",
          outcome: `needsOcr${failure.pages ? ` pages ${failure.pages.join(",")}` : ""}`,
        })
        return yield* needsOcr(doc, input, {
          selected: { engine: "anydoc", kind: "local", mode: failure.mode },
          reason: "anydoc reported scanned or image-only pages",
          trace,
          pages_needing_ocr: failure.pages ?? null,
        })
      }
      return yield* Effect.fail(error)
    }

    const classification = classified.success.value
    const via = classified.success
    trace.push({
      step: "classify",
      engine: "pdf-inspector",
      outcome: `${classification.pdfType} (confidence ${classification.confidence.toFixed(2)}, ${classification.pageCount} pages)`,
    })
    const selected: Selected = {
      engine: "pdf-inspector",
      kind: "local",
      mode: via.mode,
      version: via.version,
    }

    if (classification.pdfType !== "TextBased") {
      const partial =
        classification.pdfType === "Mixed"
          ? yield* pdfInspectorApi.extractDocument(doc).pipe(
              Effect.map((run) => run.value.markdown),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined
      const pagesNeedingOcr = classification.pagesNeedingOcr.map((page) => page + 1)
      return yield* needsOcr(doc, input, {
        selected,
        reason: `${classification.pdfType} PDF: page${pagesNeedingOcr.length === 1 ? "" : "s"} ${pagesNeedingOcr.join(",") || "all"} ${pagesNeedingOcr.length === 1 ? "has" : "have"} no usable text layer`,
        trace,
        classification,
        pages_needing_ocr: pagesNeedingOcr,
        ...(partial ? { partial } : {}),
      })
    }

    const extracted = yield* pdfInspectorApi.extractDocument(doc)
    const info = extracted.value
    if (info.hasEncodingIssues || info.pagesNeedingOcr.length > 0) {
      trace.push({
        step: "extract",
        engine: "pdf-inspector",
        outcome: info.hasEncodingIssues
          ? "text layer has broken font encodings"
          : `pages ${info.pagesNeedingOcr.join(",")} need OCR`,
      })
      return yield* needsOcr(doc, input, {
        selected,
        reason: info.hasEncodingIssues
          ? "text-based PDF but its fonts decode to garbage"
          : "text-based PDF with pages that need OCR",
        trace,
        classification,
        pages_needing_ocr: info.pagesNeedingOcr,
        ...(info.markdown ? { partial: info.markdown } : {}),
      })
    }

    trace.push({ step: "extract", engine: "pdf-inspector", outcome: "text extracted locally" })
    return done({
      selected,
      reason: "text-based PDF extracts locally (free, private, no network)",
      trace,
      doc,
      markdown: info.markdown ?? "",
      format: "pdf",
      classification,
      extra: {
        pdf: {
          pageCount: info.pageCount,
          isComplexLayout: info.isComplexLayout,
          pagesWithTables: info.pagesWithTables,
          pagesWithColumns: info.pagesWithColumns,
        },
      },
    })
  })

const convertOffice = (doc: LoadedDocument, input: UnifiedConvertInput) =>
  Effect.gen(function* () {
    const local = yield* Effect.result(anydocApi.convertDocument(doc, input.format))
    if (local._tag === "Success") {
      return done({
        selected: {
          engine: "anydoc",
          kind: "local",
          mode: local.success.tool.mode,
          version: local.success.tool.version,
        },
        reason: `non-PDF document${local.success.format ? ` (${local.success.format})` : ""} converts locally with anydoc`,
        trace: [{ step: "convert", engine: "anydoc", outcome: "converted" }],
        doc,
        markdown: local.success.markdown,
        format: local.success.format,
      })
    }

    const error = local.failure
    const canFallBack =
      error instanceof LocalToolUnavailableError &&
      (input.route ?? "auto") !== "local" &&
      (yield* hostedAvailable)
    if (!canFallBack) return yield* Effect.fail(error)

    const hosted = yield* llamaConvert(doc, input)
    return done({
      selected: { engine: "llama", kind: "hosted", mode: "api" },
      reason: "anydoc unavailable locally; routed to LlamaCloud parse (LLAMA_CLOUD_API_KEY present)",
      trace: [
        { step: "convert", engine: "anydoc", outcome: "unavailable" },
        { step: "convert", engine: "llama", outcome: `parse job ${hosted.job_id}` },
      ],
      doc,
      markdown: hosted.markdown,
      extra: { job_id: hosted.job_id },
    })
  })

export const unifiedConvert = Effect.fn("unifiedConvert")(function* (
  input: UnifiedConvertInput,
) {
  const doc = yield* loadDocumentSource(input)

  if (input.route === "llama") {
    const hosted = yield* llamaConvert(doc, input)
    return done({
      selected: { engine: "llama", kind: "hosted", mode: "api" },
      reason: "route=llama requested explicitly",
      trace: [{ step: "convert", engine: "llama", outcome: `parse job ${hosted.job_id}` }],
      doc,
      markdown: hosted.markdown,
      extra: { job_id: hosted.job_id },
    })
  }

  return yield* isPdf(doc, input.format) ? convertPdf(doc, input) : convertOffice(doc, input)
})

const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "docm", "odt", "rtf", "epub", "ppt", "pptx", "pptm", "pps", "ppsx",
  "xls", "xlsx", "xlsm", "xlsb", "ods", "odp", "csv",
])

/**
 * `extract` sends a request here only when it asks for plain document text:
 * a file, or a single URL that names a document, with no schema, prompt,
 * objective, entity or explicit provider.
 */
export const localConvertSource = (input: {
  readonly provider?: string | undefined
  readonly url?: string | undefined
  readonly urls?: ReadonlyArray<string> | undefined
  readonly file?: string | undefined
  readonly file_path?: string | undefined
  readonly schema?: unknown
  readonly prompt?: string | undefined
  readonly objective?: string | undefined
  readonly entity?: string | undefined
}): UnifiedConvertInput | undefined => {
  if (input.provider || input.schema || input.prompt || input.objective || input.entity) {
    return undefined
  }
  const file = input.file ?? input.file_path
  if (file && !input.url && !input.urls?.length) return { path: file }
  const single = input.url ?? (input.urls?.length === 1 ? input.urls[0] : undefined)
  if (!file && single && DOCUMENT_EXTENSIONS.has(urlExtension(single))) return { url: single }
  return undefined
}

export type UnifiedConvertResult = Effect.Success<ReturnType<typeof unifiedConvert>>

export const convertCommand = makeOneOrManyCommand({
  name: "convert",
  commandName: "convert",
  description:
    "Local-first document → Markdown: PDFs classify then extract locally (scanned → LlamaCloud OCR if keyed), office files via anydoc",
  schema: UnifiedConvertInput,
  run: (input) => unifiedConvert(input),
})

registerContract({
  command: "convert",
  description:
    "Local-first document to Markdown router. PDF → pdf-inspector classify: text-based extracts locally (free, private); scanned/image-only/mixed or garbled-font PDFs go to LlamaCloud parse when LLAMA_CLOUD_API_KEY is set, else return status needs_ocr with the classification. Non-PDF office files → anydoc. URLs are downloaded then converted locally. Every response names the route taken and why (route.selected, route.reason, route.trace). route=local forbids any hosted call.",
  inputSchema: UnifiedConvertInput,
  batch: true,
  output:
    "{ status: converted|needs_ocr, needs_ocr, complete, route: {selected, kind, engine, mode, reason, trace[]}, source, classification?, format?, markdown? , next_step? }",
  examples: [
    { name: "local file, any format", input: { path: "./paper.pdf" } },
    { name: "document url, keyless", input: { url: "https://example.com/report.docx" } },
    { name: "never leave the machine", input: { path: "./scan.pdf", route: "local" } },
    { name: "force hosted parse", input: { path: "./scan.pdf", route: "llama", llama_options: { tier: "cost_effective" } } },
    { name: "ordered batch", input: [{ path: "./a.pdf" }, { path: "./b.docx" }] },
  ],
})
