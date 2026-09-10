import { describe, expect, it } from "@effect/vitest"

import { mergeResults, toResults, type NormalizedResult } from "../src/capabilities/normalize"

type Row = Omit<NormalizedResult, "providers">

const row = (url: string, extra?: Partial<Row>): Row => ({
  url,
  canonical_url: url.replace(/^https?:\/\/(www\.)?/, "https://").replace(/\/$/, ""),
  ...extra,
})

describe("mergeResults", () => {
  it("dedupes by canonical_url and merges provider provenance", () => {
    const outcomes = [
      {
        provider: "exa" as const,
        ok: true,
        results: [
          row("https://a.com/x", { title: "A" }),
          row("https://b.com/y"),
        ],
      },
      {
        provider: "parallel" as const,
        ok: true,
        results: [
          row("https://a.com/x", { snippet: "parallel snippet" }),
          row("https://c.com/z"),
        ],
      },
    ]

    const merged = mergeResults(outcomes)
    expect(merged.length).toBe(3)
    const a = merged.find((r) => r.canonical_url === "https://a.com/x")!
    expect([...a.providers].sort()).toEqual(["exa", "parallel"])
    expect(a.title).toBe("A")
    expect(a.snippet).toBe("parallel snippet")
  })

  it("ranks multi-provider results first", () => {
    const outcomes = [
      {
        provider: "exa" as const,
        ok: true,
        results: [row("https://solo.com"), row("https://shared.com")],
      },
      {
        provider: "keenable" as const,
        ok: true,
        results: [row("https://shared.com")],
      },
    ]
    const merged = mergeResults(outcomes)
    expect(merged[0]?.canonical_url).toBe("https://shared.com")
    expect(merged[0]?.providers.length).toBe(2)
  })

  it("survives fully-failed providers", () => {
    const outcomes = [
      {
        provider: "exa" as const,
        ok: false,
        results: [],
        error: { type: "ApiResponseError" },
      },
      { provider: "parallel" as const, ok: true, results: [row("https://ok.com")] },
    ]
    const merged = mergeResults(outcomes)
    expect(merged.length).toBe(1)
    expect(merged[0]?.providers).toEqual(["parallel"])
  })
})
