import { Schema } from "effect"

import { documentSourceFields } from "../../local/source"

/** 1-indexed page numbers, as the library's `pages` arguments expect. */
const pages = Schema.optional(Schema.Array(Schema.Int))

const frameFields = {
  frame: Schema.optional(Schema.Literals(["sheet", "display"])),
  boldFromWeight: Schema.optional(Schema.Boolean),
  boldWeightThreshold: Schema.optional(Schema.Number),
} as const

export const PdfPageRegionsSchema = Schema.Struct({
  /** 0-indexed page number. */
  page: Schema.Int,
  /** `[x1, y1, x2, y2]` in PDF points, top-left origin of the visible page box. */
  regions: Schema.Array(Schema.Array(Schema.Number)),
})

export const PdfInspectorClassifyInputSchema = Schema.Struct({ ...documentSourceFields })
export const PdfInspectorInspectInputSchema = Schema.Struct({ ...documentSourceFields })
export const PdfInspectorTextInputSchema = Schema.Struct({ ...documentSourceFields })

export const PdfInspectorExtractInputSchema = Schema.Struct({ ...documentSourceFields, pages })
export const PdfInspectorPagesInputSchema = Schema.Struct({ ...documentSourceFields, pages })

export const PdfInspectorPositionsInputSchema = Schema.Struct({
  ...documentSourceFields,
  pages,
  ...frameFields,
})

export const PdfInspectorRegionsInputSchema = Schema.Struct({
  ...documentSourceFields,
  pageRegions: Schema.Array(PdfPageRegionsSchema),
  ...frameFields,
})

export const PdfInspectorOcrInputSchema = Schema.Struct({
  ...documentSourceFields,
  mode: Schema.optional(Schema.Literals(["Off", "Auto", "Force"])),
  pageNumbers: pages,
  password: Schema.optional(Schema.String),
  dpi: Schema.optional(Schema.Number),
  minimumConfidence: Schema.optional(Schema.Number),
  hostedRecommendationConfidence: Schema.optional(Schema.Number),
  modelDirectory: Schema.optional(Schema.String),
  /** Defaults to true here: OCR models are only downloaded when this is explicitly false. */
  offline: Schema.optional(Schema.Boolean),
})

export type PdfInspectorClassifyInput = typeof PdfInspectorClassifyInputSchema.Type
export type PdfInspectorInspectInput = typeof PdfInspectorInspectInputSchema.Type
export type PdfInspectorTextInput = typeof PdfInspectorTextInputSchema.Type
export type PdfInspectorExtractInput = typeof PdfInspectorExtractInputSchema.Type
export type PdfInspectorPagesInput = typeof PdfInspectorPagesInputSchema.Type
export type PdfInspectorPositionsInput = typeof PdfInspectorPositionsInputSchema.Type
export type PdfInspectorRegionsInput = typeof PdfInspectorRegionsInputSchema.Type
export type PdfInspectorOcrInput = typeof PdfInspectorOcrInputSchema.Type
