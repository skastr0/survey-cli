import { Effect, Path, Schema } from "effect"

import { LocalToolError, LocalToolUnavailableError } from "../core/errors"
import { surveyHome } from "../core/paths"
import { findOnPath, realPathOf, requireModule, requireModuleOwning, runCli } from "./native"

export const LocalToolName = Schema.Literals(["anydoc", "pdf-inspector"])
export type LocalToolName = typeof LocalToolName.Type

/**
 * How a local tool is reached. `embedded` (native module inside the compiled
 * binary) is deliberately not offered: the default build cross-compiles four
 * targets from one host and the per-platform napi binaries are 7-12 MB each.
 */
export type LocalToolMode = "node_module" | "path_cli" | "unavailable"

export const LOCAL_TOOLS_DIR_ENV = "SURVEY_LOCAL_TOOLS_DIR"

export interface LocalToolSpec {
  readonly name: LocalToolName
  readonly npmPackage: string
  readonly cli: string
  readonly versionFlag: string
  readonly description: string
  readonly operations: ReadonlyArray<string>
  /** Operations the PATH CLI can serve when the node module is absent. */
  readonly cliOperations: ReadonlyArray<string>
  /** Supported `process.platform-arch` pairs published by the vendor. */
  readonly platforms: ReadonlyArray<string>
}

export const LOCAL_TOOL_SPECS: Record<LocalToolName, LocalToolSpec> = {
  anydoc: {
    name: "anydoc",
    npmPackage: "@firecrawl/anydoc",
    cli: "anydoc",
    versionFlag: "--version",
    description:
      "doc/docx/odt/rtf/epub/pdf/ppt/pptx/xls/xlsx/ods/odp/csv to GFM Markdown",
    operations: ["convert", "detect", "document"],
    cliOperations: ["convert"],
    platforms: [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ],
  },
  "pdf-inspector": {
    name: "pdf-inspector",
    npmPackage: "@firecrawl/pdf-inspector",
    cli: "pdf-inspector",
    versionFlag: "--version",
    description:
      "classify text-based vs scanned PDFs; layout-aware text, tables and regions without OCR",
    operations: [
      "classify",
      "inspect",
      "extract",
      "pages",
      "text",
      "positions",
      "regions",
      "tables",
      "ocr",
    ],
    cliOperations: ["classify", "extract"],
    platforms: ["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"],
  },
}

export const localToolNames = LocalToolName.literals

export interface ToolAttempt {
  readonly mode: string
  readonly detail: string
}

export interface ToolResolution {
  readonly tool: LocalToolName
  readonly mode: LocalToolMode
  readonly version: string | null
  readonly location: string | null
  readonly attempts: ReadonlyArray<ToolAttempt>
  readonly platform_supported: boolean
  readonly install_hint: string
  /** The loaded napi module. Not serialized. */
  readonly binding: unknown
  readonly cli: string | null
}

const platformKey = () => `${process.platform}-${process.arch}`

export const toolsDirectory = Effect.gen(function* () {
  const override = Bun.env[LOCAL_TOOLS_DIR_ENV]?.trim()
  if (override && override.length > 0) return override
  const path = yield* Path.Path
  const home = yield* surveyHome
  return path.join(home, "tools")
})

const installHint = (spec: LocalToolSpec, toolsDir: string) =>
  platformSupported(spec)
    ? `Install into the survey tools directory: \`mkdir -p ${toolsDir} && bun add --cwd ${toolsDir} ${spec.npmPackage}\` (or \`npm install --prefix ${toolsDir} ${spec.npmPackage}\`); a global \`npm install -g ${spec.npmPackage}\` also works. Set ${LOCAL_TOOLS_DIR_ENV} to use another directory.`
    : `${spec.npmPackage} publishes no ${platformKey()} build (supported: ${spec.platforms.join(", ")}). Use a LlamaCloud key for the hosted route instead.`

const platformSupported = (spec: LocalToolSpec) => spec.platforms.includes(platformKey())

const searchRoots = (toolsDir: string) => {
  const home = Bun.env.HOME ?? process.env.HOME
  const roots = [
    toolsDir,
    process.cwd(),
    ...(home ? [`${home}/.bun/install/global`] : []),
  ]
  return [...new Set(roots)]
}

const cache = new Map<string, Promise<ToolResolution>>()

export const clearLocalToolCache = () => cache.clear()

const probe = async (spec: LocalToolSpec, toolsDir: string): Promise<ToolResolution> => {
  const attempts: Array<ToolAttempt> = []
  const hint = installHint(spec, toolsDir)
  const base = {
    tool: spec.name,
    platform_supported: platformSupported(spec),
    install_hint: hint,
  } as const

  const roots = searchRoots(toolsDir)
  const loadFailures: Array<string> = []
  for (const root of roots) {
    const result = await requireModule(root, spec.npmPackage)
    if (result.ok) {
      return {
        ...base,
        mode: "node_module",
        version: result.version,
        location: result.dir,
        attempts: [],
        binding: result.binding,
        cli: null,
      }
    }
    if (result.found) loadFailures.push(result.detail)
  }
  attempts.push({
    mode: "node_module",
    detail:
      loadFailures.length > 0
        ? loadFailures.join("; ")
        : `${spec.npmPackage} not found in: ${roots.join(", ")}`,
  })

  const cliPath = await findOnPath(spec.cli)
  if (cliPath === null) {
    attempts.push({ mode: "path_cli", detail: `\`${spec.cli}\` is not on PATH` })
    return { ...base, mode: "unavailable", version: null, location: null, attempts, binding: null, cli: null }
  }

  // A global install puts the CLI on PATH next to the full node module.
  const sibling = await requireModuleOwning(await realPathOf(cliPath), spec.npmPackage)
  if (sibling.ok) {
    return {
      ...base,
      mode: "node_module",
      version: sibling.version,
      location: sibling.dir,
      attempts,
      binding: sibling.binding,
      cli: cliPath,
    }
  }

  const version = await runCli(cliPath, [spec.versionFlag], { timeoutMs: 10_000 }).then(
    (run) => (run.exitCode === 0 ? run.stdout.toString("utf8").trim().split(/\s+/).pop() ?? null : null),
    () => null,
  )
  if (version === null) {
    attempts.push({
      mode: "path_cli",
      detail: `\`${spec.cli}\` at ${cliPath} did not run (\`${spec.cli} ${spec.versionFlag}\` failed; the npm CLIs need node on PATH)`,
    })
    return { ...base, mode: "unavailable", version: null, location: null, attempts, binding: null, cli: null }
  }
  return {
    ...base,
    mode: "path_cli",
    version,
    location: cliPath,
    attempts,
    binding: null,
    cli: cliPath,
  }
}

export const resolveLocalTool = Effect.fn("resolveLocalTool")(function* (
  tool: LocalToolName,
) {
  const toolsDir = yield* toolsDirectory
  const spec = LOCAL_TOOL_SPECS[tool]
  const key = `${tool}@${toolsDir}`
  let pending = cache.get(key)
  if (pending === undefined) {
    pending = probe(spec, toolsDir)
    cache.set(key, pending)
  }
  return yield* Effect.promise(() => pending!)
})

/** Honest per-tool status for doctor / capabilities / auth status. */
export const localToolStatus = Effect.fn("localToolStatus")(function* (
  tool: LocalToolName,
) {
  const spec = LOCAL_TOOL_SPECS[tool]
  const resolution = yield* resolveLocalTool(tool)
  return {
    tool,
    kind: "local" as const,
    npm_package: spec.npmPackage,
    cli: spec.cli,
    mode: resolution.mode,
    available: resolution.mode !== "unavailable",
    version: resolution.version,
    location: resolution.location,
    platform: platformKey(),
    platform_supported: resolution.platform_supported,
    operations:
      resolution.mode === "node_module"
        ? spec.operations
        : resolution.mode === "path_cli"
          ? spec.cliOperations
          : [],
    requires_key: false,
    network: false,
    ...(resolution.mode === "unavailable"
      ? { install_hint: resolution.install_hint, attempts: resolution.attempts }
      : {}),
  }
})

export interface ToolBackends<A> {
  readonly node_module?: (binding: any, resolution: ToolResolution) => Promise<A>
  readonly path_cli?: (cli: string, resolution: ToolResolution) => Promise<A>
}

/** Error carrying a vendor `code`, thrown by CLI backends to mirror napi errors. */
export const cliFailure = (message: string, code?: string) =>
  Object.assign(new Error(message), code === undefined ? {} : { code })

const toToolError =
  (tool: LocalToolName, operation: string, mode: LocalToolMode) => (error: unknown) => {
    const raw = (error ?? {}) as {
      code?: unknown
      pages?: unknown
      pageCount?: unknown
      message?: unknown
    }
    return new LocalToolError({
      tool,
      operation,
      mode,
      code: typeof raw.code === "string" ? raw.code : null,
      pages: Array.isArray(raw.pages) ? (raw.pages as Array<number>) : null,
      page_count: typeof raw.pageCount === "number" ? raw.pageCount : null,
      message:
        typeof raw.message === "string" && raw.message.length > 0
          ? raw.message
          : `${tool} ${operation} failed`,
    })
  }

/**
 * Run one operation through the best available mode. The result says which
 * mode served it, so callers can report routes honestly.
 */
export const runLocalTool = <A>(
  tool: LocalToolName,
  operation: string,
  backends: ToolBackends<A>,
) =>
  Effect.gen(function* () {
    const resolution = yield* resolveLocalTool(tool)
    const spec = LOCAL_TOOL_SPECS[tool]

    const unavailable = (attempts: ReadonlyArray<ToolAttempt>, message: string) =>
      new LocalToolUnavailableError({
        tool,
        operation,
        attempts: [...attempts],
        install_hint: resolution.install_hint,
        message,
      })

    if (resolution.mode === "unavailable") {
      return yield* unavailable(
        resolution.attempts,
        `${tool} is not available for \`${operation}\`: ${resolution.attempts.map((a) => a.detail).join("; ")}`,
      )
    }

    const mode = resolution.mode
    const run =
      mode === "node_module"
        ? backends.node_module && (() => backends.node_module!(resolution.binding, resolution))
        : backends.path_cli && (() => backends.path_cli!(resolution.cli!, resolution))

    if (run === undefined) {
      return yield* unavailable(
        [
          ...resolution.attempts,
          {
            mode,
            detail:
              mode === "path_cli"
                ? `\`${operation}\` needs the ${spec.npmPackage} node module; the ${spec.cli} CLI only exposes: ${spec.cliOperations.join(", ")}`
                : `\`${operation}\` is not supported by the loaded ${spec.npmPackage} module`,
          },
        ],
        `${tool} \`${operation}\` is not available in ${mode} mode`,
      )
    }

    const value = yield* Effect.tryPromise({
      try: run,
      catch: toToolError(tool, operation, mode),
    })
    return { value, mode, version: resolution.version }
  })
