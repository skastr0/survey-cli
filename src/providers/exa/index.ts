import { Command } from "effect/unstable/cli"

import {
  agentCommand,
  answerCommand,
  codeContextCommand,
  companyResearchCommand,
  contentsCommand,
  crawlCommand,
  deepResearchCommand,
  findSimilarCommand,
  linkedinSearchCommand,
  webSearchCommand,
} from "./commands"

export { exaApi } from "./api"
export * from "./schemas"

export const exaCommand = Command.make("exa").pipe(
  Command.withDescription("Exa provider commands"),
  Command.withSubcommands([
    webSearchCommand,
    codeContextCommand,
    contentsCommand,
    crawlCommand,
    answerCommand,
    companyResearchCommand,
    linkedinSearchCommand,
    findSimilarCommand,
    agentCommand,
    deepResearchCommand,
  ]),
)
