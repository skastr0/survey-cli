import { createInterface } from "node:readline"

import { CLI_NAME, CLI_VERSION } from "../core/constants"
import { type CommandContract, contractJsonSchema, listContracts } from "../core/discovery"
import { envelopeOf, type Executor, spawnExecutor } from "../core/exec"

export { type Executor, selfCommand, spawnExecutor } from "../core/exec"

/**
 * MCP (Model Context Protocol) stdio server. Every registered command
 * contract becomes one tool; a tool call re-invokes this same binary as a
 * subprocess, so MCP clients get exactly the CLI's validated behavior and
 * envelopes, and stdout stays reserved for JSON-RPC framing.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const

export interface McpTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly openWorldHint: boolean
  }
  /** CLI words this tool executes, e.g. ["corpus", "search"]. */
  readonly argv: ReadonlyArray<string>
}

export interface ToolFilter {
  readonly include?: ReadonlyArray<string> | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
}

/** Commands never exposed unless explicitly included (they write secrets). */
export const DEFAULT_EXCLUDES = ["auth set"]

const globToRegex = (glob: string) =>
  new RegExp(`^${glob.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)

const matchesAny = (command: string, globs: ReadonlyArray<string>) =>
  globs.some((glob) => globToRegex(glob).test(command) || globToRegex(glob.replace(/_/g, " ")).test(command))

export const toolName = (command: string) => command.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 64)

const READ_ONLY = /(^| )(search|fetch|list|inspect|check|show|read|grep|stats|versions|diff|events|errors|result|get|content|map|answer|contents|code-context|find-similar|select|wait|stream|dedupe|capabilities|doctor)$/
const DESTRUCTIVE = /(^| )(delete|remove|cancel|stop|revoke)$/

const LOCAL_ONLY = /^(corpus|sources|runs) /

const objectSchema = (contract: CommandContract): Record<string, unknown> => {
  const doc = contractJsonSchema(contract) as
    | { readonly schema?: Record<string, unknown>; readonly definitions?: Record<string, unknown> }
    | undefined
  const schema = doc?.schema
  if (schema === undefined || schema.type !== "object") {
    return {
      type: "object",
      additionalProperties: true,
      description: schema === undefined ? "Free-form JSON payload for this command" : "Payload (see `survey schema show`)",
    }
  }
  const definitions = doc?.definitions
  const out: Record<string, unknown> = { ...schema }
  if (definitions !== undefined && Object.keys(definitions).length > 0) {
    out.$defs = definitions
  }
  return out
}

const describe = (contract: CommandContract) => {
  const parts = [contract.description]
  if (contract.batch === true) {
    parts.push("Batch command: pass one object (the tool input) — the CLI also accepts arrays.")
  }
  const example = contract.examples?.[0]
  if (example !== undefined) {
    parts.push(`Example input: ${JSON.stringify(example.input)}`)
  }
  return parts.join("\n")
}

export const buildTools = (filter: ToolFilter = {}): ReadonlyArray<McpTool> => {
  const excludes = [...DEFAULT_EXCLUDES.filter((glob) => !(filter.include ?? []).includes(glob)), ...(filter.exclude ?? [])]
  return listContracts()
    .filter((contract) => filter.include === undefined || matchesAny(contract.command, filter.include))
    .filter((contract) => !matchesAny(contract.command, excludes))
    .map((contract) => ({
      name: toolName(contract.command),
      title: `survey ${contract.command}`,
      description: describe(contract),
      inputSchema: objectSchema(contract),
      annotations: {
        readOnlyHint: READ_ONLY.test(contract.command),
        destructiveHint: DESTRUCTIVE.test(contract.command),
        openWorldHint: !LOCAL_ONLY.test(`${contract.command} `),
      },
      argv: contract.command.split(" "),
    }))
}

/** Default ceiling for one tool call; long provider jobs should use start/check orbits instead. */
export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60 * 1000

export const callTool = async (tool: McpTool, args: unknown, exec: Executor, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) => {
  const payload = JSON.stringify(args ?? {})
  const signal = AbortSignal.timeout(timeoutMs)
  const result = await exec(tool.argv, payload, signal)
  const envelope = signal.aborted
    ? {
        ok: false,
        command: tool.argv.join(" "),
        error: {
          type: "TimeoutError",
          message: `${tool.argv.join(" ")} exceeded the MCP tool timeout of ${timeoutMs}ms`,
          details: {
            retryable: true,
            hint: "Use the command's start/check/wait orbit for long jobs, or raise timeout_ms on mcp serve.",
          },
        },
      }
    : envelopeOf(result)
  const isError = !envelope.ok
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError,
  }
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id?: string | number | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
})

export const createHandler = (options: {
  readonly tools: ReadonlyArray<McpTool>
  readonly exec: Executor
  readonly timeoutMs?: number | undefined
}) => {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]))
  const listed = options.tools.map(({ argv: _argv, ...tool }) => tool)

  return async (raw: unknown): Promise<unknown | undefined> => {
    // JSON-RPC 2.0: non-objects (incl. batches, unsupported since MCP 2025-06-18) are invalid requests.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return rpcError(null, -32600, "Invalid Request")
    }
    const message = raw as Partial<JsonRpcRequest>
    // A message without a method is a response to us; we never send requests, so ignore it.
    if (typeof message.method !== "string") return undefined
    const { id, method, params } = message
    // Notifications never get a reply, and none of ours has a side effect worth running.
    if (id === undefined) return undefined
    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(requested ?? "")
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0]
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: CLI_NAME, title: "survey research toolkit", version: CLI_VERSION },
            instructions:
              "survey: multi-provider web research. Start with `search` (fan-out + corroboration) or `fetch`; everything fetched lands in the local corpus — use corpus_search / corpus_grep / corpus_read instead of re-fetching. Tool results are survey JSON envelopes {ok, command, data|error}.",
          },
        }
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} }
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listed } }
      case "tools/call": {
        const name = typeof params?.name === "string" ? params.name : ""
        const tool = byName.get(name)
        if (tool === undefined) {
          return rpcError(id, -32602, `Unknown tool: ${name}`)
        }
        try {
          const result = await callTool(tool, params?.arguments, options.exec, options.timeoutMs)
          return { jsonrpc: "2.0", id, result }
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            },
          }
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }
}

/** Serve newline-delimited JSON-RPC over stdio until stdin closes. */
export const serveStdio = (options: {
  readonly tools: ReadonlyArray<McpTool>
  readonly exec?: Executor
  readonly timeoutMs?: number | undefined
}) =>
  new Promise<void>((resolve) => {
    const handle = createHandler({
      tools: options.tools,
      exec: options.exec ?? spawnExecutor,
      timeoutMs: options.timeoutMs,
    })
    const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
    const pending = new Set<Promise<void>>()
    const write = (value: unknown) => {
      process.stdout.write(`${JSON.stringify(value)}\n`)
    }
    reader.on("line", (line) => {
      if (line.trim().length === 0) return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        write(rpcError(null, -32700, "Parse error"))
        return
      }
      const task = handle(message)
        .then((response) => {
          if (response !== undefined) write(response)
        })
        .catch((error: unknown) => {
          const id = (message as { id?: JsonRpcRequest["id"] }).id
          if (id !== undefined) write(rpcError(id, -32603, error instanceof Error ? error.message : String(error)))
        })
        .finally(() => pending.delete(task))
      pending.add(task)
    })
    reader.on("close", () => {
      void Promise.all(pending).then(() => resolve())
    })
  })
