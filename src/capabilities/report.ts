import { createHash } from "node:crypto"

import { rememberDocument } from "../core/corpus"

/** Text fields providers commonly put their answer in, in preference order. */
const TEXT_KEYS = ["content", "markdown", "text", "answer", "report", "output", "result", "summary"] as const

const FENCE_LIMIT = 20_000

export const outputText = (output: unknown, depth = 0): string | undefined => {
  if (typeof output === "string") return output.length > 0 ? output : undefined
  if (!output || typeof output !== "object" || depth > 3) return undefined
  const record = output as Record<string, unknown>
  for (const key of TEXT_KEYS) {
    const found = outputText(record[key], depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** Provider output as markdown: its text answer when it has one, else fenced JSON. */
export const renderOutput = (output: unknown) => {
  const text = outputText(output)
  if (text !== undefined) return text
  const json = JSON.stringify(output, null, 2) ?? "null"
  return `\`\`\`json\n${json.length > FENCE_LIMIT ? `${json.slice(0, FENCE_LIMIT)}\n… truncated` : json}\n\`\`\``
}

export const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16)

/** Remember a finished report as a corpus document of kind "report". */
export const rememberReport = (report: {
  readonly url: string
  readonly title: string
  readonly content: string
  readonly tags?: ReadonlyArray<string> | undefined
  readonly metadata: Record<string, unknown>
}) =>
  rememberDocument({
    url: report.url,
    title: report.title,
    content: report.content,
    provider: "survey",
    kind: "report",
    tags: report.tags,
    metadata: report.metadata,
  })

export const corpusRef = (
  remembered: { readonly id: number; readonly version: number; readonly changed: boolean; readonly created: boolean } | undefined,
  url: string,
) =>
  remembered === undefined
    ? {}
    : {
        corpus: {
          id: remembered.id,
          version: remembered.version,
          changed: remembered.changed,
          created: remembered.created,
          url,
        },
      }
