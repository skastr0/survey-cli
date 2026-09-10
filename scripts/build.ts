import { $ } from "bun"

const targets = [
  ["darwin-arm64", "bun-darwin-arm64"],
  ["darwin-x64", "bun-darwin-x64"],
  ["linux-arm64", "bun-linux-arm64"],
  ["linux-x64", "bun-linux-x64"],
] as const

await $`mkdir -p dist`

for (const [suffix, target] of targets) {
  const out = `dist/survey-${suffix}`
  console.log(`building ${out}`)
  await $`bun build --compile --target=${target} --outfile ${out} src/cli.ts`
}

console.log("done")
