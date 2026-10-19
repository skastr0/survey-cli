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
  description: "Search the web with Exa (type auto|fast|instant|deep-lite|deep|deep-reasoning; neural rejected). Input: {query, numResults?, type?, category?, contents?, outputSchema?}. Returns ranked results with url/title/text.",
  schema: WebSearchInputSchema,
  run: webSearch,
})

export const codeContextCommand = makeBatchJsonCommand({
  name: "code-context",
  commandName: "exa code-context",
  description: "Fetch code snippets and docs context for a programming query via Exa POST /context. Input: {query, tokensNum? (dynamic or 50-100000), flags?}. Returns the context text plus the raw response.",
  schema: CodeContextInputSchema,
  run: codeContext,
})

export const contentsCommand = makeBatchJsonCommand({
  name: "contents",
  commandName: "exa contents",
  description: "Fetch page contents via Exa POST /contents for exactly one of ids/urls/url; options text, highlights, summary, extras, maxAgeHours (livecrawl deprecated). Returns per-page text/highlights/summary.",
  schema: ContentsInputSchema,
  run: contents,
})

export const crawlCommand = makeBatchJsonCommand({
  name: "crawl",
  commandName: "exa crawl",
  description: "Fetch one URL's fresh text via Exa /contents (maxAgeHours 0). Input: {url, maxCharacters? (default 2000)}. Prefer contents for highlights, summary, or subpages. Returns the raw contents response.",
  schema: CrawlInputSchema,
  run: crawl,
})

export const answerCommand = makeBatchJsonCommand({
  name: "answer",
  commandName: "exa answer",
  description: "Get a grounded answer with citations from Exa POST /answer. Input: {query, model?, text?, systemPrompt?, outputSchema?, stream?}. Returns the answer plus the raw response with citations.",
  schema: AnswerInputSchema,
  run: answer,
})

export const companyResearchCommand = makeBatchJsonCommand({
  name: "company-research",
  commandName: "exa company-research",
  description: "Search company-focused sources (Exa POST /search, type auto, category company, text up to 2000 chars). Input: {companyName, numResults?}. Returns ranked company pages.",
  schema: CompanyResearchInputSchema,
  run: companyResearch,
})

export const linkedinSearchCommand = makeBatchJsonCommand({
  name: "linkedin-search",
  commandName: "exa linkedin-search",
  description: "Search people or company profiles via Exa /search (profiles→people, companies→company, all→linkedin.com domain). Input: {query, searchType?, numResults?}. Returns ranked profile pages with text.",
  schema: LinkedinSearchInputSchema,
  run: linkedinSearch,
})

export const findSimilarCommand = makeBatchJsonCommand({
  name: "find-similar",
  commandName: "exa find-similar",
  description: "Find pages similar to a URL via Exa POST /findSimilar (deprecated upstream; prefer web-search). Input: {url, numResults?, includeDomains?, category?, contents?}. Returns ranked similar pages.",
  schema: FindSimilarInputSchema,
  run: findSimilar,
})

export const agentCommand = Command.make("agent").pipe(
  Command.withDescription("Manage asynchronous Exa Agent runs (POST /agent/runs): start, check, list, wait, events, stream, cancel, stop, delete"),
  Command.withSubcommands([
    makeJsonCommand({
      name: "start",
      commandName: "exa agent start",
      description: "Start an asynchronous Exa Agent run (POST /agent/runs; effort max sends agent-max-effort beta). Input: {query, effort?, outputSchema?, input?, dataSources?, budget?}. Returns the run id and status.",
      schema: AgentStartInputSchema,
      run: agentStart,
    }),
    makeJsonCommand({
      name: "run",
      commandName: "exa agent run",
      description: "Alias for agent start: start an asynchronous Exa Agent run. Input: {query, effort?, outputSchema?, input?, dataSources?, budget?}. Returns the run id and status.",
      schema: AgentStartInputSchema,
      run: agentStart,
    }),
    makeJsonCommand({
      name: "check",
      commandName: "exa agent check",
      description: "Fetch an Exa Agent run by id (GET /agent/runs/{id}) and sync the local run registry. Input: {id | runId}. Returns the raw run with status and results when finished.",
      schema: AgentIdInputSchema,
      run: agentCheck,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "exa agent inspect",
      description: "Alias for agent check: fetch an Exa Agent run by id and sync the local run registry. Input: {id | runId}. Returns the raw run with status.",
      schema: AgentIdInputSchema,
      run: agentCheck,
    }),
    makeJsonCommand({
      name: "list",
      commandName: "exa agent list",
      description: "List Exa Agent runs (GET /agent/runs). Input: {cursor?, limit? (1-100)}. Returns the raw paginated provider list.",
      schema: AgentListInputSchema,
      run: agentList,
    }),
    makeJsonCommand({
      name: "wait",
      commandName: "exa agent wait",
      description: "Poll an Exa Agent run until completed/canceled/failed. Input: {id | runId, intervalMs? (2000), timeoutMs? (180000)}. Returns the final status and run; fails with a timeout error otherwise.",
      schema: AgentWaitInputSchema,
      run: agentWait,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "exa agent events",
      description: "Fetch stored events for an Exa Agent run (GET /agent/runs/{id}/events). Input: {id | runId, cursor?, limit?}. Returns the raw paginated event list.",
      schema: AgentEventsInputSchema,
      run: agentEvents,
    }),
    makeJsonCommand({
      name: "stream",
      commandName: "exa agent stream",
      description: "Collect an Exa Agent run's events as server-sent events until the stream ends. Input: {id | runId, lastEventId?}. Returns the parsed SSE events.",
      schema: AgentStreamInputSchema,
      run: agentStream,
    }),
    makeJsonCommand({
      name: "cancel",
      commandName: "exa agent cancel",
      description: "Cancel a queued or running Exa Agent run (POST /agent/runs/{id}/cancel). Input: {id | runId}. Returns the raw provider response.",
      schema: AgentIdInputSchema,
      run: agentCancel,
    }),
    makeJsonCommand({
      name: "stop",
      commandName: "exa agent stop",
      description: "Stop a max-effort Exa Agent run early and keep results so far (POST /agent/runs/{id}/stop, agent-max-effort beta). Input: {id | runId}. Returns the raw provider response.",
      schema: AgentIdInputSchema,
      run: agentStop,
    }),
    makeJsonCommand({
      name: "delete",
      commandName: "exa agent delete",
      description: "Delete a stored Exa Agent run (DELETE /agent/runs/{id}). Input: {id | runId}. Returns the raw provider response.",
      schema: AgentIdInputSchema,
      run: agentDelete,
    }),
  ]),
)

export const deepResearchCommand = Command.make("deep-research").pipe(
  Command.withDescription("Manage Exa deep research tasks, backed by Agent runs: start, check, list, wait, events, stream, cancel"),
  Command.withSubcommands([
    makeJsonCommand({
      name: "start",
      commandName: "exa deep-research start",
      description: "Start an asynchronous Exa research task; wraps agent start (instructions→query, model rejected). Input: {instructions | query, effort?, outputSchema?}. Returns the run id and status.",
      schema: DeepResearchStartInputSchema,
      run: deepResearchStart,
    }),
    makeJsonCommand({
      name: "run",
      commandName: "exa deep-research run",
      description: "Alias for deep-research start: start an asynchronous Exa research task via agent runs. Input: {instructions | query, effort?, outputSchema?}. Returns the run id and status.",
      schema: DeepResearchStartInputSchema,
      run: deepResearchStart,
    }),
    makeJsonCommand({
      name: "check",
      commandName: "exa deep-research check",
      description: "Fetch a research task by id; wraps agent check. Input: {researchId | taskId | id | runId}. Returns the raw run with status and results when finished.",
      schema: DeepResearchCheckInputSchema,
      run: deepResearchCheck,
    }),
    makeJsonCommand({
      name: "inspect",
      commandName: "exa deep-research inspect",
      description: "Alias for deep-research check: fetch a research task by id. Input: {researchId | taskId | id | runId}. Returns the raw run with status.",
      schema: DeepResearchCheckInputSchema,
      run: deepResearchInspect,
    }),
    makeJsonCommand({
      name: "list",
      commandName: "exa deep-research list",
      description: "List research tasks; wraps agent list (GET /agent/runs). Input: {cursor?, limit? (1-100)}. Returns the raw paginated provider list.",
      schema: DeepResearchListInputSchema,
      run: deepResearchList,
    }),
    makeJsonCommand({
      name: "wait",
      commandName: "exa deep-research wait",
      description: "Poll a research task until completed/canceled/failed. Input: {researchId | taskId | id | runId, intervalMs? (2000), timeoutMs? (180000)}. Returns the final status and run.",
      schema: DeepResearchWaitInputSchema,
      run: deepResearchWait,
    }),
    makeJsonCommand({
      name: "events",
      commandName: "exa deep-research events",
      description: "Fetch a research task's event log; wraps agent events. Input: {researchId | taskId | id | runId, cursor?, limit?}. Returns the raw paginated event list.",
      schema: DeepResearchEventsInputSchema,
      run: deepResearchEvents,
    }),
    makeJsonCommand({
      name: "stream",
      commandName: "exa deep-research stream",
      description: "Collect a research task's events as server-sent events; wraps agent stream. Input: {researchId | taskId | id | runId, lastEventId?}. Returns the parsed SSE events.",
      schema: DeepResearchStreamInputSchema,
      run: deepResearchStream,
    }),
    makeJsonCommand({
      name: "cancel",
      commandName: "exa deep-research cancel",
      description: "Cancel a queued or running research task; wraps agent cancel. Input: {researchId | taskId | id | runId}. Returns the raw provider response.",
      schema: DeepResearchCheckInputSchema,
      run: deepResearchCancel,
    }),
  ]),
)

registerContracts([
  {
    command: "exa web-search",
    description:
      "Search the web with Exa (type auto|fast|instant|deep-lite|deep|deep-reasoning; neural rejected). Input: {query, numResults?, type?, category?, contents?, outputSchema?}. Returns ranked results with url/title/text.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }; each data = keyed: { auth_mode: 'keyed', context?, output?, data: raw Exa /search response { results[{ id, url, title, text? }], requestId, ... } }; keyless: { auth_mode: 'public', endpoint, ignored_options[], data: { results[{ url, title?, publishedDate?, author?, text }] } }; stream: { event_count, events[], raw? }",
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
    description:
      "Fetch code snippets and docs context for a programming query via Exa POST /context. Input: {query, tokensNum? (dynamic or 50-100000), flags?}. Returns the context text plus the raw response.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }; each data = { context (the response's `response` text), data: raw Exa /context response { response, ... } }",
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
      "Fetch page contents via Exa POST /contents for exactly one of ids/urls/url; options text, highlights, summary, extras, maxAgeHours (livecrawl deprecated). Returns per-page text/highlights/summary.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }; each data = keyed: raw Exa /contents response { results[{ id, url, title?, text?, highlights?, summary? }], statuses[{ id, status, source }], ... } plus auth_mode: 'keyed'; keyless (urls only): { auth_mode: 'public', endpoint, ignored_options[], results[{ url, title?, publishedDate?, author?, text }] }",
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
    description:
      "Fetch one URL's fresh text via Exa /contents (maxAgeHours 0). Input: {url, maxCharacters? (default 2000)}. Prefer contents for highlights, summary, or subpages. Returns the raw contents response.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }; each data = raw Exa /contents response { results[{ id, url, title?, text }], statuses[], ... }",
    inputSchema: CrawlInputSchema,
    batch: true,
    examples: [{ name: "crawl-page", input: { url: "https://example.com", maxCharacters: 3000 } }],
  },
  {
    command: "exa answer",
    description:
      "Get a grounded answer with citations from Exa POST /answer. Input: {query, model?, text?, systemPrompt?, outputSchema?, stream?}. Returns the answer plus the raw response with citations.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }; each data = { answer, data: raw Exa /answer response { answer, citations[{ url, title, ... }], ... } }; stream: { event_count, events[], raw? }",
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
    description:
      "Search company-focused sources (Exa POST /search, type auto, category company, text up to 2000 chars). Input: {companyName, numResults?}. Returns ranked company pages.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }; each data = raw Exa /search response { results[{ id, url, title, text? }], requestId, ... }",
    inputSchema: CompanyResearchInputSchema,
    batch: true,
    examples: [{ name: "company", input: { companyName: "Acme", numResults: 5 } }],
  },
  {
    command: "exa linkedin-search",
    description:
      "Search people or company profiles via Exa /search (profiles→people, companies→company, all→linkedin.com domain). Input: {query, searchType?, numResults?}. Returns ranked profile pages with text.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }; each data = raw Exa /search response { results[{ id, url, title, text? }], requestId, ... }",
    inputSchema: LinkedinSearchInputSchema,
    batch: true,
    examples: [{ name: "profiles", input: { query: "Jane Doe", searchType: "profiles" } }],
  },
  {
    command: "exa find-similar",
    description:
      "Find pages similar to a URL via Exa POST /findSimilar (deprecated upstream; prefer web-search). Input: {url, numResults?, includeDomains?, category?, contents?}. Returns ranked similar pages.",
    output:
      "Batch summary { outcome, total, success_count, error_count, concurrency, results[{ index, ok, data?, error? }] }; each data = raw Exa /findSimilar response { results[{ url, title, text? }], ... }",
    inputSchema: FindSimilarInputSchema,
    batch: true,
    examples: [{ name: "similar", input: { url: "https://example.com/article" } }],
  },
  {
    command: "exa agent start",
    description:
      "Start an asynchronous Exa Agent run (POST /agent/runs; effort max sends agent-max-effort beta). Input: {query, effort?, outputSchema?, input?, dataSources?, budget?}. Returns the run id and status.",
    output:
      "{ runId, researchId (same id), status, data: raw Exa agent run { id, status, ... } }; poll with agent wait/check",
    inputSchema: AgentStartInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-start", input: { query: "Research the Exa API", effort: "medium" } }],
  },
  {
    command: "exa agent run",
    description:
      "Alias for agent start: start an asynchronous Exa Agent run. Input: {query, effort?, outputSchema?, input?, dataSources?, budget?}. Returns the run id and status.",
    output:
      "{ runId, researchId (same id), status, data: raw Exa agent run { id, status, ... } }",
    inputSchema: AgentStartInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-run", input: { query: "Research the Exa API" } }],
  },
  {
    command: "exa agent check",
    description:
      "Fetch an Exa Agent run by id (GET /agent/runs/{id}) and sync the local run registry. Input: {id | runId}. Returns the raw run with status and results when finished.",
    output:
      "raw Exa agent run { id, status, ... }",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-check", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent inspect",
    description:
      "Alias for agent check: fetch an Exa Agent run by id and sync the local run registry. Input: {id | runId}. Returns the raw run with status.",
    output:
      "raw Exa agent run { id, status, ... }",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-inspect", input: { runId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent list",
    description:
      "List Exa Agent runs (GET /agent/runs). Input: {cursor?, limit? (1-100)}. Returns the raw paginated provider list.",
    output:
      "raw Exa list response { data[], hasMore, nextCursor, ... }",
    inputSchema: AgentListInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-list", input: { limit: 10 } }],
  },
  {
    command: "exa agent wait",
    description:
      "Poll an Exa Agent run until completed/canceled/failed. Input: {id | runId, intervalMs? (2000), timeoutMs? (180000)}. Returns the final status and run; fails with a timeout error otherwise.",
    output:
      "{ runId, researchId, status, elapsed_ms, data: raw Exa agent run { id, status, ... } }",
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
    description:
      "Fetch stored events for an Exa Agent run (GET /agent/runs/{id}/events). Input: {id | runId, cursor?, limit?}. Returns the raw paginated event list.",
    output:
      "raw Exa event list { object, data[{ id, event, data, createdAt }], hasMore, nextCursor }",
    inputSchema: AgentEventsInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-events", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent stream",
    description:
      "Collect an Exa Agent run's events as server-sent events until the stream ends. Input: {id | runId, lastEventId?}. Returns the parsed SSE events.",
    output:
      "{ runId, researchId, event_count, events[{ event?, id?, retry?, data? }], raw? (unparsed text when no events) }",
    inputSchema: AgentStreamInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-stream", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent cancel",
    description:
      "Cancel a queued or running Exa Agent run (POST /agent/runs/{id}/cancel). Input: {id | runId}. Returns the raw provider response.",
    output:
      "raw Exa agent run { id, status, ... }",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-cancel", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent stop",
    description:
      "Stop a max-effort Exa Agent run early and keep results so far (POST /agent/runs/{id}/stop, agent-max-effort beta). Input: {id | runId}. Returns the raw provider response.",
    output:
      "raw Exa agent run { id, status, ... }",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-stop", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa agent delete",
    description:
      "Delete a stored Exa Agent run (DELETE /agent/runs/{id}). Input: {id | runId}. Returns the raw provider response.",
    output:
      "raw Exa DELETE /agent/runs/{id} response (provider-defined)",
    inputSchema: AgentIdInputSchema,
    orbit: AGENT_ORBIT,
    examples: [{ name: "agent-delete", input: { id: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research start",
    description:
      "Start an asynchronous Exa research task; wraps agent start (instructions→query, model rejected). Input: {instructions | query, effort?, outputSchema?}. Returns the run id and status.",
    output:
      "{ runId, researchId (same id), status, data: raw Exa agent run { id, status, ... } }",
    inputSchema: DeepResearchStartInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "start", input: { instructions: "Research the Exa API" } }],
  },
  {
    command: "exa deep-research run",
    description:
      "Alias for deep-research start: start an asynchronous Exa research task via agent runs. Input: {instructions | query, effort?, outputSchema?}. Returns the run id and status.",
    output:
      "{ runId, researchId (same id), status, data: raw Exa agent run { id, status, ... } }",
    inputSchema: DeepResearchStartInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "run", input: { instructions: "Research the Exa API" } }],
  },
  {
    command: "exa deep-research check",
    description:
      "Fetch a research task by id; wraps agent check. Input: {researchId | taskId | id | runId}. Returns the raw run with status and results when finished.",
    output:
      "raw Exa agent run { id, status, ... }",
    inputSchema: DeepResearchCheckInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "check", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research inspect",
    description:
      "Alias for deep-research check: fetch a research task by id. Input: {researchId | taskId | id | runId}. Returns the raw run with status.",
    output:
      "raw Exa agent run { id, status, ... }",
    inputSchema: DeepResearchCheckInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "inspect", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research list",
    description:
      "List research tasks; wraps agent list (GET /agent/runs). Input: {cursor?, limit? (1-100)}. Returns the raw paginated provider list.",
    output:
      "raw Exa list response { data[], hasMore, nextCursor, ... }",
    inputSchema: DeepResearchListInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "list", input: { limit: 10 } }],
  },
  {
    command: "exa deep-research wait",
    description:
      "Poll a research task until completed/canceled/failed. Input: {researchId | taskId | id | runId, intervalMs? (2000), timeoutMs? (180000)}. Returns the final status and run.",
    output:
      "{ runId, researchId, status, elapsed_ms, data: raw Exa agent run { id, status, ... } }",
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
    description:
      "Fetch a research task's event log; wraps agent events. Input: {researchId | taskId | id | runId, cursor?, limit?}. Returns the raw paginated event list.",
    output:
      "raw Exa event list { object, data[{ id, event, data, createdAt }], hasMore, nextCursor }",
    inputSchema: DeepResearchEventsInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "events", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research stream",
    description:
      "Collect a research task's events as server-sent events; wraps agent stream. Input: {researchId | taskId | id | runId, lastEventId?}. Returns the parsed SSE events.",
    output:
      "{ runId, researchId, event_count, events[{ event?, id?, retry?, data? }], raw? }",
    inputSchema: DeepResearchStreamInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "stream", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
  {
    command: "exa deep-research cancel",
    description:
      "Cancel a queued or running research task; wraps agent cancel. Input: {researchId | taskId | id | runId}. Returns the raw provider response.",
    output:
      "raw Exa agent run { id, status, ... }",
    inputSchema: DeepResearchCheckInputSchema,
    orbit: DEEP_RESEARCH_ORBIT,
    examples: [{ name: "cancel", input: { researchId: "agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8" } }],
  },
])
