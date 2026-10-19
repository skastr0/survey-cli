import { Effect } from "effect"

import { ApiResponseError } from "../../core/errors"
import { callMcpTool } from "../../core/mcp"
import type { ContentsInput, WebSearchInput } from "./schemas"

/**
 * Keyless Exa: the hosted MCP server's free rate-limited tier
 * (https://exa.ai/docs/get-started/exa-mcp: "Keyless | Free rate-limited usage
 * without sign-in or API key"). The REST API answers 401/402 without a key.
 * Tools return plain text, parsed here into REST-like `results`.
 */

export const EXA_MCP_URL_ENV = "EXA_MCP_URL"
export const DEFAULT_EXA_MCP_URL = "https://mcp.exa.ai/mcp"

const mcpUrl = () => Bun.env[EXA_MCP_URL_ENV]?.trim() || DEFAULT_EXA_MCP_URL

export interface ExaKeylessResult {
  readonly url: string
  readonly title?: string
  readonly publishedDate?: string
  readonly author?: string
  readonly text: string
}

const HEADER = /^(Title|URL|Published|Author):\s*(.*)$/

/** Split `Title:/URL:/Published:/Author:` blocks separated by `---` lines. */
export const parseExaMcpText = (text: string): ReadonlyArray<ExaKeylessResult> =>
  text.split(/\n-{3,}\n/).flatMap((block) => {
    const fields: Record<string, string> = {}
    const body: Array<string> = []
    let inBody = false
    for (const line of block.trim().split("\n")) {
      const header = inBody ? null : HEADER.exec(line)
      if (header?.[1] && header[2] !== undefined) {
        fields[header[1]] = header[2].trim()
        continue
      }
      if (!inBody && fields.Title === undefined && line.startsWith("# ")) {
        fields.Title = line.slice(2).trim()
        continue
      }
      if (!inBody && /^Highlights:\s*$/.test(line)) {
        inBody = true
        continue
      }
      inBody = true
      body.push(line)
    }
    const url = fields.URL
    if (!url || !/^https?:\/\//.test(url)) return []
    const known = (value: string | undefined) => (value && value !== "N/A" ? value : undefined)
    const title = known(fields.Title)
    const publishedDate = known(fields.Published)
    const author = known(fields.Author)
    return [
      {
        url,
        ...(title ? { title } : {}),
        ...(publishedDate ? { publishedDate } : {}),
        ...(author ? { author } : {}),
        text: body.join("\n").trim(),
      },
    ]
  })

/** Input fields the MCP tool cannot honor, reported instead of silently dropped. */
const ignoredFields = (input: object, supported: ReadonlyArray<string>) =>
  Object.entries(input)
    .filter(([key, value]) => value !== undefined && !supported.includes(key))
    .map(([key]) => key)

const callTool = (tool: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const url = mcpUrl()
    const result = yield* callMcpTool({ provider: "exa", url, tool, arguments: args })
    if (result.is_error) {
      return yield* new ApiResponseError({
        provider: "exa",
        method: "POST",
        path: url,
        status: 200,
        message: result.text ?? `exa MCP ${tool} returned an error`,
        body: result,
      })
    }
    return { url, results: parseExaMcpText(result.text ?? "") }
  })

export const keylessWebSearch = (input: WebSearchInput, numResults: number) =>
  callTool("web_search_exa", {
    query: input.query,
    numResults,
    objective: input.systemPrompt ?? input.query,
  }).pipe(
    Effect.map(({ url, results }) => ({
      auth_mode: "public" as const,
      endpoint: url,
      ignored_options: ignoredFields(input, ["query", "numResults", "systemPrompt", "type"]),
      data: { results },
    })),
  )

export const keylessContents = (input: ContentsInput, urls: ReadonlyArray<string>) =>
  callTool("web_fetch_exa", {
    urls,
    ...(input.maxCharacters !== undefined ? { maxCharacters: input.maxCharacters } : {}),
  }).pipe(
    Effect.map(({ url, results }) => ({
      auth_mode: "public" as const,
      endpoint: url,
      ignored_options: ignoredFields(input, ["url", "urls", "maxCharacters", "text"]),
      results,
    })),
  )
