/// <reference types="vite/client" />
import { describe, expect, it } from "vitest"
import { Schema } from "effect"

;(globalThis as { Bun?: unknown }).Bun ??= { env: process.env }

// Registering contracts is an import side effect; glob so new providers and
// capabilities are covered without touching this file.
import.meta.glob(["../src/capabilities/*.ts", "../src/providers/*/index.ts", "../src/commands/*.ts"], { eager: true })

import { listContracts } from "../src/core/discovery"

describe("command contracts", () => {
  const contracts = listContracts()

  it("registers a non-trivial command inventory", () => {
    expect(contracts.length).toBeGreaterThan(100)
  })

  it("every example decodes against its command's input schema", () => {
    const failures: Array<string> = []
    for (const contract of contracts) {
      if (contract.inputSchema === undefined) continue
      const decode = Schema.decodeUnknownExit(contract.inputSchema as Schema.Codec<unknown, unknown, never, never>)
      for (const example of contract.examples ?? []) {
        const inputs: ReadonlyArray<unknown> =
          contract.batch === true && Array.isArray(example.input) ? example.input : [example.input]
        for (const input of inputs) {
          // Batch commands may accept string shorthand (normalized to objects before decoding).
          if (contract.batch === true && typeof input === "string") continue
          const exit = decode(input)
          if (exit._tag === "Failure") failures.push(`${contract.command} › ${example.name}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  // Commands owned by other lanes that have not documented `output` yet. Remove
  // an entry when its contract gains one (the test fails if a listed command
  // already documents output, so this list can only shrink).
  const OUTPUT_PENDING = new Set<string>([
    "corpus add",
    "corpus diff",
    "corpus grep",
    "corpus prune",
    "corpus read",
    "corpus search",
    "corpus stats",
    "corpus versions",
    "corpus list",
    "corpus remove",
    "extract",
    "fetch",
    "research",
    "search",
    "verify",
  ])
  const GENERIC_OUTPUT = /^(json|data|result|results|response|object|payload|the (provider|api) response|provider response|envelope)\.?$/i

  it("every contract documents a specific output shape", () => {
    const missing = contracts
      .filter((contract) => !OUTPUT_PENDING.has(contract.command))
      .filter((contract) => {
        const output = contract.output?.trim() ?? ""
        return output.length < 20 || GENERIC_OUTPUT.test(output) || !/[{[]|\w+_\w+|\w+\(/.test(output)
      })
      .map((contract) => contract.command)
    expect(missing).toEqual([])
  })

  it("the pending-output list only names undocumented, registered commands", () => {
    const registered = new Set(contracts.map((contract) => contract.command))
    const stale = [...OUTPUT_PENDING].filter(
      (command) => registered.has(command) && contracts.find((contract) => contract.command === command)?.output !== undefined,
    )
    expect(stale).toEqual([])
  })

  it("command paths are unique and MCP tool names do not collide", () => {
    const names = contracts.map((contract) => contract.command.replace(/[^a-zA-Z0-9]+/g, "_"))
    expect(new Set(names).size).toBe(names.length)
  })
})
