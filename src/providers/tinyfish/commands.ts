import { Effect, Option, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import {
  applyOutputPolicy,
  makeBatchJsonCommand,
  makeJsonCommand,
  optionalJsonInputArg,
  outputFlag,
} from "../../core/command"
import { loadJsonInput } from "../../core/json"
import { executeJsonCommand } from "../../core/output"
import {
  agentCancel,
  agentCheck,
  agentEventsUnsupported,
  agentList,
  agentRun,
  agentStart,
  agentStream,
  agentWait,
  browserClose,
  browserCreate,
  browserInspect,
  browserList,
  fetchAndRemember,
  monitorCreate,
  monitorDelete,
  monitorEventsUnsupported,
  monitorInspect,
  monitorList,
  monitorTrigger,
  monitorUpdate,
  profileCreate,
  profileDelete,
  profileInspect,
  profileList,
  profileUpdate,
  researchCancel,
  researchCheck,
  researchEvents,
  researchGet,
  researchList,
  researchRun,
  researchStart,
  researchWait,
  search,
  usage,
  vaultConnections,
  vaultItems,
  vaultSync,
  wallet,
  agentGet,
} from "./api"
import {
  AgentListInputSchema,
  AgentCheckInputSchema,
  AgentRunIdInputSchema,
  AgentRunInputSchema,
  AgentRunRefInputSchema,
  AgentStartInputSchema,
  AgentStreamInputSchema,
  AgentWaitInputSchema,
  BrowserCreateInputSchema,
  BrowserListInputSchema,
  BrowserSessionIdInputSchema,
  EmptyInputSchema,
  FetchCommandInputSchema,
  MonitorCreateInputSchema,
  MonitorIdInputSchema,
  MonitorUpdateInputSchema,
  ProfileCreateInputSchema,
  ProfileIdInputSchema,
  ProfileUpdateInputSchema,
  ResearchEventsInputSchema,
  ResearchIdInputSchema,
  ResearchListInputSchema,
  ResearchRunInputSchema,
  ResearchStartInputSchema,
  ResearchWaitInputSchema,
  SearchInputSchema,
  UsageInputSchema,
} from "./schemas"

/** JSON command whose payload may be omitted (defaults to `{}`), for list/read operations. */
const makeOptionalJsonCommand = <S extends Schema.Constraint, E, R>(options: {
  readonly name: string
  readonly commandName: string
  readonly description: string
  readonly schema: S
  readonly run: (input: S["Type"]) => Effect.Effect<unknown, E, R>
}) =>
  Command.make(
    options.name,
    { input: optionalJsonInputArg, output: outputFlag },
    ({ input, output }) =>
      executeJsonCommand(
        options.commandName,
        loadJsonInput(options.schema, Option.getOrElse(input, () => "{}")).pipe(
          Effect.flatMap(options.run),
          Effect.flatMap((data) => applyOutputPolicy({ command: options.commandName, mode: output, data })),
        ),
      ),
  ).pipe(Command.withDescription(options.description))

/* ---- search / fetch / usage ---- */

export const searchCommand = makeBatchJsonCommand({
  name: "search",
  commandName: "tinyfish search",
  description: "Live Google-index web search (GET api.search.tinyfish.ai; free 12,000/day, 30/min). Input: {query, location?, language?, include_domains?, domain_type?, recency_minutes?, page?}; object or array. Returns ranked results.",
  schema: SearchInputSchema,
  run: (input) => search(input),
})

export const fetchCommand = makeBatchJsonCommand({
  name: "fetch",
  commandName: "tinyfish fetch",
  description: "Fetch 1-10 URLs (POST api.fetch.tinyfish.ai; free 1,000/day) as markdown, html, or json tree. Input: {urls, format?, links?, page_metadata?, store?, tags?}; object or array. Returns per-URL results/errors; text kept in corpus.",
  schema: FetchCommandInputSchema,
  run: (input) => fetchAndRemember(input),
})

export const usageCommand = makeJsonCommand({
  name: "usage",
  commandName: "tinyfish usage",
  description: "Paged usage history for one product (GET <product host>/usage). Input: {product: search|fetch|browser, status?, start_after?, end_before?, limit?, page?, session_id? (browser only)}. Returns the raw usage page.",
  schema: UsageInputSchema,
  run: usage,
})

export const walletCommand = makeOptionalJsonCommand({
  name: "wallet",
  commandName: "tinyfish wallet",
  description: "Wallet balance, auto-reload state, and metered rates (GET /v1/wallet). Input optional: {}. Returns the raw wallet object.",
  schema: EmptyInputSchema,
  run: () => wallet,
})

/* ---- browser ---- */

export const browserCommand = Command.make("browser").pipe(
  Command.withDescription("Remote CDP browser sessions (create, inspect, list, close)"),
  Command.withSubcommands([
    makeOptionalJsonCommand({
      name: "create",
      commandName: "tinyfish browser create",
      description: "Create a remote CDP browser session (POST api.browser.tinyfish.ai; billed per browser-minute). Input optional: {url?, timeout_seconds?, proxy_config?}. Returns session_id, cdp_url (wss, for connectOverCDP), base_url.",
      schema: BrowserCreateInputSchema,
      run: browserCreate,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish browser inspect",
      description: "Inspect one browser session by session_id via the usage log (TinyFish has no get-session endpoint). Input: {session_id}. Returns the matching usage entry or null.",
      schema: BrowserSessionIdInputSchema,
      run: browserInspect,
    }),
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish browser list",
      description: "List browser sessions (GET api.browser.tinyfish.ai/usage). Input optional: {status?: running|ended, start_after?, end_before?, limit?, page?}. Returns the raw usage page.",
      schema: BrowserListInputSchema,
      run: browserList,
    }),
    makeJsonCommand({
      name: "close",
      commandName: "tinyfish browser close",
      description: "Close a browser session by session_id (DELETE /{session_id}, idempotent 204). Input: {session_id}. Returns a close confirmation.",
      schema: BrowserSessionIdInputSchema,
      run: browserClose,
    }),
  ]),
)

/* ---- agent ---- */

export const agentCommand = Command.make("agent").pipe(
  Command.withDescription("Goal-based web automation runs (start, run, stream, check, inspect, wait, cancel, list, events)"),
  Command.withSubcommands([
    makeBatchJsonCommand({
      name: "start",
      commandName: "tinyfish agent start",
      description: "Start async goal-based browser-agent runs (POST /v1/automation/run-async; billed per step). Input: {url, goal, browser_profile?, output_schema?}; object or array. Returns a run_id per run, recorded in the run registry.",
      schema: AgentStartInputSchema,
      run: (input) => agentStart(input),
    }),
    makeJsonCommand({
      name: "run",
      commandName: "tinyfish agent run",
      description: "Start an async browser-agent run and poll GET /v1/runs/{id} until terminal or max_wait_seconds (default 300). Input: {url, goal, max_wait_seconds?, store?}. Returns the run with status and result.",
      schema: AgentRunInputSchema,
      run: agentRun,
    }),
    makeJsonCommand({
      name: "stream",
      commandName: "tinyfish agent stream",
      description: "Run via POST /v1/automation/run-sse and collect STARTED/STREAMING_URL/PROGRESS/COMPLETE events until COMPLETE or max_wait_seconds. Input: {url, goal, max_wait_seconds?}. Returns status, result, and events.",
      schema: AgentStreamInputSchema,
      run: agentStream,
    }),
    makeJsonCommand({
      name: "check",
      commandName: "tinyfish agent check",
      description: "Get a run's status and result by run_id. Terminal runs update the run registry; COMPLETED results are stored in the corpus as tinyfish://agent/runs/<run_id> (store:false opts out). Input: {run_id, tags?}.",
      schema: AgentCheckInputSchema,
      run: agentCheck,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish agent inspect",
      description: "Raw run detail by run_id (GET /v1/runs/{id}) including steps, screenshots, and video_url. Input: {run_id, screenshots?: base64|url|none, html?: url|none}. Returns the provider run object.",
      schema: AgentRunIdInputSchema,
      run: agentGet,
    }),
    makeJsonCommand({
      name: "wait",
      commandName: "tinyfish agent wait",
      description: "Poll an existing run by run_id until COMPLETED/FAILED/CANCELLED or max_wait_seconds (default 300). Input: {run_id, max_wait_seconds?, poll_interval_seconds?}. Returns the run snapshot; timed_out:true if not terminal.",
      schema: AgentWaitInputSchema,
      run: agentWait,
    }),
    makeJsonCommand({
      name: "cancel",
      commandName: "tinyfish agent cancel",
      description: "Cancel an async or SSE run by run_id (POST /v1/runs/{id}/cancel); sync runs cannot be cancelled. Input: {run_id}. Returns the run's new status.",
      schema: AgentRunRefInputSchema,
      run: agentCancel,
    }),
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish agent list",
      description: "List runs (GET /v1/runs) with status/goal/date filters and cursor pagination. Input optional: {status?, goal?, created_after?, created_before?, sort_direction?, cursor?, limit?}. Returns runs and pagination.",
      schema: AgentListInputSchema,
      run: agentList,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "tinyfish agent events",
      description: "Report run-events support for a run_id. TinyFish has no run-events endpoint; returns supported:false pointing at agent stream and webhooks. Input: {run_id}.",
      schema: AgentRunRefInputSchema,
      run: (input) => Effect.succeed(agentEventsUnsupported(input)),
    }),
  ]),
)

/* ---- profiles / vault ---- */

export const profilesCommand = Command.make("profiles").pipe(
  Command.withDescription("Browser Context Profiles (persistent cookies/storage for agent runs)"),
  Command.withSubcommands([
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish profiles list",
      description: "List Browser Context Profiles (GET /v1/profiles). Input optional: {}. Returns the raw profile list.",
      schema: EmptyInputSchema,
      run: () => profileList,
    }),
    makeJsonCommand({
      name: "create",
      commandName: "tinyfish profiles create",
      description: "Create a Browser Context Profile (POST /v1/profiles); pass profile_id + use_profile:true to agent runs to reuse sign-ins. Input: {name, set_as_default?, proxy_country_code?}. Returns the created profile.",
      schema: ProfileCreateInputSchema,
      run: profileCreate,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish profiles inspect",
      description: "Get a profile by profile_id with its stored domains (GET /v1/profiles/{id}). Input: {profile_id}. Returns the raw profile.",
      schema: ProfileIdInputSchema,
      run: profileInspect,
    }),
    makeJsonCommand({
      name: "update",
      commandName: "tinyfish profiles update",
      description: "Update a profile by profile_id: rename, set as default, or change proxy country (PATCH /v1/profiles/{id}). Input: {profile_id, name?, set_as_default?, proxy_country_code?}. Returns the updated profile.",
      schema: ProfileUpdateInputSchema,
      run: profileUpdate,
    }),
    makeJsonCommand({
      name: "delete",
      commandName: "tinyfish profiles delete",
      description: "Delete a profile by profile_id (DELETE /v1/profiles/{id}). Input: {profile_id}. Returns the provider's delete response.",
      schema: ProfileIdInputSchema,
      run: profileDelete,
    }),
  ]),
)

export const vaultCommand = Command.make("vault").pipe(
  Command.withDescription("Read-only views of connected password-manager vaults"),
  Command.withSubcommands([
    makeOptionalJsonCommand({
      name: "connections",
      commandName: "tinyfish vault connections",
      description: "List connected password-manager vaults such as 1Password and Bitwarden (GET /v1/vault/connections). Input optional: {}. Returns the raw connection list.",
      schema: EmptyInputSchema,
      run: () => vaultConnections,
    }),
    makeOptionalJsonCommand({
      name: "items",
      commandName: "tinyfish vault items",
      description: "List vault credential items, metadata only (GET /v1/vault/items); use itemId in agent credential_item_ids. Input optional: {}. Returns the raw item list.",
      schema: EmptyInputSchema,
      run: () => vaultItems,
    }),
    makeOptionalJsonCommand({
      name: "sync",
      commandName: "tinyfish vault sync",
      description: "Re-sync vault items from connected providers (POST /v1/vault/items/sync). Input optional: {}. Returns the provider's sync response.",
      schema: EmptyInputSchema,
      run: () => vaultSync,
    }),
  ]),
)

/* ---- research ---- */

export const researchCommand = Command.make("research").pipe(
  Command.withDescription("Research API (beta): search, evaluate, cited report"),
  Command.withSubcommands([
    makeJsonCommand({
      name: "start",
      commandName: "tinyfish research start",
      description: "Start a beta research run (POST /v1/automation/run-research-async) for a cited report: deep 5-20 min, max 5-45 min. Cap 5 concurrent, 5 per Pacific day; not idempotent. Input: {query, mode?}. Returns research_run_id.",
      schema: ResearchStartInputSchema,
      run: researchStart,
    }),
    makeJsonCommand({
      name: "run",
      commandName: "tinyfish research run",
      description: "Start a research run and poll until terminal or max_wait_seconds (default 1800). Input: {query, mode?, domain_filter?, max_wait_seconds?, poll_interval_seconds?}. Returns status, report, and citations.",
      schema: ResearchRunInputSchema,
      run: researchRun,
    }),
    makeJsonCommand({
      name: "check",
      commandName: "tinyfish research check",
      description: "Get a research run's status by research_run_id; when COMPLETED returns the report (deep_result.result) and citations (URL strings). Input: {research_run_id}.",
      schema: ResearchIdInputSchema,
      run: researchCheck,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish research inspect",
      description: "Raw research run by research_run_id (GET /v1/research-run/{id}): research_plan, evidence with claims, iterations. Input: {research_run_id}. Returns the provider run object.",
      schema: ResearchIdInputSchema,
      run: researchGet,
    }),
    makeJsonCommand({
      name: "wait",
      commandName: "tinyfish research wait",
      description: "Poll an existing research run by research_run_id until terminal or max_wait_seconds (default 1800). Input: {research_run_id, max_wait_seconds?, poll_interval_seconds?}. Returns report and citations; timed_out:true if not done.",
      schema: ResearchWaitInputSchema,
      run: researchWait,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "tinyfish research events",
      description: "Read a research run's SSE stream (GET /v1/research-run/{id}/events) for up to max_wait_seconds (default 30). Input: {research_run_id, last_event_id?}. Disconnecting never cancels the run; resume with last_event_id.",
      schema: ResearchEventsInputSchema,
      run: researchEvents,
    }),
    makeJsonCommand({
      name: "cancel",
      commandName: "tinyfish research cancel",
      description: "Cancel a research run by research_run_id (POST /v1/research-run/{id}/cancel, idempotent). Input: {research_run_id}. Returns the provider's cancel response.",
      schema: ResearchIdInputSchema,
      run: researchCancel,
    }),
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish research list",
      description: "List research runs (GET /v1/research-run) with cursor pagination. Input optional: {status?, query?, created_after?, created_before?, sort_direction?, cursor?, limit?}. Returns runs and pagination.",
      schema: ResearchListInputSchema,
      run: researchList,
    }),
  ]),
)

/* ---- monitors ---- */

export const monitorCommand = Command.make("monitor").pipe(
  Command.withDescription("Page (fetch) and Topic (search) monitors on a cron schedule"),
  Command.withSubcommands([
    makeJsonCommand({
      name: "create",
      commandName: "tinyfish monitor create",
      description: "Create a Page (type=fetch, config.url) or Topic (type=search, config.query) monitor on a 5-field cron (UTC unless CRON_TZ=<IANA> prefix); a baseline runs now. Max 50; topic runs >=30 min apart. Input: {type, config, schedule_cron, name?}.",
      schema: MonitorCreateInputSchema,
      run: monitorCreate,
    }),
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish monitor list",
      description: "List monitors (GET /v1/monitors). Input optional: {}. Returns the raw monitor list.",
      schema: EmptyInputSchema,
      run: () => monitorList,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish monitor inspect",
      description: "Get one monitor by id (GET /v1/monitors/{id}). Input: {id}. Returns the raw monitor object.",
      schema: MonitorIdInputSchema,
      run: monitorInspect,
    }),
    makeJsonCommand({
      name: "update",
      commandName: "tinyfish monitor update",
      description: "Update a monitor by id (PATCH /v1/monitors/{id}): status-only {id, status: active|paused} or edits {id, schedule_cron?, name?, purpose?, webhook_url?} (null clears); type/config immutable. Returns the updated monitor.",
      schema: MonitorUpdateInputSchema,
      run: monitorUpdate,
    }),
    makeJsonCommand({
      name: "delete",
      commandName: "tinyfish monitor delete",
      description: "Delete a monitor by id (DELETE /v1/monitors/{id}). Input: {id}. Returns the provider's delete response.",
      schema: MonitorIdInputSchema,
      run: monitorDelete,
    }),
    makeJsonCommand({
      name: "trigger",
      commandName: "tinyfish monitor trigger",
      description: "Run a monitor now by id (POST /v1/monitors/{id}/runs); topic monitors may return 409 RETRY_REQUIRED. Input: {id}. Returns the provider's trigger response.",
      schema: MonitorIdInputSchema,
      run: monitorTrigger,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "tinyfish monitor events",
      description: "Report run-history support for a monitor id. TinyFish has no REST run-history endpoint; returns supported:false pointing at webhooks and trigger. Input: {id}.",
      schema: MonitorIdInputSchema,
      run: (input) => Effect.succeed(monitorEventsUnsupported(input)),
    }),
  ]),
)
