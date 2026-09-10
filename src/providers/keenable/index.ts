import { Command } from "effect/unstable/cli"

import { fetchPage, search, selectQuery } from "./api"
import {
  fetchCommand,
  searchCommand,
  selectCommand,
  selectReportCommand,
  selectRevokeCommand,
} from "./commands"

export const keenableCommand = Command.make("keenable").pipe(
  Command.withDescription(
    "Keenable web search, fetch, and SELECT (DuckDB over the live web via MCP)",
  ),
  Command.withSubcommands([
    searchCommand,
    fetchCommand,
    selectCommand,
    selectReportCommand,
    selectRevokeCommand,
  ]),
)

export const keenableApi = {
  search,
  fetch: fetchPage,
  select: selectQuery,
}
