import { Command } from "effect/unstable/cli"

import {
  agentCheck,
  agentStart,
  fetchPages,
  monitorCreate,
  monitorDelete,
  monitorInspect,
  monitorList,
  monitorTrigger,
  monitorUpdate,
  monitorEventsUnsupported,
  researchCheck,
  researchSources,
  researchStart,
  search,
} from "./api"
import {
  agentCommand,
  browserCommand,
  fetchCommand,
  monitorCommand,
  profilesCommand,
  researchCommand,
  searchCommand,
  usageCommand,
  vaultCommand,
  walletCommand,
} from "./commands"

// Registers this provider's CommandContracts as a side effect.
import "./capabilities"

export const tinyfishCommand = Command.make("tinyfish").pipe(
  Command.withDescription(
    "TinyFish provider namespace — search, fetch, browser sessions, agent runs, profiles, vault, research (beta), monitors, usage, wallet",
  ),
  Command.withSubcommands([
    searchCommand,
    fetchCommand,
    browserCommand,
    agentCommand,
    profilesCommand,
    vaultCommand,
    researchCommand,
    monitorCommand,
    usageCommand,
    walletCommand,
  ]),
)

export const tinyfishApi = {
  search,
  fetch: fetchPages,
  agentStart,
  agentCheck,
  researchStart,
  researchCheck,
  researchSources,
  monitorCreate,
  monitorList,
  monitorInspect,
  monitorUpdate,
  monitorDelete,
  monitorTrigger,
  monitorEventsUnsupported,
}
