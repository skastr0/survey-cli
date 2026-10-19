import { Effect, Option, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import { makeJsonCommand, optionalJsonInputArg } from "../core/command"
import { CLI_NAME } from "../core/constants"
import { registerContracts } from "../core/discovery"
import { loadJsonInput } from "../core/json"
import { executeJsonCommand } from "../core/output"
import { buildTools, DEFAULT_EXCLUDES, selfCommand, serveStdio } from "../mcp/server"

export const McpFilterInput = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  /** Per tool-call ceiling for `mcp serve` (default 10 minutes); ignored by `mcp tools`. */
  timeout_ms: Schema.optional(Schema.Int),
})

export const McpConfigInput = Schema.Struct({
  client: Schema.optional(Schema.Literals(["claude-code", "codex", "opencode", "cursor", "generic"])),
  include: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
})

const mcpServeCommand = Command.make(
  "serve",
  { input: optionalJsonInputArg },
  ({ input }) =>
    Effect.gen(function* () {
      const filter = yield* loadJsonInput(McpFilterInput, Option.getOrElse(input, () => "{}"))
      yield* Effect.promise(() => serveStdio({ tools: buildTools(filter), timeoutMs: filter.timeout_ms }))
    }).pipe(
      // Protocol channel is stdout; failures before serving still get an envelope.
      Effect.catch((error) => executeJsonCommand("mcp serve", Effect.fail(error))),
    ),
).pipe(
  Command.withDescription(
    "Serve every survey command as an MCP tool over stdio (JSON-RPC). Optional {include, exclude} globs over command paths, e.g. {\"include\":[\"search\",\"fetch\",\"corpus *\"]}.",
  ),
)

const mcpToolsCommand = makeJsonCommand({
  name: "tools",
  commandName: "mcp tools",
  description: "List the MCP tool definitions `mcp serve` would expose (same include/exclude filter)",
  schema: McpFilterInput,
  optionalInput: true,
  run: (filter) =>
    Effect.sync(() => {
      const tools = buildTools(filter).map(({ argv, ...tool }) => ({ ...tool, command: argv.join(" ") }))
      return { tools, count: tools.length, default_excludes: DEFAULT_EXCLUDES }
    }),
})

const mcpConfigCommand = makeJsonCommand({
  name: "config",
  commandName: "mcp config",
  description: "Print the MCP client configuration snippet that mounts this survey binary (claude-code, codex, opencode, cursor, generic)",
  schema: McpConfigInput,
  optionalInput: true,
  run: (input) =>
    Effect.sync(() => {
      const [command, ...prefix] = selfCommand()
      const filter =
        input.include !== undefined || input.exclude !== undefined
          ? [JSON.stringify({ include: input.include, exclude: input.exclude })]
          : []
      const args = [...prefix, "mcp", "serve", ...filter]
      const client = input.client ?? "generic"
      const server = { command: command!, args }
      switch (client) {
        case "claude-code":
          return {
            client,
            shell: `claude mcp add ${CLI_NAME} -- ${[command, ...args].map((part) => JSON.stringify(part)).join(" ")}`,
            json: { mcpServers: { [CLI_NAME]: { type: "stdio", ...server } } },
          }
        case "codex":
          return {
            client,
            file: "~/.codex/config.toml",
            toml: `[mcp_servers.${CLI_NAME}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`,
          }
        case "opencode":
          return {
            client,
            file: "opencode.json",
            json: { mcp: { [CLI_NAME]: { type: "local", command: [command, ...args], enabled: true } } },
          }
        case "cursor":
          return { client, file: "~/.cursor/mcp.json", json: { mcpServers: { [CLI_NAME]: server } } }
        default:
          return { client, json: { mcpServers: { [CLI_NAME]: server } } }
      }
    }),
})

export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Model Context Protocol server — mount survey's full command surface in any MCP client"),
  Command.withSubcommands([mcpServeCommand, mcpToolsCommand, mcpConfigCommand]),
)

registerContracts([
  {
    command: "mcp tools",
    description: "List MCP tool definitions",
    inputSchema: McpFilterInput,
    examples: [
      { name: "all", input: {} },
      { name: "research subset", input: { include: ["search", "fetch", "corpus *", "papers*"] } },
    ],
  },
  {
    command: "mcp config",
    description: "MCP client config snippet for this binary",
    inputSchema: McpConfigInput,
    examples: [
      { name: "claude code", input: { client: "claude-code" } },
      { name: "codex subset", input: { client: "codex", include: ["search", "fetch", "corpus *"] } },
    ],
  },
])
