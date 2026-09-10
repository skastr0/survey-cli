import { Command } from "effect/unstable/cli"

import { makeBatchJsonCommand, makeJsonCommand } from "../../core/command"
import { registerContracts } from "../../core/discovery"
import {
  agentCancel,
  agentCheck,
  agentDelete,
  agentEvents,
  agentList,
  agentStart,
  agentStop,
  agentStream,
  agentWait,
  answer,
  codeContext,
  companyResearch,
  contents,
  crawl,
  deepResearchCancel,
  deepResearchCheck,
  deepResearchEvents,
  deepResearchInspect,
  deepResearchList,
  deepResearchStart,
  deepResearchStream,
  deepResearchWait,
  findSimilar,
  linkedinSearch,
  webSearch,
} from "./api"
import {
  AgentEventsInputSchema,
  AgentIdInputSchema,
  AgentListInputSchema,
  AgentStartInputSchema,
  AgentStreamInputSchema,
  AgentWaitInputSchema,
  AnswerInputSchema,
  CodeContextInputSchema,
  CompanyResearchInputSchema,
  ContentsInputSchema,
  CrawlInputSchema,
  DeepResearchCheckInputSchema,
  DeepResearchEventsInputSchema,
  DeepResearchListInputSchema,
  DeepResearchStartInputSchema,
  DeepResearchStreamInputSchema,
  DeepResearchWaitInputSchema,
  FindSimilarInputSchema,
  LinkedinSearchInputSchema,
  WebSearchInputSchema,
} from "./schemas"

const AGENT_ORBIT = [
  "start",
  "run",
  "check",
  "inspect",
  "list",
  "wait",
  "events",
  "stream",
  "cancel",
  "stop",
  "delete",
] as const

const DEEP_RESEARCH_ORBIT = [
  "start",
  "run",
  "check",
  "inspect",
  "list",
  "wait",
  "events",
  "stream",
  "cancel",
] as const

export const webSearchCommand = makeBatchJsonCommand({
  name: "web-search",
  commandName: "exa web-search",
  description: "Search the web with Exa",
  schema: WebSearchInputSchema,
  run: webSearch,
})

export const codeContextCommand = makeBatchJsonCommand({
  name: "code-context",
  commandName: "exa code-context",
  description: "Fetch Exa code context",
  schema: CodeContextInputSchema,
  run: codeContext,
})

export const contentsCommand = makeBatchJsonCommand({
  name: "contents",
  commandName: "exa contents",
  description: "Fetch Exa contents for ids or URLs",
  schema: ContentsInputSchema,
  run: contents,
})

export const crawlCommand = makeBatchJsonCommand({
  name: "crawl",
  commandName: "exa crawl",
  description: "Crawl a URL with the Exa contents API",
  schema: CrawlInputSchema,
  run: crawl,
})

export const answerCommand = makeBatchJsonCommand({
  name: "answer",
  commandName: "exa answer",
  description: "Get a grounded Exa answer",
  schema: AnswerInputSchema,
  run: answer,
})

export const companyResearchCommand = makeBatchJsonCommand({
  name: "company-research",
  commandName: "exa company-research",
  description: "Research a company with Exa",
  schema: CompanyResearchInputSchema,
  run: companyResearch,
})

export const linkedinSearchCommand = makeBatchJsonCommand({
  name: "linkedin-search",
  commandName: "exa linkedin-search",
  description: "Search LinkedIn with Exa",
  schema: LinkedinSearchInputSchema,
  run: linkedinSearch,
})

export const findSimilarCommand = makeBatchJsonCommand({
  name: "find-similar",
  commandName: "exa find-similar",
  description: "Find pages similar to a URL (deprecated upstream)",
  schema: FindSimilarInputSchema,
  run: findSimilar,
})

export const agentCommand = Command.make("agent").pipe(
  Command.withDescription("Manage Exa Agent runs"),
  Command.withSubcommands([
    makeJsonCommand({
      name: "start",
      commandName: "exa agent start",
      description: "Start an Agent run from JSON input",
      schema: AgentStartInputSchema,
      run: agentStart,
    }),
    makeJsonCommand({
      name: "run",
      commandName: "exa agent run",
      description: "Alias for starting an Agent run from JSON input",
      schema: AgentStartInputSchema,
      run: agentStart,
    }),
    makeJsonCommand({
      name: "check",
      commandName: "exa agent check",
      description: "Check an Agent run from JSON input",
      schema: AgentIdInputSchema,
      run: agentCheck,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "exa agent inspect",
      description: "Alias for checking an Agent run from JSON input",
      schema: AgentIdInputSchema,
      run: agentCheck,
    }),
    makeJsonCommand({
      name: "list",
      commandName: "exa agent list",
      description: "List Agent runs from JSON input",
      schema: AgentListInputSchema,
      run: agentList,
    }),
    makeJsonCommand({
      name: "wait",
      commandName: "exa agent wait",
      description: "Wait for an Agent run to reach a terminal status",
      schema: AgentWaitInputSchema,
      run: agentWait,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "exa agent events",
      description: "Fetch stored events for an Agent run",
      schema: AgentEventsInputSchema,
      run: agentEvents,
    }),
    makeJsonCommand({
      name: "stream",
      commandName: "exa agent stream",
      description: "Collect provider SSE events for an Agent run",
      schema: AgentStreamInputSchema,
      run: agentStream,
    }),
    makeJsonCommand({
      name: "cancel",
      commandName: "exa agent cancel",
      description: "Cancel a queued or running Agent run",
      schema: AgentIdInputSchema,
      run: agentCancel,
    }),
    makeJsonCommand({
      name: "stop",
      commandName: "exa agent stop",
      description: "Stop a max-effort Agent run early",
      schema: AgentIdInputSchema,
      run: agentStop,
    }),
    makeJsonCommand({
      name: "delete",
      commandName: "exa agent delete",
      description: "Delete a stored Agent run",
      schema: AgentIdInputSchema,
      run: agentDelete,
    }),
  ]),
)

export const deepResearchCommand = Command.make("deep-research").pipe(
  Command.withDescription("Manage Exa deep research tasks via Agent runs"),
  Command.withSubcommands([
    makeJsonCommand({
      name: "start",
      commandName: "exa deep-research start",
      description: "Start a deep research task from JSON input",
      schema: DeepResearchStartInputSchema,
      run: deepResearchStart,
    }),
    makeJsonCommand({
      name: "run",
      commandName: "exa deep-research run",
      description: "Alias for starting a deep research task from JSON input",
      schema: DeepResearchStartInputSchema,
      run: deepResearchStart,
    }),
    makeJsonCommand({
      name: "check",
      commandName: "exa deep-research check",
      description: "Check a deep research task from JSON input",
      schema: DeepResearchCheckInputSchema,
      run: deepResearchCheck,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "exa deep-research inspect",
      description: "Alias for checking a deep research task from JSON input",
      schema: DeepResearchCheckInputSchema,
      run: deepResearchInspect,
    }),
    makeJsonCommand({
      name: "list",
      commandName: "exa deep-research list",
      description: "List deep research tasks from JSON input",
      schema: DeepResearchListInputSchema,
      run: deepResearchList,
    }),
    makeJsonCommand({
      name: "wait",
      commandName: "exa deep-research wait",
      description: "Wait for a deep research task to reach a terminal status",
      schema: DeepResearchWaitInputSchema,
      run: deepResearchWait,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "exa deep-research events",
      description: "Fetch the detailed event log for a deep research task",
      schema: DeepResearchEventsInputSchema,
      run: deepResearchEvents,
    }),
    makeJsonCommand({
      name: "stream",
      commandName: "exa deep-research stream",
      description: "Collect provider SSE events for a deep research task",
      schema: DeepResearchStreamInputSchema,
      run: deepResearchStream,
    }),
    makeJsonCommand({
      name: "cancel",
      commandName: "exa deep-research cancel",
      description: "Cancel a queued or running deep research task",
      schema: DeepResearchCheckInputSchema,
      run: deepResearchCancel,
    }),
  ]),
)

registerContracts([
  {
    command: "exa web-search",
    description: "Search the web with Exa (auto|fast|instant|deep-lite|deep|deep-reasoning; neural rejected)",
    inputSchema: WebSearchInputSchema,
    batch: true,
    examples: [
      { name: "single-search", input: { query: "Effect Schema", numResults: 5 } },
      { name: "batch-search", input: [{ query: "Effect Schema" }, { query: "Effect CLI" }] },
      {
        name: "deep-reasoning",
        input: {
          query: "Compare Exa search types for agent research",
          type: "deep-reasoning",
          outputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
        },
      },
    ],
  },
  {
    command: "exa code-context",
    description: "Fetch Exa code context (tokensNum: dynamic or 50-100000)",
    inputSchema: CodeContextInputSchema,
    batch: true,
    examples: [
      { name: "react-hooks", input: { query: "React useState examples", tokensNum: 5000 } },
      { name: "dynamic-tokens", input: { query: "Effect Schema decodeUnknown", tokensNum: "dynamic" } },
    ],
  },
  {
    command: "exa contents",
    description:
      "Fetch page contents for document ids or URLs; exactly one of ids/urls/url; livecrawl deprecated vs maxAgeHours",
    inputSchema: ContentsInputSchema,
    batch: true,
    examples: [
      { name: "contents-url", input: { url: "https://example.com", text: true } },
      {
        name: "contents-ids",
        input: {
          ids: ["https://example.com"],
          highlights: { query: "API contract" },
          summary: { query: "What does this page describe?" },
        },
      },
    ],
  },
  {
    command: "exa crawl",
    description: "Thin /contents wrapper for one URL; prefer contents for highlights, summary, or subpages",
    inputSchema: CrawlInputSchema,
    batch: true,
    examples: [{ name: "crawl-page", input: { url: "https://example.com", maxCharacters: 3000 } }],
  },
  {
    command: "exa answer",
    description: "Get a grounded Exa answer with citations",
    inputSchema: AnswerInputSchema,
    batch: true,
    examples: [
      { name: "factual-answer", input: { query: "What is the capital of France?" } },
      {
        name: "structured-answer",
        input: {
          query: "Latest SpaceX valuation",
          model: "exa",
          outputSchema: {
            type: "object",
            properties: { valuation: { type: "string" } },
            required: ["valuation"],
          },
        },
      },
    ],
  },
  {
    command: "exa company-research",
    description: "Search company-focused sources (POST /search type auto, category company)",
    inputSchema: CompanyResearchInputSchema,
    batch: true,
    examples: [{ name: "company", input: { companyName: "Acme", numResults: 5 } }],
  },
  {
    command: "exa linkedin-search",
    description: "Search people or company profiles (profiles→people, companies→company, all→linkedin.com)",
    inputSchema: LinkedinSearchInputSchema,
    batch: true,
    examples: [{ name: "profiles", input: { query: "Jane Doe", searchType: "profiles" } }],
  },
  {
    command: "exa find-similar",
    description: "Find pages similar to a URL; Exa marks POST /findSimilar deprecated — prefer web-search",
    inputSchema: FindSimilarInputSchema,
    batch: true,
    examples: [{ name: "similar", input: { url: "https://example.com/article" } }],
  },
  {
    command: "exa agent",
    description: "Manage Exa Agent runs",
    orbit: AGENT_ORBIT,
  },
  {
    command: "exa agent start",
    description: "Start an asynchronous Exa Agent run (effort max sends agent-max-effort beta)",
    inputSchema: AgentStartInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-start", input: { query: "Research the Exa API", effort: "medium" } }],
  },
  {
    command: "exa agent run",
    description: "Alias for starting an asynchronous Exa Agent run",
    inputSchema: AgentStartInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-run", input: { query: "Research the Exa API" } }],
  },
  {
    command: "exa agent check",
    description: "Inspect an Agent run by id (id or runId)",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-check", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent inspect",
    description: "Alias for inspecting an Agent run by id",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-inspect", input: { runId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent list",
    description: "List Agent runs",
    inputSchema: AgentListInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-list", input: { limit: 10 } }],
  },
  {
    command: "exa agent wait",
    description: "Poll an Agent run until it reaches a terminal status",
    inputSchema: AgentWaitInputSchema,
    orbit: AGENT_ORBIT,
    examples: [
      {
        name: "agent-wait",
        input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8", intervalMs: 2000, timeoutMs: 180000 },
      },
    ],
  },
  {
    command: "exa agent events",
    description: "Fetch stored Agent run events",
    inputSchema: AgentEventsInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-events", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent stream",
    description: "Collect Agent run events as provider SSE",
    inputSchema: AgentStreamInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-stream", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent cancel",
    description: "Cancel a queued or running Agent run",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-cancel", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent stop",
    description: "Stop a max-effort Agent run early and keep results so far (sends agent-max-effort beta)",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-stop", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent delete",
    description: "Delete a stored Agent run",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-delete", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research",
    description: "Manage Exa deep research tasks (deprecated aliases of Agent runs)",
    orbit: DEEP_RESEARCH_ORBIT,
  },
  {
    command: "exa deep-research start",
    description:
      "Start an asynchronous Exa research task; aliases agent start (instructions→query, model rejected)",
    inputSchema: DeepResearchStartInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "start", input: { instructions: "Research the Exa API" } }],
  },
  {
    command: "exa deep-research run",
    description: "Alias for starting an asynchronous Exa research task",
    inputSchema: DeepResearchStartInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "run", input: { instructions: "Research the Exa API" } }],
  },
  {
    command: "exa deep-research check",
    description: "Inspect a research task by id (researchId, taskId, id, or runId)",
    inputSchema: DeepResearchCheckInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "check", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research inspect",
    description: "Alias for inspecting a research task by id",
    inputSchema: DeepResearchCheckInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "inspect", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research list",
    description: "List research tasks",
    inputSchema: DeepResearchListInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "list", input: { limit: 10 } }],
  },
  {
    command: "exa deep-research wait",
    description: "Poll a research task until it reaches a terminal status",
    inputSchema: DeepResearchWaitInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [
      {
        name: "wait",
        input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8", intervalMs: 2000, timeoutMs: 180000 },
      },
    ],
  },
  {
    command: "exa deep-research events",
    description: "Fetch research event log data",
    inputSchema: DeepResearchEventsInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "events", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research stream",
    description: "Collect provider SSE updates for a research task",
    inputSchema: DeepResearchStreamInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "stream", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research cancel",
    description: "Cancel a queued or running research task (aliases agent cancel)",
    inputSchema: DeepResearchCheckInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "cancel", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
])
