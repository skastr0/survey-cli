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
  description: "Convert a document (path | url | base64) to GFM Markdown locally; object or ordered batch array",
  schema: AnydocConvertInputSchema,
  run: convert,
})

export const detectCommand = makeOneOrManyCommand({
  name: "detect",
  commandName: "anydoc detect",
  description: "Detect a document's format from its content, falling back to the extension",
  schema: AnydocDetectInputSchema,
  run: detect,
})

export const documentCommand = makeOneOrManyCommand({
  name: "document",
  commandName: "anydoc document",
  description: "Parse a non-PDF document into anydoc's document model (blocks, notes, assets)",
  schema: AnydocDocumentInputSchema,
  run: document,
})
