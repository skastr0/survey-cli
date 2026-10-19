import { makeOneOrManyCommand } from "../../local/command"
import { convert, detect, document } from "./api"
import {
  AnydocConvertInputSchema,
  AnydocDetectInputSchema,
  AnydocDocumentInputSchema,
} from "./schemas"

export const convertCommand = makeOneOrManyCommand({
  name: "convert",
  commandName: "anydoc convert",
  description: "Convert doc/docx/odt/rtf/epub/pdf/ppt(x)/xls(x)/ods/odp/csv to GFM Markdown locally with @firecrawl/anydoc (no network, no key). Input: {path | url | base64, format?}. Returns markdown; scanned PDFs fail with needsOcr.",
  schema: AnydocConvertInputSchema,
  run: convert,
})

export const detectCommand = makeOneOrManyCommand({
  name: "detect",
  commandName: "anydoc detect",
  description: "Detect a document's format from its bytes (signature), falling back to the extension; requires the node module. Input: {path | url | base64, filename?}. Returns the detected format.",
  schema: AnydocDetectInputSchema,
  run: detect,
})

export const documentCommand = makeOneOrManyCommand({
  name: "document",
  commandName: "anydoc document",
  description: "Parse a non-PDF document into the anydoc document model; requires the node module. Input: {path | url | base64, format?, include_assets?}. Returns blocks, notes, and asset metadata (bytes only with include_assets).",
  schema: AnydocDocumentInputSchema,
  run: document,
})
