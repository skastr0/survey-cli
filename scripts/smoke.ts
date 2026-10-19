#!/usr/bin/env bun
/**
 * End-to-end smoke test against a real binary (or `bun run src/cli.ts`) with
 * an isolated SURVEY_HOME. Exercises discovery for every registered command,
 * the local corpus/pipe/watch/MCP flows on real SQLite, and — with --live —
 * keyless provider calls (no API keys are forwarded).
 *
 *   bun scripts/smoke.ts                       # source, offline
 *   bun scripts/smoke.ts dist/survey-darwin-arm64 --live
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const live = args.includes("--live")
const binary = args.find((arg) => !arg.startsWith("--"))
const base = binary === undefined ? [process.execPath, join(import.meta.dir, "..", "src", "cli.ts")] : [binary]

const home = mkdtempSync(join(tmpdir(), "survey-smoke-"))
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? home,
  SURVEY_HOME: home,
}

interface Envelope {
  ok: boolean
  command?: string
  data?: any
  error?: { type: string; message: string }
}

const run = async (argv: ReadonlyArray<string>, stdin?: string) => {
  const proc = Bun.spawn([...base, ...argv], {
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

const call = async (argv: ReadonlyArray<string>, input?: unknown): Promise<Envelope> => {
  const result = await run(input === undefined ? argv : [...argv, JSON.stringify(input)])
  const text = (result.stdout.trim() || result.stderr.trim()).trim()
  try {
    return JSON.parse(text) as Envelope
  } catch {
    return { ok: false, error: { type: "Unparseable", message: `${argv.join(" ")}: ${text.slice(0, 300)}` } }
  }
}

const failures: Array<string> = []
let passed = 0
const check = (name: string, condition: unknown, detail?: unknown) => {
  if (condition) {
    passed += 1
  } else {
    failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`)
  }
}

try {
  // Discovery: every contract must have a schema, examples, and resolvable help.
  const version = await run(["--version"])
  check("--version", /survey v\d+\.\d+\.\d+/.test(version.stdout), version.stdout)

  const doctor = await call(["doctor"])
  check("doctor", doctor.ok, doctor.error)

  const capabilities = await call(["capabilities"])
  check("capabilities", capabilities.ok && capabilities.data.commands.length > 0, capabilities.error)
  const commands: Array<string> = capabilities.data?.commands?.map((c: { command: string }) => c.command) ?? []

  const schemaList = await call(["schema", "list"])
  const withSchema = new Set<string>(schemaList.data?.commands?.map((c: { command: string }) => c.command) ?? [])
  const missingSchema = commands.filter((command) => !withSchema.has(command))
  check("every command has an input schema", missingSchema.length === 0, missingSchema)

  const examplesList = await call(["examples", "list"])
  const withExamples = new Set<string>(examplesList.data?.commands?.map((c: { command: string }) => c.command) ?? [])
  const missingExamples = commands.filter((command) => !withExamples.has(command))
  check("every command has examples", missingExamples.length === 0, missingExamples)

  // Bounded: ~200 parallel binaries starved each other right after a build.
  const helpFailures: Array<string> = []
  const queue = [...commands]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let command = queue.shift(); command !== undefined; command = queue.shift()) {
        const help = await run([...command.split(" "), "--help"])
        if (help.exitCode !== 0 || !help.stdout.includes("USAGE") || !help.stdout.includes("CONTRACT")) {
          helpFailures.push(command)
        }
      }
    }),
  )
  check("every contract resolves to a real command (--help)", helpFailures.length === 0, helpFailures)

  // Capabilities derives per-command flags and input mode from the parser.
  const surfaceGaps = (capabilities.data?.commands ?? []).filter(
    (c: { flags?: unknown; input?: string }) =>
      !Array.isArray(c.flags) || !["required", "optional", "none"].includes(c.input ?? ""),
  )
  check("capabilities lists flags + input mode per command", surfaceGaps.length === 0, surfaceGaps.slice(0, 3))

  // Failure contract: exit 1, nothing on stdout, one stderr envelope with details.retryable.
  const failing: ReadonlyArray<[string, ReadonlyArray<string>, string]> = [
    ["unknown command", ["no-such-command"], "CliUsageError"],
    ["unknown flag", ["search", "--no-such-flag", "{}"], "CliUsageError"],
    ["invalid json", ["search", "{bad"], "JsonInputError"],
    ["schema mismatch", ["search", '{"query":1}'], "JsonInputError"],
  ]
  for (const [name, argv, type] of failing) {
    const result = await run(argv)
    let envelope: any
    try {
      envelope = JSON.parse(result.stderr)
    } catch {
      envelope = undefined
    }
    check(
      `failure contract: ${name}`,
      result.exitCode === 1 &&
        result.stdout.trim() === "" &&
        envelope?.ok === false &&
        envelope.error?.type === type &&
        typeof envelope.error?.details?.retryable === "boolean" &&
        typeof envelope.error?.details?.hint === "string",
      { exitCode: result.exitCode, stdout: result.stdout.slice(0, 120), stderr: result.stderr.slice(0, 300) },
    )
  }
  const mismatch = await run(["search", '{"query":1}'])
  const mismatchError = JSON.parse(mismatch.stderr || "{}").error
  check(
    "schema mismatch reports issue paths + schema next_step",
    mismatchError?.details?.issues?.[0]?.path === "query" &&
      String(mismatchError?.details?.next_step).includes('schema show "search"'),
    mismatchError,
  )
  const help = await run(["--help"])
  check("--help exits 0 on stdout", help.exitCode === 0 && help.stdout.includes("USAGE") && help.stderr === "", help.stderr)

  // Corpus on real SQLite/FTS5.
  const notePath = join(home, "note.md")
  writeFileSync(notePath, "# Smoke\nThe quick brown fox.\nRate limit: 100 rpm\n")
  const added = await call(["corpus", "add"], [
    { url: "note://smoke/1", content: "alpha beta\nrate limit 100 rpm\nomega", tags: ["smoke"] },
    { path: notePath },
  ])
  check("corpus add", added.ok && added.data.success_count === 2, added)
  const searched = await call(["corpus", "search"], { query: "rate limit" })
  check("corpus search (fts5)", searched.ok && searched.data.count === 2, searched)
  const grepped = await call(["corpus", "grep"], { pattern: "fox", context: 1 })
  check("corpus grep", grepped.ok && grepped.data.count === 1, grepped)
  await call(["corpus", "add"], { url: "note://smoke/1", content: "alpha beta\nrate limit 200 rpm\nomega" })
  const diffed = await call(["corpus", "diff"], { url: "note://smoke/1" })
  check(
    "corpus diff",
    diffed.ok && diffed.data.diff.hunks[0]?.lines.includes("-rate limit 100 rpm"),
    diffed,
  )
  const read = await call(["corpus", "read"], { url: "note://smoke/1", lines: "2" })
  check("corpus read", read.ok && read.data.content === "rate limit 200 rpm", read)
  const stats = await call(["corpus", "stats"])
  check("corpus stats", stats.ok && stats.data.documents === 2 && stats.data.versions === 3, stats)
  const local = await call(["sql"], { query: "SELECT COUNT(*) AS n FROM documents", local: true })
  check("sql local over corpus", local.ok && local.data.rows[0]?.n === 2, local)

  // Pipe composes commands through the binary.
  const piped = await call(["pipe"], {
    steps: [
      { id: "hits", command: "corpus search", input: { query: "rate" }, select: "$.data.hits[*].id" },
      { id: "reads", command: "corpus read", foreach: "$.hits.data", input: { id: "$item", lines: "1" } },
    ],
    output: "$.reads.data[*].content",
  })
  check("pipe foreach over corpus", piped.ok && piped.data.output?.length === 2, piped)

  // Watch fails cleanly with nothing to watch.
  const watched = await call(["watch"], { tag: "nothing-here" })
  check("watch empty list error", !watched.ok && watched.error?.type === "CommandInputError", watched)

  // MCP handshake + tool call over stdio.
  const rpc = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "corpus_stats", arguments: {} } },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n")
  const mcp = await run(["mcp", "serve"], `${rpc}\n`)
  const responses = mcp.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const byId = new Map(responses.map((response: { id: number }) => [response.id, response]))
  check("mcp initialize", (byId.get(1) as any)?.result?.protocolVersion === "2025-06-18", responses)
  check("mcp tools/list covers commands", ((byId.get(2) as any)?.result?.tools?.length ?? 0) >= commands.length - 1)
  check("mcp tools/call", (byId.get(3) as any)?.result?.isError === false, byId.get(3))

  if (live) {
    const keyless = await call(["keenable", "search"], { query: "effect typescript" })
    check("live keenable public search", keyless.ok, keyless.error)
    const fetched = await call(["fetch"], { url: "https://example.com", providers: ["keenable"] })
    check("live keyless fetch → corpus", fetched.ok && fetched.data.corpus?.created === true, fetched.error)
    const search = await call(["search"], { query: "reciprocal rank fusion", num_results: 5 })
    check("live keyless unified search", search.ok && search.data.results.length > 0, search.error ?? search.data?.failures)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(JSON.stringify({ ok: failures.length === 0, passed, failed: failures.length, failures, live, binary: base.join(" ") }, null, 2))
process.exit(failures.length === 0 ? 0 : 1)
