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
      "Convert doc/docx/odt/rtf/epub/pdf/ppt(x)/xls(x)/ods/odp/csv to GFM Markdown locally with @firecrawl/anydoc (no network, no key). Input: {path | url | base64, format?}. Returns markdown; scanned PDFs fail with needsOcr.",
    inputSchema: AnydocConvertInputSchema,
    batch: true,
    orbit,
    output:
      "{ tool: { name, mode, version }, operation, source: { kind, path?, url?, filename?, content_type?, bytes }, elapsed_ms, format, chars, markdown }; array input returns a batch summary { outcome, success_count, error_count, results[{ index, ok, data?, error? }] }",
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
      "Detect a document's format from its bytes (signature), falling back to the extension; requires the node module. Input: {path | url | base64, filename?}. Returns the detected format.",
    inputSchema: AnydocDetectInputSchema,
    batch: true,
    orbit,
    output:
      "{ tool: { name, mode, version }, operation, source: { kind, path?, url?, filename?, content_type?, bytes }, elapsed_ms, format, from_content, from_extension }; array input returns a batch summary { outcome, success_count, error_count, results[{ index, ok, data?, error? }] }",
    examples: [
      { name: "detect a file", input: { path: "./mystery.bin" } },
      { name: "detect with a name hint", input: { base64: "YSxiCjEsMgo=", filename: "data.csv" } },
    ],
  },
  {
    command: "anydoc document",
    description:
      "Parse a non-PDF document into the anydoc document model; requires the node module. Input: {path | url | base64, format?, include_assets?}. Returns blocks, notes, and asset metadata (bytes only with include_assets).",
    inputSchema: AnydocDocumentInputSchema,
    batch: true,
    orbit,
    output:
      "{ tool: { name, mode, version }, operation, source: { kind, path?, url?, filename?, content_type?, bytes }, elapsed_ms, format, document: { blocks, notes, assets[{ id, mediaType, originPart, bytes, data_base64? }] } }; array input returns a batch summary { outcome, success_count, error_count, results[{ index, ok, data?, error? }] }",
    examples: [
      { name: "document model", input: { path: "./report.docx" } },
      {
        name: "with embedded asset bytes",
        input: { path: "./slides.pptx", include_assets: true },
      },
    ],
  },
])
