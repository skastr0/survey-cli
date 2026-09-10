#!/usr/bin/env bun

import { readFileSync } from "node:fs"
import { chmod, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  readonly version?: string
}
const version = packageJson.version ?? "0.0.0"
const distDir = join(repoRoot, "dist")
const binaryName = "survey"

const targets = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
] as const

console.log("Cleaning dist directory...")
await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

console.log(`\nBuilding ${binaryName} v${version}...\n`)

for (const { platform, arch } of targets) {
  const target = `bun-${platform}-${arch}`
  const outfile = join(distDir, `${binaryName}-${platform}-${arch}`)
  console.log(`→ ${platform}-${arch}`)

  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=${target}`,
      "--minify",
      "--sourcemap=none",
      "--outfile",
      outfile,
      "src/cli.ts",
    ],
    { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
  )

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error(`Build failed for ${platform}-${arch} (exit ${exitCode})`)
    process.exit(exitCode)
  }

  await chmod(outfile, 0o755)
}

console.log(`\nDone. Binaries in ${distDir}`)
