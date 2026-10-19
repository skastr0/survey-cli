import { describe, expect, it } from "vitest"

;(globalThis as { Bun?: unknown }).Bun ??= { env: process.env }

import "../src/capabilities/corpus"
import "../src/capabilities/sources"
import "../src/commands/auth"
import { stripNullBranches } from "../src/core/discovery"
import { buildTools, callTool, createHandler, type Executor, toolName } from "../src/mcp/server"

const calls: Array<{ argv: ReadonlyArray<string>; input: string | undefined }> = []
const fakeExec: Executor = async (argv, input) => {
  calls.push({ argv, input })
  if (argv.join(" ") === "corpus read") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: JSON.stringify({ ok: false, command: "corpus read", error: { type: "CommandInputError", message: "nope" } }),
    }
  }
  return { exitCode: 0, stdout: JSON.stringify({ ok: true, command: argv.join(" "), data: { echo: JSON.parse(input ?? "{}") } }), stderr: "" }
}

describe("buildTools", () => {
  it("names tools from command paths and filters with globs", () => {
    const tools = buildTools({ include: ["corpus *"], exclude: ["corpus remove"] })
    const names = tools.map((tool) => tool.name)
    expect(names).toContain("corpus_search")
    expect(names).not.toContain("corpus_remove")
    expect(names.every((name) => name.startsWith("corpus_"))).toBe(true)
    expect(toolName("firecrawl crawl start")).toBe("firecrawl_crawl_start")
  })

  it("excludes secret-writing commands by default but allows explicit include", () => {
    expect(buildTools().some((tool) => tool.name === "auth_set")).toBe(false)
    expect(buildTools({ include: ["auth set"] }).map((tool) => tool.name)).toEqual(["auth_set"])
  })

  it("emits object input schemas and behavior annotations", () => {
    const [search] = buildTools({ include: ["corpus search"] })
    expect(search?.inputSchema.type).toBe("object")
    expect(search?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    const [remove] = buildTools({ include: ["corpus remove"] })
    expect(remove?.annotations.destructiveHint).toBe(true)
  })
})

describe("stripNullBranches", () => {
  it("collapses optional anyOf-null into the inner schema", () => {
    expect(
      stripNullBranches({ properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } }),
    ).toEqual({ properties: { a: { type: "string" } } })
  })

  it("keeps multi-branch unions minus null", () => {
    expect(stripNullBranches({ anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] })).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    })
  })
})

describe("MCP handler", () => {
  const handle = createHandler({ tools: buildTools({ include: ["corpus *"] }), exec: fakeExec })

  it("negotiates protocol version on initialize", async () => {
    const supported = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as {
      result: { protocolVersion: string; capabilities: unknown }
    }
    expect(supported.result.protocolVersion).toBe("2025-06-18")
    expect(supported.result.capabilities).toEqual({ tools: { listChanged: false } })
    const unknown = (await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as {
      result: { protocolVersion: string }
    }
    expect(unknown.result.protocolVersion).toBe("2025-11-25")
  })

  it("lists tools without internal argv", async () => {
    const response = (await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as {
      result: { tools: Array<Record<string, unknown>> }
    }
    expect(response.result.tools.length).toBeGreaterThan(0)
    expect(response.result.tools.every((tool) => !("argv" in tool))).toBe(true)
  })

  it("executes tools via the CLI and returns structured envelopes", async () => {
    const response = (await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "corpus_search", arguments: { query: "x" } },
    })) as { result: { isError: boolean; structuredContent: { data: unknown } } }
    expect(response.result.isError).toBe(false)
    expect(response.result.structuredContent.data).toEqual({ echo: { query: "x" } })
    expect(calls.at(-1)).toEqual({ argv: ["corpus", "search"], input: '{"query":"x"}' })
  })

  it("surfaces failure envelopes as isError", async () => {
    const response = (await handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "corpus_read", arguments: { id: 1 } },
    })) as { result: { isError: boolean; structuredContent: { error: { type: string } } } }
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent.error.type).toBe("CommandInputError")
  })

  it("rejects unknown tools and methods, ignores notifications", async () => {
    expect(await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })).toMatchObject({
      error: { code: -32602 },
    })
    expect(await handle({ jsonrpc: "2.0", id: 7, method: "resources/list" })).toMatchObject({ error: { code: -32601 } })
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined()
  })

  it("never answers or executes notifications", async () => {
    const before = calls.length
    expect(await handle({ jsonrpc: "2.0", method: "tools/list" })).toBeUndefined()
    expect(await handle({ jsonrpc: "2.0", method: "initialize", params: {} })).toBeUndefined()
    expect(
      await handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "corpus_stats", arguments: {} } }),
    ).toBeUndefined()
    expect(calls.length).toBe(before)
  })

  it("rejects non-object messages and ignores responses", async () => {
    expect(await handle(null)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } })
    expect(await handle([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toMatchObject({ error: { code: -32600 } })
    expect(await handle({ jsonrpc: "2.0", id: 1, result: {} })).toBeUndefined()
  })
})

describe("MCP tool timeout", () => {
  it("aborts the child and returns a retryable TimeoutError envelope", async () => {
    let aborted = false
    const slowExec: Executor = (_argv, _input, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true
          resolve({ exitCode: 143, stdout: "", stderr: "" })
        })
      })
    const [tool] = buildTools({ include: ["corpus stats"] })
    const result = await callTool(tool!, {}, slowExec, 20)
    expect(aborted).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { type: "TimeoutError", details: { retryable: true } } })
  })
})
