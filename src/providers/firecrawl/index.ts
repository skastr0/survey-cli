import { Command } from "effect/unstable/cli"

import {
  agentCancel,
  agentCheck,
  agentEvents,
  agentList,
  agentStart,
  batchScrapeCancel,
  batchScrapeCheck,
  batchScrapeErrors,
  batchScrapeStart,
  crawlCancel,
  crawlCheck,
  crawlErrors,
  crawlStart,
  extractCheck,
  extractStart,
  interactExecute,
  interactStop,
  mapSite,
  parseFile,
  scrape,
  searchWeb,
  waitForJob,
} from "./api"
import {
  agentCommand,
  batchCommand,
  crawlCommand,
  extractCommand,
  interactCommand,
  mapCommand,
  parseCommand,
  scrapeCommand,
  searchCommand,
} from "./commands"

// Registers this provider's CommandContracts as a side effect.
import "./capabilities"

export const firecrawlCommand = Command.make("firecrawl").pipe(
  Command.withDescription(
    "Firecrawl v2 provider namespace — scrape, map, search, parse, batch, crawl, agent, extract, interact",
  ),
  Command.withSubcommands([
    scrapeCommand,
    mapCommand,
    searchCommand,
    parseCommand,
    batchCommand,
    crawlCommand,
    agentCommand,
    extractCommand,
    interactCommand,
  ]),
)

export const firecrawlApi = {
  scrape,
  search: searchWeb,
  map: mapSite,
  parse: parseFile,
  extractStart,
  extractCheck,
  agentStart,
  agentCheck,
  agentCancel,
  agentEvents,
  agentList,
  crawlStart,
  crawlCheck,
  crawlCancel,
  crawlErrors,
  batchStart: batchScrapeStart,
  batchCheck: batchScrapeCheck,
  batchCancel: batchScrapeCancel,
  batchErrors: batchScrapeErrors,
  interactExecute,
  interactStop,
  waitForJob,
}
