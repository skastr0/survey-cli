/**
 * Re-invoke this survey binary as a subprocess with a JSON payload on stdin.
 * Shared by the MCP server and pipelines so composed calls get exactly the
 * CLI's validation, side effects (runs/sources/corpus), and envelopes.
 */

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type Executor = (argv: ReadonlyArray<string>, input: string) => Promise<ExecResult>

/** How to re-invoke this CLI: compiled binary → execPath; `bun run cli.ts` → execPath + script. */
export const selfCommand = (): ReadonlyArray<string> => {
  const script = process.argv[1]
  if (script === undefined || script.startsWith("/$bunfs") || script.startsWith("B:/~BUN") || script === process.execPath) {
    return [process.execPath]
  }
  return [process.execPath, script]
}

export const spawnExecutor: Executor = async (argv, input) => {
  const proc = Bun.spawn([...selfCommand(), ...argv, "-"], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export const parseEnvelope = (text: string): unknown => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // Some commands stream NDJSON; keep the last complete envelope.
    const lines = trimmed.split("\n").filter((line) => line.trim().length > 0)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]!)
      } catch {
        continue
      }
    }
    return { raw: trimmed }
  }
}

export interface Envelope {
  readonly ok: boolean
  readonly command?: string
  readonly data?: unknown
  readonly error?: { readonly type: string; readonly message: string; readonly details?: unknown }
}

/** Pick the success envelope from stdout, else the failure envelope from stderr. */
export const envelopeOf = (result: ExecResult): Envelope => {
  const success = parseEnvelope(result.stdout) as Envelope | undefined
  if (success?.ok === true) return success
  const failure = parseEnvelope(result.stderr) as Envelope | undefined
  if (failure !== undefined && typeof failure === "object" && "ok" in failure) return failure
  return {
    ok: false,
    error: {
      type: "ExecError",
      message: `exit ${result.exitCode}`,
      details: { stderr: result.stderr.slice(0, 2000) },
    },
  }
}
