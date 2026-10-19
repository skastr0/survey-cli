import { Effect } from "effect"

import { toolEnvelope } from "../../local/result"
import { runCli } from "../../local/native"
import {
  loadDocumentSource,
  summarizeSource,
  type DocumentSourceInput,
  type LoadedDocument,
} from "../../local/source"
import { cliFailure, runLocalTool } from "../../local/tools"
import type {
  PdfInspectorClassifyInput,
  PdfInspectorExtractInput,
  PdfInspectorInspectInput,
  PdfInspectorOcrInput,
  PdfInspectorPagesInput,
  PdfInspectorPositionsInput,
  PdfInspectorRegionsInput,
  PdfInspectorTextInput,
} from "./schemas"

/** The subset of the `@firecrawl/pdf-inspector` node API survey uses (Buffer in, plain objects out). */
export interface PdfInspectorBinding {
  readonly classifyPdfAsync: (buffer: Buffer) => Promise<PdfClassification>
  readonly detectPdf: (buffer: Buffer) => PdfInfo
  readonly processPdfAsync: (buffer: Buffer, pages?: ReadonlyArray<number> | null) => Promise<PdfInfo>
  readonly extractPagesMarkdownAsync: (buffer: Buffer, pages?: ReadonlyArray<number> | null) => Promise<unknown>
  readonly extractText: (buffer: Buffer) => string
  readonly extractTextWithPositionsAndRotations: (
    buffer: Buffer,
    pages?: ReadonlyArray<number> | null,
    options?: FrameOptions | null,
  ) => unknown
  readonly extractTextInRegions: (buffer: Buffer, pageRegions: unknown, options?: FrameOptions | null) => unknown
  readonly extractTablesInRegions: (buffer: Buffer, pageRegions: unknown, options?: FrameOptions | null) => unknown
  readonly processPdfWithOcr: (buffer: Buffer, options?: unknown) => Promise<unknown>
}

export interface PdfClassification {
  readonly pdfType: "TextBased" | "Scanned" | "ImageBased" | "Mixed"
  readonly pageCount: number
  /** 0-indexed. */
  readonly pagesNeedingOcr: ReadonlyArray<number>
  readonly confidence: number
}

export interface PdfInfo {
  readonly pdfType: PdfClassification["pdfType"]
  readonly markdown?: string
  readonly pageCount: number
  /** 1-indexed. */
  readonly pagesNeedingOcr: ReadonlyArray<number>
  readonly confidence: number
  readonly isComplexLayout: boolean
  readonly hasEncodingIssues: boolean
  readonly pagesWithTables: ReadonlyArray<number>
  readonly pagesWithColumns: ReadonlyArray<number>
  readonly [key: string]: unknown
}

interface FrameOptions {
  readonly frame?: "sheet" | "display"
  readonly boldFromWeight?: boolean
  readonly boldWeightThreshold?: number
}

const TOOL = "pdf-inspector"

const frameOptions = (input: {
  readonly frame?: "sheet" | "display" | undefined
  readonly boldFromWeight?: boolean | undefined
  readonly boldWeightThreshold?: number | undefined
}): FrameOptions | null => {
  const options = {
    ...(input.frame !== undefined ? { frame: input.frame } : {}),
    ...(input.boldFromWeight !== undefined ? { boldFromWeight: input.boldFromWeight } : {}),
    ...(input.boldWeightThreshold !== undefined
      ? { boldWeightThreshold: input.boldWeightThreshold }
      : {}),
  }
  return Object.keys(options).length > 0 ? options : null
}

const pagesArg = (pages: ReadonlyArray<number> | undefined) =>
  pages !== undefined && pages.length > 0 ? [...pages] : null

const bufferOf = (doc: LoadedDocument) => Buffer.from(doc.bytes)

interface Backends<A> {
  readonly node: (binding: PdfInspectorBinding, buffer: Buffer) => Promise<A> | A
  readonly cli?: (cli: string, doc: LoadedDocument) => Promise<A>
}

/** Load the source, run one operation, wrap the result in the shared envelope. */
const operation = <A>(
  name: string,
  input: DocumentSourceInput,
  backends: Backends<A>,
) =>
  Effect.gen(function* () {
    const started = Date.now()
    const doc = yield* loadDocumentSource(input)
    const served = yield* runLocalTool(TOOL, name, {
      node_module: async (binding: PdfInspectorBinding) => backends.node(binding, bufferOf(doc)),
      ...(backends.cli ? { path_cli: (cli: string) => backends.cli!(cli, doc) } : {}),
    })
    return {
      ...toolEnvelope(TOOL, name, served, summarizeSource(doc), started),
      result: served.value,
    }
  })

const cliJson = async (cli: string, args: ReadonlyArray<string>, doc: LoadedDocument) => {
  const run = await runCli(cli, [...args, doc.path ?? "-"], doc.path ? {} : { stdin: doc.bytes })
  if (run.exitCode !== 0) {
    throw cliFailure(run.stderr.replace(/^error:\s*/, "").trim() || `pdf-inspector exited ${run.exitCode}`)
  }
  return JSON.parse(run.stdout.toString("utf8")) as unknown
}

export const classify = (input: PdfInspectorClassifyInput) =>
  operation("classify", input, {
    node: (binding, buffer) => binding.classifyPdfAsync(buffer),
    cli: (cli, doc) => cliJson(cli, ["detect", "--json"], doc),
  })

export const inspect = (input: PdfInspectorInspectInput) =>
  operation("inspect", input, { node: (binding, buffer) => binding.detectPdf(buffer) })

export const extract = (input: PdfInspectorExtractInput) =>
  operation("extract", input, {
    node: (binding, buffer) => binding.processPdfAsync(buffer, pagesArg(input.pages)),
    cli: (cli, doc) =>
      cliJson(
        cli,
        ["--json", ...(input.pages?.length ? ["--pages", input.pages.join(",")] : [])],
        doc,
      ),
  })

export const pages = (input: PdfInspectorPagesInput) =>
  operation("pages", input, {
    node: (binding, buffer) => binding.extractPagesMarkdownAsync(buffer, pagesArg(input.pages)),
  })

export const text = (input: PdfInspectorTextInput) =>
  operation("text", input, { node: (binding, buffer) => binding.extractText(buffer) })

export const positions = (input: PdfInspectorPositionsInput) =>
  operation("positions", input, {
    node: (binding, buffer) =>
      binding.extractTextWithPositionsAndRotations(
        buffer,
        pagesArg(input.pages),
        frameOptions(input),
      ),
  })

export const regions = (input: PdfInspectorRegionsInput) =>
  operation("regions", input, {
    node: (binding, buffer) =>
      binding.extractTextInRegions(buffer, input.pageRegions, frameOptions(input)),
  })

export const tables = (input: PdfInspectorRegionsInput) =>
  operation("tables", input, {
    node: (binding, buffer) =>
      binding.extractTablesInRegions(buffer, input.pageRegions, frameOptions(input)),
  })

export const ocr = (input: PdfInspectorOcrInput) =>
  operation("ocr", input, {
    node: (binding, buffer) =>
      binding.processPdfWithOcr(buffer, {
        mode: input.mode ?? "Auto",
        // Private by default: never download OCR models unless asked.
        offline: input.offline ?? true,
        ...(input.pageNumbers ? { pageNumbers: [...input.pageNumbers] } : {}),
        ...(input.password !== undefined ? { password: input.password } : {}),
        ...(input.dpi !== undefined ? { dpi: input.dpi } : {}),
        ...(input.minimumConfidence !== undefined ? { minimumConfidence: input.minimumConfidence } : {}),
        ...(input.hostedRecommendationConfidence !== undefined
          ? { hostedRecommendationConfidence: input.hostedRecommendationConfidence }
          : {}),
        ...(input.modelDirectory !== undefined ? { modelDirectory: input.modelDirectory } : {}),
      }),
  })

/** Classify + (when text-based) extract in one load; used by the unified router. */
export const classifyDocument = (doc: LoadedDocument) =>
  runLocalTool(TOOL, "classify", {
    node_module: async (binding: PdfInspectorBinding) => binding.classifyPdfAsync(bufferOf(doc)),
    path_cli: (cli) => cliJson(cli, ["detect", "--json"], doc) as Promise<PdfClassification>,
  })

export const extractDocument = (doc: LoadedDocument, pages?: ReadonlyArray<number>) =>
  runLocalTool(TOOL, "extract", {
    node_module: async (binding: PdfInspectorBinding) =>
      binding.processPdfAsync(bufferOf(doc), pagesArg(pages)),
    path_cli: (cli) =>
      cliJson(
        cli,
        ["--json", ...(pages?.length ? ["--pages", pages.join(",")] : [])],
        doc,
      ) as Promise<PdfInfo>,
  })
