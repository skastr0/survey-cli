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

  it("fuses by reciprocal rank, not raw cross-provider scores", () => {
    const outcomes = [
      {
        provider: "exa" as const,
        ok: true,
        results: [row("https://a.com", { score: 0.99 }), row("https://b.com", { score: 0.98 })],
      },
      {
        provider: "parallel" as const,
        ok: true,
        results: [row("https://b.com", { score: 0.1 }), row("https://c.com", { score: 0.05 })],
      },
    ]
    const merged = mergeResults(outcomes)
    expect(merged.map((r) => r.canonical_url)).toEqual(["https://b.com", "https://a.com", "https://c.com"])
    expect(merged[0]?.ranks).toEqual({ exa: 2, parallel: 1 })
    expect(merged[0]?.fusion_score).toBeCloseTo(1 / 62 + 1 / 61, 6)
  })

  it("weights keenable 1.5x by default without overriding two-provider agreement", () => {
    const merged = mergeResults([
      { provider: "exa" as const, ok: true, results: [row("https://exa-top.com"), row("https://shared.com")] },
      { provider: "parallel" as const, ok: true, results: [row("https://shared.com")] },
      { provider: "keenable" as const, ok: true, results: [row("https://keenable-top.com")] },
    ])
    expect(merged.map((r) => r.canonical_url)).toEqual([
      "https://shared.com",
      "https://keenable-top.com",
      "https://exa-top.com",
    ])
    expect(merged[1]?.fusion_score).toBeCloseTo(1.5 / 61, 6)
  })

  it("honours explicit weights, including equal weighting", () => {
    const outcomes = [
      { provider: "exa" as const, ok: true, results: [row("https://exa-top.com")] },
      { provider: "keenable" as const, ok: true, results: [row("https://keenable-top.com")] },
    ]
    expect(mergeResults(outcomes, { exa: 2 })[0]?.canonical_url).toBe("https://exa-top.com")
    expect(mergeResults(outcomes, {})[0]?.fusion_score).toBeCloseTo(1 / 61, 6)
  })

  it("counts only the first occurrence of a URL within one provider", () => {
    const merged = mergeResults([
      { provider: "exa" as const, ok: true, results: [row("https://a.com"), row("https://a.com/"), row("https://b.com")] },
    ])
    expect(merged.find((r) => r.canonical_url === "https://b.com")?.ranks).toEqual({ exa: 2 })
  })
})

import { compareResults } from "../src/capabilities/compare"

describe("compareResults", () => {
  it("builds per-provider lists, pairwise overlap, and consensus from fused ranks", () => {
    const merged = mergeResults([
      { provider: "exa" as const, ok: true, results: [row("https://a.com"), row("https://b.com")] },
      { provider: "keenable" as const, ok: true, results: [row("https://b.com"), row("https://c.com")] },
    ])
    const view = compareResults(merged, ["exa", "keenable"])
    expect(view.summary).toEqual({ unique_urls: 3, corroborated_urls: 1, agreement_rate: 0.333 })
    expect(view.overlap).toEqual([{ a: "exa", b: "keenable", shared: 1, jaccard: 0.333 }])
    const exa = view.providers.find((p) => p.provider === "exa")!
    expect(exa.results.map((r) => [r.rank, r.url, r.also_in])).toEqual([
      [1, "https://a.com", []],
      [2, "https://b.com", ["keenable"]],
    ])
    expect(exa.unique).toBe(1)
    expect(view.consensus.map((c) => c.url)).toEqual(["https://b.com"])
  })
})
