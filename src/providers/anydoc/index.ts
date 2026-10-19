import { Command } from "effect/unstable/cli"

import { convertCommand, detectCommand, documentCommand } from "./commands"
import { convert, convertDocument, detect, document } from "./api"

// Registers all `anydoc <cmd>` CommandContracts at module load.
import "./capabilities"

export const anydocCommand = Command.make("anydoc").pipe(
  Command.withDescription("Local document → Markdown (@firecrawl/anydoc): no network, no key"),
  Command.withSubcommands([convertCommand, detectCommand, documentCommand]),
)

/** Provider domain functions shared by commands and cross-provider tooling. */
export const anydocApi = { convert, convertDocument, detect, document } as const
