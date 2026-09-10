#!/usr/bin/env bun

import { chmod, copyFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LICENSE_PATH = join(REPO_ROOT, "LICENSE")

const npmPackageDirs = [
  "packages/npm/survey",
  "packages/npm/survey-darwin-arm64",
  "packages/npm/survey-darwin-x64",
  "packages/npm/survey-linux-arm64",
  "packages/npm/survey-linux-x64",
] as const

const platformPackages = [
  { target: "darwin-arm64", packageDir: "packages/npm/survey-darwin-arm64" },
  { target: "darwin-x64", packageDir: "packages/npm/survey-darwin-x64" },
  { target: "linux-arm64", packageDir: "packages/npm/survey-linux-arm64" },
  { target: "linux-x64", packageDir: "packages/npm/survey-linux-x64" },
] as const

const run = async (label: string, command: ReadonlyArray<string>): Promise<void> => {
  console.log(`\n${label}`)
  const proc = Bun.spawn(command, {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error(`${label} failed with exit code ${exitCode}`)
    process.exit(exitCode)
  }
}

await run("Building standalone CLI binaries", ["bun", "run", "build:cli"])

for (const packageDir of npmPackageDirs) {
  await copyFile(LICENSE_PATH, join(REPO_ROOT, packageDir, "LICENSE"))
}

for (const { target, packageDir } of platformPackages) {
  const source = join(REPO_ROOT, "dist", `survey-${target}`)
  const binDir = join(REPO_ROOT, packageDir, "bin")
  const destination = join(binDir, "survey")

  await mkdir(binDir, { recursive: true })
  await copyFile(source, destination)
  await chmod(destination, 0o755)

  console.log(`Copied ${source} -> ${destination}`)
}
