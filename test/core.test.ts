import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, FileSystem, Layer, Path, Schema } from "effect"

import { emitOutput } from "../src/core/artifacts"
import { canonicalizeUrl, Store } from "../src/core/store"
import { extractUrls } from "../src/core/runs"
import { decodeJsonText, loadJsonInput } from "../src/core/json"
import { causeToErrorDetails, renderFailureEnvelope, renderSuccessEnvelope, toErrorDetails } from "../src/core/output"
import { CommandInputError, MissingApiKeyError } from "../src/core/errors"

// emitOutput reads Bun.env; vitest runs under Node.
;(globalThis as { Bun?: unknown }).Bun ??= { env: process.env }

const TestPaths = Layer.mergeAll(
  FileSystem.layerNoop({
    readFileString: (path: string) =>
      path === "/tmp/input.json"
        ? Effect.succeed('{"a":1}')
        : Effect.fail({ _tag: "BadArgument", message: "missing", path } as never),
    exists: () => Effect.succeed(false),
    makeDirectory: () => Effect.void,
    writeFileString: () => Effect.void,
    chmod: () => Effect.void,
  }),
  Path.layer,
)

describe("canonicalizeUrl", () => {
  it("strips tracking params, www, fragments, trailing slash", () => {
    expect(
      canonicalizeUrl("https://www.Example.com/path/?utm_source=x&b=2#frag"),
    ).toBe("https://example.com/path?b=2")
  })

  it("returns raw string for invalid urls", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url")
  })
})

describe("extractUrls", () => {
  it("finds url-bearing rows deeply", () => {
    const payload = {
      results: [
        { url: "https://a.com/x", title: "A" },
        { url: "https://b.com/y", text: "some body text" },
      ],
      nested: { data: [{ url: "https://c.com" }] },
      bad: { url: "notaurl" },
    }
    const urls = extractUrls(payload)
    expect(urls.map((u) => u.url)).toEqual([
      "https://a.com/x",
      "https://b.com/y",
      "https://c.com",
    ])
  })
})

describe("loadJsonInput", () => {
  const S = Schema.Struct({ a: Schema.Number })

  it.effect("decodes inline JSON", () =>
    Effect.gen(function* () {
      const value = yield* loadJsonInput(S, '{"a": 1}')
      expect(value.a).toBe(1)
    }).pipe(Effect.provide(TestPaths)),
  )

  it.effect("rejects invalid JSON with JsonInputError", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(loadJsonInput(S, "{nope"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("JsonInputError")
      }
    }).pipe(Effect.provide(TestPaths)),
  )

  it.effect("loads @file", () =>
    Effect.gen(function* () {
      const value = yield* loadJsonInput(S, "@/tmp/input.json")
      expect(value.a).toBe(1)
    }).pipe(Effect.provide(TestPaths)),
  )

  it.effect("rejects empty input", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(loadJsonInput(S, "  "))
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(TestPaths)),
  )
})

describe("envelopes", () => {
  it("renders success envelope", () => {
    const parsed = JSON.parse(renderSuccessEnvelope("cmd", { x: 1 }))
    expect(parsed).toEqual({ ok: true, command: "cmd", data: { x: 1 } })
  })

  it("renders failure envelope with details", () => {
    const parsed = JSON.parse(
      renderFailureEnvelope("cmd", new MissingApiKeyError({ provider: "exa", envVar: "EXA_API_KEY", hint: "hint" })),
    )
    expect(parsed.ok).toBe(false)
    expect(parsed.error.type).toBe("MissingApiKeyError")
    expect(parsed.error.details.provider).toBe("exa")
  })

  it("redacts secrets in details", () => {
    const details = toErrorDetails(
      new CommandInputError({ field: "x", message: "m" }),
    )
    expect(details.type).toBe("CommandInputError")
  })
})

describe("error contract", () => {
  it("renders plain {_tag} failure records like their TaggedError class", () => {
    const details = toErrorDetails({
      _tag: "MissingApiKeyError",
      provider: "parallel",
      envVar: "PARALLEL_API_KEY",
      hint: "set it",
    })
    expect(details.type).toBe("MissingApiKeyError")
    expect(details.message).toBe("PARALLEL_API_KEY is not configured")
    expect(details.details).toMatchObject({ env_var: "PARALLEL_API_KEY", retryable: false })
  })

  it("keeps unknown tagged errors' fields, redacting secrets", () => {
    const details = toErrorDetails({ _tag: "SomethingNew", message: "m", target: "t", api_key: "sk" })
    expect(details).toMatchObject({
      type: "SomethingNew",
      details: { target: "t", api_key: "[redacted]", retryable: false },
    })
  })

  it("points input errors at schema discovery for the failing command", () => {
    const parsed = JSON.parse(renderFailureEnvelope("exa web-search", new CommandInputError({ field: "q", message: "m" })))
    expect(parsed.error.details.next_step).toContain('survey schema show "exa web-search"')
  })

  it("gives every failure retryable and hint", () => {
    for (const error of [new Error("boom"), "text", { _tag: "X" }]) {
      const details = toErrorDetails(error).details as Record<string, unknown>
      expect(typeof details.retryable).toBe("boolean")
      expect(typeof details.hint).toBe("string")
    }
  })

  it("renders defects with the squashed message and the trace in details", () => {
    const details = causeToErrorDetails(Cause.die(new Error("invariant broke")))
    expect(details.type).toBe("UnexpectedError")
    expect(details.message).toBe("invariant broke")
    expect((details.details as Record<string, unknown>).trace).toEqual(expect.any(String))
  })
})

describe("input issues", () => {
  it.effect("reports schema mismatches as InvalidShape with every issue path", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ query: Schema.String, opts: Schema.Struct({ n: Schema.Number }) })
      const error = yield* Effect.flip(decodeJsonText(schema, '{"query":1,"opts":{"n":"x"}}', "inline"))
      expect(error.reason).toBe("InvalidShape")
      expect(error.issues?.map((issue) => issue.path)).toEqual(["query", "opts.n"])
    }),
  )

  it.effect("reports unparseable text as InvalidJson with the parser message", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeJsonText(Schema.Unknown, "{bad", "inline"))
      expect(error.reason).toBe("InvalidJson")
      expect(error.message).not.toBe("Expected a valid JSON string")
    }),
  )
})

describe("store service contract", () => {
  const inMemoryStore = () => {
    const runs = new Map<string, import("../src/core/store").RunRecord>()
    const sources: Array<import("../src/core/store").SourceRecord> = []
    let nextId = 1
    const ts = "2026-01-01T00:00:00.000Z"
    return Store.of({
      upsertRun: (input) =>
        Effect.sync(() => {
          const record: import("../src/core/store").RunRecord = {
            id: input.id,
            provider: input.provider,
            kind: input.kind,
            remote_id: input.remoteId ?? null,
            status: input.status,
            payload: input.payload === undefined ? null : JSON.stringify(input.payload),
            result_ref: input.resultRef ?? null,
            created_at: ts,
            updated_at: ts,
          }
          runs.set(input.id, record)
          return record
        }),
      getRun: (id) => Effect.succeed(runs.get(id)),
      findRunByRemote: (provider, remoteId) =>
        Effect.succeed([...runs.values()].find((r) => r.provider === provider && r.remote_id === remoteId)),
      listRuns: (options) =>
        Effect.succeed(
          [...runs.values()].filter(
            (r) =>
              (options?.provider === undefined || r.provider === options.provider) &&
              (options?.status === undefined || r.status === options.status),
          ),
        ),
      updateRun: (id, patch) =>
        Effect.sync(() => {
          const existing = runs.get(id)
          if (existing) {
            runs.set(id, {
              ...existing,
              status: patch.status ?? existing.status,
              remote_id: patch.remoteId ?? existing.remote_id,
              result_ref: patch.resultRef ?? existing.result_ref,
            })
          }
        }),
      insertSources: (items) =>
        Effect.sync(() => {
          for (const item of items) {
            sources.push({
              id: nextId++,
              run_id: item.runId ?? null,
              provider: item.provider,
              url: item.url,
              canonical_url: canonicalizeUrl(item.url),
              title: item.title ?? null,
              snippet: item.snippet ?? null,
              content_hash: item.contentHash ?? null,
              fetched_at: ts,
            })
          }
          return items.length
        }),
      sourcesForRun: (runId) => Effect.succeed(sources.filter((s) => s.run_id === runId)),
      listSources: (options) =>
        Effect.succeed(
          sources.filter(
            (s) =>
              (options?.provider === undefined || s.provider === options.provider) &&
              (options?.canonicalUrl === undefined || s.canonical_url === options.canonicalUrl),
          ),
        ),
      citationOverlap: (urls) =>
        Effect.succeed(
          [...new Set(urls.map(canonicalizeUrl))]
            .map((canonical_url) => ({
              canonical_url,
              providers: [...new Set(sources.filter((s) => s.canonical_url === canonical_url).map((s) => s.provider))].join(","),
            }))
            .filter((row) => row.providers.length > 0),
        ),
    })
  }

  it.effect("upserts runs and records sources with canonical dedupe", () =>
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.upsertRun({
        id: "srv_test1",
        provider: "exa",
        kind: "exa.agent",
        remoteId: "r1",
        status: "running",
        payload: { q: 1 },
      })
      yield* store.updateRun("srv_test1", { status: "succeeded" })
      const run = yield* store.getRun("srv_test1")
      expect(run?.status).toBe("succeeded")

      yield* store.insertSources([
        { provider: "exa", url: "https://a.com/?utm_source=x", title: "A" },
        { provider: "parallel", url: "https://a.com/", runId: "srv_test1" },
      ])
      const overlap = yield* store.citationOverlap(["https://a.com"])
      expect(overlap[0]?.providers).toBe("exa,parallel")
    }).pipe(Effect.provide(Layer.succeed(Store, inMemoryStore()))),
  )
})

describe("emitOutput", () => {
  const big = "x".repeat(70 * 1024)
  it.effect("keeps auto output inline for pipe/MCP children", () =>
    Effect.gen(function* () {
      process.env.SURVEY_OUTPUT_INLINE = "1"
      const emitted = yield* emitOutput({ policy: "auto", key: "k", kind: "json", contents: big, summary: "s" }).pipe(
        Effect.ensuring(Effect.sync(() => delete process.env.SURVEY_OUTPUT_INLINE)),
      )
      expect(emitted.kind).toBe("inline")
    }).pipe(Effect.provide(TestPaths)),
  )
})

