import { registerContracts } from "../../core/discovery"
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

const orbit = [
  "classify",
  "inspect",
  "extract",
  "pages",
  "text",
  "positions",
  "regions",
  "tables",
  "ocr",
] as const

const note = "Input: one of path | url | base64. Runs locally (no network, no key)."

/** Shared success shape: the library's own camelCase result sits under `result`. */
const envelope = (result: string) =>
  `{ tool: { name, mode, version }, operation, source: { kind, path?, url?, filename?, content_type?, bytes }, elapsed_ms, result: ${result} }; array input returns a batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }`

registerContracts([
  {
    command: "pdf-inspector classify",
    description: `Classify a PDF as TextBased | Scanned | ImageBased | Mixed in ~10-50ms, with confidence, pageCount and 0-indexed pagesNeedingOcr. node_module or path_cli. ${note}`,
    inputSchema: PdfInspectorClassifyInputSchema,
    batch: true,
    orbit,
    output: envelope("{ pdfType, pageCount, pagesNeedingOcr (0-indexed), confidence }"),
    examples: [
      { name: "classify a local pdf", input: { path: "./paper.pdf" } },
      { name: "classify a pdf url", input: { url: "https://example.com/report.pdf" } },
      { name: "ordered local batch", input: [{ path: "./a.pdf" }, { path: "./b.pdf" }] },
    ],
  },
  {
    command: "pdf-inspector inspect",
    description: `Detect classification, metadata and layout flags (isComplexLayout, pagesWithTables, pagesWithColumns) without extracting markdown. Node module only. ${note}`,
    inputSchema: PdfInspectorInspectInputSchema,
    batch: true,
    orbit,
    output: envelope(
      "{ pdfType, pageCount, pagesNeedingOcr, confidence, isComplexLayout, hasEncodingIssues, pagesWithTables, pagesWithColumns, ...library metadata fields }",
    ),
    examples: [{ name: "inspect a pdf", input: { path: "./paper.pdf" } }],
  },
  {
    command: "pdf-inspector extract",
    description: `Extract a PDF to Markdown with classification and layout flags. Input adds pages? (1-indexed subset). node_module or path_cli. ${note}`,
    inputSchema: PdfInspectorExtractInputSchema,
    batch: true,
    orbit,
    output: envelope(
      "{ pdfType, markdown, pageCount, pagesNeedingOcr, confidence, isComplexLayout, hasEncodingIssues, pagesWithTables, pagesWithColumns, ...library metadata fields }",
    ),
    examples: [
      { name: "extract a pdf", input: { path: "./paper.pdf" } },
      { name: "selected pages", input: { path: "./paper.pdf", pages: [1, 3, 5] } },
    ],
  },
  {
    command: "pdf-inspector pages",
    description: `Per-page Markdown (0-indexed page) with needsOcr and ocrReason, plus pagesWithTables/pagesWithColumns/pagesNeedingOcr (1-indexed). Node module only. ${note}`,
    inputSchema: PdfInspectorPagesInputSchema,
    batch: true,
    orbit,
    output: envelope("the library's per-page object (pages with page, markdown, needsOcr, ocrReason; page-number lists)"),
    examples: [{ name: "per-page markdown", input: { path: "./paper.pdf", pages: [1, 2] } }],
  },
  {
    command: "pdf-inspector text",
    description: `Plain text of a PDF in reading order; result is one string. Node module only. ${note}`,
    inputSchema: PdfInspectorTextInputSchema,
    batch: true,
    orbit,
    output: envelope("string"),
    examples: [{ name: "plain text", input: { path: "./paper.pdf" } }],
  },
  {
    command: "pdf-inspector positions",
    description: `Every text item with font, size, bold/italic, x/y/width/height (PDF points), colours, plus pageRotations. Input adds pages?, frame? sheet|display. Node module only. ${note}`,
    inputSchema: PdfInspectorPositionsInputSchema,
    batch: true,
    orbit,
    output: envelope("the library's positioned-text object (text items with font and x/y/width/height, pageRotations)"),
    examples: [
      { name: "positioned text, page 1", input: { path: "./paper.pdf", pages: [1] } },
      {
        name: "rendered-page frame with weight-based bold",
        input: { path: "./paper.pdf", frame: "display", boldFromWeight: true },
      },
    ],
  },
  {
    command: "pdf-inspector regions",
    description: `Text inside regions for hybrid OCR. Input adds pageRegions[{page (0-indexed), regions[[x1,y1,x2,y2]] (PDF points, top-left)}]; per-region needsOcr, ocrReason. Node module only. ${note}`,
    inputSchema: PdfInspectorRegionsInputSchema,
    batch: true,
    orbit,
    output: envelope("the library's per-region results (text, needsOcr, ocrReason)"),
    examples: [
      {
        name: "two columns on page 0",
        input: {
          path: "./paper.pdf",
          pageRegions: [{ page: 0, regions: [[0, 0, 300, 400], [300, 0, 612, 400]] }],
        },
      },
    ],
  },
  {
    command: "pdf-inspector tables",
    description: `Tables inside regions as Markdown. Input adds pageRegions, same contract as pdf-inspector regions; per-region needsOcr checks. Node module only. ${note}`,
    inputSchema: PdfInspectorRegionsInputSchema,
    batch: true,
    orbit,
    output: envelope("the library's per-region table results (Markdown tables, needsOcr)"),
    examples: [
      {
        name: "table region",
        input: {
          path: "./report.pdf",
          pageRegions: [{ page: 2, regions: [[50, 120, 560, 420]] }],
        },
      },
    ],
  },
  {
    command: "pdf-inspector ocr",
    description: `Native extraction, then local PP-OCR on pages failing quality checks. Input adds mode? Off|Auto|Force, offline? (default true: no download). Needs PDFium + ONNX Runtime. ${note}`,
    inputSchema: PdfInspectorOcrInputSchema,
    batch: true,
    orbit,
    output: envelope("the library's OCR result object, passed through unnormalized"),
    examples: [
      { name: "selective ocr, offline", input: { path: "./scan.pdf", modelDirectory: "~/.cache/ocr-models" } },
      { name: "native only, same result shape", input: { path: "./paper.pdf", mode: "Off" } },
    ],
  },
])
