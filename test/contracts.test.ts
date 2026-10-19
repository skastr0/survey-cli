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

  it("command paths are unique and MCP tool names do not collide", () => {
    const names = contracts.map((contract) => contract.command.replace(/[^a-zA-Z0-9]+/g, "_"))
    expect(new Set(names).size).toBe(names.length)
  })
})
