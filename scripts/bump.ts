#!/usr/bin/env bun
/**
 * Bump the version everywhere it is pinned: workspace package.json, the npm
 * wrapper + platform packages (incl. optionalDependencies), and CLI_VERSION.
 * Usage: bun scripts/bump.ts [patch|minor|major|<x.y.z>]
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const rootPkgPath = join(root, "package.json")
const current: string = (await Bun.file(rootPkgPath).json()).version
const arg = process.argv[2] ?? "patch"

const next = (() => {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg
  const [major, minor, patch] = current.split(".").map(Number) as [number, number, number]
  if (arg === "major") return `${major + 1}.0.0`
  if (arg === "minor") return `${major}.${minor + 1}.0`
  if (arg === "patch") return `${major}.${minor}.${patch + 1}`
  throw new Error(`Unknown bump "${arg}"`)
})()

const npmDir = join(root, "packages", "npm")
const pkgPaths = [rootPkgPath, ...readdirSync(npmDir).map((dir) => join(npmDir, dir, "package.json"))]

for (const path of pkgPaths) {
  const pkg = await Bun.file(path).json()
  pkg.version = next
  for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
    if (name.startsWith("@skastr0/survey-")) pkg.optionalDependencies[name] = next
  }
  await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`)
}

const constantsPath = join(root, "src", "core", "constants.ts")
const constants = await Bun.file(constantsPath).text()
await Bun.write(constantsPath, constants.replace(/CLI_VERSION = "[^"]+"/, `CLI_VERSION = "${next}"`))

console.log(JSON.stringify({ from: current, to: next, files: pkgPaths.length + 1 }))
