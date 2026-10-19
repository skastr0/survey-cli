import { registerContracts } from "../../core/discovery"
import {
  AnydocConvertInputSchema,
  AnydocDetectInputSchema,
  AnydocDocumentInputSchema,
} from "./schemas"

const orbit = ["convert", "detect", "document"] as const

registerContracts([
  {
    command: "anydoc convert",
    description:
      "Convert doc/docx/odt/rtf/epub/pdf/ppt/pptx/xls/xlsx/ods/odp/csv to GFM Markdown with the local @firecrawl/anydoc engine (no network, no key). Source is exactly one of path | url | base64; a URL is downloaded then converted locally. Scanned PDFs fail with code needsOcr; hosted OCR is never used.",
    inputSchema: AnydocConvertInputSchema,
    batch: true,
    orbit,
    output:
      "{ tool: {name, mode, version}, operation, source, elapsed_ms, format, chars, markdown } or a batch summary for array input",
    examples: [
      { name: "convert a local file", input: { path: "./report.docx" } },
      {
        name: "convert a document URL",
        input: { url: "https://example.com/slides.pptx" },
      },
      {
        name: "csv from base64 needs a format",
        input: { base64: "YSxiCjEsMgo=", format: "csv" },
      },
      {
        name: "ordered local batch",
        input: [{ path: "./a.docx" }, { path: "./b.xlsx" }, { path: "./c.epub" }],
      },
    ],
  },
  {
    command: "anydoc detect",
    description:
      "Detect the document format from its bytes (signature) with the extension as fallback. Requires the node module.",
    inputSchema: AnydocDetectInputSchema,
    batch: true,
    orbit,
    examples: [
      { name: "detect a file", input: { path: "./mystery.bin" } },
      { name: "detect with a name hint", input: { base64: "YSxiCjEsMgo=", filename: "data.csv" } },
    ],
  },
  {
    command: "anydoc document",
    description:
      "Parse a non-PDF document into the anydoc document model (blocks, footnotes, embedded assets). Asset bytes are omitted unless include_assets is true. Requires the node module.",
    inputSchema: AnydocDocumentInputSchema,
    batch: true,
    orbit,
    examples: [
      { name: "document model", input: { path: "./report.docx" } },
      {
        name: "with embedded asset bytes",
        input: { path: "./slides.pptx", include_assets: true },
      },
    ],
  },
])
