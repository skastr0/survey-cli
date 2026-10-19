import { Effect, Option, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import {
  applyOutputPolicy,
  concurrencyFlag,
  jsonInputArg,
  makeJsonCommand,
  optionalJsonInputArg,
  outputFlag,
} from "../../core/command"
import { loadJsonInput } from "../../core/json"
import { executeJsonCommand } from "../../core/output"
import {
  extractUrls,
  recordRun,
  recordSources,
  updateRun,
  type SourceLike,
} from "../../core/runs"
import { Store, type RunStatus } from "../../core/store"
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
  failInput,
  interactExecute,
  interactStop,
  isRecord,
  researchInspectPaper,
  researchReadPaper,
  researchRelatedPapers,
  researchSearchPapers,
  runResearchCommand,
  runMapCommand,
  runParseCommand,
  runScrapeCommand,
  runSearchCommand,
  unsupportedEventStream,
  validateAgentEventsInput,
  validateAgentStartInput,
  validateBatchStartInput,
  validateConcurrency,
  validateCrawlStartInput,
  validateExtractStartInput,
  validateInteractExecuteInput,
  validateJobCheckInput,
  validateJobIdInput,
  validateMapCommandInput,
  validateParseCommandInput,
  validateScrapeCommandInput,
  validateSearchCommandInput,
  validateWaitInput,
  waitForJob,
} from "./api"
import {
  AgentEventsInputSchema,
  AgentListInputSchema,
  AgentStartInputSchema,
  BatchStartInputSchema,
  CrawlStartInputSchema,
  ExtractStartInputSchema,
  InteractExecuteInputSchema,
  JobCheckInputSchema,
  JobIdInputSchema,
  MapCommandInputSchema,
  ParseCommandInputSchema,
  ResearchInspectPaperCommandInputSchema,
  ResearchReadPaperCommandInputSchema,
  ResearchRelatedPapersCommandInputSchema,
  ResearchSearchPapersCommandInputSchema,
  ScrapeCommandInputSchema,
  SearchCommandInputSchema,
  WaitInputSchema,
  type NormalizedJobStatus,
  type ProviderJobSnapshot,
} from "./schemas"
import { paperSources } from "./papers"

/* ------------------------------------------------------------------------ */
/* Run registry + source ledger (best-effort)                                */
/* ------------------------------------------------------------------------ */

const toRunStatus = (status: NormalizedJobStatus): RunStatus => {
  switch (status) {
    case "succeeded":
      return "succeeded"
    case "failed":
      return "failed"
    case "canceled":
      return "canceled"
    case "submitted":
    case "queued":
      return "queued"
    default:
      return "running"
  }
}

const trackJobStart = (kind: string, payload: unknown, snapshot: ProviderJobSnapshot) =>
  recordRun({
    provider: "firecrawl",
    kind,
    remoteId: snapshot.id,
    status: toRunStatus(snapshot.status),
    payload,
  }).pipe(Effect.catchCause(() => Effect.void))

const syncTrackedRun = (remoteId: string | undefined, status: NormalizedJobStatus) =>
  remoteId === undefined
    ? Effect.void
    : Effect.gen(function* () {
        const store = yield* Store
        const run = yield* store.findRunByRemote("firecrawl", remoteId)
        yield* updateRun(run?.id, { status: toRunStatus(status) })
      }).pipe(Effect.catchCause(() => Effect.void))

const firecrawlSources = (result: unknown): ReadonlyArray<SourceLike> => {
  // /map returns { links: [{url,title}] } — outside the keys extractUrls scans.
  if (isRecord(result) && Array.isArray(result.links)) {
    return extractUrls({ results: result.links })
  }
  return extractUrls(result)
}

const trackSources = (result: unknown) =>
  recordSources("firecrawl", firecrawlSources(result)).pipe(
    Effect.catchCause(() => Effect.void),
  )

const trackBatchSources = (result: unknown) => {
  if (!isRecord(result) || !Array.isArray(result.results)) {
    return trackSources(result)
  }
  return Effect.forEach(
    result.results,
    (item) =>
      isRecord(item) && item.ok === true && "data" in item
        ? trackSources(item.data)
        : Effect.void,
    { discard: true },
  ).pipe(Effect.catchCause(() => Effect.void))
}

/** Research Index results land in the ledger under canonical paper refs. */
const trackPaperSources = (result: unknown) => {
  const payloads =
    isRecord(result) && Array.isArray(result.results) && "outcome" in result
      ? result.results.flatMap((item) =>
          isRecord(item) && item.ok === true && "data" in item ? [item.data] : [],
        )
      : [result]
  return recordSources("firecrawl", payloads.flatMap((payload) => paperSources(payload))).pipe(
    Effect.catchCause(() => Effect.void),
  )
}

/* ------------------------------------------------------------------------ */
/* Shared command plumbing                                                   */
/* ------------------------------------------------------------------------ */

const withOutput = (command: string, output: "inline" | "artifact" | "auto") =>
  Effect.flatMap((data: unknown) => applyOutputPolicy({ command, mode: output, data }))

/**
 * Command with required JSON input plus the --concurrency flag used by the
 * object-or-array local batch commands (scrape, map, search, parse).
 */
const makeLocalBatchCommand = <S extends Schema.Constraint, VE, VR, E, R, AR = never>(options: {
  readonly name: string
  readonly commandName: string
  readonly description: string
  readonly schema: S
  readonly validate: (
    input: S["Type"],
  ) => Effect.Effect<S["Type"], VE, VR>
  readonly run: (input: S["Type"], concurrency: number) => Effect.Effect<unknown, E, R>
  readonly after?: (data: unknown) => Effect.Effect<unknown, never, AR>
}) =>
  Command.make(
    options.name,
    { input: jsonInputArg, output: outputFlag, concurrency: concurrencyFlag },
    ({ input, output, concurrency }) =>
      executeJsonCommand(
        options.commandName,
        loadJsonInput(options.schema, input).pipe(
          Effect.flatMap(options.validate),
          Effect.flatMap((validated) =>
            validateConcurrency(concurrency).pipe(
              Effect.andThen(options.run(validated, concurrency)),
            ),
          ),
          Effect.tap((data) => options.after?.(data) ?? Effect.void),
          withOutput(options.commandName, output),
        ),
      ),
  ).pipe(Command.withDescription(options.description))

/** Bare parent handler: `firecrawl <ns> '<json>'` as shorthand for start/execute. */
const optionalInputEffect = <S extends Schema.Constraint, E, R>(options: {
  readonly command: string
  readonly field: string
  readonly hint: string
  readonly schema: S
  readonly input: Option.Option<string>
  readonly output: "inline" | "artifact" | "auto"
  readonly run: (validated: S["Type"]) => Effect.Effect<unknown, E, R>
}) =>
  executeJsonCommand(
    options.command,
    Effect.gen(function* () {
      const inputText = Option.getOrUndefined(options.input)
      if (inputText === undefined) {
        return yield* failInput(options.field, options.hint)
      }
      const parsed = yield* loadJsonInput(options.schema, inputText)
      return yield* options.run(parsed).pipe(withOutput(options.command, options.output))
    }),
  )

/* ------------------------------------------------------------------------ */
/* scrape                                                                    */
/* ------------------------------------------------------------------------ */

export const scrapeCommand = makeLocalBatchCommand({
  name: "scrape",
  commandName: "firecrawl scrape",
  description:
    "Scrape one URL (or an ordered local batch) via POST /scrape. Input: {url, formats?, only_main_content?, json_schema?, screenshot?, question?}. Returns page content plus metadata. Keyless free tier works.",
  schema: ScrapeCommandInputSchema,
  validate: (input) => validateScrapeCommandInput(input),
  run: (input, concurrency) => runScrapeCommand(input, concurrency),
  after: (data) => trackBatchSources(data),
})

/* ------------------------------------------------------------------------ */
/* map                                                                       */
/* ------------------------------------------------------------------------ */

export const mapCommand = makeLocalBatchCommand({
  name: "map",
  commandName: "firecrawl map",
  description:
    "Map a website to discovered URLs via POST /map, or an ordered local batch. Input: {url, search?, sitemap?, include_subdomains?, limit?}. Returns the discovered links.",
  schema: MapCommandInputSchema,
  validate: (input) => validateMapCommandInput(input),
  run: (input, concurrency) => runMapCommand(input, concurrency),
  after: (data) => trackBatchSources(data),
})

/* ------------------------------------------------------------------------ */
/* search                                                                    */
/* ------------------------------------------------------------------------ */

export const searchCommand = makeLocalBatchCommand({
  name: "search",
  commandName: "firecrawl search",
  description:
    "Search the web via POST /search, optionally scraping result pages. Input: {query, limit?, sources?, scrape_options?}. Returns results grouped by source. Keyless free tier works.",
  schema: SearchCommandInputSchema,
  validate: (input) => validateSearchCommandInput(input),
  run: (input, concurrency) => runSearchCommand(input, concurrency),
  after: (data) => trackBatchSources(data),
})

/* ------------------------------------------------------------------------ */
/* parse                                                                     */
/* ------------------------------------------------------------------------ */

export const parseCommand = makeLocalBatchCommand({
  name: "parse",
  commandName: "firecrawl parse",
  description:
    "Parse a local file (PDF, Office, HTML, ...) via /v2/parse multipart upload. Input: {path, formats?, json_schema?, pdf_*?}. Returns parsed document content. Keyless free tier works.",
  schema: ParseCommandInputSchema,
  validate: (input) => validateParseCommandInput(input),
  run: (input, concurrency) => runParseCommand(input, concurrency),
})

/* ------------------------------------------------------------------------ */
/* batch                                                                     */
/* ------------------------------------------------------------------------ */

const runBatchStart = (input: typeof BatchStartInputSchema.Type) =>
  validateBatchStartInput(input).pipe(
    Effect.flatMap(batchScrapeStart),
    Effect.tap((snapshot) => trackJobStart("firecrawl.batch", input, snapshot)),
  )

const batchStartCommand = makeJsonCommand({
  name: "start",
  commandName: "firecrawl batch start",
  description:
    "Start a provider-owned batch scrape job (POST /batch/scrape). Input: {urls, formats?, max_concurrency?, webhook?}. Returns a submitted job snapshot whose id feeds batch check/wait.",
  schema: BatchStartInputSchema,
  run: runBatchStart,
})

const batchRunCommand = makeJsonCommand({
  name: "run",
  commandName: "firecrawl batch run",
  description:
    "Alias for firecrawl batch start: start a provider-owned batch scrape job. Input: {urls, formats?, max_concurrency?}. Returns a submitted job snapshot with id.",
  schema: BatchStartInputSchema,
  run: runBatchStart,
})

const batchCheckCommand = makeJsonCommand({
  name: "check",
  commandName: "firecrawl batch check",
  description:
    "Check a batch scrape job by id (GET /batch/scrape/{id}), or fetch a results page via next_url. Input: {id, next_url?}. Returns a normalized status snapshot with scraped pages.",
  schema: JobCheckInputSchema,
  run: (input) =>
    validateJobCheckInput(input).pipe(
      Effect.flatMap(batchScrapeCheck),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const batchInspectCommand = makeJsonCommand({
  name: "inspect",
  commandName: "firecrawl batch inspect",
  description:
    "Alias for firecrawl batch check: snapshot a batch scrape job by id. Input: {id, next_url?}. Returns normalized status, progress and the provider response.",
  schema: JobCheckInputSchema,
  run: (input) =>
    validateJobCheckInput(input).pipe(
      Effect.flatMap(batchScrapeCheck),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const batchWaitCommand = makeJsonCommand({
  name: "wait",
  commandName: "firecrawl batch wait",
  description:
    "Poll a batch scrape job by id until terminal. Input: {id, poll_interval_ms?, timeout_ms?}. Returns the final job snapshot plus waited_ms; fails with a timeout error otherwise.",
  schema: WaitInputSchema,
  run: (input) =>
    validateWaitInput(input).pipe(
      Effect.flatMap((waitInput) => waitForJob(waitInput, batchScrapeCheck)),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const batchErrorsCommand = makeJsonCommand({
  name: "errors",
  commandName: "firecrawl batch errors",
  description:
    "Fetch per-URL errors of a batch scrape job (GET /batch/scrape/{id}/errors). Input: {id}. Returns error and robots-blocked counts plus the provider response.",
  schema: JobIdInputSchema,
  run: (input) => validateJobIdInput(input).pipe(Effect.flatMap(batchScrapeErrors)),
})

const batchCancelCommand = makeJsonCommand({
  name: "cancel",
  commandName: "firecrawl batch cancel",
  description:
    "Cancel a batch scrape job (DELETE /batch/scrape/{id}). Input: {id}. Returns a canceled terminal snapshot.",
  schema: JobIdInputSchema,
  run: (input) =>
    validateJobIdInput(input).pipe(
      Effect.flatMap(batchScrapeCancel),
      Effect.tap(() => syncTrackedRun(input.id, "canceled")),
    ),
})

const batchEventsCommand = makeJsonCommand({
  name: "events",
  commandName: "firecrawl batch events",
  description:
    "Report batch event stream support for a job id. Input: {id}. No provider event stream exists (polling only); returns supported:false with polling alternatives.",
  schema: JobIdInputSchema,
  run: (input) =>
    validateJobIdInput(input).pipe(
      Effect.map((value) => unsupportedEventStream("batch_scrape", value)),
    ),
})

export const batchCommand = Command.make(
  "batch",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    optionalInputEffect({
      command: "firecrawl batch",
      field: "batch",
      hint:
        "batch requires either a JSON input object (shorthand for batch start) or a lifecycle subcommand (start|check|inspect|wait|errors|cancel|events)",
      schema: BatchStartInputSchema,
      input,
      output,
      run: runBatchStart,
    }),
).pipe(
  Command.withDescription("Firecrawl provider-owned batch scrape workflow commands"),
  Command.withSubcommands([
    batchStartCommand,
    batchRunCommand,
    batchCheckCommand,
    batchInspectCommand,
    batchWaitCommand,
    batchCancelCommand,
    batchErrorsCommand,
    batchEventsCommand,
  ]),
)

/* ------------------------------------------------------------------------ */
/* crawl                                                                     */
/* ------------------------------------------------------------------------ */

const runCrawlStart = (input: typeof CrawlStartInputSchema.Type) =>
  validateCrawlStartInput(input).pipe(
    Effect.flatMap(crawlStart),
    Effect.tap((snapshot) => trackJobStart("firecrawl.crawl", input, snapshot)),
  )

const crawlStartCommand = makeJsonCommand({
  name: "start",
  commandName: "firecrawl crawl start",
  description:
    "Start a provider-owned crawl job (POST /crawl). Input: {url, limit?, include_paths?, exclude_paths?, sitemap?, scrape_options?}. Returns a submitted job snapshot whose id feeds crawl check/wait.",
  schema: CrawlStartInputSchema,
  run: runCrawlStart,
})

const crawlRunCommand = makeJsonCommand({
  name: "run",
  commandName: "firecrawl crawl run",
  description:
    "Alias for firecrawl crawl start: start a provider-owned crawl job. Input: {url, limit?, sitemap?, scrape_options?}. Returns a submitted job snapshot with id.",
  schema: CrawlStartInputSchema,
  run: runCrawlStart,
})

const crawlCheckCommand = makeJsonCommand({
  name: "check",
  commandName: "firecrawl crawl check",
  description:
    "Check a crawl job by id (GET /crawl/{id}), or fetch a results page via next_url. Input: {id, next_url?}. Returns a normalized status snapshot with crawled pages.",
  schema: JobCheckInputSchema,
  run: (input) =>
    validateJobCheckInput(input).pipe(
      Effect.flatMap(crawlCheck),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const crawlInspectCommand = makeJsonCommand({
  name: "inspect",
  commandName: "firecrawl crawl inspect",
  description:
    "Alias for firecrawl crawl check: snapshot a crawl job by id. Input: {id, next_url?}. Returns normalized status, progress and the provider response.",
  schema: JobCheckInputSchema,
  run: (input) =>
    validateJobCheckInput(input).pipe(
      Effect.flatMap(crawlCheck),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const crawlWaitCommand = makeJsonCommand({
  name: "wait",
  commandName: "firecrawl crawl wait",
  description:
    "Poll a crawl job by id until terminal. Input: {id, poll_interval_ms?, timeout_ms?}. Returns the final job snapshot plus waited_ms; fails with a timeout error otherwise.",
  schema: WaitInputSchema,
  run: (input) =>
    validateWaitInput(input).pipe(
      Effect.flatMap((waitInput) => waitForJob(waitInput, crawlCheck)),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const crawlErrorsCommand = makeJsonCommand({
  name: "errors",
  commandName: "firecrawl crawl errors",
  description:
    "Fetch per-URL errors of a crawl job (GET /crawl/{id}/errors). Input: {id}. Returns error and robots-blocked counts plus the provider response.",
  schema: JobIdInputSchema,
  run: (input) => validateJobIdInput(input).pipe(Effect.flatMap(crawlErrors)),
})

const crawlCancelCommand = makeJsonCommand({
  name: "cancel",
  commandName: "firecrawl crawl cancel",
  description:
    "Cancel a crawl job (DELETE /crawl/{id}). Input: {id}. Returns a canceled terminal snapshot.",
  schema: JobIdInputSchema,
  run: (input) =>
    validateJobIdInput(input).pipe(
      Effect.flatMap(crawlCancel),
      Effect.tap(() => syncTrackedRun(input.id, "canceled")),
    ),
})

const crawlEventsCommand = makeJsonCommand({
  name: "events",
  commandName: "firecrawl crawl events",
  description:
    "Report crawl event stream support for a job id. Input: {id}. Realtime updates exist only via SDK/WebSocket watchers (polling only here); returns supported:false with alternatives.",
  schema: JobIdInputSchema,
  run: (input) =>
    validateJobIdInput(input).pipe(
      Effect.map((value) => unsupportedEventStream("crawl", value)),
    ),
})

export const crawlCommand = Command.make("crawl").pipe(
  Command.withDescription("Firecrawl provider-owned crawl workflow commands"),
  Command.withSubcommands([
    crawlStartCommand,
    crawlRunCommand,
    crawlCheckCommand,
    crawlInspectCommand,
    crawlWaitCommand,
    crawlCancelCommand,
    crawlErrorsCommand,
    crawlEventsCommand,
  ]),
)

/* ------------------------------------------------------------------------ */
/* agent                                                                     */
/* ------------------------------------------------------------------------ */

const runAgentStart = (input: typeof AgentStartInputSchema.Type) =>
  validateAgentStartInput(input).pipe(
    Effect.flatMap(agentStart),
    Effect.tap((snapshot) => trackJobStart("firecrawl.agent", input, snapshot)),
  )

const agentStartCommand = makeJsonCommand({
  name: "start",
  commandName: "firecrawl agent start",
  description:
    "Start an agent job (POST /agent), successor to /extract for web-wide structured extraction. Input: {prompt, urls?, schema?, max_credits?, model?}. Returns a submitted job snapshot with id.",
  schema: AgentStartInputSchema,
  run: runAgentStart,
})

const agentRunCommand = makeJsonCommand({
  name: "run",
  commandName: "firecrawl agent run",
  description:
    "Alias for firecrawl agent start: start an agent extraction job. Input: {prompt, urls?, schema?, max_credits?}. Returns a submitted job snapshot with id.",
  schema: AgentStartInputSchema,
  run: runAgentStart,
})

const agentCheckCommand = makeJsonCommand({
  name: "check",
  commandName: "firecrawl agent check",
  description:
    "Check an agent job by id (GET /agent/{id}). Input: {id}. Returns a normalized status snapshot; provider_response holds the extracted data once completed.",
  schema: JobCheckInputSchema,
  run: (input) =>
    validateJobCheckInput(input).pipe(
      Effect.flatMap(agentCheck),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const agentInspectCommand = makeJsonCommand({
  name: "inspect",
  commandName: "firecrawl agent inspect",
  description:
    "Alias for firecrawl agent check: snapshot an agent job by id. Input: {id}. Returns normalized status, credits used and the provider response.",
  schema: JobCheckInputSchema,
  run: (input) =>
    validateJobCheckInput(input).pipe(
      Effect.flatMap(agentCheck),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const agentWaitCommand = makeJsonCommand({
  name: "wait",
  commandName: "firecrawl agent wait",
  description:
    "Poll an agent job by id until terminal. Input: {id, poll_interval_ms?, timeout_ms?}. Returns the final job snapshot plus waited_ms; fails with a timeout error otherwise.",
  schema: WaitInputSchema,
  run: (input) =>
    validateWaitInput(input).pipe(
      Effect.flatMap((waitInput) => waitForJob(waitInput, agentCheck)),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const agentCancelCommand = makeJsonCommand({
  name: "cancel",
  commandName: "firecrawl agent cancel",
  description:
    "Cancel an agent job (DELETE /agent/{id}). Input: {id}. Returns a canceled terminal snapshot.",
  schema: JobIdInputSchema,
  run: (input) =>
    validateJobIdInput(input).pipe(
      Effect.flatMap(agentCancel),
      Effect.tap(() => syncTrackedRun(input.id, "canceled")),
    ),
})

const agentEventsCommand = makeJsonCommand({
  name: "events",
  commandName: "firecrawl agent events",
  description:
    "Fetch an agent job's execution trace by id (GET /agent/{id}/trace REST snapshot, not an SSE stream). Input: {id, live_view?}. Returns the trace in provider_response.",
  schema: AgentEventsInputSchema,
  run: (input) => validateAgentEventsInput(input).pipe(Effect.flatMap(agentEvents)),
})

const agentListCommand = Command.make(
  "list",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    executeJsonCommand(
      "firecrawl agent list",
      Effect.gen(function* () {
        const inputText = Option.getOrUndefined(input) ?? "{}"
        const parsed = yield* loadJsonInput(AgentListInputSchema, inputText)
        const data = yield* agentList(parsed)
        return yield* applyOutputPolicy({
          command: "firecrawl agent list",
          mode: output,
          data,
        })
      }),
    ),
).pipe(Command.withDescription(
    "List recent agent runs (GET /agent). Input: {before?}; pages are fixed at 20, pass before from the previous next URL. Returns the raw provider listing.",
  ))

export const agentCommand = Command.make(
  "agent",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    optionalInputEffect({
      command: "firecrawl agent",
      field: "agent",
      hint:
        "agent requires a JSON input object (shorthand for agent start) or a lifecycle subcommand (start|check|inspect|wait|cancel|events|list)",
      schema: AgentStartInputSchema,
      input,
      output,
      run: runAgentStart,
    }),
).pipe(
  Command.withDescription(
    "Firecrawl agent job orbit. Successor to /extract for autonomous structured extraction.",
  ),
  Command.withSubcommands([
    agentStartCommand,
    agentRunCommand,
    agentCheckCommand,
    agentInspectCommand,
    agentWaitCommand,
    agentCancelCommand,
    agentEventsCommand,
    agentListCommand,
  ]),
)

/* ------------------------------------------------------------------------ */
/* extract — /v2/extract job orbit; no cancel or events endpoint exists      */
/* ------------------------------------------------------------------------ */

const runExtractStart = (input: typeof ExtractStartInputSchema.Type) =>
  validateExtractStartInput(input).pipe(
    Effect.flatMap(extractStart),
    Effect.tap((snapshot) => trackJobStart("firecrawl.extract", input, snapshot)),
  )

const extractStartCommand = makeJsonCommand({
  name: "start",
  commandName: "firecrawl extract start",
  description:
    "Start a /v2/extract job (Firecrawl recommends agent for new work). Input: {urls?, prompt?, schema?, enable_web_search?}. Returns a submitted job snapshot whose id feeds extract check/wait.",
  schema: ExtractStartInputSchema,
  run: runExtractStart,
})

const extractRunCommand = makeJsonCommand({
  name: "run",
  commandName: "firecrawl extract run",
  description:
    "Alias for firecrawl extract start: start a /v2/extract job. Input: {urls?, prompt?, schema?}. Returns a submitted job snapshot with id.",
  schema: ExtractStartInputSchema,
  run: runExtractStart,
})

const extractCheckCommand = makeJsonCommand({
  name: "check",
  commandName: "firecrawl extract check",
  description:
    "Check an extract job by id (GET /extract/{id}). Input: {id}. Returns a normalized status snapshot; provider_response.data holds the extracted object once completed.",
  schema: JobCheckInputSchema,
  run: (input) =>
    validateJobCheckInput(input).pipe(
      Effect.flatMap(extractCheck),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const extractInspectCommand = makeJsonCommand({
  name: "inspect",
  commandName: "firecrawl extract inspect",
  description:
    "Alias for firecrawl extract check: snapshot an extract job by id. Input: {id}. Returns normalized status and the provider response with extracted data.",
  schema: JobCheckInputSchema,
  run: (input) =>
    validateJobCheckInput(input).pipe(
      Effect.flatMap(extractCheck),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

const extractWaitCommand = makeJsonCommand({
  name: "wait",
  commandName: "firecrawl extract wait",
  description:
    "Poll an extract job by id until terminal. Input: {id, poll_interval_ms?, timeout_ms?}. Returns the final snapshot plus waited_ms. No cancel or events endpoint exists for extract.",
  schema: WaitInputSchema,
  run: (input) =>
    validateWaitInput(input).pipe(
      Effect.flatMap((waitInput) => waitForJob(waitInput, extractCheck)),
      Effect.tap((snapshot) => syncTrackedRun(snapshot.id, snapshot.status)),
    ),
})

export const extractCommand = Command.make(
  "extract",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    optionalInputEffect({
      command: "firecrawl extract",
      field: "extract",
      hint:
        "extract requires a JSON input object (shorthand for extract start) or a lifecycle subcommand (start|check|inspect|wait)",
      schema: ExtractStartInputSchema,
      input,
      output,
      run: runExtractStart,
    }),
).pipe(
  Command.withDescription(
    "Firecrawl /v2/extract job orbit. No cancel/events endpoints exist; use check and wait. Prefer agent for new extraction work.",
  ),
  Command.withSubcommands([
    extractStartCommand,
    extractRunCommand,
    extractCheckCommand,
    extractInspectCommand,
    extractWaitCommand,
  ]),
)

/* ------------------------------------------------------------------------ */
/* interact                                                                  */
/* ------------------------------------------------------------------------ */

const runInteractExecute = (input: typeof InteractExecuteInputSchema.Type) =>
  validateInteractExecuteInput(input).pipe(Effect.flatMap(interactExecute))

const interactExecuteCommand = makeJsonCommand({
  name: "execute",
  commandName: "firecrawl interact execute",
  description:
    "Run a prompt or code in the browser session of a scrape job. Input: {id (data.metadata.scrapeId), prompt xor code, language?, timeout?}. Returns the provider result. Keyless free tier works.",
  schema: InteractExecuteInputSchema,
  run: runInteractExecute,
})

const interactStopCommand = makeJsonCommand({
  name: "stop",
  commandName: "firecrawl interact stop",
  description:
    "Stop the interactive browser session bound to a scrape job (DELETE /scrape/{id}/interact). Input: {id} (data.metadata.scrapeId). Returns a stopped marker.",
  schema: JobIdInputSchema,
  run: (input) => validateJobIdInput(input).pipe(Effect.flatMap(interactStop)),
})

export const interactCommand = Command.make(
  "interact",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    optionalInputEffect({
      command: "firecrawl interact",
      field: "interact",
      hint:
        "interact requires a JSON input object (shorthand for interact execute) or a subcommand (execute|stop); id is scrape data.metadata.scrapeId",
      schema: InteractExecuteInputSchema,
      input,
      output,
      run: runInteractExecute,
    }),
).pipe(
  Command.withDescription(
    "Interact with a scrape-bound browser session using prompt or code. Requires data.metadata.scrapeId from scrape.",
  ),
  Command.withSubcommands([interactExecuteCommand, interactStopCommand]),
)

/* ------------------------------------------------------------------------ */
/* research (Research Index, keyless)                                        */
/* ------------------------------------------------------------------------ */

const researchSearchPapersCommand = makeLocalBatchCommand({
  name: "search-papers",
  commandName: "firecrawl research search-papers",
  description:
    "Search ~43M arXiv/PubMed/bioRxiv/medRxiv abstracts (GET /search/research/papers). Input: {query, k?, authors?, categories?, from?, to?}. Returns ranked papers. Keyless; batch-capable.",
  schema: ResearchSearchPapersCommandInputSchema,
  validate: (input) => Effect.succeed(input),
  run: (input, concurrency) => runResearchCommand(input, concurrency, researchSearchPapers),
  after: trackPaperSources,
})

const researchInspectPaperCommand = makeLocalBatchCommand({
  name: "inspect-paper",
  commandName: "firecrawl research inspect-paper",
  description:
    "Get paper metadata by paperId or primaryId (GET /search/research/papers/{id}). Input: {id} e.g. arxiv:1706.03762. Returns title, abstract, authors, categories, dates, ids. Keyless.",
  schema: ResearchInspectPaperCommandInputSchema,
  validate: (input) => Effect.succeed(input),
  run: (input, concurrency) => runResearchCommand(input, concurrency, researchInspectPaper),
  after: trackPaperSources,
})

const researchReadPaperCommand = makeLocalBatchCommand({
  name: "read-paper",
  commandName: "firecrawl research read-paper",
  description:
    "Read the top full-text passages of a paper answering a question (GET /search/research/papers/{id}?query=). Input: {id, query, k? 1-50, default 4}. Keyless.",
  schema: ResearchReadPaperCommandInputSchema,
  validate: (input) => Effect.succeed(input),
  run: (input, concurrency) => runResearchCommand(input, concurrency, researchReadPaper),
  after: trackPaperSources,
})

const researchRelatedPapersCommand = makeLocalBatchCommand({
  name: "related-papers",
  commandName: "firecrawl research related-papers",
  description:
    "Expand a seed paper (GET /search/research/papers/{id}/similar). Input: {id, intent, mode? similar|citers|references, k?, anchor?, rerank?}. Returns papers ranked by intent. Keyless.",
  schema: ResearchRelatedPapersCommandInputSchema,
  validate: (input) => Effect.succeed(input),
  run: (input, concurrency) => runResearchCommand(input, concurrency, researchRelatedPapers),
  after: trackPaperSources,
})

export const researchCommand = Command.make("research").pipe(
  Command.withDescription(
    "Firecrawl Research Index (/v2/search/research): ~43M papers from arXiv, PubMed, bioRxiv, medRxiv. Works without FIRECRAWL_API_KEY.",
  ),
  Command.withSubcommands([
    researchSearchPapersCommand,
    researchInspectPaperCommand,
    researchReadPaperCommand,
    researchRelatedPapersCommand,
  ]),
)
