import { Command } from "effect/unstable/cli"

import {
  classifyCommand,
  extractCommand,
  inspectCommand,
  ocrCommand,
  pagesCommand,
  positionsCommand,
  regionsCommand,
  tablesCommand,
  textCommand,
} from "./commands"
import {
  classify,
  classifyDocument,
  extract,
  extractDocument,
  inspect,
  ocr,
  pages,
  positions,
  regions,
  tables,
  text,
} from "./api"

// Registers all `pdf-inspector <cmd>` CommandContracts at module load.
import "./capabilities"

export const pdfInspectorCommand = Command.make("pdf-inspector").pipe(
  Command.withDescription("Local PDF tools (@firecrawl/pdf-inspector, no network, no key): classify, inspect, extract Markdown, per-page text, positions, regions, tables, selective OCR"),
  Command.withSubcommands([
    classifyCommand,
    inspectCommand,
    extractCommand,
    pagesCommand,
    textCommand,
    positionsCommand,
    regionsCommand,
    tablesCommand,
    ocrCommand,
  ]),
)

/** Provider domain functions shared by commands and cross-provider tooling. */
export const pdfInspectorApi = {
  classify,
  classifyDocument,
  extract,
  extractDocument,
  inspect,
  pages,
  text,
  positions,
  regions,
  tables,
  ocr,
} as const
