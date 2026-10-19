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
  fetchPages,
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
  FetchInputSchema,
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
  description: "Live web search (GET api.search.tinyfish.ai). One object or an ordered local array.",
  schema: SearchInputSchema,
  run: (input) => search(input),
})

export const fetchCommand = makeBatchJsonCommand({
  name: "fetch",
  commandName: "tinyfish fetch",
  description: "Fetch 1-10 URLs as markdown/html/json (POST api.fetch.tinyfish.ai). One object or an ordered local array.",
  schema: FetchInputSchema,
  run: (input) => fetchPages(input),
})

export const usageCommand = makeJsonCommand({
  name: "usage",
  commandName: "tinyfish usage",
  description: "Usage history for the search, fetch, or browser product",
  schema: UsageInputSchema,
  run: usage,
})

export const walletCommand = makeOptionalJsonCommand({
  name: "wallet",
  commandName: "tinyfish wallet",
  description: "Wallet balance, auto-reload state, and metered rates",
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
      description: "Create a remote browser session; returns session_id, cdp_url, base_url",
      schema: BrowserCreateInputSchema,
      run: browserCreate,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish browser inspect",
      description: "Inspect one session via the usage log (no get-session endpoint exists)",
      schema: BrowserSessionIdInputSchema,
      run: browserInspect,
    }),
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish browser list",
      description: "List browser sessions (GET /usage)",
      schema: BrowserListInputSchema,
      run: browserList,
    }),
    makeJsonCommand({
      name: "close",
      commandName: "tinyfish browser close",
      description: "Close a browser session (idempotent)",
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
      description: "Start async automation runs (POST /v1/automation/run-async). One object or an ordered local array.",
      schema: AgentStartInputSchema,
      run: (input) => agentStart(input),
    }),
    makeJsonCommand({
      name: "run",
      commandName: "tinyfish agent run",
      description: "Start an async run and poll until terminal or max_wait_seconds",
      schema: AgentRunInputSchema,
      run: agentRun,
    }),
    makeJsonCommand({
      name: "stream",
      commandName: "tinyfish agent stream",
      description: "Run via POST /v1/automation/run-sse and collect events until COMPLETE",
      schema: AgentStreamInputSchema,
      run: agentStream,
    }),
    makeJsonCommand({
      name: "check",
      commandName: "tinyfish agent check",
      description: "Get a run's status and result; records terminal state in the run registry",
      schema: AgentRunIdInputSchema,
      run: agentCheck,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish agent inspect",
      description: "Raw GET /v1/runs/{id} (steps, screenshots, video_url)",
      schema: AgentRunIdInputSchema,
      run: agentGet,
    }),
    makeJsonCommand({
      name: "wait",
      commandName: "tinyfish agent wait",
      description: "Poll an existing run until terminal or max_wait_seconds",
      schema: AgentWaitInputSchema,
      run: agentWait,
    }),
    makeJsonCommand({
      name: "cancel",
      commandName: "tinyfish agent cancel",
      description: "Cancel an async or SSE run",
      schema: AgentRunRefInputSchema,
      run: agentCancel,
    }),
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish agent list",
      description: "List runs with cursor pagination",
      schema: AgentListInputSchema,
      run: agentList,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "tinyfish agent events",
      description: "Report run-events support (none exists; use agent stream or webhooks)",
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
      description: "List browser context profiles",
      schema: EmptyInputSchema,
      run: () => profileList,
    }),
    makeJsonCommand({
      name: "create",
      commandName: "tinyfish profiles create",
      description: "Create a browser context profile",
      schema: ProfileCreateInputSchema,
      run: profileCreate,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish profiles inspect",
      description: "Get a profile with its stored domains",
      schema: ProfileIdInputSchema,
      run: profileInspect,
    }),
    makeJsonCommand({
      name: "update",
      commandName: "tinyfish profiles update",
      description: "Rename a profile, make it default, or change its proxy country",
      schema: ProfileUpdateInputSchema,
      run: profileUpdate,
    }),
    makeJsonCommand({
      name: "delete",
      commandName: "tinyfish profiles delete",
      description: "Delete a profile",
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
      description: "List vault connections",
      schema: EmptyInputSchema,
      run: () => vaultConnections,
    }),
    makeOptionalJsonCommand({
      name: "items",
      commandName: "tinyfish vault items",
      description: "List vault credential items (metadata only)",
      schema: EmptyInputSchema,
      run: () => vaultItems,
    }),
    makeOptionalJsonCommand({
      name: "sync",
      commandName: "tinyfish vault sync",
      description: "Re-sync vault items from connected providers",
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
      description: "Start an async research run (not idempotent)",
      schema: ResearchStartInputSchema,
      run: researchStart,
    }),
    makeJsonCommand({
      name: "run",
      commandName: "tinyfish research run",
      description: "Start a research run and poll until terminal or max_wait_seconds",
      schema: ResearchRunInputSchema,
      run: researchRun,
    }),
    makeJsonCommand({
      name: "check",
      commandName: "tinyfish research check",
      description: "Get status plus report and citations when complete",
      schema: ResearchIdInputSchema,
      run: researchCheck,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish research inspect",
      description: "Raw GET /v1/research-run/{id} (plan, evidence, iterations)",
      schema: ResearchIdInputSchema,
      run: researchGet,
    }),
    makeJsonCommand({
      name: "wait",
      commandName: "tinyfish research wait",
      description: "Poll an existing research run until terminal or max_wait_seconds",
      schema: ResearchWaitInputSchema,
      run: researchWait,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "tinyfish research events",
      description: "Read the run's SSE event stream for up to max_wait_seconds (resumable via last_event_id)",
      schema: ResearchEventsInputSchema,
      run: researchEvents,
    }),
    makeJsonCommand({
      name: "cancel",
      commandName: "tinyfish research cancel",
      description: "Cancel a research run (idempotent)",
      schema: ResearchIdInputSchema,
      run: researchCancel,
    }),
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish research list",
      description: "List research runs with cursor pagination",
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
      description: "Create a monitor; runs a baseline immediately",
      schema: MonitorCreateInputSchema,
      run: monitorCreate,
    }),
    makeOptionalJsonCommand({
      name: "list",
      commandName: "tinyfish monitor list",
      description: "List monitors",
      schema: EmptyInputSchema,
      run: () => monitorList,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "tinyfish monitor inspect",
      description: "Get one monitor",
      schema: MonitorIdInputSchema,
      run: monitorInspect,
    }),
    makeJsonCommand({
      name: "update",
      commandName: "tinyfish monitor update",
      description: "Pause/resume (status) or edit schedule_cron/name/purpose/webhook_url",
      schema: MonitorUpdateInputSchema,
      run: monitorUpdate,
    }),
    makeJsonCommand({
      name: "delete",
      commandName: "tinyfish monitor delete",
      description: "Delete a monitor",
      schema: MonitorIdInputSchema,
      run: monitorDelete,
    }),
    makeJsonCommand({
      name: "trigger",
      commandName: "tinyfish monitor trigger",
      description: "Run a monitor now (POST /v1/monitors/{id}/runs)",
      schema: MonitorIdInputSchema,
      run: monitorTrigger,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "tinyfish monitor events",
      description: "Report run-history support (none via REST; use webhooks)",
      schema: MonitorIdInputSchema,
      run: (input) => Effect.succeed(monitorEventsUnsupported(input)),
    }),
  ]),
)
