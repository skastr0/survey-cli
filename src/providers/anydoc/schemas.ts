import { Schema } from "effect"

import { documentSourceFields } from "../../local/source"

/** Formats `@firecrawl/anydoc` names; extension aliases (xls, docm, ppsx, ...) are accepted too. */
export const ANYDOC_FORMATS = [
  "doc",
  "docx",
  "odt",
  "pdf",
  "ppt",
  "pptx",
  "rtf",
  "epub",
  "xlsx",
  "ods",
  "odp",
  "csv",
] as const

const formatField = Schema.optional(Schema.String)

export const AnydocConvertInputSchema = Schema.Struct({
  ...documentSourceFields,
  format: formatField,
})
export type AnydocConvertInput = typeof AnydocConvertInputSchema.Type

export const AnydocDetectInputSchema = Schema.Struct({
  ...documentSourceFields,
})
export type AnydocDetectInput = typeof AnydocDetectInputSchema.Type

export const AnydocDocumentInputSchema = Schema.Struct({
  ...documentSourceFields,
  format: formatField,
  include_assets: Schema.optional(Schema.Boolean),
})
export type AnydocDocumentInput = typeof AnydocDocumentInputSchema.Type
