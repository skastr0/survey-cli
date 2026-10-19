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

const note =
  "Source is exactly one of path | url | base64. Runs locally via @firecrawl/pdf-inspector (no network, no key); results use the library's own camelCase field names under `result`."

registerContracts([
  {
    command: "pdf-inspector classify",
    description: `Classify a PDF (TextBased | Scanned | ImageBased | Mixed) with confidence, page count and 0-indexed pagesNeedingOcr in ~10-50ms. Works in node_module and path_cli modes. ${note}`,
    inputSchema: PdfInspectorClassifyInputSchema,
    batch: true,
    orbit,
    output: "{ tool, operation, source, elapsed_ms, result: { pdfType, pageCount, pagesNeedingOcr, confidence } }",
    examples: [
      { name: "classify a local pdf", input: { path: "./paper.pdf" } },
      { name: "classify a pdf url", input: { url: "https://example.com/report.pdf" } },
      { name: "ordered local batch", input: [{ path: "./a.pdf" }, { path: "./b.pdf" }] },
    ],
  },
  {
    command: "pdf-inspector inspect",
    description: `Fast detection only: metadata (title, author, producer, dates) and layout flags (isComplexLayout, pagesWithTables, pagesWithColumns, hasEncodingIssues) without markdown. Node module only. ${note}`,
    inputSchema: PdfInspectorInspectInputSchema,
    batch: true,
    orbit,
    examples: [{ name: "inspect a pdf", input: { path: "./paper.pdf" } }],
  },
  {
    command: "pdf-inspector extract",
    description: `Extract Markdown plus classification and metadata, optionally for 1-indexed pages only. Works in node_module and path_cli modes. ${note}`,
    inputSchema: PdfInspectorExtractInputSchema,
    batch: true,
    orbit,
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
    examples: [{ name: "per-page markdown", input: { path: "./paper.pdf", pages: [1, 2] } }],
  },
  {
    command: "pdf-inspector text",
    description: `Plain text in reading order. Node module only. ${note}`,
    inputSchema: PdfInspectorTextInputSchema,
    batch: true,
    orbit,
    examples: [{ name: "plain text", input: { path: "./paper.pdf" } }],
  },
  {
    command: "pdf-inspector positions",
    description: `Every text item with font, size, bold/italic, x/y/width/height in PDF points, colours, render mode, plus pageRotations. frame "sheet" (default) or "display". Node module only. ${note}`,
    inputSchema: PdfInspectorPositionsInputSchema,
    batch: true,
    orbit,
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
    description: `Text inside [x1,y1,x2,y2] regions (PDF points, top-left origin, 0-indexed page) with per-region needsOcr and ocrReason, for hybrid OCR pipelines. Node module only. ${note}`,
    inputSchema: PdfInspectorRegionsInputSchema,
    batch: true,
    orbit,
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
    description: `Tables inside regions as Markdown, same region contract as regions. Node module only. ${note}`,
    inputSchema: PdfInspectorRegionsInputSchema,
    batch: true,
    orbit,
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
    description: `Native extraction first, then local PP-OCR on pages the quality checks reject (mode Off | Auto | Force). Needs PDFium and ONNX Runtime installed (PDFIUM_LIB_PATH, ORT_DYLIB_PATH). offline defaults to true so no model is ever downloaded unless offline is explicitly false. Node module only. ${note}`,
    inputSchema: PdfInspectorOcrInputSchema,
    batch: true,
    orbit,
    examples: [
      { name: "selective ocr, offline", input: { path: "./scan.pdf", modelDirectory: "~/.cache/ocr-models" } },
      { name: "native only, same result shape", input: { path: "./paper.pdf", mode: "Off" } },
    ],
  },
])
