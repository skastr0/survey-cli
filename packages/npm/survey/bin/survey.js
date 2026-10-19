#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const platformKey = `${process.platform}-${process.arch}`

const packageMap = {
  "darwin-arm64": "@skastr0/survey-darwin-arm64",
  "darwin-x64": "@skastr0/survey-darwin-x64",
  "linux-arm64": "@skastr0/survey-linux-arm64",
  "linux-x64": "@skastr0/survey-linux-x64",
}

const packageName = packageMap[platformKey]

if (packageName === undefined) {
  console.error(`survey: unsupported platform ${platformKey}`)
  process.exit(1)
}

let packageJsonPath
try {
  packageJsonPath = require.resolve(`${packageName}/package.json`)
} catch {
  console.error(`survey: missing platform package ${packageName}`)
  console.error("Reinstall @skastr0/survey with optional dependencies enabled.")
  process.exit(1)
}

const binaryPath = join(dirname(packageJsonPath), "bin", "survey")

if (!existsSync(binaryPath)) {
  console.error(`survey: platform binary not found at ${binaryPath}`)
  process.exit(1)
}

// npm may hoist the platform package away from this wrapper's node_modules,
// where the optional @firecrawl/* local tools live; tell the binary where we are.
const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, SURVEY_NPM_PACKAGE_DIR: join(dirname(fileURLToPath(import.meta.url)), "..") },
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

if (result.signal) {
  process.kill(process.pid, result.signal)
}

process.exit(result.status ?? 1)
