import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

;(globalThis as { Bun?: unknown }).Bun ??= { env: process.env }

import "../src/capabilities/corpus"
import "../src/capabilities/fetch"
import "../src/capabilities/search"
import { PipeInput, runPipeline } from "../src/capabilities/pipe"
import type { Executor } from "../src/core/exec"
import { resolveReference, resolveValue } from "../src/core/jsonpath"

describe("jsonpath", () => {
  const root = {
    s: { data: { results: [{ url: "a", tags: ["x", "y"] }, { url: "b", tags: ["z"] }, { url: "c", tags: [] }] } },
    vars: { topic: "effect" },
  }

  it("resolves keys, indexes, negative indexes, wildcards, slices", () => {
    expect(resolveReference("$.s.data.results[0].url", { root })).toBe("a")
    expect(resolveReference("$.s.data.results[-1].url", { root })).toBe("c")
    expect(resolveReference("$.s.data.results[*].url", { root })).toEqual(["a", "b", "c"])
    expect(resolveReference("$.s.data.results[0:2].url", { root })).toEqual(["a", "b"])
    expect(resolveReference("$.s.data.results[*].tags[*]", { root })).toEqual(["x", "y", "z"])
    expect(resolveReference("$.missing.path", { root })).toBeUndefined()
  })

  it("resolves $item/$index, templates, and $$ escapes inside nested values", () => {
    const value = resolveValue(
      { url: "$item.url", label: "{{ $.vars.topic }} #{{$index}}", literal: "$$.not.a.ref", list: ["$item.url"] },
      { root, item: { url: "u" }, index: 2 },
    )
    expect(value).toEqual({ url: "u", label: "effect #2", literal: "$.not.a.ref", list: ["u"] })
  })

  it("keeps literal dollars, non-reference templates, and rejects malformed slices", () => {
    expect(resolveValue("$.50", { root })).toBe("$.50")
    expect(resolveValue("$5", { root })).toBe("$5")
    expect(resolveValue("Hello {{ name }} — {{ $.vars.topic }}", { root })).toBe("Hello {{ name }} — effect")
    expect(() => resolveReference("$.s.data.results[-:]", { root })).toThrow()
    expect(resolveReference("$.s.data.results[1:]", { root })).toHaveLength(2)
  })

  it("leaves ordinary strings that merely contain $ alone", () => {
    expect(resolveValue("costs $5 per call", { root })).toBe("costs $5 per call")
  })
})

const fakeExec = (handlers: Record<string, (input: any) => unknown>) => {
  const calls: Array<{ command: string; input: unknown }> = []
  const exec: Executor = async (argv, raw) => {
    const command = argv.join(" ")
    const input = raw === undefined ? undefined : JSON.parse(raw)
    calls.push({ command, input })
    const handler = handlers[command]
    if (handler === undefined) {
      return { exitCode: 1, stdout: "", stderr: JSON.stringify({ ok: false, command, error: { type: "Boom", message: command } }) }
    }
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, command, data: handler(input) }), stderr: "" }
  }
  return { exec, calls }
}

describe("runPipeline", () => {
  it.effect("chains steps with references, select, foreach, and output", () => {
    const { exec, calls } = fakeExec({
      search: (input) => ({ query: input.query, results: [{ url: "https://a" }, { url: "https://b" }, { url: "https://c" }] }),
      fetch: (input) => ({ url: input.url, content: `page ${input.url}` }),
    })
    return Effect.gen(function* () {
      const result = yield* runPipeline(
        {
          vars: { topic: "t" },
          steps: [
            { id: "s", command: "search", input: { query: "$.vars.topic" }, select: "$.data.results[0:2]" },
            { id: "f", command: "fetch", foreach: "$.s.data", input: { url: "$item.url" }, concurrency: 2 },
          ],
          output: { urls: "$.f.data[*].url", first: "{{ $.f.data[0].content }}" },
        },
        exec,
      )
      expect(result.ok).toBe(true)
      expect((result as any).output).toEqual({ urls: ["https://a", "https://b"], first: "page https://a" })
      expect(calls.map((call) => call.command)).toEqual(["search", "fetch", "fetch"])
      expect(calls[0]?.input).toEqual({ query: "t" })
      expect(result.steps[1]).toMatchObject({ id: "f", items: 2, error_count: 0 })
    })
  })

  it.effect("stops on first failure by default and continues when asked", () =>
    Effect.gen(function* () {
      const { exec } = fakeExec({ search: () => ({ results: [] }) })
      const stopped = yield* runPipeline(
        {
          steps: [
            { id: "a", command: "fetch", input: { url: "x" } },
            { id: "b", command: "search", input: { query: "q" } },
          ],
        },
        exec,
      )
      expect(stopped.ok).toBe(false)
      expect(stopped.stopped_at).toBe("a")
      expect(stopped.steps.length).toBe(1)

      const continued = yield* runPipeline(
        {
          steps: [
            { id: "a", command: "fetch", input: { url: "x" }, on_error: "continue" },
            { id: "b", command: "search", input: { query: "q" } },
          ],
        },
        exec,
      )
      expect(continued.steps.map((step) => step.ok)).toEqual([false, true])
    }),
  )

  it.effect("skips steps whose if reference is falsy", () =>
    Effect.gen(function* () {
      const { exec, calls } = fakeExec({ search: () => ({ results: [] }), fetch: () => ({}) })
      const result = yield* runPipeline(
        {
          steps: [
            { id: "s", command: "search", input: { query: "q" } },
            { id: "f", command: "fetch", if: "$.s.data.results", input: { url: "x" } },
          ],
        },
        exec,
      )
      expect(result.steps[1]).toMatchObject({ id: "f", skipped: true })
      expect(calls.length).toBe(1)
    }),
  )

  it.effect("rejects unknown commands, recursion into mcp serve, and duplicate ids", () =>
    Effect.gen(function* () {
      const { exec } = fakeExec({})
      const unknown = yield* Effect.flip(runPipeline({ steps: [{ id: "a", command: "rm -rf" }] }, exec))
      expect(unknown._tag).toBe("CommandInputError")
      const mcp = yield* Effect.flip(runPipeline({ steps: [{ id: "a", command: "mcp serve" }] }, exec))
      expect(mcp._tag).toBe("CommandInputError")
      const dup = yield* Effect.flip(
        runPipeline({ steps: [{ id: "a", command: "search" }, { id: "a", command: "search" }] }, exec),
      )
      expect(dup._tag).toBe("CommandInputError")
    }),
  )

  it.effect("fails foreach over non-arrays and caps fan-out with max_items", () =>
    Effect.gen(function* () {
      const { exec, calls } = fakeExec({
        search: () => ({ results: Array.from({ length: 10 }, (_, i) => ({ url: `u${i}` })) }),
        fetch: () => ({}),
      })
      const bad = yield* Effect.flip(
        runPipeline({ steps: [{ id: "s", command: "search" }, { id: "f", command: "fetch", foreach: "$.s.data" }] }, exec),
      )
      expect(bad._tag).toBe("CommandInputError")
      const capped = yield* runPipeline(
        {
          max_items: 3,
          steps: [
            { id: "s", command: "search" },
            { id: "f", command: "fetch", foreach: "$.s.data.results", input: { url: "$item.url" } },
          ],
        },
        exec,
      )
      expect(calls.filter((call) => call.command === "fetch").length).toBe(3)
      expect((capped as any).results.f.truncated_items).toBe(7)
    }),
  )

  it.effect("runs no-input commands without a payload", () =>
    Effect.gen(function* () {
      const { exec, calls } = fakeExec({ doctor: () => ({ cli: "survey" }) })
      const result = yield* runPipeline({ steps: [{ id: "d", command: "doctor", input: { ignored: true } }] }, exec)
      expect(result.ok).toBe(true)
      expect(calls).toEqual([{ command: "doctor", input: undefined }])
    }),
  )

  it.live("aborts the child's signal when a step times out", () =>
    Effect.gen(function* () {
      let aborted = false
      const hang: Executor = (_argv, _input, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true
            resolve({ exitCode: 143, stdout: "", stderr: "" })
          })
        })
      const result = yield* runPipeline({ steps: [{ id: "f", command: "fetch", timeout_ms: 50 }] }, hang)
      expect(result.steps[0]?.error?.type).toBe("TimeoutError")
      expect(aborted).toBe(true)
    }),
  )

  it("rejects negative max_items instead of silently dropping items", () => {
    const decoded = Schema.decodeUnknownResult(PipeInput)({ max_items: -1, steps: [] })
    expect(decoded._tag).toBe("Failure")
  })
})
