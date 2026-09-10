import { Command } from "effect/unstable/cli"

import {
  deleteFile,
  defaultParseExpand,
  extractCheck,
  extractCreate,
  extractGet,
  extractList,
  extractRun,
  extractWait,
  getFile,
  getFileContent,
  isTerminalJobStatus,
  listFiles,
  mimeForFileName,
  omitUndefined,
  parseAndExtract,
  parseCheck,
  parseCreate,
  parseList,
  parseResult,
  parseRun,
  parseUpload,
  parseVersions,
  parseWait,
  readLocalFileBytes,
  toParseBody,
  uploadFile,
} from "./api"
import { extractCommand } from "./extract"
import { filesCommand } from "./files"
import { parseCommand } from "./parse"

// Registers all `llama <cmd>` CommandContracts at module load.
import "./capabilities"

export const llamaCommand = Command.make("llama").pipe(
  Command.withDescription("LlamaCloud files, LlamaParse, and LlamaExtract jobs"),
  Command.withSubcommands([filesCommand, parseCommand, extractCommand]),
)

/** Provider domain functions shared by commands and cross-provider tooling. */
export const llamaApi = {
  uploadFile,
  listFiles,
  getFile,
  getFileContent,
  deleteFile,
  parseCreate,
  parseUpload,
  parseResult,
  parseList,
  parseVersions,
  parseWait,
  parseRun,
  extractCreate,
  extractGet,
  extractList,
  extractWait,
  extractRun,
  parseCheck,
  extractCheck,
  parseAndExtract,
  toParseBody,
  mimeForFileName,
  defaultParseExpand,
  isTerminalJobStatus,
  omitUndefined,
  readLocalFileBytes,
} as const

export {
  JobFailedError,
  PARSE_TERMINAL_STATUSES,
  DEFAULT_JOB_POLL_INTERVAL_MS,
  DEFAULT_JOB_TIMEOUT_SECONDS,
  FILE_PURPOSES,
} from "./api"
export type {
  ExtractJob,
  FileListResponse,
  FileRecord,
  ParseConfiguration,
  ParseGetResponse,
  ParseJob,
  ProjectQuery,
} from "./api"
