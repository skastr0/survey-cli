import { execFile } from "node:child_process"
import { access, constants, readdir, readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { delimiter, dirname, join } from "node:path"

/**
 * The impure edge of the local-tool layer: everything that touches the module
 * loader, PATH, or child processes lives here so tests can stub one file.
 */

export type ModuleProbe =
  | {
      readonly ok: true
      readonly binding: unknown
      readonly version: string | null
      readonly dir: string
    }
  | { readonly ok: false; readonly found: boolean; readonly detail: string }

const firstLine = (message: string) => message.split("\n")[0]?.trim() ?? message

const readManifest = async (dir: string) => {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      name?: string
      version?: string
    }
  } catch {
    return null
  }
}

/**
 * Node-style lookup (`node_modules/<name>` from `root` upward) done by hand:
 * bun's `require.resolve` would auto-install a missing package from the
 * network when no node_modules directory exists above `root`.
 */
const findPackageDir = async (root: string, name: string) => {
  let dir = root
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(dir, "node_modules", name)
    if ((await readManifest(candidate))?.name === name) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Walk up from a file (e.g. a symlink-resolved CLI) to its owning package directory. */
const owningPackageDir = async (file: string, name: string) => {
  let dir = dirname(file)
  for (let depth = 0; depth < 6; depth += 1) {
    if ((await readManifest(dir))?.name === name) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

const isMusl = async () => {
  if (process.platform !== "linux") return false
  const loader = await readdir("/lib").catch(() => [] as Array<string>)
  return loader.some((entry) => entry.startsWith("ld-musl-"))
}

/**
 * napi-rs packages ship one optional dependency per platform, e.g.
 * `@firecrawl/anydoc-darwin-arm64`. Locate that package's `.node` file next to
 * the main package (or nested inside it) so it can be handed to the loader.
 */
const platformBindingFile = async (dir: string, name: string) => {
  const [scope, base] = name.split("/") as [string, string]
  const target = `${base}-${process.platform}-${process.arch}`
  const libc = (await isMusl()) ? "musl" : "gnu"
  const scopes = [join(dir, ".."), join(dir, "node_modules", scope)]
  for (const scopeDir of scopes) {
    const siblings = await readdir(scopeDir).catch(() => [] as Array<string>)
    const candidates = siblings
      .filter((entry) => entry === target || entry.startsWith(`${target}-`))
      .sort((a, b) => Number(b.endsWith(libc)) - Number(a.endsWith(libc)))
    for (const candidate of candidates) {
      const files = await readdir(join(scopeDir, candidate)).catch(() => [] as Array<string>)
      const binding = files.find((file) => file.endsWith(".node"))
      if (binding) return join(scopeDir, candidate, binding)
    }
  }
  return null
}

const loadPackage = async (dir: string, name: string): Promise<ModuleProbe> => {
  const version = (await readManifest(dir))?.version ?? null
  const nativeFile = await platformBindingFile(dir, name)
  const previous = process.env.NAPI_RS_NATIVE_LIBRARY_PATH
  try {
    // A compiled bun binary cannot resolve a napi package's platform
    // dependency by name, but it can dlopen the .node file by absolute path,
    // which is what NAPI_RS_NATIVE_LIBRARY_PATH asks the loader to do. The
    // variable is set only for this synchronous require.
    if (nativeFile !== null) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = nativeFile
    const binding = createRequire(join(dir, "package.json"))(dir)
    return { ok: true, binding, version, dir }
  } catch (error) {
    return {
      ok: false,
      found: true,
      detail: `${name} found at ${dir} but its native binding failed to load${
        nativeFile === null ? ` (no ${process.platform}-${process.arch} binding package installed)` : ""
      }: ${firstLine(error instanceof Error ? error.message : String(error))}`,
    }
  } finally {
    if (previous === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH
    else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = previous
  }
}

/** Load an npm package installed at or above `root`. */
export const requireModule = async (root: string, name: string): Promise<ModuleProbe> => {
  const dir = await findPackageDir(root, name)
  return dir === null
    ? { ok: false, found: false, detail: `${name} is not installed under ${root}` }
    : loadPackage(dir, name)
}

/** Load the package that owns a CLI binary (global installs put both side by side). */
export const requireModuleOwning = async (file: string, name: string): Promise<ModuleProbe> => {
  const dir = await owningPackageDir(file, name)
  return dir === null
    ? { ok: false, found: false, detail: `${file} does not belong to ${name}` }
    : loadPackage(dir, name)
}

export const findOnPath = async (binary: string): Promise<string | null> => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, binary)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return null
}

export const realPathOf = (path: string) => realpath(path).catch(() => path)

export interface CliRun {
  readonly stdout: Buffer
  readonly stderr: string
  readonly exitCode: number
}

export const runCli = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly stdin?: Uint8Array; readonly timeoutMs?: number } = {},
) =>
  new Promise<CliRun>((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        encoding: "buffer",
        maxBuffer: 1024 * 1024 * 1024,
        timeout: options.timeoutMs ?? 120_000,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error)
          return
        }
        resolve({
          stdout,
          stderr: stderr.toString("utf8"),
          exitCode: typeof error?.code === "number" ? error.code : 0,
        })
      },
    )
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(options.stdin === undefined ? undefined : Buffer.from(options.stdin))
  })
