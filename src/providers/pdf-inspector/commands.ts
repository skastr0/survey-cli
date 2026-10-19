import { makeOneOrManyCommand } from "../../local/command"
import {
  classify,
  extract,
  inspect,
  ocr,
  pages,
  positions,
  regions,
  tables,
  text,
} from "./api"
import {
  PdfInspectorClassifyInputSchema,
  PdfInspectorExtractInputSchema,
  PdfInspectorInspectInputSchema,
  PdfInspectorOcrInputSchema,
  PdfInspectorPagesInputSchema,
  PdfInspectorPositionsInputSchema,
  PdfInspectorRegionsInputSchema,
  PdfInspectorTextInputSchema,
} from "./schemas"

export const classifyCommand = makeOneOrManyCommand({
  name: "classify",
  commandName: "pdf-inspector classify",
  description: "Classify a PDF as TextBased, Scanned, ImageBased or Mixed with per-page OCR routing. Input: {path | url | base64}. Returns {tool, source, elapsed_ms, result: {pdfType, pageCount, pagesNeedingOcr, confidence}}.",
  schema: PdfInspectorClassifyInputSchema,
  run: classify,
})

export const inspectCommand = makeOneOrManyCommand({
  name: "inspect",
  commandName: "pdf-inspector inspect",
  description: "PDF metadata and layout flags (page count, title/author, tables, columns, encoding issues) without extraction. Input: {path | url | base64}. Returns {tool, source, elapsed_ms, result}.",
  schema: PdfInspectorInspectInputSchema,
  run: inspect,
})

export const extractCommand = makeOneOrManyCommand({
  name: "extract",
  commandName: "pdf-inspector extract",
  description: "Extract a PDF to Markdown with classification and metadata. Input: {path | url | base64, pages?} (1-indexed). Returns {tool, source, elapsed_ms, result: {markdown, pdfType, pageCount, ...}}.",
  schema: PdfInspectorExtractInputSchema,
  run: extract,
})

export const pagesCommand = makeOneOrManyCommand({
  name: "pages",
  commandName: "pdf-inspector pages",
  description: "Per-page Markdown with a per-page needsOcr flag and reason. Input: {path | url | base64, pages?}. Returns {tool, source, elapsed_ms, result}.",
  schema: PdfInspectorPagesInputSchema,
  run: pages,
})

export const textCommand = makeOneOrManyCommand({
  name: "text",
  commandName: "pdf-inspector text",
  description: "Plain text of a PDF in reading order. Input: {path | url | base64}. Returns {tool, source, elapsed_ms, result: string}.",
  schema: PdfInspectorTextInputSchema,
  run: text,
})

export const positionsCommand = makeOneOrManyCommand({
  name: "positions",
  commandName: "pdf-inspector positions",
  description: "Every text item with font, coordinates, colour and page rotation. Input: {path | url | base64, pages?, frame?}. Returns {tool, source, elapsed_ms, result}.",
  schema: PdfInspectorPositionsInputSchema,
  run: positions,
})

export const regionsCommand = makeOneOrManyCommand({
  name: "regions",
  commandName: "pdf-inspector regions",
  description: "Text inside bounding-box regions with per-region needsOcr quality checks. Input: {path | url | base64, pageRegions[{page, regions}]}. Returns {tool, source, elapsed_ms, result}.",
  schema: PdfInspectorRegionsInputSchema,
  run: regions,
})

export const tablesCommand = makeOneOrManyCommand({
  name: "tables",
  commandName: "pdf-inspector tables",
  description: "Tables inside bounding-box regions as Markdown with per-region needsOcr checks. Input: {path | url | base64, pageRegions[{page, regions}]}. Returns {tool, source, elapsed_ms, result}.",
  schema: PdfInspectorRegionsInputSchema,
  run: tables,
})

export const ocrCommand = makeOneOrManyCommand({
  name: "ocr",
  commandName: "pdf-inspector ocr",
  description: "Native extraction with selective local OCR (needs PDFium + ONNX Runtime; offline by default). Input: {path | url | base64, mode?}. Returns {tool, source, elapsed_ms, result}.",
  schema: PdfInspectorOcrInputSchema,
  run: ocr,
})
