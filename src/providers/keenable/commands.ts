import { Effect, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { runMutationBatch } from "../../core/batch"
import {
  applyOutputPolicy,
  concurrencyFlag,
  jsonInputArg,
  outputFlag,
} from "../../core/command"
import { registerContracts } from "../../core/discovery"
import { JsonInputError } from "../../core/errors"
import { loadJsonInput } from "../../core/json"
import { executeJsonCommand } from "../../core/output"
import { fetchPage, search, selectQuery, selectReport, selectRevoke } from "./api"
import {
  DEFAULT_SELECT_CONCURRENCY,
  DEFAULT_SELECT_TIMEOUT_SECONDS,
} from "./config"
import {
  FetchInputSchema,
  SearchInputSchema,
  SelectInputSchema,
  SelectReportInputSchema,
  SelectRevokeInputSchema,
} from "./schemas"

registerContracts([
  {
    command: "keenable search",
    description:
      "Search the web with Keenable. Keyed POST /v1/search, or public POST /v1/search/public when no API key is configured. Accepts one object, one query string, or an array of objects or query strings. keenable_title/title are sent as X-Keenable-Title, not in the search body. mode=standard maps to realtime.",
    inputSchema: SearchInputSchema,
    batch: true,
    examples: [
      { name: "single-search", input: { query: "typescript best practices", max_results: 5 } },
      {
        name: "batch-search",
        input: [{ query: "Effect Schema" }, { query: "Effect CLI" }],
      },
      { name: "query-strings", input: ["rust async", "bun compile"] },
      {
        name: "site-filter",
        input: {
          query: "AI news",
          site: "techcrunch.com",
          published_after: "7d",
          snippet_max_length: 2000,
        },
      },
      {
        name: "public-title",
        input: { query: "keenable api", keenable_title: "my-agent" },
      },
    ],
  },
  {
    command: "keenable fetch",
    description:
      "Fetch page markdown with Keenable. Keyed GET /v1/fetch, or public GET /v1/fetch/public when no API key is configured. Accepts one object, one URL string, or an array of objects or URL strings. live=true fetches unindexed URLs; prompt returns LLM extraction output (max 2000 chars).",
    inputSchema: FetchInputSchema,
    batch: true,
    examples: [
      { name: "single-fetch", input: { url: "https://example.com" } },
      { name: "live-fetch", input: { url: "https://example.com", live: true, max_chars: 20000 } },
      {
        name: "extract-prompt",
        input: { url: "https://example.com", prompt: "List all pricing tiers with their monthly prices" },
      },
      {
        name: "batch-fetch",
        input: ["https://example.com", { url: "https://example.org", live: true }],
      },
    ],
  },
  {
    command: "keenable select",
    description:
      "Run a DuckDB SELECT over live web results via Keenable SELECT MCP (https://select.keenable.ai/mcp). Requires an API key; there is no public twin. query is one read-only DuckDB SELECT; WEB_SEARCH/WEB_FETCH/SEM_* operators run on the server. Accepts a SQL string as {query}. A later query can FROM a returned result_set_id for 30 days.",
    inputSchema: SelectInputSchema,
    batch: true,
    examples: [
      {
        name: "select-web-search",
        input: {
          query: "SELECT url, title FROM WEB_SEARCH('Effect Schema official docs') LIMIT 5",
          show_preview: true,
        },
      },
      {
        name: "select-from-result-set",
        input: {
          query: "SELECT * FROM ra84968f0532 WHERE TRY_CAST(price_eur AS INTEGER) < 30000",
        },
      },
    ],
  },
  {
    command: "keenable select-report",
    description:
      "Ask Keenable SELECT to generate an HTML report from stored result set ids (MCP tool generate_html_report). Requires an API key. Reports can take minutes.",
    inputSchema: SelectReportInputSchema,
    batch: true,
    examples: [
      {
        name: "select-report",
        input: {
          brief: "Which electric cars sold in Europe come up most often, with range and starting price?",
          result_set_ids: ["ra84968f0532"],
        },
      },
    ],
  },
  {
    command: "keenable select-revoke",
    description:
      "Revoke a previously generated Keenable SELECT HTML report (MCP tool revoke_html_report). Provide url or report_url. Requires an API key.",
    inputSchema: SelectRevokeInputSchema,
    batch: true,
    examples: [
      {
        name: "select-revoke",
        input: { url: "https://select.keenable.ai/r/example/id" },
      },
    ],
  },
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Keenable inputs accept bare strings (query/url/SQL) in addition to objects —
 * normalize them to objects before handing the batch to the shared runner.
 */
const normalizeBatchInput = (
  input: string,
  prepare?: (value: unknown) => unknown,
) =>
  loadJsonInput(Schema.Unknown, input).pipe(
    Effect.flatMap((value) => {
      const items = Array.isArray(value)
        ? value
        : isRecord(value) || typeof value === "string"
          ? [value]
          : undefined

      if (!items) {
        return Effect.fail(
          new JsonInputError({
            source: "input",
            reason: "InvalidShape",
            message: "batch input must be a JSON object, string, or array of objects or strings",
          }),
        )
      }

      if (items.length === 0) {
        return Effect.fail(
          new JsonInputError({
            source: "input",
            reason: "InvalidShape",
            message: "batch input must contain at least one item",
          }),
        )
      }

      return Effect.succeed(
        JSON.stringify(items.map((item) => (prepare ? prepare(item) : item))),
      )
    }),
  )

export const runKeenableBatch = <S extends Schema.Constraint, E, R>(options: {
  readonly input: string
  readonly concurrency: number
  readonly itemSchema: S
  readonly prepare?: (value: unknown) => unknown
  readonly run: (item: S["Type"], index: number) => Effect.Effect<unknown, E, R>
}) =>
  normalizeBatchInput(options.input, options.prepare).pipe(
    Effect.flatMap((normalized) =>
      runMutationBatch({
        input: normalized,
        concurrency: options.concurrency,
        itemSchema: options.itemSchema,
        run: options.run,
      }),
    ),
  )

const selectConcurrencyFlag = Flag.integer("concurrency").pipe(
  Flag.withDefault(DEFAULT_SELECT_CONCURRENCY),
  Flag.withDescription("Batch concurrency (positive integer). Default 1; SELECT is expensive."),
)

const selectTimeoutFlag = Flag.integer("timeout").pipe(
  Flag.withDefault(DEFAULT_SELECT_TIMEOUT_SECONDS),
  Flag.withDescription("Seconds to wait for the SELECT MCP tool call. Queries can take minutes."),
)

const prepareSearchItem = (value: unknown) => (typeof value === "string" ? { query: value } : value)
const prepareFetchItem = (value: unknown) => (typeof value === "string" ? { url: value } : value)
const prepareSelectItem = (value: unknown) => (typeof value === "string" ? { query: value } : value)

export const searchCommand = Command.make(
  "search",
  { input: jsonInputArg, output: outputFlag, concurrency: concurrencyFlag },
  ({ input, output, concurrency }) =>
    executeJsonCommand(
      "keenable search",
      runKeenableBatch({
        input,
        concurrency,
        itemSchema: SearchInputSchema,
        prepare: prepareSearchItem,
        run: (item) => search(item),
      }).pipe(
        Effect.flatMap((summary) =>
          applyOutputPolicy({ command: "keenable search", mode: output, data: summary }),
        ),
      ),
    ),
).pipe(Command.withDescription("Search the web with Keenable from JSON input"))

export const fetchCommand = Command.make(
  "fetch",
  { input: jsonInputArg, output: outputFlag, concurrency: concurrencyFlag },
  ({ input, output, concurrency }) =>
    executeJsonCommand(
      "keenable fetch",
      runKeenableBatch({
        input,
        concurrency,
        itemSchema: FetchInputSchema,
        prepare: prepareFetchItem,
        run: (item) => fetchPage(item),
      }).pipe(
        Effect.flatMap((summary) =>
          applyOutputPolicy({ command: "keenable fetch", mode: output, data: summary }),
        ),
      ),
    ),
).pipe(Command.withDescription("Fetch page content as markdown from JSON input"))

export const selectCommand = Command.make(
  "select",
  {
    input: jsonInputArg,
    output: outputFlag,
    concurrency: selectConcurrencyFlag,
    timeout: selectTimeoutFlag,
  },
  ({ input, output, concurrency, timeout }) =>
    executeJsonCommand(
      "keenable select",
      runKeenableBatch({
        input,
        concurrency,
        itemSchema: SelectInputSchema,
        prepare: prepareSelectItem,
        run: (item) => selectQuery(item, item.timeout_seconds ?? timeout),
      }).pipe(
        Effect.flatMap((summary) =>
          applyOutputPolicy({ command: "keenable select", mode: output, data: summary }),
        ),
      ),
    ),
).pipe(Command.withDescription("Run a Keenable SELECT SQL query over live web results"))

export const selectReportCommand = Command.make(
  "select-report",
  {
    input: jsonInputArg,
    output: outputFlag,
    concurrency: selectConcurrencyFlag,
    timeout: selectTimeoutFlag,
  },
  ({ input, output, concurrency, timeout }) =>
    executeJsonCommand(
      "keenable select-report",
      runKeenableBatch({
        input,
        concurrency,
        itemSchema: SelectReportInputSchema,
        run: (item) => selectReport(item, item.timeout_seconds ?? timeout),
      }).pipe(
        Effect.flatMap((summary) =>
          applyOutputPolicy({ command: "keenable select-report", mode: output, data: summary }),
        ),
      ),
    ),
).pipe(Command.withDescription("Generate a Keenable SELECT HTML report from result set ids"))

export const selectRevokeCommand = Command.make(
  "select-revoke",
  {
    input: jsonInputArg,
    output: outputFlag,
    concurrency: selectConcurrencyFlag,
    timeout: selectTimeoutFlag,
  },
  ({ input, output, concurrency, timeout }) =>
    executeJsonCommand(
      "keenable select-revoke",
      runKeenableBatch({
        input,
        concurrency,
        itemSchema: SelectRevokeInputSchema,
        run: (item) => selectRevoke(item, item.timeout_seconds ?? timeout),
      }).pipe(
        Effect.flatMap((summary) =>
          applyOutputPolicy({ command: "keenable select-revoke", mode: output, data: summary }),
        ),
      ),
    ),
).pipe(Command.withDescription("Revoke a Keenable SELECT HTML report"))
