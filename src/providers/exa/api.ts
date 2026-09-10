import { Effect } from "effect"

import { requestJson, requestText } from "../../core/http"
import { CommandInputError, JobWaitTimeoutError } from "../../core/errors"
import { extractUrls, recordRun, recordSources, updateRun } from "../../core/runs"
import { Store, type RunStatus } from "../../core/store"
import {
  UnknownRecord,
  type AgentEventsInput,
  type AgentIdInput,
  type AgentListInput,
  type AgentStartInput,
  type AgentStreamInput,
  type AgentWaitInput,
  type AnswerInput,
  type CodeContextInput,
  type CompanyResearchInput,
  type ContentsInput,
  type ContentsOptions,
  type CrawlInput,
  type DeepResearchEventsInput,
  type DeepResearchIdInput,
  type DeepResearchListInput,
  type DeepResearchStartInput,
  type DeepResearchStreamInput,
  type DeepResearchWaitInput,
  type FindSimilarInput,
  type LinkedinSearchInput,
  type WebSearchInput,
} from "./schemas"

const DEFAULT_NUM_RESULTS = 8
const DEFAULT_MAX_CHARACTERS = 2000
const DEFAULT_CODE_TOKENS = 5000
const DEFAULT_SIMILAR_RESULTS = 10
const DEFAULT_WAIT_INTERVAL_MS = 2000
const DEFAULT_WAIT_TIMEOUT_MS = 180_000
const DYNAMIC_HIGHLIGHTS_BETA = "dynamic-highlights-2026-08-28"
const AGENT_MAX_EFFORT_BETA = "agent-max-effort-2026-07-27"
const DEEP_SEARCH_TYPES = new Set(["deep-lite", "deep", "deep-reasoning"])
const ENTITY_CATEGORIES = new Set(["company", "people"])

const INTEGRATION = {
  webSearch: "exa-cli-web-search",
  codeContext: "exa-cli-code-context",
  contents: "exa-cli-contents",
  crawl: "exa-cli-crawling",
  answer: "exa-cli-answer",
  companyResearch: "exa-cli-company-research",
  linkedinSearch: "exa-cli-linkedin-search",
  findSimilar: "exa-cli-find-similar",
  agent: "exa-cli-agent",
} as const

const asTextArray = (value: string | ReadonlyArray<string> | undefined) =>
  typeof value === "string" ? [value] : value

const omitUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(omitUndefined)
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .map(([key, nested]) => [key, omitUndefined(nested)]),
    )
  }

  return value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const highlightsNeedBeta = (highlights: unknown) => {
  if (!isRecord(highlights)) {
    return false
  }

  return highlights.dynamic === true || highlights.verbosity !== undefined
}

const betaHeaders = (...tokens: Array<string | undefined>) => {
  const unique = [...new Set(tokens.filter((token): token is string => Boolean(token)))]
  return unique.length > 0 ? { "Exa-Beta": unique.join(",") } : undefined
}

const withHeaders = (integration: string, ...tokens: Array<string | undefined>) => ({
  "x-exa-integration": integration,
  ...betaHeaders(...tokens),
})

const validateNonEmpty = (field: string, value: string) =>
  value.trim().length === 0
    ? Effect.fail(
        new CommandInputError({
          field,
          message: `${field} must not be empty`,
        }),
      )
    : Effect.void

const validatePositiveInteger = (field: string, value: number | undefined) =>
  value !== undefined && (!Number.isInteger(value) || value <= 0)
    ? Effect.fail(
        new CommandInputError({
          field,
          message: `${field} must be a positive integer`,
        }),
      )
    : Effect.void

const validateIntegerRange = (field: string, value: number | undefined, min: number, max: number) =>
  value !== undefined && (!Number.isInteger(value) || value < min || value > max)
    ? Effect.fail(
        new CommandInputError({
          field,
          message: `${field} must be an integer between ${min} and ${max}`,
        }),
      )
    : Effect.void

const validatePositiveNumber = (field: string, value: number | undefined) =>
  value !== undefined && value <= 0
    ? Effect.fail(
        new CommandInputError({
          field,
          message: `${field} must be positive`,
        }),
      )
    : Effect.void

const validateUrl = (field: string, value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: () =>
      new CommandInputError({
        field,
        message: `${field} must be a valid URL`,
      }),
  }).pipe(Effect.asVoid)

const validateUserLocation = (value: string | undefined) =>
  value !== undefined && !/^[A-Za-z]{2}$/.test(value)
    ? Effect.fail(
        new CommandInputError({
          field: "userLocation",
          message: "userLocation must be a two-letter ISO country code",
        }),
      )
    : Effect.void

const phraseFilterItems = (value: string | ReadonlyArray<string>) =>
  typeof value === "string" ? [value] : [...value]

const validatePhraseFilter = (field: string, value: string | ReadonlyArray<string> | undefined) => {
  if (value === undefined) {
    return Effect.void
  }

  const items = phraseFilterItems(value)
  if (items.length !== 1) {
    return Effect.fail(
      new CommandInputError({
        field,
        message: `${field} must contain exactly 1 string of at most 5 words`,
      }),
    )
  }

  const words = items[0]?.trim().split(/\s+/).filter((word) => word.length > 0) ?? []
  if (words.length === 0 || words.length > 5) {
    return Effect.fail(
      new CommandInputError({
        field,
        message: `${field} must contain exactly 1 string of at most 5 words`,
      }),
    )
  }

  return Effect.void
}

const validateEntityCategoryFilters = (input: {
  readonly category?: string | undefined
  readonly startPublishedDate?: string | undefined
  readonly endPublishedDate?: string | undefined
  readonly excludeDomains?: ReadonlyArray<string> | undefined
  readonly includeText?: string | ReadonlyArray<string> | undefined
  readonly excludeText?: string | ReadonlyArray<string> | undefined
}) => {
  if (input.category === "financial report" && input.excludeText !== undefined) {
    return Effect.fail(
      new CommandInputError({
        field: "excludeText",
        message: "financial report does not support excludeText",
      }),
    )
  }

  if (!input.category || !ENTITY_CATEGORIES.has(input.category)) {
    return Effect.void
  }

  const unsupported = [
    input.startPublishedDate ? "startPublishedDate" : undefined,
    input.endPublishedDate ? "endPublishedDate" : undefined,
    input.excludeDomains ? "excludeDomains" : undefined,
    input.includeText ? "includeText" : undefined,
    input.excludeText ? "excludeText" : undefined,
  ].filter((field): field is string => field !== undefined)

  if (unsupported.length > 0) {
    return Effect.fail(
      new CommandInputError({
        field: "category",
        message: `${input.category} does not support ${unsupported.join(", ")}`,
      }),
    )
  }

  return Effect.void
}

const validateContentsOptions = (contents: ContentsOptions | undefined, prefix = "") =>
  Effect.gen(function* () {
    if (!contents) {
      return
    }

    const field = (name: string) => (prefix.length > 0 ? `${prefix}${name}` : name)
    const text = contents.text
    if (text && typeof text === "object") {
      yield* validateIntegerRange(field("text.maxCharacters"), text.maxCharacters, 1, 10000)
    }

    const highlights = contents.highlights
    if (highlights && typeof highlights === "object") {
      yield* validateIntegerRange(field("highlights.maxCharacters"), highlights.maxCharacters, 1, 10000)
      if (highlights.dynamic === true && highlights.maxCharacters !== undefined) {
        yield* Effect.fail(
          new CommandInputError({
            field: field("highlights.dynamic"),
            message: "highlights.dynamic is not compatible with highlights.maxCharacters",
          }),
        )
      }
    }

    yield* validateIntegerRange(field("livecrawlTimeout"), contents.livecrawlTimeout, 1, 90000)
    yield* validateIntegerRange(field("maxAgeHours"), contents.maxAgeHours, -1, 720)
    yield* validateIntegerRange(field("subpages"), contents.subpages, 0, 100)
    if (contents.livecrawl !== undefined && contents.maxAgeHours !== undefined) {
      yield* Effect.fail(
        new CommandInputError({
          field: field("livecrawl"),
          message: "Do not send livecrawl and maxAgeHours together; prefer maxAgeHours",
        }),
      )
    }
  })

const firstNonEmpty = (...values: Array<string | undefined>) => {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value
    }
  }

  return undefined
}

const resolveAgentRunId = (input: {
  readonly id?: string | undefined
  readonly runId?: string | undefined
  readonly researchId?: string | undefined
  readonly taskId?: string | undefined
}) =>
  Effect.gen(function* () {
    const runId = firstNonEmpty(input.id, input.runId, input.researchId, input.taskId)

    if (!runId) {
      return yield* Effect.fail(
        new CommandInputError({
          field: "id",
          message: "id, runId, researchId, or taskId must not be empty",
        }),
      )
    }

    return runId
  })

const extractStatus = (data: unknown) =>
  data && typeof data === "object" && "status" in data && typeof data.status === "string"
    ? data.status
    : undefined

const extractId = (data: unknown) =>
  data && typeof data === "object" && "id" in data && typeof data.id === "string" ? data.id : undefined

const isTerminalRunStatus = (status: string | undefined) =>
  status === "completed" || status === "canceled" || status === "cancelled" || status === "failed"

const toRunStatus = (status: string | undefined): RunStatus =>
  status === "completed"
    ? "succeeded"
    : status === "canceled" || status === "cancelled"
      ? "canceled"
      : status === "failed"
        ? "failed"
        : status === "running"
          ? "running"
          : "queued"

/** Best-effort sync of the local run registry with a remote agent run status. */
const syncRunStatus = (remoteId: string, status: string | undefined) =>
  status === undefined
    ? Effect.void
    : Effect.gen(function* () {
        const store = yield* Store
        const existing = yield* store.findRunByRemote("exa", remoteId)
        yield* updateRun(existing?.id, { status: toRunStatus(status), remoteId })
      }).pipe(Effect.catch(() => Effect.void))

const parseSse = (text: string) =>
  text
    .split(/\n\s*\n/g)
    .map((chunk) => {
      const event: Record<string, unknown> = {}
      const dataLines: string[] = []

      for (const line of chunk.split(/\r?\n/g)) {
        if (line.startsWith("event:")) {
          event.event = line.slice("event:".length).trim()
        } else if (line.startsWith("id:")) {
          event.id = line.slice("id:".length).trim()
        } else if (line.startsWith("retry:")) {
          event.retry = Number(line.slice("retry:".length).trim())
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim())
        }
      }

      if (dataLines.length === 0 && Object.keys(event).length === 0) {
        return undefined
      }

      const dataText = dataLines.join("\n")
      if (dataText.length > 0) {
        try {
          event.data = JSON.parse(dataText) as unknown
        } catch {
          event.data = dataText
        }
      }

      return event
    })
    .filter((event): event is Record<string, unknown> => event !== undefined)

const resolveSearchContents = (input: WebSearchInput): ContentsOptions => {
  const contents: ContentsOptions = {
    ...(input.contents ?? {}),
    ...(input.livecrawl !== undefined && input.contents?.livecrawl === undefined
      ? { livecrawl: input.livecrawl }
      : {}),
    ...(input.contextMaxCharacters !== undefined && input.contents?.context === undefined
      ? { context: { maxCharacters: input.contextMaxCharacters } }
      : {}),
  }

  const hasContents =
    contents.text !== undefined ||
    contents.highlights !== undefined ||
    contents.summary !== undefined ||
    contents.extras !== undefined ||
    contents.context !== undefined ||
    contents.livecrawl !== undefined ||
    contents.livecrawlTimeout !== undefined ||
    contents.maxAgeHours !== undefined ||
    contents.subpages !== undefined ||
    contents.subpageTarget !== undefined

  if (!hasContents) {
    return { text: true }
  }

  if (input.contents === undefined && contents.text === undefined) {
    return { ...contents, text: true }
  }

  return contents
}

const collectedSse = (runId: string, text: string) => {
  const events = parseSse(text)
  return {
    runId,
    researchId: runId,
    event_count: events.length,
    events,
    ...(events.length === 0 && text.trim().length > 0 ? { raw: text } : {}),
  }
}

export const webSearch = Effect.fn("exa.webSearch")(function* (input: WebSearchInput) {
  yield* validateNonEmpty("query", input.query)
  yield* validateIntegerRange("numResults", input.numResults, 1, 100)
  yield* validateIntegerRange("contextMaxCharacters", input.contextMaxCharacters, 1, 10000)
  yield* validateUserLocation(input.userLocation)
  yield* validateEntityCategoryFilters(input)
  yield* validatePhraseFilter("includeText", input.includeText)
  yield* validatePhraseFilter("excludeText", input.excludeText)
  const contents = resolveSearchContents(input)
  yield* validateContentsOptions(contents, "contents.")

  if (input.type === "neural") {
    return yield* Effect.fail(
      new CommandInputError({
        field: "type",
        message: "neural is no longer a public search type. Use auto, fast, or instant.",
      }),
    )
  }

  const type = input.type ?? "auto"
  if (input.additionalQueries && !DEEP_SEARCH_TYPES.has(type)) {
    yield* Effect.fail(
      new CommandInputError({
        field: "additionalQueries",
        message: "additionalQueries is only valid with type deep-lite, deep, or deep-reasoning",
      }),
    )
  }

  if (input.additionalQueries && (input.additionalQueries.length < 1 || input.additionalQueries.length > 10)) {
    yield* Effect.fail(
      new CommandInputError({
        field: "additionalQueries",
        message: "additionalQueries must contain between 1 and 10 queries",
      }),
    )
  }

  if (input.stream === true && input.outputSchema === undefined) {
    yield* Effect.fail(
      new CommandInputError({
        field: "stream",
        message: "stream requires outputSchema",
      }),
    )
  }

  const body = omitUndefined({
    query: input.query,
    type,
    numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
    contents,
    category: input.category,
    includeDomains: input.includeDomains,
    excludeDomains: input.excludeDomains,
    startPublishedDate: input.startPublishedDate,
    endPublishedDate: input.endPublishedDate,
    includeText: asTextArray(input.includeText),
    excludeText: asTextArray(input.excludeText),
    userLocation: input.userLocation,
    moderation: input.moderation,
    additionalQueries: input.additionalQueries,
    outputSchema: input.outputSchema,
    systemPrompt: input.systemPrompt,
    stream: input.stream === true ? true : undefined,
  })

  const beta = highlightsNeedBeta(contents.highlights) ? DYNAMIC_HIGHLIGHTS_BETA : undefined

  if (input.stream === true) {
    const text = yield* requestText({
      provider: "exa",
      method: "POST",
      path: "/search",
      body,
      headers: {
        accept: "text/event-stream",
        ...withHeaders(INTEGRATION.webSearch, beta),
      },
    })
    const events = parseSse(text)
    return {
      event_count: events.length,
      events,
      ...(events.length === 0 && text.trim().length > 0 ? { raw: text } : {}),
    }
  }

  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: "/search",
    body,
    headers: withHeaders(INTEGRATION.webSearch, beta),
    responseSchema: UnknownRecord,
  })

  const result = {
    context: isRecord(data) && "context" in data ? data.context : undefined,
    output: isRecord(data) && "output" in data ? data.output : undefined,
    data,
  }
  yield* recordSources("exa", extractUrls(result))
  return result
})

export const codeContext = Effect.fn("exa.codeContext")(function* (input: CodeContextInput) {
  yield* validateNonEmpty("query", input.query)
  if (input.query.length > 2000) {
    yield* Effect.fail(
      new CommandInputError({
        field: "query",
        message: "query must be at most 2000 characters",
      }),
    )
  }

  const tokensNum = input.tokensNum ?? DEFAULT_CODE_TOKENS
  if (typeof tokensNum === "number") {
    yield* validateIntegerRange("tokensNum", tokensNum, 50, 100000)
  }

  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: "/context",
    body: omitUndefined({
      query: input.query,
      tokensNum,
      flags: input.flags,
    }),
    headers: withHeaders(INTEGRATION.codeContext),
    responseSchema: UnknownRecord,
  })

  return {
    context: isRecord(data) && "response" in data ? data.response : undefined,
    data,
  }
})

export const contents = Effect.fn("exa.contents")(function* (input: ContentsInput) {
  const selected = [input.ids, input.urls, input.url].filter((value) => value !== undefined)
  if (selected.length !== 1) {
    yield* Effect.fail(
      new CommandInputError({
        field: "ids",
        message: "Provide exactly one of ids, urls, or url",
      }),
    )
  }

  if (input.ids) {
    if (input.ids.length < 1 || input.ids.length > 100) {
      yield* Effect.fail(
        new CommandInputError({
          field: "ids",
          message: "ids must contain between 1 and 100 values",
        }),
      )
    }
    yield* Effect.forEach(input.ids, (id) => validateNonEmpty("ids", id), { concurrency: 1, discard: true })
  }

  if (input.urls) {
    if (input.urls.length < 1 || input.urls.length > 100) {
      yield* Effect.fail(
        new CommandInputError({
          field: "urls",
          message: "urls must contain between 1 and 100 values",
        }),
      )
    }
    yield* Effect.forEach(input.urls, (url) => validateUrl("urls", url), { concurrency: 1, discard: true })
  }

  if (input.url) {
    yield* validateNonEmpty("url", input.url)
    yield* validateUrl("url", input.url)
  }

  yield* validatePositiveInteger("maxCharacters", input.maxCharacters)
  const contentsOptions: ContentsOptions = {
    text: input.text ?? (input.maxCharacters !== undefined ? { maxCharacters: input.maxCharacters } : undefined),
    highlights: input.highlights,
    summary: input.summary,
    extras: input.extras,
    context: input.context,
    livecrawl: input.livecrawl,
    livecrawlTimeout: input.livecrawlTimeout,
    maxAgeHours: input.maxAgeHours,
    subpages: input.subpages,
    subpageTarget: input.subpageTarget,
  }

  const hasContents =
    contentsOptions.text !== undefined ||
    contentsOptions.highlights !== undefined ||
    contentsOptions.summary !== undefined ||
    contentsOptions.extras !== undefined ||
    contentsOptions.context !== undefined ||
    contentsOptions.livecrawl !== undefined ||
    contentsOptions.livecrawlTimeout !== undefined ||
    contentsOptions.maxAgeHours !== undefined ||
    contentsOptions.subpages !== undefined ||
    contentsOptions.subpageTarget !== undefined

  const resolvedContents = hasContents ? contentsOptions : { ...contentsOptions, text: true as const }

  yield* validateContentsOptions(resolvedContents)

  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: "/contents",
    body: omitUndefined({
      ids: input.ids,
      urls: input.urls ?? (input.url ? [input.url] : undefined),
      ...resolvedContents,
    }),
    headers: withHeaders(
      INTEGRATION.contents,
      highlightsNeedBeta(resolvedContents.highlights) ? DYNAMIC_HIGHLIGHTS_BETA : undefined,
    ),
    responseSchema: UnknownRecord,
  })
  yield* recordSources("exa", extractUrls(data))
  return data
})

export const crawl = Effect.fn("exa.crawl")(function* (input: CrawlInput) {
  yield* validateNonEmpty("url", input.url)
  yield* validateUrl("url", input.url)
  yield* validateIntegerRange("maxCharacters", input.maxCharacters, 1, 10000)

  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: "/contents",
    body: {
      urls: [input.url],
      text: { maxCharacters: input.maxCharacters ?? DEFAULT_MAX_CHARACTERS },
      maxAgeHours: 0,
    },
    headers: withHeaders(INTEGRATION.crawl),
    responseSchema: UnknownRecord,
  })
  yield* recordSources("exa", extractUrls(data))
  return data
})

export const answer = Effect.fn("exa.answer")(function* (input: AnswerInput) {
  yield* validateNonEmpty("query", input.query)
  yield* validateUserLocation(input.userLocation)

  const body = omitUndefined({
    query: input.query,
    text: input.text,
    model: input.model,
    systemPrompt: input.systemPrompt,
    userLocation: input.userLocation,
    outputSchema: input.outputSchema,
    stream: input.stream === true ? true : undefined,
  })

  if (input.stream === true) {
    const text = yield* requestText({
      provider: "exa",
      method: "POST",
      path: "/answer",
      body,
      headers: {
        accept: "text/event-stream",
        ...withHeaders(INTEGRATION.answer),
      },
    })
    const events = parseSse(text)
    return {
      event_count: events.length,
      events,
      ...(events.length === 0 && text.trim().length > 0 ? { raw: text } : {}),
    }
  }

  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: "/answer",
    body,
    headers: withHeaders(INTEGRATION.answer),
    responseSchema: UnknownRecord,
  })

  const result = {
    answer: isRecord(data) && "answer" in data ? data.answer : undefined,
    data,
  }
  yield* recordSources("exa", extractUrls(result))
  return result
})

export const companyResearch = Effect.fn("exa.companyResearch")(function* (
  input: CompanyResearchInput,
) {
  yield* validateNonEmpty("companyName", input.companyName)
  yield* validateIntegerRange("numResults", input.numResults, 1, 100)

  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: "/search",
    body: {
      query: input.companyName,
      type: "auto",
      category: "company",
      numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
      contents: {
        text: { maxCharacters: DEFAULT_MAX_CHARACTERS },
      },
    },
    headers: withHeaders(INTEGRATION.companyResearch),
    responseSchema: UnknownRecord,
  })
  yield* recordSources("exa", extractUrls(data))
  return data
})

export const linkedinSearch = Effect.fn("exa.linkedinSearch")(function* (
  input: LinkedinSearchInput,
) {
  yield* validateNonEmpty("query", input.query)
  yield* validateIntegerRange("numResults", input.numResults, 1, 100)

  const searchType = input.searchType ?? "all"
  const body =
    searchType === "profiles"
      ? {
          query: input.query,
          type: "auto",
          category: "people",
          numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
          contents: { text: { maxCharacters: DEFAULT_MAX_CHARACTERS } },
        }
      : searchType === "companies"
        ? {
            query: input.query,
            type: "auto",
            category: "company",
            numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
            contents: { text: { maxCharacters: DEFAULT_MAX_CHARACTERS } },
          }
        : {
            query: `${input.query} LinkedIn`,
            type: "auto",
            numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
            contents: { text: { maxCharacters: DEFAULT_MAX_CHARACTERS } },
            includeDomains: ["linkedin.com"],
          }

  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: "/search",
    body,
    headers: withHeaders(INTEGRATION.linkedinSearch),
    responseSchema: UnknownRecord,
  })
  yield* recordSources("exa", extractUrls(data))
  return data
})

export const findSimilar = Effect.fn("exa.findSimilar")(function* (input: FindSimilarInput) {
  yield* validateNonEmpty("url", input.url)
  yield* validateUrl("url", input.url)
  yield* validateIntegerRange("numResults", input.numResults, 1, 100)
  yield* validateEntityCategoryFilters(input)
  yield* validateContentsOptions(input.contents, "contents.")

  const contentsOptions = input.contents ?? { text: true }

  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: "/findSimilar",
    body: omitUndefined({
      url: input.url,
      numResults: input.numResults ?? DEFAULT_SIMILAR_RESULTS,
      includeDomains: input.includeDomains,
      excludeDomains: input.excludeDomains,
      startPublishedDate: input.startPublishedDate,
      endPublishedDate: input.endPublishedDate,
      category: input.category,
      excludeSourceDomain: input.excludeSourceDomain,
      contents: contentsOptions,
    }),
    headers: withHeaders(
      INTEGRATION.findSimilar,
      highlightsNeedBeta(contentsOptions.highlights) ? DYNAMIC_HIGHLIGHTS_BETA : undefined,
    ),
    responseSchema: UnknownRecord,
  })
  yield* recordSources("exa", extractUrls(data))
  return data
})

const startAgentRun = (input: AgentStartInput, kind: "exa.agent" | "exa.deep-research") =>
  Effect.gen(function* () {
    yield* validateNonEmpty("query", input.query)
    if (input.dataSources && input.dataSources.length > 5) {
      yield* Effect.fail(
        new CommandInputError({
          field: "dataSources",
          message: "dataSources must contain at most 5 providers",
        }),
      )
    }

    const effort = input.effort ?? "auto"
    if (input.budget !== undefined && effort !== "auto" && effort !== "max") {
      yield* Effect.fail(
        new CommandInputError({
          field: "budget",
          message: "budget is only valid with effort auto or max",
        }),
      )
    }

    if (input.budget?.maxCostDollars !== undefined) {
      yield* validatePositiveNumber("budget.maxCostDollars", input.budget.maxCostDollars)
      if (input.budget.maxCostDollars < 1 || input.budget.maxCostDollars > 100) {
        yield* Effect.fail(
          new CommandInputError({
            field: "budget.maxCostDollars",
            message: "budget.maxCostDollars must be between 1 and 100",
          }),
        )
      }
    }

    const data = yield* requestJson({
      provider: "exa",
      method: "POST",
      path: "/agent/runs",
      body: omitUndefined({
        query: input.query,
        systemPrompt: input.systemPrompt,
        input: input.input,
        outputSchema: input.outputSchema,
        effort,
        previousRunId: input.previousRunId,
        metadata: input.metadata,
        dataSources: input.dataSources,
        budget: input.budget,
      }),
      headers: withHeaders(INTEGRATION.agent, effort === "max" ? AGENT_MAX_EFFORT_BETA : undefined),
      responseSchema: UnknownRecord,
    })

    const runId = extractId(data)
    yield* recordRun({
      provider: "exa",
      kind,
      remoteId: runId,
      status: toRunStatus(extractStatus(data)),
      payload: input,
    })
    return {
      runId,
      researchId: runId,
      status: extractStatus(data),
      data,
    }
  })

export const agentStart = (input: AgentStartInput) => startAgentRun(input, "exa.agent")

export const agentCheck = Effect.fn("exa.agentCheck")(function* (input: AgentIdInput) {
  const runId = yield* resolveAgentRunId(input)
  const data = yield* requestJson({
    provider: "exa",
    method: "GET",
    path: `/agent/runs/${encodeURIComponent(runId)}`,
    headers: withHeaders(INTEGRATION.agent),
    responseSchema: UnknownRecord,
  })
  yield* syncRunStatus(runId, extractStatus(data))
  return data
})

export const agentList = Effect.fn("exa.agentList")(function* (input: AgentListInput) {
  yield* validateIntegerRange("limit", input.limit, 1, 100)

  return yield* requestJson({
    provider: "exa",
    method: "GET",
    path: "/agent/runs",
    urlParams: {
      cursor: input.cursor,
      limit: input.limit,
    },
    headers: withHeaders(INTEGRATION.agent),
    responseSchema: UnknownRecord,
  })
})

export const agentEvents = Effect.fn("exa.agentEvents")(function* (input: AgentEventsInput) {
  const runId = yield* resolveAgentRunId(input)
  yield* validateIntegerRange("limit", input.limit, 1, 100)

  return yield* requestJson({
    provider: "exa",
    method: "GET",
    path: `/agent/runs/${encodeURIComponent(runId)}/events`,
    urlParams: {
      cursor: input.cursor,
      limit: input.limit,
    },
    headers: withHeaders(INTEGRATION.agent),
    responseSchema: UnknownRecord,
  })
})

export const agentStream = Effect.fn("exa.agentStream")(function* (input: AgentStreamInput) {
  const runId = yield* resolveAgentRunId(input)
  const text = yield* requestText({
    provider: "exa",
    method: "GET",
    path: `/agent/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      accept: "text/event-stream",
      ...(input.lastEventId ? { "Last-Event-ID": input.lastEventId } : {}),
      ...withHeaders(INTEGRATION.agent),
    },
  })

  return collectedSse(runId, text)
})

export const agentCancel = Effect.fn("exa.agentCancel")(function* (input: AgentIdInput) {
  const runId = yield* resolveAgentRunId(input)
  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: `/agent/runs/${encodeURIComponent(runId)}/cancel`,
    headers: withHeaders(INTEGRATION.agent),
    responseSchema: UnknownRecord,
  })
  yield* syncRunStatus(runId, extractStatus(data) ?? "canceled")
  return data
})

export const agentStop = Effect.fn("exa.agentStop")(function* (input: AgentIdInput) {
  const runId = yield* resolveAgentRunId(input)
  const data = yield* requestJson({
    provider: "exa",
    method: "POST",
    path: `/agent/runs/${encodeURIComponent(runId)}/stop`,
    headers: withHeaders(INTEGRATION.agent, AGENT_MAX_EFFORT_BETA),
    responseSchema: UnknownRecord,
  })
  yield* syncRunStatus(runId, extractStatus(data) ?? "canceled")
  return data
})

export const agentDelete = Effect.fn("exa.agentDelete")(function* (input: AgentIdInput) {
  const runId = yield* resolveAgentRunId(input)
  const data = yield* requestJson({
    provider: "exa",
    method: "DELETE",
    path: `/agent/runs/${encodeURIComponent(runId)}`,
    headers: withHeaders(INTEGRATION.agent),
    responseSchema: UnknownRecord,
  })
  yield* syncRunStatus(runId, "canceled")
  return data
})

const waitForRun = (options: {
  readonly runId: string
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly label: string
}) =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    let latest: unknown
    let lastStatus: string | undefined

    while (Date.now() - startedAt <= options.timeoutMs) {
      latest = yield* requestJson({
        provider: "exa",
        method: "GET",
        path: `/agent/runs/${encodeURIComponent(options.runId)}`,
        headers: withHeaders(INTEGRATION.agent),
        responseSchema: UnknownRecord,
      })
      lastStatus = extractStatus(latest)

      if (isTerminalRunStatus(lastStatus)) {
        yield* syncRunStatus(options.runId, lastStatus)
        return {
          runId: options.runId,
          researchId: options.runId,
          status: lastStatus,
          elapsed_ms: Date.now() - startedAt,
          data: latest,
        }
      }

      yield* Effect.sleep(options.intervalMs)
    }

    yield* syncRunStatus(options.runId, lastStatus)
    return yield* Effect.fail(
      new JobWaitTimeoutError({
        provider: "exa",
        jobId: options.runId,
        timeoutMs: options.timeoutMs,
        lastStatus,
        message: `Timed out waiting for ${options.label} ${options.runId}`,
      }),
    )
  })

export const agentWait = Effect.fn("exa.agentWait")(function* (input: AgentWaitInput) {
  const runId = yield* resolveAgentRunId(input)
  yield* validatePositiveInteger("intervalMs", input.intervalMs)
  yield* validatePositiveInteger("timeoutMs", input.timeoutMs)
  yield* validatePositiveNumber("timeoutMs", input.timeoutMs)

  const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  return yield* waitForRun({
    runId,
    intervalMs: input.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS,
    timeoutMs,
    label: "agent run",
  })
})

export const deepResearchStart = Effect.fn("exa.deepResearchStart")(function* (
  input: DeepResearchStartInput,
) {
  if (input.model !== undefined) {
    yield* Effect.fail(
      new CommandInputError({
        field: "model",
        message:
          "The retired /research/v1 model field is not sent. Use effort on agent start, or omit model.",
      }),
    )
  }

  const query = firstNonEmpty(input.query, input.instructions)
  if (!query) {
    return yield* Effect.fail(
      new CommandInputError({
        field: "instructions",
        message: "instructions or query must not be empty",
      }),
    )
  }

  return yield* startAgentRun(
    {
      query,
      systemPrompt: input.systemPrompt,
      input: input.input,
      outputSchema: input.outputSchema,
      effort: input.effort,
      previousRunId: input.previousRunId,
      metadata: input.metadata,
      dataSources: input.dataSources,
      budget: input.budget,
    },
    "exa.deep-research",
  )
})

export const deepResearchWait = Effect.fn("exa.deepResearchWait")(function* (
  input: DeepResearchWaitInput,
) {
  const runId = yield* resolveAgentRunId(input)
  yield* validatePositiveInteger("intervalMs", input.intervalMs)
  yield* validatePositiveInteger("timeoutMs", input.timeoutMs)
  yield* validatePositiveNumber("timeoutMs", input.timeoutMs)

  const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  return yield* waitForRun({
    runId,
    intervalMs: input.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS,
    timeoutMs,
    label: "research task",
  })
})

export const deepResearchCheck = (input: DeepResearchIdInput) => agentCheck(input)

export const deepResearchInspect = (input: DeepResearchIdInput) => agentCheck(input)

export const deepResearchList = (input: DeepResearchListInput) => agentList(input)

export const deepResearchEvents = (input: DeepResearchEventsInput) => agentEvents(input)

export const deepResearchStream = (input: DeepResearchStreamInput) => agentStream(input)

export const deepResearchCancel = (input: DeepResearchIdInput) => agentCancel(input)

export const exaApi = {
  webSearch,
  codeContext,
  contents,
  crawl,
  answer,
  companyResearch,
  linkedinSearch,
  findSimilar,
  agentStart,
  agentRun: agentStart,
  agentCheck,
  agentInspect: agentCheck,
  agentList,
  agentWait,
  agentEvents,
  agentStream,
  agentCancel,
  agentStop,
  agentDelete,
  deepResearchStart,
  deepResearchRun: deepResearchStart,
  deepResearchCheck,
  deepResearchInspect,
  deepResearchList,
  deepResearchWait,
  deepResearchEvents,
  deepResearchStream,
  deepResearchCancel,
} as const
