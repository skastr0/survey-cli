import { Command } from "effect/unstable/cli"

import {
  cancelFindAllRun,
  cancelMonitor,
  createFindAllRun,
  createMonitor,
  createTaskRun,
  enrichFindAllRun,
  entitySearch,
  extendFindAllRun,
  extract,
  getFindAllEvents,
  getFindAllResult,
  getFindAllRun,
  getMonitor,
  getTaskResult,
  getTaskRun,
  getTaskRunEvents,
  ingestFindAll,
  listMonitorEvents,
  listMonitors,
  search,
  triggerMonitorRun,
} from "./api"
import {
  checkFindAllRun,
  checkTaskRun,
  deepResearchCommand,
  findAllCommand,
  monitorsCommand,
  parallelExtractCommand,
  parallelSearchCommand,
  runDeepResearch,
  waitForFindAllRun,
  waitForTaskRun,
} from "./commands"

// Registering contracts is a module side effect consumed by
// `survey capabilities` / `survey schema` / `survey examples`.
import "./capabilities"

export const parallelCommand = Command.make("parallel").pipe(
  Command.withDescription(
    "Parallel Search, Extract, Task, FindAll, and Monitor APIs",
  ),
  Command.withSubcommands([
    parallelSearchCommand,
    parallelExtractCommand,
    deepResearchCommand,
    findAllCommand,
    monitorsCommand,
  ]),
)

export {
  cancelFindAllRun,
  cancelMonitor,
  createFindAllRun,
  createMonitor,
  createTaskRun,
  enrichFindAllRun,
  entitySearch,
  extendFindAllRun,
  extract,
  getFindAllEvents,
  getFindAllResult,
  getFindAllRun,
  getMonitor,
  getTaskResult,
  getTaskRun,
  getTaskRunEvents,
  ingestFindAll,
  listMonitorEvents,
  listMonitors,
  search,
  triggerMonitorRun,
}

/**
 * Domain-level functions for use by unified capability commands and
 * programmatic consumers. Wire format stays snake_case.
 */
export const parallelApi = {
  // sync endpoints (POST /v1/search, POST /v1/extract)
  search,
  extract,
  // task API orbit (/v1/tasks/runs)
  deepResearchStart: (input: Parameters<typeof createTaskRun>[0]) =>
    createTaskRun(input, "text"),
  deepResearchRun: runDeepResearch,
  taskInspect: getTaskRun,
  taskCheck: checkTaskRun,
  taskWait: waitForTaskRun,
  taskEvents: getTaskRunEvents,
  taskResult: getTaskResult,
  // findall orbit (/v1beta/findall/*)
  findallIngest: ingestFindAll,
  findallStart: createFindAllRun,
  findallEntitySearch: entitySearch,
  findallInspect: getFindAllRun,
  findallCheck: checkFindAllRun,
  findallWait: waitForFindAllRun,
  findallResult: getFindAllResult,
  findallEvents: getFindAllEvents,
  findallEnrich: enrichFindAllRun,
  findallExtend: extendFindAllRun,
  findallCancel: cancelFindAllRun,
  // monitors (/v1/monitors)
  monitorCreate: createMonitor,
  monitorList: listMonitors,
  monitorInspect: getMonitor,
  monitorEvents: listMonitorEvents,
  monitorTrigger: triggerMonitorRun,
  monitorCancel: cancelMonitor,
}
